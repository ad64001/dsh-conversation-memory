import { ConversationStore } from './sqlite-store.mjs';
import { packContext, validateRerank, BudgetExceededError } from './context.mjs';
import { MEMORY_INDEX_PROMPT, MEMORY_RERANK_PROMPT } from './prompts.mjs';
import { detectEntities, entityCoverage } from './entities.mjs';
export { ConversationStore } from './sqlite-store.mjs';
export { packContext, validateRerank, BudgetExceededError } from './context.mjs';
export * from './prompts.mjs';
export { detectEntities, entityCoverage } from './entities.mjs';

const length = text => Array.from(text).length;
const KINDS = new Set(['constraint', 'decision', 'fact', 'failure', 'correction', 'state', 'inference']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validRef = ref => Number.isSafeInteger(ref) && ref > 0;
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
function keys(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Invalid model JSON schema');
  }
}
function aborted(signal) { if (signal?.aborted) throw signal.reason ?? new Error('Aborted'); }
function responseJson(response) {
  if (!object(response) || response.finish !== 'stop' || typeof response.text !== 'string' || response.text.length > 65536) {
    throw new TypeError('Incomplete or invalid model response');
  }
  return JSON.parse(response.text);
}
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Immutable evidence plus explicitly curated memory. No host hooks on import. */
export class ConversationMemory {
  constructor({ rootDir, conversationId, model, contextChars = 16000 } = {}) {
    if (model !== undefined && typeof model !== 'function') throw new TypeError('model must be a function');
    integer(contextChars, 'contextChars', 1, 1_000_000);
    this.store = new ConversationStore({ rootDir, conversationId });
    Object.defineProperty(this, 'conversationId', { value: conversationId, enumerable: true });
    this.model = model;
    this.contextChars = contextChars;
  }
  append(input) { return this.store.append(input); }
  read(ref) { return this.store.sourceEvidence(ref); }
  /** Expand an excerpt to bounded surrounding original text. Returned ref names
   * the actual returned span; requestedRef retains the incoming citation.
   */
  readSource(ref, { start, maxChars = 4000 } = {}) {
    integer(maxChars, 'maxChars', 1, 8192);
    const source = this.read(ref);
    if (!source) return null;
    const message = this.store.getMessage(source.messageId);
    const chars = Array.from(message.text);
    start = start ?? Math.max(0, source.start - Math.min(512, Math.floor(maxChars / 4)));
    integer(start, 'start', 0, chars.length - 1);
    const end = Math.min(chars.length, start + maxChars);
    const citation = this.cite({ messageId: message.id, start, end });
    return { ...this.read(citation.ref), requestedRef: ref, totalChars: chars.length,
      nextStart: end < chars.length ? end : null, hasMore: end < chars.length,
      containsRequestedSpan: start <= source.start && end >= source.end };
  }
  cite(span) { return this.store.cite(span); }
  stats() { return this.store.stats(); }
  close() { this.store.close(); }
  confirm(ref, options) { return this.store.confirm(ref, options); }
  supersede(oldRef, newRef) { return this.store.supersede(oldRef, newRef); }
  retract(ref) { return this.store.retract(ref); }
  resolve(ref) { return this.store.resolve(ref); }

  /** Trusted application API. Never pass arbitrary model objects to this method. */
  remember({ ref, ...record }) {
    if (ref !== undefined) {
      const source = this.read(ref);
      if (!source) throw new Error('Unknown source reference');
      for (const key of ['messageId', 'start', 'end']) if (Object.hasOwn(record, key)) throw new TypeError('Use either ref or source span');
      return this.store.addMemory({ ...record, messageId: source.messageId, start: source.start, end: source.end });
    }
    return this.store.addMemory(record);
  }

