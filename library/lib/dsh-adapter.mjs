/** Standalone DSH integration. Importing this module registers no host hooks. */

const PURPOSES = new Set(['memory-index', 'memory-rerank', 'memory-dedup']);
const TEXT_ROLES = new Set(['system', 'user', 'assistant']);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const MAX_RESPONSE_CHARS = 1_048_576;

export class DshAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DshAdapterError';
    this.code = code;
  }
}

const fail = (code, message) => new DshAdapterError(code, message);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw fail('INVALID_REQUEST', 'Memory model messages must be a nonempty array');
  let hasText = false;
  const result = messages.map(message => {
    if (!isObject(message) || !TEXT_ROLES.has(message.role)) throw fail('INVALID_REQUEST', 'Memory model messages must use system, user, or assistant roles');
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
    if (!Array.isArray(content) || !content.length || content.some(block => !isObject(block) || block.type !== 'text' || typeof block.text !== 'string')) {
      throw fail('INVALID_REQUEST', 'Memory model messages must contain only text');
    }
    const copied = content.map(block => {
      if (block.text.trim()) hasText = true;
      return { type: 'text', text: block.text };
    });
    // Do not forward caller-supplied message source, tool IDs, or replay state.
    return { role: message.role, content: copied };
  });
  if (!hasText) throw fail('INVALID_REQUEST', 'Memory model messages must contain nonempty text');
  return result;
}

function abortScope(callerSignal, timeoutMs) {
  if (callerSignal !== undefined && (!callerSignal || typeof callerSignal.addEventListener !== 'function' || typeof callerSignal.removeEventListener !== 'function' || typeof callerSignal.aborted !== 'boolean')) {
    throw fail('INVALID_REQUEST', 'signal must be an AbortSignal');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(fail('ABORTED', 'Memory model request was aborted'));
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail('TIMEOUT', 'Memory model request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cancel() { if (!controller.signal.aborted) abort(); },
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    },
  };
}

function checkAbort(signal) {
  if (signal.aborted) throw signal.reason;
}

