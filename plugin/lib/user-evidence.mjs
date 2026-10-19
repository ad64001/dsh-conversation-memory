import { cpLength } from './protocol.mjs';

// This is a source-location index, not a summary or a policy engine. In
// particular, neither an assistant paraphrase nor this classifier may revoke,
// merge, reinterpret or grant a user's instruction.
const instructionCue = /纠正|更正|修正|改为|改成|撤销|取消|不要|禁止|必须|只能|不允许|不能|不再|保持|未经|未授权|\b(?:correction|correct|instead|revoke|cancel|never|must|only)\b|\bdo\s+not\b|\bdon['’]t\b|\b[A-Za-z_]\w*\s*=/iu;
const filler = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'then', 'please', 'continue', 'resume', 'keep', 'going', 'next', 'now', '继续', '接着', '下一步', '按之前', '照之前', '请继续', '完成', '任务']);

/** Deliberately literal: paths, parameters, negations and additional facts are
 * new input, not an implicit request to revive some earlier task. */
export function isContinuationPrompt(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  return /^(?:(?:请|麻烦|劳驾|那就|那么)\s*)?(?:继续|接着)(?:一下|吧)?[。！!，,？?；;～~…]*$/u.test(value)
    || /^(?:please\s+)?(?:continue|resume|go\s+on|keep\s+going|proceed)(?:\s+please)?[.!?,;]*$/iu.test(value);
}

function terms(text) {
  const result = new Map();
  const lowered = text.toLowerCase();
  for (const token of lowered.match(/[a-z]:[\\/][^\s`"'<>，。；]+|(?:[\w.-]+[\\/])+[\w.()/-]+|\b[a-z_][a-z0-9_.-]{2,}\b/gu) ?? []) {
    for (const variant of new Set([token, token.replace(/[.,;:!?]+$/u, '')])) {
      if (variant && !filler.has(variant)) result.set(variant, /[\\/_.=]/u.test(variant) ? 4 : 2);
    }
  }
  for (const token of lowered.match(/\b\d{3,}\b/gu) ?? []) result.set(token, 3);
  for (const run of lowered.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (filler.has(run)) continue;
    for (let at = 0; at + 1 < run.length; at++) {
      const token = run.slice(at, at + 2);
      if (!filler.has(token)) result.set(token, 1);
    }
  }
  return result;
}

function matchScore(indexed, query) {
  let score = 0, concrete = 0, han = 0;
  for (const [term, weight] of query) if (indexed.has(term)) {
    score += weight;
    if (weight > 1) concrete++;
    else han++;
  }
  return concrete || han >= 2 ? score : 0;
}

function segments(text, width) {
  const points = Array.from(text), result = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + width);
    if (end < points.length) {
      // Prefer a complete clause. Splitting a long line remains an explicitly
      // partial exact excerpt; the consumer must read the rest before relying
      // on any statement whose qualifier may be outside the excerpt.
      for (let at = end - 1; at >= start + Math.floor(width / 2); at--) {
        if (/[\n。！？!?；;]/u.test(points[at])) { end = at + 1; break; }
      }
    }
    result.push({ start, end, text: points.slice(start, end).join('') });
    start = end;
  }
  return result;
}

/** Durable raw messages supply the index's truth. Only message IDs are saved in
 * bridge state; restart rebuilds lexical locations without a model call. The
 * full index is never rendered into the agent context. */
export class UserEvidenceIndex {
  constructor(memory) { this.memory = memory; this.messages = new Map(); }
  add(message) {
    if (message?.role !== 'user' || this.messages.has(message.id)) return;
    this.messages.set(message.id, { message, terms: terms(message.text), instruction: instructionCue.test(message.text) });
  }
  select({ query, excludeSourceSeq, limit, maxChars, continuation = false }) {
    const queryTerms = terms(query);
    const generic = queryTerms.size === 0 || /^(?:请|再|那就|现在|按照之前的要求|按之前的要求|按原来的要求|把|继续|接着|完成|当前|这个|这项|该|任务|工作|下一步|做|下去|执行|推进|。|！|!|，|,|\s)+$/u.test(query);
    const eligible = [...this.messages.values()].filter(item => item.message.metadata?.seq !== excludeSourceSeq || excludeSourceSeq === undefined);
    const anchor = continuation === true || isContinuationPrompt(query)
      ? eligible.filter(item => !isContinuationPrompt(item.message.text)).sort((a, b) => b.message.seq - a.message.seq)[0] : undefined;
    const matching = eligible
      .map(item => ({ ...item, score: matchScore(item.terms, queryTerms), scoped: [...queryTerms].some(([term, weight]) => weight >= 4 && item.terms.has(term)) }))
      .map(item => ({ ...item, anchor: item.message.id === anchor?.message.id }))
      .filter(item => item.anchor || item.score > 0 || (generic && item.instruction))
      // Recency orders overlapping original instructions; it is not a claim
      // that the newer one semantically supersedes a differently scoped one.
      .sort((a, b) => Number(b.anchor) - Number(a.anchor) || Number(b.scoped) - Number(a.scoped) || Number(b.instruction) - Number(a.instruction)
        || b.message.seq - a.message.seq || b.score - a.score);
    const records = [];
    const spanChars = Math.max(32, Math.min(1400, maxChars - 640));
    for (const item of matching) {
      if (records.length >= limit) break;
      const { message } = item;
      const totalChars = cpLength(message.text);
      // Whole originals have priority whenever they fit a conservative single
      // entry allowance. Long originals are navigable excerpts, never a claim
      // that every constraint of the source was provided.
      const wholeFits = totalChars <= Math.min(2800, Math.max(32, maxChars - 640));
      const pieces = wholeFits ? [{ start: 0, end: totalChars, text: message.text }]
        : segments(message.text, spanChars).map(part => ({ ...part, score: matchScore(terms(part.text), queryTerms), cue: instructionCue.test(part.text) }))
          .filter(part => item.anchor || part.score > 0 || part.cue)
          .sort((a, b) => b.score - a.score || Number(b.cue) - Number(a.cue) || a.start - b.start).slice(0, 2);
      for (const part of pieces) {
        if (records.length >= limit) break;
        const source = this.memory.read(this.memory.cite({ messageId: message.id, start: part.start, end: part.end }).ref);
        if (!source?.active) continue;
        records.push({ ...source, kind: 'user-original', sourceRole: 'user', sourceSeq: message.seq,
          sourceKey: message.sourceKey, priorityUser: true, userPriority: item.anchor ? 4 : item.instruction ? 3 : 1, scope: {},
          original: { ref: source.ref, messageId: message.id, sourceRole: 'user', sourceSeq: message.seq, eventSeq: message.metadata?.seq,
            start: part.start, end: part.end, totalChars, partial: !wholeFits, nextStart: part.end < totalChars ? part.end : null,
            instructionCue: item.instruction, continuationAnchor: item.anchor, text: part.text } });
      }
    }
    return { records, matchingMessages: matching.length, genericFallback: generic,
      scopedMessageIds: matching.filter(item => item.scoped).map(item => item.message.id), scopedQuery: [...queryTerms.values()].some(weight => weight >= 4) };
  }
}
