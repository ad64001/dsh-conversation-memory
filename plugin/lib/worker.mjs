import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cpLength, safeCode, searchQueries } from './protocol.mjs';
import { UserEvidenceIndex } from './user-evidence.mjs';
import { collectQueries, incompleteNotice } from './retrieval.mjs';
import { atomicState } from './atomic-state.mjs';

const { openConversation } = await import(workerData.libraryUrl);
const directory = join(workerData.rootDir, createHash('sha256').update(workerData.conversationId).digest('hex'));
mkdirSync(directory, { recursive: true });
const statePath = join(directory, 'bridge-state.json');
let state = { schema: 1, conversationId: workerData.conversationId, archivedThroughSeq: -1, indexOffsets: {}, completedMessages: [], lastErrorCode: null };
try {
  const prior = JSON.parse(readFileSync(statePath, 'utf8'));
  if (prior.schema !== 1 || prior.conversationId !== workerData.conversationId) throw new Error('Invalid memory bridge identity');
  state = prior;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let stateReplacementRetries = 0;
const saveState = () => { stateReplacementRetries += atomicState(statePath, state); };
const modelCalls = new Map();
const controllers = new Map();
let modelId = 0;
let disposed = false;
let indexing = false;
const memory = openConversation({ rootDir: workerData.rootDir, conversationId: workerData.conversationId, contextChars: workerData.contextChars,
  model: request => new Promise((resolve, reject) => {
    const id = ++modelId;
    const onAbort = () => { modelCalls.delete(id); parentPort.postMessage({ type: 'model-cancel', id }); reject(request.signal.reason ?? new Error('Aborted')); };
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    modelCalls.set(id, { resolve, reject, cleanup: () => request.signal?.removeEventListener('abort', onAbort) });
    parentPort.postMessage({ type: 'model', id, request: { purpose: request.purpose, messages: request.messages, maxTokens: request.maxTokens } });
  }),
});
const userEvidence = new UserEvidenceIndex(memory);
// Store only immutable source identities, not a second summarized conversation.
// The cursor also repairs a crash between SQLite append and bridge-state save.
if (state.userIndexVersion !== 1) {
  state.userIndexVersion = 1; state.userMessageIds = []; state.userIndexThroughSeq = 0;
}
for (const id of state.userMessageIds ?? []) userEvidence.add(memory.store.getMessage(id));
for (;;) {
  const page = memory.store.listMessages({ afterSeq: state.userIndexThroughSeq ?? 0, limit: 100 });
  for (const message of page) {
    if (message.role === 'user') {
      userEvidence.add(message);
      if (!state.userMessageIds.includes(message.id)) state.userMessageIds.push(message.id);
    }
    state.userIndexThroughSeq = message.seq;
  }
  if (page.length < 100) break;
}
saveState();

function health() {
  const stats = memory.stats();
  return { conversationId: memory.conversationId, archivedThroughSeq: state.archivedThroughSeq, stats,
    indexedMessages: state.completedMessages.length, pendingOffsets: Object.keys(state.indexOffsets).length,
    unindexedMessages: Math.max(0, stats.messages - state.completedMessages.length), indexing,
    lastErrorCode: state.lastErrorCode, stateReplacementRetries, automaticModelIndexing: false, contextChars: workerData.contextChars };
}
function hasLinkedBackground(record) {
  const refs = record.scope?.indexingBackgroundRefs;
  return Array.isArray(refs) && refs.some(ref => Number.isSafeInteger(ref) && ref > 0 && ref !== record.ref && memory.read(ref)?.active);
}
function originalSpan(record) {
  const message = memory.store.getMessage(record.messageId), totalChars = cpLength(message.text);
  return { ref: record.ref, messageId: record.messageId, sourceRole: 'user', sourceSeq: message.seq, eventSeq: message.metadata?.seq,
    start: record.start, end: record.end, totalChars, partial: record.start !== 0 || record.end !== totalChars,
    nextStart: record.end < totalChars ? record.end : null, text: record.text };
}
function preferExistingUserGroups(originals, candidates, maxChars) {
  const groups = new Map();
  for (const record of candidates) {
    if (record.sourceRole !== 'user' || !hasLinkedBackground(record) || groups.has(record.messageId)) continue;
    if (originals.some(source => source.messageId === record.messageId && source.original?.continuationAnchor)) continue;
    if (!originals.some(source => source.messageId === record.messageId && source.start < record.end && source.end > record.start)) continue;
    const background = [...new Set(record.scope?.indexingBackgroundRefs ?? [])].filter(ref => ref !== record.ref).map(ref => memory.read(ref)).filter(source => source?.active);
    // Only replace duplicated excerpts with an existing all-user original
    // causal unit. Assistant/tool background never gets this source priority.
    if (!background.length || background.some(source => memory.store.getMessage(source.messageId).role !== 'user')) continue;
    const parts = [...background, record];
    const conservativeCost = parts.reduce((sum, source) => sum + cpLength(source.text) + source.text.split('\n').length * 2 + 160, 32);
    if (conservativeCost > maxChars) continue;
    const sourcePriority = Math.max(2, ...originals.filter(source => source.messageId === record.messageId).map(source => source.userPriority ?? 1));
    groups.set(record.messageId, { ...record, priorityUser: true, userPriority: sourcePriority, originals: parts.map(originalSpan) });
  }
  const seen = new Set();
  return originals.flatMap(record => {
    if (!groups.has(record.messageId)) return [record];
    if (seen.has(record.messageId)) return [];
    seen.add(record.messageId); return [groups.get(record.messageId)];
  });
}
function compactEvidence(result, maxChars) {
  // The native tool render uses text verbatim. A hard cap applies to every label
  // and source body; overlarge whole entries are omitted, never clipped silently.
  const heading = '本会话检索证据（只读；引用需回读核对）\n';
  let text = heading;
  const refs = [];
  const omittedRefs = [];
  const wireByRef = new Map();
  const quoted = value => value.split('\n').map(line => `> ${line}`).join('\n');
  // Source priority is a packing rule, not semantic revocation: a literal
  // continuation's latest original user anchor, explicit user cues, established
  // causal units, ordinary matching user originals, then bare assistant/tools.
  const ordered = result.records.map(record => ({ record, linked: hasLinkedBackground(record) }))
    .sort((a, b) => (b.record.userPriority ?? (b.linked ? 2 : 0)) - (a.record.userPriority ?? (a.linked ? 2 : 0)))
    .map(item => item.record);
  for (const record of ordered) {
    if (refs.includes(record.ref)) continue;
    const original = record.original;
    const sourceDetails = original ? ` range=${original.start}:${original.end} totalChars=${original.totalChars} partial=${original.partial}${original.partial ? '（仅片段，不能声称已提供该用户说明的全部限制；memory_read start=0 可核对全文）' : ''}${original.continuationAnchor ? ' continuationAnchor=true（最近一条非续做用户原文；只读衔接，不推断授权或撤销）' : ''}` : '';
    const header = `[${record.ref}] ${record.kind} role=${record.sourceRole ?? 'unknown'} sourceSeq=${record.sourceSeq}${sourceDetails}\n`;
    const body = quoted(record.text);
    const part = `${header}${body}\n`;
    const dependencies = [...new Set(record.scope?.indexingBackgroundRefs ?? [])].filter(ref => Number.isSafeInteger(ref) && ref > 0 && !refs.includes(ref))
      .map(ref => memory.read(ref)).filter(source => source?.active && source.ref !== record.ref);
    const backgroundParts = dependencies.map(source => {
      const original = memory.store.getMessage(source.messageId);
      return { ref: source.ref, text: `[${source.ref}] 上一段原文背景 for=[${record.ref}] role=${original.role} sourceSeq=${original.seq}（只读理解背景，不是当前正文的新断言）\n${quoted(source.text)}\n` };
    });
    const background = backgroundParts.map(part => part.text).join('');
    // A causal excerpt and its required prior-original background are one
    // packing unit. Never silently show the pronoun without its stored source.
    if (cpLength(text) + cpLength(background) + cpLength(part) > maxChars) { omittedRefs.push(record.ref); continue; }
    text += background + part;
    for (const source of backgroundParts) wireByRef.set(source.ref, source.text);
    wireByRef.set(record.ref, part);
    refs.push(...dependencies.map(source => source.ref));
    refs.push(record.ref);
  }
  const requiredUserOriginals = [...new Map(ordered.filter(record => record.priorityUser && refs.includes(record.ref))
    .flatMap(record => record.originals ?? [record.original]).map(original => [original.ref, { ...original, wireText: wireByRef.get(original.ref) }])).values()];
  const omittedUserOriginalRefs = ordered.filter(record => record.priorityUser && !refs.includes(record.ref)).map(record => record.ref);
  const providedUserMessages = new Set(requiredUserOriginals.map(original => original.messageId));
  // The source-candidate limit can hide matching messages before packing, so
  // omittedRefs alone cannot establish complete original-user coverage.
  const missingMatchingUserMessages = Math.max(0, (result.matchingUserMessages ?? 0) - providedUserMessages.size);
  const userOriginalCoverageIncomplete = omittedUserOriginalRefs.length > 0
    || requiredUserOriginals.some(original => original.partial) || missingMatchingUserMessages > 0;
  const unreadRefs = [...new Set(omittedRefs)].filter(ref => !refs.includes(ref));
  if (!refs.length) text = unreadRefs.length
    ? '本次命中证据的正文未装入预算；以下仅供定位，请 memory_read 回读，不能视为已读或查全。\n'
    : '本会话记忆：本次查询未命中可提供证据；不能据此声称全库或任务约束已查全。';
  if (userOriginalCoverageIncomplete) {
    const notice = `用户原文覆盖不完整：本次仅提供预算内片段；行动前请按相关 [n] 回读缺失条件，不得把片段或助手转述当作用户完整说明。\n`;
    if (cpLength(text) + cpLength(notice) <= maxChars) text += notice;
  }
  // Only currently omitted matched sources receive locators. This footer never
  // reserves space by removing a whole original or causal unit that already
  // fitted. A ref locator is not a provided quote and must be read before use.
  const locatorRefs = [];
  const locatorHeading = '正文未装入，仅定位（不等于已读；请 memory_read）：\n';
  let footer = '';
  const footerChars = Math.min(384, Math.max(0, maxChars - cpLength(text)));
  for (const ref of unreadRefs) {
    const source = memory.read(ref);
    if (!source) continue;
    const message = memory.store.getMessage(source.messageId);
    const line = `memory_read ref=${ref} role=${message.role} sourceSeq=${message.seq} range=${source.start}:${source.end}\n`;
    const next = (footer ? footer : locatorHeading) + line;
    if (cpLength(next) > footerChars) continue;
    footer = next; locatorRefs.push(ref);
  }
  text += footer;
  if (unreadRefs.length && !footer) {
    // A shorter fixed heading can disclose omission without touching any
    // already-provided source header or exact wire quote.
    const omittedHeading = '命中正文有省略，不能视为无命中或查全。\n';
    if (text.startsWith(heading)) text = omittedHeading + text.slice(heading.length);
  }
  if (cpLength(text) > maxChars) text = unreadRefs.length
    ? ['命中正文已省略，不能视为无命中或查全。', '命中正文省略。', '有省略。', '略'].find(value => cpLength(value) <= maxChars) ?? ''
    : '';
  const providedSources = [...new Set(refs)].map(ref => {
    const source = memory.read(ref), message = memory.store.getMessage(source.messageId);
    return { ref, eventSeq: message.metadata?.seq, start: source.start, end: source.end,
      sha256: createHash('sha256').update(source.text).digest('hex') };
  });
  return { text, refs: [...new Set(refs)], providedSources, omittedRefs: unreadRefs, locatorRefs, chars: cpLength(text), retrievalStatus: result.status, candidateCount: result.candidateRefs.length,
    requiredUserOriginals, omittedUserOriginalRefs, missingMatchingUserMessages, userOriginalCoverageIncomplete };
}
async function handle(op, args, signal) {
  signal.throwIfAborted();
  if (disposed) throw Object.assign(new Error('Memory worker is closed'), { code: 'CLOSED' });
  switch (op) {
    case 'archive': {
      for (const record of args.records) {
        signal.throwIfAborted();
        const message = memory.append({ sourceKey: `dsh:${memory.conversationId}:${record.seq}`, role: record.role, text: record.text,
          createdAt: record.createdAt, metadata: { ...record.metadata, sessionId: memory.conversationId } });
        if (message.role === 'user') {
          userEvidence.add(message);
          if (!state.userMessageIds.includes(message.id)) state.userMessageIds.push(message.id);
        }
        state.userIndexThroughSeq = Math.max(state.userIndexThroughSeq ?? 0, message.seq);
      }
      state.archivedThroughSeq = Math.max(state.archivedThroughSeq, args.lastSeq);
      state.lastErrorCode = null;
      saveState();
      return { appended: args.records.length, ...health() };
    }
    case 'search': {
      const started = performance.now();
      const queries = searchQueries(args.query);
      const batch = await collectQueries({ queries, signal, deadlineAt: args.deadlineAt,
        lookup: query => memory.recall({ query, limit: args.limit, useModel: false, signal }) });
      const candidates = batch.candidates;
      for (const [ref, { record }] of candidates) {
        // A correction can arrive while the bounded query plan yields. Validate
        // against the canonical store again before packing or future ES reuse.
        const source = memory.read(ref);
        if (!source?.active || source.text !== record.text
          || args.excludeSourceSeq !== undefined && memory.store.getMessage(record.messageId).metadata?.seq === args.excludeSourceSeq) candidates.delete(ref);
      }
      const originalUsers = userEvidence.select({ query: args.query, excludeSourceSeq: args.excludeSourceSeq, limit: args.limit, maxChars: args.maxChars,
        continuation: args.continuation === true });
      const preferredUsers = preferExistingUserGroups(originalUsers.records, [...candidates.values()].map(item => item.record), args.maxChars);
      const userRefs = new Set(preferredUsers.map(record => record.ref));
      const records = [...candidates.values()].filter(item => !userRefs.has(item.record.ref))
        .filter(item => !originalUsers.scopedQuery || !originalUsers.scopedMessageIds.length || item.record.sourceRole !== 'user' || originalUsers.scopedMessageIds.includes(item.record.messageId))
        .map(item => ({ ...item, linked: hasLinkedBackground(item.record) }))
        .sort((a, b) => Number(b.linked) - Number(a.linked) || b.hits - a.hits || b.record.sourceSeq - a.record.sourceSeq)
        .slice(0, args.limit).map(item => item.record);
      const incomplete = batch.incomplete || Date.now() >= args.deadlineAt;
      const notice = incomplete ? incompleteNotice(args.maxChars) : '';
      const packed = compactEvidence({ records: [...preferredUsers, ...records], status: incomplete ? 'deadline-partial' : queries.length > 1 ? 'local-multiquery' : 'local',
        candidateRefs: [...new Set([...userRefs, ...candidates.keys()])], matchingUserMessages: originalUsers.matchingMessages }, args.maxChars - cpLength(notice));
      const text = notice + (incomplete && !packed.refs.length && !packed.omittedRefs.length ? '' : packed.text);
      return { ...packed, text, chars: cpLength(text), searchIncomplete: incomplete,
        userOriginalCoverageIncomplete: incomplete || packed.userOriginalCoverageIncomplete,
        queryCount: batch.queryCount, plannedQueryCount: batch.plannedQueryCount, workerSearchMs: performance.now() - started,
        matchingUserMessages: originalUsers.matchingMessages, userGenericFallback: originalUsers.genericFallback };
    }
    case 'read': {
      const result = memory.readSource(args.ref, { ...(args.start === undefined ? {} : { start: args.start }), maxChars: args.maxChars });
      if (!result) return { found: false, ref: args.ref, text: `未找到本会话引用 [${args.ref}]。`, chars: 0 };
      const header = `[${result.ref}] original source=${result.sourceSeq ?? result.messageId} range=${result.start}:${result.end}; requested=[${args.ref}]\n`;
      // Reserve all header and continuation metadata inside requested result budget.
      const footer = `\nnextStart=${result.nextStart ?? 'null'}; hasMore=${result.hasMore}; totalChars=${result.totalChars}`;
      const overhead = cpLength(header) + cpLength(footer);
      const available = Math.max(1, args.maxChars - Math.max(overhead, 256));
      if (cpLength(result.text) > available) {
        const exact = memory.readSource(args.ref, { start: result.start, maxChars: available });
        const nextHeader = `[${exact.ref}] original source=${exact.sourceSeq ?? exact.messageId} range=${exact.start}:${exact.end}; requested=[${args.ref}]\n`;
        const nextFooter = `\nnextStart=${exact.nextStart ?? 'null'}; hasMore=${exact.hasMore}; totalChars=${exact.totalChars}`;
        const text = `${nextHeader}${exact.text}${nextFooter}`;
        // Numeric width may add a few characters after reciting. The wire bound
        // is checked, so callers never receive a false budget assertion.
        if (cpLength(text) > args.maxChars) throw Object.assign(new Error('Read result exceeds requested budget'), { code: 'READ_BUDGET' });
        return { found: true, ref: exact.ref, requestedRef: args.ref, start: exact.start, nextStart: exact.nextStart,
          hasMore: exact.hasMore, totalChars: exact.totalChars, text, chars: cpLength(text) };
      }
      const text = `${header}${result.text}${footer}`;
      return { found: true, ref: result.ref, requestedRef: args.ref, start: result.start, nextStart: result.nextStart,
        hasMore: result.hasMore, totalChars: result.totalChars, text, chars: cpLength(text) };
    }
    case 'index': {
      if (indexing) throw Object.assign(new Error('A bounded index batch is already running'), { code: 'INDEX_BUSY' });
      indexing = true;
      try {
        let messages;
        let queryCount = 0;
        let targetedMatches;
        let alreadyIndexed;
        const complete = new Set(state.completedMessages);
        if (args.query) {
          // A combined query uses FTS AND semantics and can match nothing even
          // when its concrete identifiers occur in separate source messages.
          // Use the same bounded local query plan as search, without falling
          // back to indexing unrelated conversation history on zero matches.
          const candidates = new Map();
          for (const query of searchQueries(args.query)) {
            signal.throwIfAborted();
            const result = await memory.recall({ query, limit: 20, useModel: false, signal });
            const weight = queryCount++ === 0 ? 3 : 1;
            for (const id of new Set(result.records.map(record => record.messageId))) {
              const current = candidates.get(id);
              if (current) current.hits += weight;
              else candidates.set(id, { message: memory.store.getMessage(id), hits: weight });
            }
          }
          const matched = [...candidates.values()].sort((a, b) => b.hits - a.hits || b.message.seq - a.message.seq)
            .map(item => item.message);
          targetedMatches = matched.length;
          alreadyIndexed = matched.filter(message => complete.has(message.id)).length;
          messages = matched.filter(message => !complete.has(message.id));
        } else {
          // Message sequence is monotonic. Never discard a failed chunk merely
          // because a later batch succeeded, and never reinterpret model errors.
          messages = [];
          let afterSeq = 0;
          while (messages.length < args.maxCalls) {
            const batch = memory.store.listMessages({ afterSeq, limit: 100 });
            if (!batch.length) break;
            messages.push(...batch.filter(message => !complete.has(message.id)));
            afterSeq = batch.at(-1).seq;
          }
          targetedMatches = memory.stats().messages;
          alreadyIndexed = complete.size;
        }
        const report = { calls: 0, added: [], existing: [], rejected: [], pending: [], sourceRefs: [], coverage: [], backgrounds: [] };
        for (const message of messages) {
          if (report.calls >= args.maxCalls) break;
          signal.throwIfAborted();
          const part = await memory.indexMessages({ messageIds: [message.id], startOffsets: { [message.id]: state.indexOffsets[message.id] ?? 0 },
            maxCalls: args.maxCalls - report.calls, maxChunkChars: 4000, maxBackgroundChars: 1024, signal });
          report.calls += part.calls;
          for (const key of ['added', 'existing', 'rejected', 'pending', 'sourceRefs', 'coverage', 'backgrounds']) if (Array.isArray(part[key])) report[key].push(...part[key]);
          if (part.pending.length) state.indexOffsets[message.id] = Math.min(...part.pending.map(span => span.start));
          else { delete state.indexOffsets[message.id]; if (!state.completedMessages.includes(message.id)) state.completedMessages.push(message.id); }
          state.lastErrorCode = part.rejected.length ? 'INDEX_PARTIAL' : null;
          saveState();
        }
        const noMatches = Boolean(args.query) && targetedMatches === 0;
        // pending describes spans in started messages only. A batch can consume
        // maxCalls before it even starts another matched message, so report the
        // remaining message count explicitly rather than implying completion.
        const remainingTargeted = args.query
          ? messages.filter(message => !state.completedMessages.includes(message.id)).length
          : Math.max(0, memory.stats().messages - state.completedMessages.length);
        indexing = false;
        return { ...report, indexScope: args.query ? 'query' : 'conversation', queryCount,
          targetedMatches, alreadyIndexed, remainingTargeted, noMatches,
          incomplete: noMatches || remainingTargeted > 0, status: health() };
      } finally { indexing = false; }
    }
    case 'status': return health();
    default: throw Object.assign(new Error('Unknown memory worker operation'), { code: 'INVALID_OPERATION' });
  }
}

parentPort.on('message', message => {
  if (message.type === 'model-result') {
    const pending = modelCalls.get(message.id);
    if (!pending) return;
    modelCalls.delete(message.id); pending.cleanup();
    if (message.error) pending.reject(Object.assign(new Error('Memory model request failed'), { code: message.error }));
    else pending.resolve(message.result);
    return;
  }
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(Object.assign(new Error('Memory operation cancelled'), { code: 'ABORTED' })); return; }
  if (message.type === 'close') {
    disposed = true;
    for (const controller of controllers.values()) controller.abort(Object.assign(new Error('Memory worker disposed'), { code: 'CLOSED' }));
    Promise.allSettled([...controllers.values()].map(controller => controller.done)).then(() => { memory.close(); parentPort.close(); });
    return;
  }
  if (message.type !== 'request') return;
  const controller = new AbortController();
  controllers.set(message.id, controller);
  controller.done = handle(message.op, message.args, controller.signal).then(result => parentPort.postMessage({ type: 'result', id: message.id, result }), error => {
    state.lastErrorCode = safeCode(error);
    const causeCode = state.lastErrorCode;
    let stateErrorCode = null;
    try { saveState(); } catch (saveError) { stateErrorCode = safeCode(saveError); state.lastErrorCode = 'STATE_WRITE_FAILED'; }
    parentPort.postMessage({ type: 'result', id: message.id, error: state.lastErrorCode,
      diagnostic: { operation: message.op, causeCode, stateErrorCode } });
  }).finally(() => controllers.delete(message.id));
});
parentPort.postMessage({ type: 'ready', status: health() });