/** Bound proxy calls and iterator.next even if an implementation ignores signal. */
function abortable(value, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function routeFrom(config) {
  if (!isObject(config) || !nonempty(config.provider) || !nonempty(config.model)) return undefined;
  return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
}

function reasoningFor(info, route) {
  const efforts = info?.reasoning?.efforts;
  if (!Array.isArray(efforts)) return undefined;
  if (efforts.some(effort => effort?.id === 'low')) return 'low';
  if (nonempty(route.reasoningEffort) && efforts.some(effort => effort?.id === route.reasoningEffort)) return route.reasoningEffort;
  return undefined;
}

function copyUsage(usage) {
  if (!isObject(usage) || !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0 || !Number.isFinite(usage.outputTokens) || usage.outputTokens < 0) {
    throw fail('INVALID_RESPONSE', 'DSH returned invalid token usage');
  }
  const copied = {};
  for (const key of USAGE_FIELDS) {
    if (usage[key] === undefined) continue;
    if (!Number.isFinite(usage[key]) || usage[key] < 0) throw fail('INVALID_RESPONSE', 'DSH returned invalid token usage');
    copied[key] = usage[key];
  }
  return copied;
}

async function consumeText(stream, signal) {
  const iterator = stream?.[Symbol.asyncIterator]?.() ?? stream?.[Symbol.iterator]?.();
  if (!iterator || typeof iterator.next !== 'function') throw fail('INVALID_RESPONSE', 'DSH did not return a model stream');
  const deltas = new Map();
  const completed = new Map();
  const kinds = new Map();
  let finish;
  let usage;
  let chars = 0;
  let exhausted = false;
  const indexOf = chunk => {
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) throw fail('INVALID_RESPONSE', 'DSH returned an invalid content index');
    return chunk.index;
  };
  const kindAt = (index, kind) => {
    if (!['text', 'reasoning'].includes(kind)) throw fail(kind === 'tool-call' ? 'TOOL_RESPONSE' : 'NONTEXT_RESPONSE', 'Memory model must return only text');
    if (kinds.has(index) && kinds.get(index) !== kind) throw fail('INVALID_RESPONSE', 'DSH returned inconsistent content blocks');
    kinds.set(index, kind);
  };
  try {
    for (;;) {
      checkAbort(signal);
      const next = await abortable(iterator.next(), signal);
      checkAbort(signal);
      if (!isObject(next)) throw fail('INVALID_RESPONSE', 'DSH returned an invalid stream item');
      if (next.done) { exhausted = true; break; }
      const chunk = next.value;
      if (!isObject(chunk)) throw fail('INVALID_RESPONSE', 'DSH returned an invalid stream chunk');
      if (finish && chunk.type !== 'usage') throw fail('INVALID_RESPONSE', 'DSH returned content after the terminal finish');
      switch (chunk.type) {
        case 'block-start':
          kindAt(indexOf(chunk), chunk.blockType);
          break;
        case 'text-delta': {
          const index = indexOf(chunk);
          kindAt(index, 'text');
          if (typeof chunk.text !== 'string' || completed.has(index)) throw fail('INVALID_RESPONSE', 'DSH returned an invalid text delta');
          chars += chunk.text.length;
          if (chars > MAX_RESPONSE_CHARS) throw fail('INVALID_RESPONSE', 'Memory model response exceeded the size limit');
          deltas.set(index, (deltas.get(index) ?? '') + chunk.text);
          break;
        }
        case 'reasoning-delta':
          kindAt(indexOf(chunk), 'reasoning');
          if (typeof chunk.text !== 'string') throw fail('INVALID_RESPONSE', 'DSH returned invalid reasoning metadata');
          break;
        case 'block-end': {
          const index = indexOf(chunk);
          if (!isObject(chunk.block)) throw fail('INVALID_RESPONSE', 'DSH returned an invalid completed block');
          kindAt(index, chunk.block.type);
          if (chunk.block.type === 'text') {
            if (typeof chunk.block.text !== 'string' || completed.has(index)) throw fail('INVALID_RESPONSE', 'DSH returned an invalid completed text block');
            chars += chunk.block.text.length - (deltas.get(index)?.length ?? 0);
            if (chars > MAX_RESPONSE_CHARS) throw fail('INVALID_RESPONSE', 'Memory model response exceeded the size limit');
            completed.set(index, chunk.block.text);
          }
          break;
        }
        case 'tool-call-delta':
          throw fail('TOOL_RESPONSE', 'Memory model must return only text');
        case 'usage':
          usage = copyUsage(chunk.usage);
          break;
        case 'finish':
          if (!isObject(chunk.reason) || chunk.reason.kind !== 'stop') {
            // Raw failure causes, request headers, and provider messages stay private.
            throw fail('INCOMPLETE_RESPONSE', 'Memory model did not finish normally');
          }
          finish = chunk.reason.kind;
          break;
        default:
          throw fail('INVALID_RESPONSE', 'DSH returned an unsupported stream chunk');
      }
    }
    if (finish !== 'stop') throw fail('INCOMPLETE_RESPONSE', 'Memory model did not provide a terminal stop');
    const indexes = [...new Set([...deltas.keys(), ...completed.keys()])].sort((a, b) => a - b);
    const text = indexes.map(index => completed.get(index) ?? deltas.get(index)).join('');
    if (!text.trim()) throw fail('EMPTY_RESPONSE', 'Memory model returned empty text');
    return { text, finish: 'stop', ...(usage === undefined ? {} : { usage }) };
  } finally {
    // Do not let a stalled provider cleanup extend the bounded request deadline.
    if (!exhausted && typeof iterator.return === 'function') {
      try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* best effort */ }
    }
  }
}

/**
 * Create an independent, text-only auxiliary request against the current route.
 * request.maxTokens can lower (never raise) the adapter's token ceiling.
 * Library purposes are traced; native DSH uses its supported compaction purpose.
 * No agent loop, tools, tool history, model defaults, or session events are changed.
 */