  #evidence(record) {
    const message = this.store.getMessage(record.messageId);
    return { ...record, sourceRole: message.role, sourceSeq: message.seq, sourceKey: message.sourceKey };
  }
  #state() {
    const { messages, memories, relations, confirmations } = this.stats();
    return `${messages}:${memories}:${relations}:${confirmations}`;
  }

  #previousMessages(seq, limit = 2) {
    // Storage API is append ordered. Page without loading the full archive into
    // a model request. Retain only the last two nonempty preceding messages.
    let afterSeq = 0;
    const previous = [];
    for (;;) {
      const page = this.store.listMessages({ afterSeq, limit: 100 });
      for (const message of page) {
        if (message.seq >= seq) return previous;
        afterSeq = message.seq;
        if (message.text.length) { previous.push(message); if (previous.length > limit) previous.shift(); }
      }
      if (page.length < 100) return previous;
    }
  }

  #background(span, maxChars) {
    if (!maxChars) return [];
    const current = this.store.getMessage(span.messageId);
    const preceding = span.start > 0 ? [{ message: current, end: span.start }]
      : this.#previousMessages(current.seq).map(message => ({ message, end: length(message.text) }));
    let remaining = maxChars;
    const sources = [];
    // Most recent original text has priority, but emitted sources stay in their
    // original chronological order. Never feed a prior model summary as state.
    for (const { message, end } of preceding.reverse()) {
      if (!remaining) break;
      const start = Math.max(0, end - remaining);
      if (end <= start) continue;
      const source = this.#evidence(this.cite({ messageId: message.id, start, end }));
      sources.unshift(source);
      remaining -= end - start;
    }
    return sources;
  }

  #entityManifest(span, cache) {
    const message = this.store.getMessage(span.messageId);
    if (!cache.has(message.id)) cache.set(message.id, detectEntities(message.text));
    return cache.get(message.id).filter(entity => entity.end > span.start && entity.start < span.end).map(entity => ({ ...entity,
      ref: this.cite({ messageId: message.id, start: entity.start, end: entity.end }).ref,
      withinCurrentSource: entity.start >= span.start && entity.end <= span.end }));
  }

  /** Extraction is advisory and exact-quote only. Cursor advances after a valid
   * response; interrupted/unprocessed chunks are returned as pending spans.
   * maxCalls bounds per invocation, not total lifetime; callers schedule work.
   */
  async indexMessages({ messageIds, startOffsets = {}, maxCalls = 4, maxChunkChars = 4000, maxRecordsPerCall = 12, maxBackgroundChars = 1024, signal } = {}) {
    if (!this.model) throw new Error('No model configured');
    if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string')) throw new TypeError('messageIds must be strings');
    if (!object(startOffsets)) throw new TypeError('startOffsets must be an object');
    integer(maxCalls, 'maxCalls', 1, 32);
    integer(maxChunkChars, 'maxChunkChars', 256, 8192);
    integer(maxRecordsPerCall, 'maxRecordsPerCall', 1, 24);
    integer(maxBackgroundChars, 'maxBackgroundChars', 0, 2048);
    const pending = [];
    for (const id of [...new Set(messageIds)]) {
      const message = this.store.getMessage(id);
      if (!message) throw new Error('Unknown source message');
      const chars = Array.from(message.text);
      const offset = startOffsets[id] ?? 0;
      integer(offset, 'start offset', 0, chars.length);
      for (let start = offset; start < chars.length; start += maxChunkChars) {
        pending.push({ messageId: id, start, end: Math.min(chars.length, start + maxChunkChars) });
      }
    }
    const report = { calls: 0, added: [], existing: [], inactive: [], rejected: [], pending: [...pending], sourceRefs: [], backgrounds: [], coverage: [] };
    const entityCache = new Map();
    for (const span of pending.slice(0, maxCalls)) {
      aborted(signal);
      const source = this.#evidence(this.cite(span));
      const background = this.#background(span, maxBackgroundChars);
      const entities = this.#entityManifest(span, entityCache);
      let manifestChars = 0;
      const wireEntities = entities.filter(entity => {
        const chars = length(JSON.stringify(entity));
        if (manifestChars + chars > 8192) return false;
        manifestChars += chars; return true;
      });
      const backgroundRefs = background.map(item => item.ref);
      report.backgrounds.push({ sourceRef: source.ref, refs: backgroundRefs, chars: background.reduce((sum, item) => sum + length(item.text), 0) });
      report.sourceRefs.push(source.ref);
      let records = [], accepted = false;
      report.calls++;
      try {
        const response = await this.model({ purpose: 'memory-index', maxTokens: 8192, signal, messages: [
          { role: 'system', content: MEMORY_INDEX_PROMPT },
          { role: 'user', content: JSON.stringify({ maxRecords: maxRecordsPerCall,
            previousBackground: { readOnly: true, sources: background },
            entityManifest: { sourceRef: source.ref, sourceRole: source.sourceRole, sourceSeq: source.sourceSeq,
              entities: wireEntities, omittedCount: entities.length - wireEntities.length },
            sources: [source] }) },
        ] });
        aborted(signal);
        const data = responseJson(response);
        keys(data, ['records']);
        if (!Array.isArray(data.records) || data.records.length > maxRecordsPerCall) throw new TypeError('Invalid records count');
        const spans = new Set();
        // Validate the whole response before writing any proposed record.
        records = data.records.map(record => {
          keys(record, ['ref', 'kind', 'quote', 'key'], ['ref', 'kind', 'quote']);
          if (record.ref !== source.ref || !KINDS.has(record.kind) || typeof record.quote !== 'string' || !record.quote.trim() || !record.quote.isWellFormed() || length(record.quote) > 1600) {
            throw new TypeError('Invalid record source, kind or quote');
          }
          if (record.key !== undefined && (typeof record.key !== 'string' || !record.key.trim() || length(record.key) > 120)) throw new TypeError('Invalid record key');
          const offset = source.text.indexOf(record.quote);
          if (offset < 0 || source.text.indexOf(record.quote, offset + 1) !== -1) throw new TypeError('Quote must occur exactly once in source');
          const start = source.start + length(source.text.slice(0, offset));
          const end = start + length(record.quote);
          if (spans.has(`${start}:${end}`)) throw new TypeError('Duplicate proposed source span');
          spans.add(`${start}:${end}`);
          return { kind: record.kind, key: record.key ?? null, messageId: source.messageId, start, end, origin: 'model', pinned: false,
            scope: { indexingBackgroundRefs: backgroundRefs } };
        });
        accepted = true;
      } catch (error) {
        aborted(signal);
        // Raw source is retained. Failed chunks remain pending for explicit retry.
        report.rejected.push({ ...span, sourceRef: source.ref, code: error instanceof SyntaxError ? 'INVALID_JSON' : 'INDEX_REJECTED' });
      }
      // Storage failures propagate; never silently advance a persistence cursor.
      const activeRecords = [];
      for (const record of records) {
        const citation = this.cite(record);
        const old = this.store.getMemory(citation.ref);
        if (!this.read(citation.ref).active) { report.inactive.push(citation.ref); continue; }
        if (old) report.existing.push(old.ref);
        else report.added.push(this.store.addMemory(record).ref);
        activeRecords.push(record);
      }
      const coverage = entityCoverage(entities, activeRecords).map(entity => {
        if (entity.selected) return { ...entity, status: 'selected' };
        // Raw source is already durable. An additional exact excerpt makes a
        // model-omitted identifier searchable at its precise source location.
        // The detector is not allowed to assert truth, a root cause or a ban.
        const old = this.store.getMemory(entity.ref);
        if (!this.read(entity.ref).active) return { ...entity, status: 'inactive-evidence' };
        if (!old) this.store.addMemory({ kind: 'entity', messageId: span.messageId,
          start: entity.start, end: entity.end, key: `entity:${entity.categories.join(',')}`,
          origin: 'model', pinned: false, scope: { evidenceOnly: true,
            detectedBy: 'deterministic-v1', entityCategories: entity.categories, indexingBackgroundRefs: backgroundRefs } });
        return { ...entity, status: old ? 'existing-evidence' : 'fallback' };
      });
      report.coverage.push({ sourceRef: source.ref, messageId: span.messageId,
        detectedCount: coverage.length, modelSelectedCount: coverage.filter(item => item.selected).length,
        fallbackCount: coverage.filter(item => !item.selected).length, entities: coverage,
        modelAccepted: accepted, completenessClaimed: false });
      if (accepted) report.pending = report.pending.filter(item => item !== span);
    }
    return report;
  }

  /** Local search always works without a model. Invalid rerank results fall back
   * to the deterministic candidates; cancellation propagates to the caller.
   */
  async recall({ query, limit = 8, kinds, useModel = true, signal } = {}) {
    integer(limit, 'limit', 1, 20);
    aborted(signal);
    const local = () => {
      const seen = new Set();
      return this.store.search(query, { limit: Math.min(40, Math.max(limit * 2, 12)), kinds })
        .filter(record => this.read(record.ref)?.active)
        .filter(record => { if (seen.has(record.ref)) return false; seen.add(record.ref); return true; })
        .map(record => this.#evidence(record));
    };
    let candidates = local();
    const state = this.#state();
    let ranked = candidates;
    let status = 'local';
    if (useModel && this.model && candidates.length) {
      try {
        let candidateChars = 0;
        const wireCandidates = candidates.map(({ ref, kind, text, sourceRole, sourceSeq, origin, active, scope, key, relations }) =>
          ({ ref, kind, text, sourceRole, sourceSeq, origin, active, scope, key, relations }))
          .filter(record => { const size = length(JSON.stringify(record)); if (candidateChars + size > 16000) return false; candidateChars += size; return true; });
        if (!wireCandidates.length) throw new RangeError('No whole candidate fits model rerank budget');
        const response = await this.model({ purpose: 'memory-rerank', maxTokens: 1024, signal, messages: [
          { role: 'system', content: MEMORY_RERANK_PROMPT },
          { role: 'user', content: JSON.stringify({ query, candidates: wireCandidates }) },
        ] });
        aborted(signal);
        const data = responseJson(response);
        keys(data, ['refs']);
        if (!validateRerank(data.refs, wireCandidates)) throw new TypeError('Invalid rerank references');
        const byRef = new Map(candidates.map(item => [item.ref, item]));
        ranked = data.refs.map(ref => byRef.get(ref));
        status = 'reranked';
      } catch {
        aborted(signal);
        status = 'local-fallback';
      }
    }
    if (state !== this.#state()) {
      candidates = local();
      ranked = candidates;
      status = 'local-state-changed';
    }
    return { records: ranked.slice(0, limit), status, candidateRefs: candidates.map(item => item.ref) };
  }

  /** The instruction prompt is exported separately; this method only produces
   * evidence. Recent raw history is opt-in because unrelated recency adds noise.
   */
  async buildContext({ query = '', currentTask = '', maxChars = this.contextChars, limit = 8, recentLimit = 0,
    pinMode = 'relevant', pinRefs = [], includeBackground = true, useModel = true, signal } = {}) {
    integer(recentLimit, 'recentLimit', 0, 20);
    if (!['relevant', 'none', 'all'].includes(pinMode)) throw new TypeError('pinMode must be relevant, none or all');
    if (!Array.isArray(pinRefs) || pinRefs.some(ref => !validRef(ref))) throw new TypeError('pinRefs must be positive references');
    if (typeof includeBackground !== 'boolean') throw new TypeError('includeBackground must be boolean');
    const retrieval = await this.recall({ query, limit, useModel, signal });
    const mandatory = [...new Set(pinRefs)].map(ref => {
      const record = this.store.getMemory(ref);
      if (!record || !record.active || !this.read(ref)?.active || !record.pinned || !['user', 'manual'].includes(record.origin)) throw new TypeError('Explicit pinRefs must be active confirmed pins');
      return this.#evidence(record);
    });
    let pinned = [...mandatory];
    if (pinMode === 'all') {
      const all = this.store.pinnedMemories({ limit: 1000 });
      if (all.length === 1000) throw new RangeError('Pinned record scan limit reached; curate or paginate explicitly before packing');
      pinned.push(...all.filter(record => this.read(record.ref)?.active).map(record => this.#evidence(record)));
    } else if (pinMode === 'relevant') pinned.push(...retrieval.records.filter(record => record.pinned && ['user', 'manual'].includes(record.origin)));
    const recent = recentLimit ? this.store.recentMessages({ limit: recentLimit }).filter(message => message.text.length)
      .map(message => this.read(this.cite({ messageId: message.id, start: 0, end: length(message.text) }).ref))
      .filter(record => record.active).map(record => this.#evidence(record)) : [];
    // A parent excerpt and its original boundary background are one admission
    // unit. Packing independent entries can retain "this modification failed"
    // while dropping the only original text that identifies the modification.
    pinned = [...new Map(pinned.map(record => [record.ref, record])).values()];
    const makeGroup = (parent, index) => {
      const backgrounds = [], unavailableBackgroundRefs = [];
      if (includeBackground) for (const ref of [...new Set(parent.scope?.indexingBackgroundRefs ?? [])]) {
        if (!validRef(ref) || ref === parent.ref) continue;
        const source = this.read(ref);
        if (source?.active) backgrounds.push({ ...this.#evidence(source), relation: 'original-boundary-background', relatedToRef: parent.ref });
        else unavailableBackgroundRefs.push(ref);
      }
      const entries = [parent, ...backgrounds];
      return { parentRef: parent.ref, backgroundRefs: backgrounds.map(record => record.ref), unavailableBackgroundRefs,
        refs: entries.map(record => record.ref), entries, index,
        priority: backgrounds.length ? 0 : parent.kind === 'source' ? 2 : 1 };
    };
    const mandatoryGroups = pinned.map(makeGroup);
    const pinnedRefs = new Set(pinned.map(record => record.ref));
    const groups = retrieval.records.filter(record => !pinnedRefs.has(record.ref)).map(makeGroup)
      .sort((a, b) => a.priority - b.priority || a.index - b.index);
    const allRefs = [...new Set([...mandatoryGroups, ...groups].flatMap(group => group.refs).concat(recent.map(record => record.ref)))];
    const selected = mandatoryGroups.flatMap(group => group.entries.slice(1));
    const selectedRecent = [];
    // Price complete units with the existing exact renderer. Its unlimited
    // trial budget prevents it from silently omitting half a candidate unit.
    // The final omission count and every source header still consume maxChars.
    const renderSelected = () => {
      const packed = packContext({ currentTask, pinned, recent: selectedRecent, retrieved: selected, maxChars: Number.MAX_SAFE_INTEGER });
      const omittedRefs = allRefs.filter(ref => !packed.usedRefs.includes(ref));
      const text = packed.text.replace(/Omitted active records: \d+\. Read full originals by \[ref\]\.$/u,
        `Omitted active records: ${omittedRefs.length}. Read full originals by [ref].`);
      return { ...packed, text, chars: length(text), omittedRefs };
    };
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive safe integer');
    let packed = renderSelected();
    if (packed.chars > maxChars) throw new BudgetExceededError({ maxChars, requiredChars: packed.chars,
      requiredRefs: [...new Set(mandatoryGroups.flatMap(group => group.refs))] });
    const admittedGroups = [...mandatoryGroups], omittedGroups = [];
    for (const group of groups) {
      selected.push(...group.entries);
      const candidate = renderSelected();
      if (candidate.chars <= maxChars) { packed = candidate; admittedGroups.push(group); }
      else { selected.splice(selected.length - group.entries.length); omittedGroups.push(group); }
    }
    // Optional recency cannot displace an already admitted evidence bundle.
    for (const record of recent) {
      selectedRecent.push(record);
      const candidate = renderSelected();
      if (candidate.chars <= maxChars) packed = candidate;
      else selectedRecent.pop();
    }
    const summary = ({ parentRef, backgroundRefs, unavailableBackgroundRefs, refs }) => ({ parentRef, backgroundRefs, unavailableBackgroundRefs, refs });
    return { ...packed, retrievalStatus: retrieval.status, pinMode, groups: admittedGroups.map(summary),
      omittedGroups: omittedGroups.map(summary), citations: packed.usedRefs.map(ref => this.#evidence(this.read(ref))) };
  }

  recordFailure({ ref, actionKey, scope = {}, origin = 'manual' }) {
    if (typeof actionKey !== 'string' || !actionKey.trim()) throw new TypeError('actionKey must be a nonempty string');
    if (!object(scope)) throw new TypeError('failure scope must be an object');
    return this.remember({ ref, kind: 'failure', key: actionKey, scope, origin });
  }
  checkAction({ actionKey, scope = {} }) {
    if (typeof actionKey !== 'string' || !actionKey.trim()) throw new TypeError('actionKey must be a nonempty string');
    if (!object(scope)) throw new TypeError('action scope must be an object');
    const scanned = this.store.listMemories({ kinds: ['failure'], limit: 1000 });
    if (scanned.length === 1000) throw new RangeError('Failure scan limit reached; query or paginate explicitly before deciding applicability');
    const failures = scanned.filter(record => record.key === actionKey && this.read(record.ref)?.active);
    const applicable = failures.filter(record => canonical(record.scope) === canonical(scope));
    const unknownConditions = failures.filter(record => !applicable.includes(record) && (!object(record.scope) || !Object.keys(record.scope).length));
    return { actionKey, applicable, unknownConditions,
      otherConditions: failures.filter(record => !applicable.includes(record) && !unknownConditions.includes(record)),
      reviewRequired: applicable.length > 0 || unknownConditions.length > 0,
      note: 'Exact caller-supplied scope comparison, not a proof of applicability. Review unscoped evidence; this API does not execute or authorize actions.' };
  }

  /** Provenance/availability check only. It cannot prove semantic entailment. */
  checkCitations(answer, { allowedRefs = [] } = {}) {
    if (typeof answer !== 'string' || !Array.isArray(allowedRefs) || allowedRefs.some(ref => !validRef(ref))) throw new TypeError('Invalid citation check input');
    const refs = [...new Set([...answer.matchAll(/\[([1-9]\d*)\]/g)].map(match => Number(match[1])))];
    const allowed = new Set(allowedRefs);
    const unknown = refs.filter(ref => !validRef(ref) || !this.read(ref));
    const unprovided = refs.filter(ref => !allowed.has(ref));
    return { valid: !unknown.length && !unprovided.length, refs, unknown, unprovided, semanticEntailmentChecked: false };
  }
}

export const openConversation = options => new ConversationMemory(options);
