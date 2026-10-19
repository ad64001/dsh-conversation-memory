import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NAME, BRIDGE_INSTRUCTION, assertAgent, positive, projectEvents, currentUserMessage, queryFrom, queryKey, cpLength, safeCode } from './protocol.mjs';
import { planMemoryDedup, DEDUP_LIMITS } from './model-dedup.mjs';
import { memorySurface, commitMemorySurface, evidenceBody } from './runtime-memory.mjs';
import { isContinuationPrompt } from './user-evidence.mjs';
import { restoreApprovedPackage } from './approved-package.mjs';
import { canonicalMemoryPacket, snapshotEvidence } from './dedup-status.mjs';

const failure = code => Object.assign(new Error(`Conversation memory: ${code}`), { code });
const aborted = signal => { if (signal?.aborted) throw signal.reason ?? failure('ABORTED'); };
export function evidenceAlreadyVisible(result, events, nodes) {
  if (!result.refs?.length || result.userOriginalCoverageIncomplete || result.omittedRefs?.length
    || result.providedSources?.length !== new Set(result.refs).size) return false;
  const visible = new Set(nodes), originals = new Map(projectEvents(events).records.map(record => [record.seq, record.text]));
  const refs = new Set();
  return result.providedSources.every(source => {
    if (!result.refs.includes(source.ref) || refs.has(source.ref) || !visible.has(source.eventSeq)
      || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0 || source.end <= source.start) return false;
    refs.add(source.ref);
    const text = originals.get(source.eventSeq);
    if (text === undefined) return false;
    const points = Array.from(text);
    return source.end <= points.length && createHash('sha256').update(points.slice(source.start, source.end).join('')).digest('hex') === source.sha256;
  });
}
function abortable(promise, signal) {
  aborted(signal);
  return new Promise((resolveResult, reject) => {
    const onAbort = () => reject(signal.reason ?? failure('ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolveResult, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function settings(input = {}) {
  const allowed = ['rootDir', 'contextChars', 'maxWorkers', 'rpcTimeoutMs', 'autoRecallTimeoutMs', 'cachePolicy'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError('Invalid conversation memory configuration');
  const config = { rootDir: join(homedir(), '.dsh', 'conversation-memory'), contextChars: 6000, maxWorkers: 8, rpcTimeoutMs: 250000, autoRecallTimeoutMs: 2000, cachePolicy: 'stable-prefix', ...input };
  if (!['stable-prefix', 'legacy'].includes(config.cachePolicy)) throw new TypeError('Invalid memory cachePolicy');
  if (typeof config.rootDir !== 'string' || !config.rootDir.trim()) throw new TypeError('rootDir is required');
  config.rootDir = resolve(config.rootDir);
  positive(config.contextChars, 'contextChars', 8192);
  if (config.contextChars < 3000) throw new RangeError('contextChars must leave room for memory usage instructions');
  positive(config.maxWorkers, 'maxWorkers', 32);
  positive(config.rpcTimeoutMs, 'rpcTimeoutMs', 300000);
  positive(config.autoRecallTimeoutMs, 'autoRecallTimeoutMs', 10000);
  return config;
}

/** No API in this bridge accepts a caller-selected conversation ID. A real
 * agent/session pair is captured before each asynchronous operation and checked
 * again before results can reach that agent's context. SQLite stays in workers. */
export class ConversationMemoryBridge {
  constructor(ctx, input = {}, dependencies = {}) {
    this.ctx = ctx;
    this.config = settings(input);
    this.entries = new Map();
    this.concludedTurns = new WeakMap();
    this.scheduled = new Set();
    this.ensureChain = Promise.resolve();
    this.disposed = false;
    this.workerFactory = dependencies.workerFactory ?? ((url, options) => new Worker(url, options));
    this.libraryUrl = dependencies.libraryUrl ?? new URL('../library/lib/index.mjs', import.meta.url).href;
    this.makeModel = dependencies.makeModel;
    this.instructions = `${dependencies.workingPrompt ?? ''}\n${BRIDGE_INSTRUCTION}`.trim();
    if (cpLength(this.instructions) + 256 >= this.config.contextChars) throw new RangeError('Memory instructions exceed context budget');
    // Reserve bounded transport/status headroom; the public provider cap remains
    // unchanged. Model decisions still select the semantic evidence.
    this.evidenceChars = this.config.contextChars - cpLength(this.instructions) - 256;
  }
  warn(code) { this.ctx.logger?.warn?.(`${NAME}: ${code}; memory_status reports progress, raw session logs remain available`); }
  ensure(agent) {
    // Capacity eviction can await worker exit. Serialize admission before that
    // await, so concurrent calls cannot create two workers for the same DB or
    // lose a worker by overwriting its entry. Existing SQLite operations remain
    // concurrent; this queue only covers admission and readiness.
    const result = this.ensureChain.then(() => this.ensureLocked(agent));
    this.ensureChain = result.catch(() => {});
    return result;
  }
  async ensureLocked(agent) {
    const id = assertAgent(agent);
    if (this.disposed) throw failure('CLOSED');
    let entry = this.entries.get(id);
    if (entry) {
      if (entry.closed || entry.session !== agent.session) {
        await this.closeEntry(entry);
        this.entries.delete(id);
        entry = undefined;
      } else { entry.agent = agent; entry.lastUsed = Date.now(); return entry.ready.then(() => entry); }
    }
    if (this.entries.size >= this.config.maxWorkers) {
      const idle = [...this.entries.values()].filter(item => !item.pending.size && !item.modelControllers.size && !item.archiving).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw failure('WORKER_LIMIT');
      this.entries.delete(idle.id);
      await this.closeEntry(idle);
    }
    if (this.disposed) throw failure('CLOSED');
    assertAgent(agent, id);
    const worker = this.workerFactory(new URL('./worker.mjs', import.meta.url), { workerData: {
      rootDir: this.config.rootDir, conversationId: id, contextChars: this.config.contextChars, libraryUrl: this.libraryUrl,
    } });
    entry = { id, agent, session: agent.session, worker, pending: new Map(), modelControllers: new Map(), nextId: 0,
      lastUsed: Date.now(), cache: '', cacheVersion: 0, health: null, lastErrorCode: null, closed: false, archiveChain: Promise.resolve() };
    entry.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(failure('WORKER_START_TIMEOUT')), 10000);
      timer.unref?.();
      entry.resolveReady = status => { clearTimeout(timer); entry.health = status; worker.unref?.(); resolveReady(); };
      entry.rejectReady = error => { clearTimeout(timer); rejectReady(error); };
    });
    // Ready may fail before a caller awaits it; keep the actual failure visible
    // through ensure/status while avoiding an unhandled-rejection process crash.
    entry.ready.catch(() => {});
    worker.on('message', message => this.onMessage(entry, message));
    worker.on('error', () => this.failEntry(entry, 'WORKER_FAILED'));
    worker.on('exit', code => { if (!entry.closed) this.failEntry(entry, code ? 'WORKER_EXIT' : 'WORKER_CLOSED'); });
    this.entries.set(id, entry);
    await entry.ready;
    if (entry.closed || this.disposed) throw failure('CLOSED');
    return entry;
  }
  async onMessage(entry, message) {
    if (message.type === 'ready') { entry.resolveReady(message.status); return; }
    if (message.type === 'result') {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      entry.pending.delete(message.id); pending.cleanup();
      if (message.error) { entry.lastErrorCode = message.error; pending.reject(failure(message.error)); }
      else { entry.lastErrorCode = null; if (message.result?.archivedThroughSeq !== undefined) entry.health = message.result; pending.resolve(message.result); }
      return;
    }
    if (message.type === 'model-cancel') { entry.modelControllers.get(message.id)?.abort(failure('ABORTED')); return; }
    if (message.type !== 'model') return;
    const controller = new AbortController();
    entry.modelControllers.set(message.id, controller);
    try {
      if (!this.makeModel || entry.closed) throw failure('MODEL_UNAVAILABLE');
      assertAgent(entry.agent, entry.id);
      if (entry.agent.session !== entry.session) throw failure('SESSION_MISMATCH');
      const model = this.makeModel(entry.agent);
      const result = await model({ ...message.request, signal: controller.signal });
      assertAgent(entry.agent, entry.id);
      if (!entry.closed) entry.worker.postMessage({ type: 'model-result', id: message.id, result });
    } catch (error) {
      const code = safeCode(error);
      entry.lastErrorCode = code;
      if (!entry.closed) entry.worker.postMessage({ type: 'model-result', id: message.id, error: code });
    } finally { entry.modelControllers.delete(message.id); }
  }
  failEntry(entry, code) {
    entry.lastErrorCode = code; entry.cache = ''; entry.closed = true;
    entry.rejectReady(failure(code));
    for (const pending of entry.pending.values()) { pending.cleanup(); pending.reject(failure(code)); }
    entry.pending.clear();
    for (const controller of entry.modelControllers.values()) controller.abort(failure(code));
    this.warn(code);
  }
  rpc(entry, op, args = {}, signal, timeoutMs = this.config.rpcTimeoutMs) {
    aborted(signal);
    if (entry.closed || this.disposed) throw failure('CLOSED');
    assertAgent(entry.agent, entry.id);
    if (entry.agent.session !== entry.session) throw failure('SESSION_MISMATCH');
    const id = ++entry.nextId;
    entry.worker.ref?.();
    return new Promise((resolveResult, reject) => {
      const cancel = code => {
        const pending = entry.pending.get(id);
        if (!pending) return;
        entry.pending.delete(id); pending.cleanup(); entry.worker.postMessage({ type: 'cancel', id }); reject(failure(code));
      };
      const onAbort = () => cancel('ABORTED');
      const timer = setTimeout(() => cancel('MEMORY_TIMEOUT'), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (!entry.pending.size && !entry.modelControllers.size) entry.worker.unref?.(); };
      entry.pending.set(id, { cleanup, reject, resolve: result => {
        try { aborted(signal); assertAgent(entry.agent, entry.id); if (entry.agent.session !== entry.session) throw failure('SESSION_MISMATCH'); resolveResult(result); }
        catch (error) { reject(error); }
      } });
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.worker.postMessage({ type: 'request', id, op, args });
    });
  }
  async snapshot(agent, expected) {
    const id = assertAgent(agent, expected);
    // Raw snapshot, never projected surface. Reading a snapshot does not append
    // to the session or enter an agent request loop.
    const snapshot = await agent.session.snapshotEvents();
    assertAgent(agent, id);
    return Array.from(snapshot);
  }
  async flush(agent, { signal } = {}) {
    const entry = await this.ensure(agent);
    const work = async () => {
      aborted(signal);
      entry.archiving = true;
      try {
        const events = await this.snapshot(agent, entry.id);
        const status = await this.rpc(entry, 'status', {}, signal);
        const projected = projectEvents(events, status.archivedThroughSeq);
        // Batch records to avoid cloning a complete long conversation at once.
        for (let start = 0; start < projected.records.length; start += 32) {
          const batch = projected.records.slice(start, start + 32);
          await this.rpc(entry, 'archive', { records: batch, lastSeq: batch.at(-1).seq }, signal);
        }
        return await this.rpc(entry, 'archive', { records: [], lastSeq: projected.lastSeq }, signal);
      } finally { entry.archiving = false; }
    };
    const result = entry.archiveChain.then(work);
    entry.archiveChain = result.catch(error => { entry.lastErrorCode = safeCode(error); });
    return result;
  }
  enqueue(agent) {
    if (this.disposed) return;
    const id = assertAgent(agent);
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    // This observer returns immediately. No model call, append or awaited work
    // runs under session/event's publication/re-entry guard.
    queueMicrotask(() => {
      this.flush(agent).catch(error => this.warn(safeCode(error))).finally(() => {
        this.scheduled.delete(id);
        // A source can arrive after snapshot() while the earlier flush is in
        // flight. Check seq rather than dropping that final notification.
        const entry = this.entries.get(id);
        if (entry && !entry.closed && entry.session === agent.session && Number.isSafeInteger(agent.session.seq) && agent.session.seq - 1 > (entry.health?.archivedThroughSeq ?? -1)) this.enqueue(agent);
      });
    });
  }
  async search(agent, { query, limit = 6, maxChars = 6000, signal, excludeSourceSeq, continuation = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || cpLength(query) > 2000) throw failure('INVALID_QUERY');
    positive(limit, 'limit', 8); positive(maxChars, 'maxChars', 6000);
    await this.flush(agent, { signal });
    return this.rpc(await this.ensure(agent), 'search', { query, limit, maxChars, excludeSourceSeq, continuation }, signal);
  }
  async read(agent, { ref, start, maxChars = 4000, signal } = {}) {
    positive(ref, 'ref', Number.MAX_SAFE_INTEGER); positive(maxChars, 'maxChars', 4000);
    if (maxChars < 256 || (start !== undefined && (!Number.isSafeInteger(start) || start < 0))) throw failure('INVALID_ARGUMENT');
    return this.rpc(await this.ensure(agent), 'read', { ref, start, maxChars }, signal);
  }
  async index(agent, { maxCalls = 2, query, signal } = {}) {
    positive(maxCalls, 'maxCalls', 4);
    if (query !== undefined && (typeof query !== 'string' || !query.trim() || cpLength(query) > 2000)) throw failure('INVALID_QUERY');
    await this.flush(agent, { signal });
    return this.rpc(await this.ensure(agent), 'index', { maxCalls, query }, signal);
  }
  async status(agent, { signal } = {}) {
    const entry = await this.ensure(agent);
    const status = await this.rpc(entry, 'status', {}, signal);
    return { ...status, cachePolicy: this.config.cachePolicy, autoRecallCadence: this.config.cachePolicy === 'stable-prefix' ? 'turn-or-compaction' : 'step', autoRecallStatus: entry.autoRecallStatus ?? 'not-yet-needed', cacheChars: cpLength(this.contextFor(agent)), cacheEvidenceChars: cpLength(entry.cache),
      lastQueryKey: entry.lastQueryKey ?? null, lastErrorCode: entry.lastErrorCode ?? status.lastErrorCode,
      dedup: entry.dedup ?? { state: 'not-yet-needed', modelDecides: true },
      requiredUserOriginals: (entry.requiredUserOriginals ?? []).map(({ text, wireText, ...meta }) => meta),
      userOriginalCoverageIncomplete: entry.userOriginalCoverageIncomplete ?? false };
  }
  contextFor(agent) {
    if (!agent?.session?.id || this.disposed) return '';
    const entry = this.entries.get(agent.session.id);
    if (entry?.dedupSuppressed) return entry.safeFallbackPackage?.text
      ?? `本会话记忆整理未完成（${entry.dedup?.code ?? entry.lastErrorCode ?? 'MEMORY_UNAVAILABLE'}）：原文仍在会话库，当前没有已验证的新记忆包，不能声称查全。可用 memory_status 检查并按引用回读；下步重试。`;
    const evidence = entry?.session === agent.session ? entry.cache : '';
    const status = entry?.lastErrorCode ? `\n记忆库状态：${entry.lastErrorCode}；不能声称已查全，可用 memory_status 检查。` : '';
    // Evidence contains exact source units, including original/renderer ending
    // newlines. Trim only the fixed policy when constructed, never this packet.
    const text = `${this.instructions}${evidence ? '\n' + evidence : ''}${status}`;
    if (cpLength(text) > this.config.contextChars) throw new Error('Memory context budget invariant violated');
    return text;
  }
  async refresh(agent, { query, signal, currentUser, omitVisible = false } = {}) {
    const entry = await this.ensure(agent);
    const version = ++entry.cacheVersion;
    entry.cache = '';
    try {
      const events = await this.snapshot(agent, entry.id);
      const claimedUser = currentUserMessage([currentUser]);
      const retrievalUser = claimedUser ?? [...events].reverse().find(event => event.type === 'user/message'
        && (!event.data?.source?.kind || event.data.source.kind === 'user'))?.data;
      // An old error remains useful evidence but cannot redefine whether the
      // human just asked to continue. Anchor from original user text first.
      const continuation = query === undefined && isContinuationPrompt((retrievalUser?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(''));
      const selectedQuery = query ?? queryFrom(events, 640, claimedUser);
      if (!selectedQuery.trim()) return { text: '', refs: [], chars: 0, retrievalStatus: 'empty-query' };
      const key = queryKey(selectedQuery);
      // A new turn's claimed input is still in the inbox at this boundary. Do
      // not mistake the preceding user correction for that input and exclude
      // it. An already-admitted current message is identified only by its id,
      // never by matching text that an earlier user may have repeated.
      const currentUserSeq = claimedUser
        ? typeof claimedUser.id === 'string' && claimedUser.id
          ? [...events].reverse().find(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.id === claimedUser.id)?.seq
          : undefined
        : [...events].reverse().find(event => event.type === 'user/message' && (!event.data?.source?.kind || event.data.source.kind === 'user'))?.seq;
      const result = await this.search(agent, { query: selectedQuery, limit: 6, maxChars: this.evidenceChars, signal, continuation,
        ...(query === undefined && currentUserSeq !== undefined ? { excludeSourceSeq: currentUserSeq } : {}) });
      assertAgent(agent, entry.id);
      if (entry.session !== agent.session || version !== entry.cacheVersion || signal?.aborted || entry.closed) throw failure('STALE_RETRIEVAL');
      // Diagnostic query identity must not create a new native runtime-context
      // snapshot when different wording retrieves identical evidence.
      entry.lastQueryKey = key;
      // Exact source identities and code-point hashes prove the originals are
      // already on the active surface. Avoid appending copies of them on each
      // new turn. Explicit searches keep their complete read-back contract.
      const noMatches = result.refs?.length === 0 && !result.omittedRefs?.length && !result.userOriginalCoverageIncomplete;
      if (omitVisible && (noMatches || evidenceAlreadyVisible(result, events, agent.session.surface.nodes))) {
        entry.cache = ''; entry.requiredUserOriginals = []; entry.userOriginalCoverageIncomplete = false;
        entry.coverageNotice = ''; entry.lastErrorCode = null; entry.autoRecallStatus = result.refs.length ? 'already-visible' : 'no-match';
        return result;
      }
      entry.autoRecallStatus = 'provided';
      entry.cache = `本步历史召回（仅按需证据）\n${result.text}`;
      entry.requiredUserOriginals = result.requiredUserOriginals ?? [];
      entry.userOriginalCoverageIncomplete = result.userOriginalCoverageIncomplete ?? false;
      entry.coverageNotice = '';
      if (entry.userOriginalCoverageIncomplete) {
        entry.coverageNotice = result.text.match(/^用户原文覆盖不完整[^\n]*/mu)?.[0]
          ?? '用户原文覆盖不完整：行动前按相关引用回读缺失条件；不能把片段或助手转述当作完整用户说明。';
        if (!entry.cache.includes(entry.coverageNotice)) entry.cache += '\n' + entry.coverageNotice;
      }
      entry.lastErrorCode = null;
      if (cpLength(this.contextFor(agent)) > this.config.contextChars) throw failure('CONTEXT_BUDGET');
      return result;
    } catch (error) {
      if (version === entry.cacheVersion) { entry.cache = ''; entry.lastErrorCode = safeCode(error); }
      throw error;
    }
  }
  async preStep(payload, next) {
    // Native Session supplies a replayable surface; minimal adapter/mocked agents
    // keep their existing after-next refresh contract.
    if (payload.agent?.session?.surface && typeof payload.agent.session.append === 'function') return this.config.cachePolicy === 'stable-prefix'
      ? this.preStepStablePrefix(payload, next) : this.preStepWithModelDedup(payload, next);
    const decision = await next();
    if (decision?.kind === 'reject' || payload.signal?.aborted || this.disposed) {
      const entry = this.entries.get(payload.agent?.session?.id); if (entry) { entry.cacheVersion++; entry.cache = ''; }
      return decision;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(failure('ABORTED'));
    payload.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('MEMORY_TIMEOUT')), this.config.autoRecallTimeoutMs);
    const currentUser = currentUserMessage([...(Array.isArray(payload.messages) ? payload.messages : []),
      ...(Array.isArray(decision?.messages) ? decision.messages : [])]);
    try { await abortable(this.refresh(payload.agent, { signal: controller.signal, currentUser }), controller.signal); }
    catch (error) { if (!payload.signal?.aborted) this.warn(safeCode(error)); }
    finally { clearTimeout(timer); payload.signal?.removeEventListener('abort', onAbort); }
    // Neither a memory failure nor a successful lookup changes native admission,
    // compaction decisions, retry counts, tools or the user's stopping budget.
    return decision;
  }
  async refreshBounded(agent, currentUser, signal, omitVisible = false) {
    const controller = new AbortController();
    const abort = () => controller.abort(failure('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('MEMORY_TIMEOUT')), this.config.autoRecallTimeoutMs);
    try { return await abortable(this.refresh(agent, { currentUser, signal: controller.signal, omitVisible }), controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async consolidate(agent, currentUser, signal) {
    const entry = await this.ensure(agent);
    const view = await memorySurface(agent.session);
    if (!view.slots.length) { entry.dedupSuppressed = false; entry.approvedCanonical = null; return; }
    const route = agent.session.requestHeader()?.config ?? agent.options;
    const model = this.makeModel?.(agent);
    if (!model) throw failure('MEMORY_DEDUP_MODEL_UNAVAILABLE');
    // Rehydrate only the identical whole packet already approved by this route's
    // model and proven against immutable native replacement events. This makes
    // no new keep/retire decision and never claims coverage of today's evidence.
    if (!entry.lastApprovedPackage) {
      const originalSession = agent.session;
      const restored = await restoreApprovedPackage({ sessionId: entry.id, route, instructions: this.instructions,
        maxChars: this.config.contextChars, rootDir: this.config.rootDir, session: originalSession, view });
      assertAgent(agent, entry.id);
      if (entry.closed || entry.session !== originalSession || agent.session !== originalSession) throw failure('MEMORY_DEDUP_STALE');
      const currentRoute = agent.session.requestHeader()?.config ?? agent.options;
      if (currentRoute.provider !== route.provider || currentRoute.model !== route.model) throw failure('MEMORY_DEDUP_ROUTE_CHANGED');
      if (restored) { entry.lastApprovedPackage = restored; entry.restoredApproval = restored.proof; }
    }
    const task = queryFrom(await this.snapshot(agent, entry.id), 640, currentUser);
    const required = (entry.requiredUserOriginals ?? []).map(source => ({ ref: source.ref, text: source.wireText }));
    if (entry.coverageNotice) required.push({ ref: 'coverage-status', text: entry.coverageNotice });
    const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(DEDUP_LIMITS.planTimeoutMs)].filter(Boolean));
    const maxChars = this.config.contextChars - cpLength(this.instructions) - 160;
    const version = entry.cacheVersion, currentText = entry.cache, originalSession = agent.session;
    const guard = () => { aborted(activeSignal); assertAgent(agent, entry.id);
      if (entry.cacheVersion !== version || entry.cache !== currentText || entry.session !== originalSession || agent.session !== originalSession || entry.closed) throw failure('MEMORY_DEDUP_STALE'); };
    const snapshots = view.slots.map(slot => ({ id: String(slot.seq), ...snapshotEvidence(slot.owned, this.instructions, entry.lastApprovedPackage) }));
    entry.dedup = { state: 'running', modelDecides: true, provider: route.provider, model: route.model,
      beforeSlots: view.slots.length, startedAt: new Date().toISOString(),
      snapshotTransport: snapshots.filter(source => source.transport).map(source => ({ sourceId: source.id, ...source.transport })),
      ...(entry.restoredApproval ? { restoredModelPlan: entry.restoredApproval } : {}) };
    const plan = await planMemoryDedup({ snapshots: snapshots.map(({ id, text }) => ({ id, text })),
      current: { id: 'current', text: currentText }, required, task, maxChars, model: async request => {
        const response = await model(request);
        if (response.traceRoute && (response.traceRoute.provider !== route.provider || response.traceRoute.model !== route.model)) throw failure('MEMORY_DEDUP_ROUTE_CHANGED');
        return response;
      }, signal: activeSignal });
    guard();
    const canonical = canonicalMemoryPacket(this.instructions, plan.canonicalText, plan.optionalCoverageIncomplete === true);
    if (cpLength(canonical) > this.config.contextChars) throw failure('MEMORY_DEDUP_OUTPUT_LIMIT');
    const committed = await commitMemorySurface(agent.session, view, canonical, { signal: activeSignal, approved: true, guard });
    // Keep provider rendering byte-identical to the approved canonical,
    // including the fixed non-source budget notice when any block was omitted.
    entry.cache = evidenceBody(canonical, this.instructions); entry.dedupSuppressed = false; entry.safeFallbackPackage = null; entry.lastErrorCode = null;
    entry.approvedCanonical = { text: canonical, provider: route.provider, model: route.model };
    entry.dedup = { ...entry.dedup, state: 'ready', completedAt: new Date().toISOString(), calls: plan.calls,
      canonicalChars: cpLength(canonical), retiredIds: plan.retiredIds, decisions: plan.decisions,
      optionalCoverageIncomplete: plan.optionalCoverageIncomplete === true,
      omittedApprovedCandidates: plan.omittedApprovedCandidates ?? [],
      sourceSelection: plan.sourceSelection, requestMetadata: plan.requestMetadata, replacements: committed.replacements };
    entry.lastApprovedPackage = { text: canonical, provider: route.provider, model: route.model,
      completedAt: entry.dedup.completedAt, variants: new Set([canonical]), evidenceText: plan.canonicalText,
      optionalCoverageIncomplete: plan.optionalCoverageIncomplete === true };
    // This ready audit keeps the earlier restoration proof; future plans now
    // depend on this fresh approval rather than repeatedly citing the old one.
    entry.restoredApproval = null;
    try { appendFileSync(join(this.config.rootDir, createHash('sha256').update(entry.id).digest('hex'), 'dedup-audit.jsonl'), JSON.stringify({ at: entry.dedup.completedAt,
      sessionId: entry.id, ...entry.dedup }) + '\n'); } catch { entry.dedup.auditStatus = 'AUDIT_UNAVAILABLE'; this.warn('AUDIT_UNAVAILABLE'); }
  }
  preserveFailedDedup(entry, error, { reuseApproved = true } = {}) {
    const code = safeCode(error), previous = entry.lastApprovedPackage, running = entry.dedup;
    entry.lastErrorCode = code; entry.dedupSuppressed = true; entry.approvedCanonical = null; entry.safeFallbackPackage = null;
    entry.dedup = { state: 'failed-preserved', modelDecides: true, code, failedAt: new Date().toISOString(),
      ...(error?.audit && running?.state === 'running' ? { startedAt: running.startedAt, provider: running.provider, model: running.model,
        beforeSlots: running.beforeSlots, snapshotTransport: running.snapshotTransport ?? [],
        ...(running.restoredModelPlan ? { restoredModelPlan: running.restoredModelPlan } : {}) } : {}),
      ...(error?.audit ? { failedModelAudit: error.audit } : {}) };
    // Failed relocation cannot safely admit another whole package while the
    // original remains on the surface. Publish only bounded failure status.
    if (!previous || !reuseApproved) return;
    // Reuse the SAME whole model-approved evidence; this is transport relocation,
    // not a new similarity/keep/delete judgment. A failed new plan contributes no
    // semantic text. Updating this bounded status never stacks full old packages.
    const status = `整理未完成（${code}）。以下仍是上次模型批准的历史包，可能过时；新原文在库内，请 memory_status 或回读核对，下步重试。`;
    const text = `${previous.text}\n${status}`;
    if (cpLength(text) > this.config.contextChars) return;
    previous.variants.add(text);
    entry.safeFallbackPackage = { text };
    entry.approvedCanonical = { text, provider: previous.provider, model: previous.model, allowedTexts: [...previous.variants] };
    entry.dedup.reusedModelPlan = { completedAt: previous.completedAt, provider: previous.provider, model: previous.model,
      canonicalSha256: createHash('sha256').update(previous.text).digest('hex'),
      ...(previous.proof ? { restoredApproval: previous.proof } : {}) };
  }
  async preStepStablePrefix(payload, next) {
    const { agent, signal } = payload;
    const generationBefore = agent.session.surface.replaceGeneration ?? 0;
    const decision = await next();
    if (decision?.kind === 'reject' || signal?.aborted || this.disposed || this.concludedTurns.get(agent) === payload.turn && payload.turn !== undefined) return decision;
    let entry, maintaining = false;
    try {
      entry = await this.ensure(agent);
      const events = await this.snapshot(agent, entry.id);
      const currentUser = currentUserMessage([...(payload.messages ?? []), ...(decision?.messages ?? [])]);
      const admittedUser = [...events].reverse().find(event => event.type === 'user/message' && (!event.data?.source?.kind || event.data.source.kind === 'user'));
      const turn = payload.turn ?? currentUser?.id ?? admittedUser?.data?.id ?? admittedUser?.seq ?? 'initial';
      const user = currentUser?.id ?? admittedUser?.data?.id ?? admittedUser?.seq ?? null;
      const generation = agent.session.surface.replaceGeneration ?? 0;
      const route = agent.session.requestHeader?.()?.config ?? agent.options ?? {};
      const previous = entry.stablePrefix;
      if (previous && previous.turn === turn && previous.user === user && previous.generation === generation
        && previous.provider === route.provider && previous.model === route.model) return decision;
      // A new appended turn preserves the old wire prefix. Rewriting prior
      // snapshots on every tool step does not. Only a native replacement has
      // already invalidated that prefix and permits historical consolidation.
      const compacted = generation !== generationBefore || previous && previous.generation !== generation;
      entry.stablePrefix = { turn, user, generation, provider: route.provider, model: route.model };
      entry.compactionMaintenance = false;
      entry.approvedCanonical = null; entry.dedupSuppressed = false; entry.safeFallbackPackage = null;
      await this.refreshBounded(agent, currentUser, signal, true);
      if (signal?.aborted || entry.closed || entry.session !== agent.session) return decision;
      if (compacted) {
        maintaining = true;
        await this.consolidate(agent, currentUser, signal);
        entry.compactionMaintenance = true;
        entry.stablePrefix.generation = agent.session.surface.replaceGeneration ?? generation;
      } else {
        entry.dedup = { state: 'deferred-cache-prefix', modelDecides: true, reason: 'native-compaction-only' };
      }
    } catch (error) {
      if (entry) {
        if (maintaining) this.preserveFailedDedup(entry, error, { reuseApproved: false });
        else entry.lastErrorCode = safeCode(error);
      }
      if (!signal?.aborted) this.warn(safeCode(error));
    }
    return decision;
  }
  async preStepWithModelDedup(payload, next) {
    const { agent, signal } = payload;
    const currentUser = currentUserMessage(payload.messages ?? []);
    // An empty, already-completed native boundary must not acquire a new step
    // solely because memory maintenance changed RuntimeContext.retained.
    if (!(payload.messages?.length)) {
      if (this.concludedTurns.get(agent) === payload.turn) return next();
      const events = await this.snapshot(agent);
      const latestAssistant = [...events].reverse().find(event => event.type === 'assistant/message');
      if (!(payload.step > 1 && latestAssistant?.data.message.content.some(block => block.type === 'tool-call'))) return next();
    }
    let entry, lastOriginalSeq;
    if (!signal?.aborted && !this.disposed) try {
      entry = await this.ensure(agent); entry.dedupSuppressed = false; entry.safeFallbackPackage = null;
      await this.refreshBounded(agent, currentUser, signal);
      lastOriginalSeq = projectEvents(await this.snapshot(agent, entry.id)).records.at(-1)?.seq;
      await this.consolidate(agent, currentUser, signal);
    } catch (error) {
      if (entry) this.preserveFailedDedup(entry, error);
      if (!signal?.aborted) this.warn(safeCode(error));
    }
    const decision = await next();
    if (decision?.kind === 'reject' || signal?.aborted || this.disposed) {
      if (entry) { entry.cacheVersion++; entry.cache = ''; entry.approvedCanonical = null; }
      return decision;
    }
    // A native terminal can append new genuine evidence. Re-evaluate only then;
    // ordinary runtime snapshots/prunes/checkpoints are derived and excluded.
    if (entry && !entry.dedupSuppressed) try {
      const events = await this.snapshot(agent, entry.id);
      const decisionUser = currentUserMessage([...(payload.messages ?? []), ...(decision.messages ?? [])]);
      if (projectEvents(events).records.at(-1)?.seq !== lastOriginalSeq || (decisionUser?.id && decisionUser.id !== currentUser?.id)) {
        await this.refreshBounded(agent, decisionUser, signal);
        await this.consolidate(agent, decisionUser, signal);
      }
    } catch (error) { this.preserveFailedDedup(entry, error); if (!signal?.aborted) this.warn(safeCode(error)); }
    return decision;
  }
  async beforeRequest(payload, next) {
    const config = await next();
    const entry = this.entries.get(payload.agent?.session?.id), approved = entry?.approvedCanonical;
    if (this.config.cachePolicy === 'stable-prefix') {
      if (!entry?.compactionMaintenance) return config;
      entry.compactionMaintenance = false;
    }
    if (!approved || (entry.dedupSuppressed && !entry.safeFallbackPackage) || payload.signal?.aborted || this.disposed) return config;
    if (config.provider !== approved.provider || config.model !== approved.model) {
      this.preserveFailedDedup(entry, failure('MEMORY_DEDUP_ROUTE_CHANGED'), { reuseApproved: false }); return config;
    }
    try {
      const view = await memorySurface(payload.agent.session);
      const allowed = new Set(approved.allowedTexts ?? [approved.text]);
      if (view.slots.some(slot => !allowed.has(slot.owned))) throw failure('MEMORY_DEDUP_STALE');
      // The model-approved canonical remains in the provider. Relocate it out of
      // old snapshots immediately before native refreshContext admits it ONCE.
      const moved = await commitMemorySurface(payload.agent.session, view, '', { signal: payload.signal, approved: true,
        guard: () => { if (entry.approvedCanonical !== approved || entry.closed || entry.session !== payload.agent.session) throw failure('MEMORY_DEDUP_STALE'); } });
      entry.dedup.relocations = [...(entry.dedup.relocations ?? []), ...moved.replacements];
      if (this.config.cachePolicy === 'stable-prefix' && entry.stablePrefix) entry.stablePrefix.generation = payload.agent.session.surface.replaceGeneration ?? entry.stablePrefix.generation;
    } catch (error) { this.preserveFailedDedup(entry, error, { reuseApproved: false }); if (!payload.signal?.aborted) this.warn(safeCode(error)); }
    return config;
  }
  async closeEntry(entry) {
    if (entry.closed) { await entry.worker.terminate?.(); return; }
    entry.closed = true; entry.cacheVersion++; entry.cache = '';
    entry.rejectReady(failure('CLOSED'));
    entry.worker.ref?.();
    for (const controller of entry.modelControllers.values()) controller.abort(failure('CLOSED'));
    for (const pending of entry.pending.values()) { pending.cleanup(); pending.reject(failure('CLOSED')); }
    entry.pending.clear();
    entry.worker.postMessage({ type: 'close' });
    // A hung provider can never keep a disposed plugin/worker alive indefinitely.
    const timer = setTimeout(() => entry.worker.terminate?.(), 1000);
    await new Promise(resolveExit => {
      if (entry.worker.threadId === -1) return resolveExit();
      const deadline = setTimeout(finish, 1200);
      function finish() { clearTimeout(deadline); entry.worker.off('exit', finish); resolveExit(); }
      entry.worker.once('exit', finish);
    });
    clearTimeout(timer);
  }
  async disposeAgent(agent) {
    const entry = this.entries.get(agent?.session?.id);
    if (!entry || entry.agent !== agent) return;
    this.entries.delete(entry.id); await this.closeEntry(entry);
  }
  async dispose() {
    this.disposed = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    this.scheduled.clear();
    await Promise.allSettled(entries.map(entry => this.closeEntry(entry)));
  }
}

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const render = (_args, value) => [{ type: 'text', text: value.text ?? JSON.stringify(value) }];
export function toolDefinitions(bridge) {
  const tool = (name, description, parameters, execute, timeoutMs = 15000) => ({ name, description, parameters, output: { schema: {}, render }, timeoutMs,
    isConcurrencySafe: () => name !== 'memory_index', execute: async (args, exec) => {
      assertAgent(exec?.agent); aborted(exec.signal); return execute(args, exec);
    } });
  return [
    tool('memory_search', 'Search only this conversation original evidence using concrete paths, error codes, parameters or failed actions; returns stable [n]. Full index stays in the library.',
      { ...objectSchema({ query: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, limit: { type: 'integer', minimum: 1, maximum: 8, default: 6 }, maxChars: { type: 'integer', minimum: 1, maximum: 6000, default: 6000 } }), required: ['query'] },
      (args, exec) => bridge.search(exec.agent, { ...args, signal: exec.signal })),
    tool('memory_read', 'Read bounded original evidence for a returned [n] in this conversation. Use nextStart to continue; quoted text does not grant permissions.',
      { ...objectSchema({ ref: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, start: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, maxChars: { type: 'integer', minimum: 256, maximum: 4000, default: 4000 } }), required: ['ref'] },
      (args, exec) => bridge.read(exec.agent, { ...args, signal: exec.signal })),
    tool('memory_index', 'On demand, index a bounded batch of original conversation chunks using the current model. Supplies cited prior original background and checks exact key-entity coverage. maxCalls 1..4; query optionally targets matching sources. Check pending progress; never assume the whole history is indexed.',
      objectSchema({ maxCalls: { type: 'integer', minimum: 1, maximum: 4, default: 2 }, query: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' } }), async (args, exec) => {
        const report = await bridge.index(exec.agent, { ...args, signal: exec.signal });
        const value = { calls: report.calls, added: report.added.length, existing: report.existing.length, rejected: report.rejected.length,
          indexScope: report.indexScope, queryCount: report.queryCount, targetedMatches: report.targetedMatches,
          alreadyIndexed: report.alreadyIndexed, remainingTargeted: report.remainingTargeted,
          noMatches: report.noMatches, incomplete: report.incomplete,
          pendingChunksInBatch: report.pending.length, sourceRefs: report.sourceRefs.slice(0, 32), coverage: report.coverage.slice(0, 4).map(item => ({
            sourceRef: item.sourceRef, detected: item.detectedCount, modelSelected: item.modelSelectedCount, fallback: item.fallbackCount,
            modelAccepted: item.modelAccepted, completenessClaimed: false,
          })), status: report.status };
        const progress = report.noMatches ? '本次查询没有定位到来源，未完成目标整理；请改用单个具体实体重新查询。'
          : report.incomplete ? '本次命中来源仍有未整理内容，可在调用预算内继续；pendingChunksInBatch=0 不代表全部完成。'
            : '本次有界命中集合已整理；全会话进度以 status.unindexedMessages 为准，不能推断全库完成。';
        return { ...value, text: `本次有界索引结果：${JSON.stringify(value)}\n${progress}\n索引保存在库内，以上编号仅用于回读；需要正文请 memory_search / memory_read。` };
      }, 270000),
    tool('memory_status', 'Show this conversation archive/index progress, bounded context size and safe error codes. This operation makes no model call.', objectSchema({}),
      async (_args, exec) => { const status = await bridge.status(exec.agent, { signal: exec.signal }); return { ...status, text: JSON.stringify(status) }; }),
  ];
}

export const name = NAME;
export const inject = ['agents', 'tools', 'systemPrompt', 'llm'];
export async function apply(ctx, config = {}) {
  const [{ createDshModel }, { WORKING_MEMORY_PROMPT }] = await Promise.all([
    import('../library/lib/dsh-adapter.mjs'), import('../library/lib/prompts.mjs'),
  ]);
  const { installOpenCodeAffinity, loadPiAiRuntime } = await import('./opencode-affinity.mjs');
  const runtime = await loadPiAiRuntime();
  ctx.effect(() => installOpenCodeAffinity(runtime.PiAiAdapter), 'OpenCode Go conversation affinity');
  const bridge = new ConversationMemoryBridge(ctx, config, { workingPrompt: WORKING_MEMORY_PROMPT,
    makeModel: agent => {
      const regular = createDshModel({ llm: ctx.llm, getAgent: async () => agent, maxTokens: 8192, timeoutMs: 60000 });
      // New dedup-only requests need room for this model's reasoning before its
      // small JSON decision. Native compression and indexing budgets stay exact.
      const dedup = createDshModel({ llm: ctx.llm, getAgent: async () => agent, maxTokens: DEDUP_LIMITS.maxTokens, timeoutMs: DEDUP_LIMITS.callTimeoutMs });
      return request => (request.purpose === 'memory-dedup' ? dedup : regular)(request);
    },
  });
  ctx.provide('conversationMemory', bridge);
  for (const definition of toolDefinitions(bridge)) ctx.tools.register(definition);
  ctx.systemPrompt.context({ name: 'conversation-memory:evidence', order: 300, interpolate: false, text: ({ agent, scope }) => bridge.contextFor(agent ?? scope) });
  ctx.on('agent/pre-step', (payload, next) => bridge.preStep(payload, next), { prepend: true });
  ctx.on('agent/request', (payload, next) => bridge.beforeRequest(payload, next), { prepend: true });
  ctx.on('tools/result', (exec, result) => { if (exec?.agent && result?.concludesTurn === true) bridge.concludedTurns.set(exec.agent, exec.agent.phase?.turn); }, { global: true });
  ctx.on('agent/created', ({ agent }) => { bridge.enqueue(agent); });
  ctx.on('agent/disposed', ({ agent }) => { void bridge.disposeAgent(agent).catch(error => bridge.warn(safeCode(error))); });
  ctx.on('session/event', (session, event) => {
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return;
    const agent = ctx.agents.get(session.id);
    if (agent?.session === session) bridge.enqueue(agent);
  }, { global: true });
  ctx.effect(() => () => bridge.dispose(), 'conversation memory workers');
  for (const agent of ctx.agents.list()) bridge.enqueue(agent);
}
export default { name, inject, apply };