export function createDshModel({ llm, getAgent, maxTokens = 2048, timeoutMs = 60000 } = {}) {
  if (!llm || typeof llm.stream !== 'function' || typeof llm.resolveModelInfo !== 'function' || typeof getAgent !== 'function') {
    throw fail('INVALID_CONFIG', 'DSH adapter requires llm.stream, llm.resolveModelInfo, and getAgent');
  }
  if (!positiveInteger(maxTokens) || !positiveInteger(timeoutMs) || timeoutMs > 2_147_483_647) throw fail('INVALID_CONFIG', 'DSH adapter limits must be positive integers within timer bounds');
  return async function model(request = {}) {
    if (!isObject(request) || !PURPOSES.has(request.purpose)) throw fail('INVALID_REQUEST', 'Unsupported memory model purpose');
    if (request.maxTokens !== undefined && !positiveInteger(request.maxTokens)) throw fail('INVALID_REQUEST', 'Memory model maxTokens must be a positive integer');
    const messages = normalizeMessages(request.messages);
    const scope = abortScope(request.signal, timeoutMs);
    try {
      checkAbort(scope.signal);
      const agent = await abortable(getAgent(), scope.signal);
      const session = agent?.session;
      if (!session || !nonempty(session.id)) throw fail('NO_SESSION', 'A current DSH session is required');
      const sessionId = session.id;
      const header = typeof session.requestHeader === 'function'
        ? await abortable(session.requestHeader(), scope.signal)
        : undefined;
      let route = routeFrom(header?.config);
      if (!route) route = routeFrom(await abortable(agent.options, scope.signal));
      if (!route) throw fail('NO_MODEL', 'The current DSH session has no complete provider and model route');
      const info = await abortable(llm.resolveModelInfo(route.provider, route.model, scope.signal), scope.signal);
      if (agent.session !== session || session.id !== sessionId) throw fail('SESSION_CHANGED', 'The current DSH session changed before model dispatch');
      checkAbort(scope.signal);
      const effort = reasoningFor(info, route);
      const stream = await abortable(llm.stream({
        provider: route.provider,
        model: route.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        sessionId,
        purpose: 'compaction',
        messages,
        tools: [],
        maxTokens: Math.min(request.maxTokens ?? maxTokens, maxTokens),
        signal: scope.signal,
      }), scope.signal);
      const response = await consumeText(stream, scope.signal);
      checkAbort(scope.signal);
      return { ...response, tracePurpose: request.purpose,
        ...(request.purpose === 'memory-dedup' ? { traceRoute: { provider: route.provider, model: route.model } } : {}) };
    } catch (error) {
      const failure = scope.signal.aborted ? scope.signal.reason : error instanceof DshAdapterError
        ? error : fail('MODEL_FAILED', 'The DSH memory model request failed');
      scope.cancel();
      throw failure;
    } finally {
      scope.dispose();
    }
  };
}

function assertConversation(memory, session, expected) {
  if (memory.conversationId !== expected || session.id !== expected) throw fail('SESSION_MISMATCH', 'Memory and DSH session must belong to the same conversation');
}

function eventText(event) {
  const role = { 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'tool' }[event.type];
  if (!role) return undefined;
  const message = event.type === 'user/message' ? event.data : event.data?.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  // Extract text in source order; never archive hidden reasoning or tool arguments.
  const text = message.content.filter(block => isObject(block) && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
  return text.trim() ? { role, text } : undefined;
}

/**
 * Backfill raw DSH events into one already-bound conversation memory.
 * afterSeq is exclusive. Source keys make repeat ingestion idempotent in the store.
 * snapshotEvents may return a sync iterable, an async iterable, or a promise of one.
 */
export async function ingestDshSession(memory, session, { afterSeq = 0 } = {}) {
  if (!memory || typeof memory.append !== 'function' || !session || typeof session.snapshotEvents !== 'function' || !nonempty(session.id)) {
    throw fail('INVALID_CONFIG', 'Ingestion requires a bound memory and a DSH session');
  }
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw fail('INVALID_REQUEST', 'afterSeq must be a nonnegative safe integer');
  const sessionId = session.id;
  assertConversation(memory, session, sessionId);
  const events = await session.snapshotEvents();
  assertConversation(memory, session, sessionId);
  if (!events || (typeof events[Symbol.iterator] !== 'function' && typeof events[Symbol.asyncIterator] !== 'function')) throw fail('INVALID_RESPONSE', 'DSH did not return an iterable event snapshot');
  const result = { sessionId, scanned: 0, appended: 0, skipped: 0, lastSeq: afterSeq };
  for await (const event of events) {
    assertConversation(memory, session, sessionId);
    result.scanned++;
    if (!isObject(event) || !Number.isSafeInteger(event.seq) || event.seq < 0) throw fail('INVALID_RESPONSE', 'DSH returned an invalid event sequence');
    if (event.sessionId !== undefined && event.sessionId !== sessionId) throw fail('SESSION_MISMATCH', 'A DSH event belongs to another conversation');
    result.lastSeq = Math.max(result.lastSeq, event.seq);
    if (event.seq <= afterSeq) { result.skipped++; continue; }
    const extracted = eventText(event);
    if (!extracted) { result.skipped++; continue; }
    if (!Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) throw fail('INVALID_RESPONSE', 'DSH returned an invalid event timestamp');
    await memory.append({
      sourceKey: `dsh:${sessionId}:${event.seq}`,
      role: extracted.role,
      text: extracted.text,
      createdAt: new Date(event.time).toISOString(),
      metadata: { sessionId, seq: event.seq, type: event.type, role: extracted.role, time: event.time },
    });
    assertConversation(memory, session, sessionId);
    result.appended++;
  }
  return result;
}
