/** Deterministic omission guard, not a claim/fact extractor. Every item is an
 * exact code-point span in the immutable original. Detection is deliberately
 * conservative and cannot promise that every domain-specific entity is found.
 */
const points = text => Array.from(text);

export function detectEntities(text, { start = 0, end = points(text).length, baseOffset = 0 } = {}) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('text must be well-formed Unicode');
  const size = points(text).length;
  if (!Number.isSafeInteger(baseOffset) || baseOffset < 0) throw new RangeError('Invalid entity baseOffset');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) throw new RangeError('Invalid entity scan span');
  const spans = new Map();
  const offsets = new Uint32Array(text.length + 1);
  let utf = 0, cp = 0;
  for (const char of text) {
    for (let index = 0; index < char.length; index++) offsets[utf + index] = cp;
    utf += char.length;
    offsets[utf] = ++cp;
  }
  const add = (category, utfStart, utfEnd) => {
    const from = offsets[utfStart], to = offsets[utfEnd];
    if (to <= start || from >= end || from === to) return;
    const key = `${from}:${to}`;
    const old = spans.get(key);
    if (old) { if (!old.categories.includes(category)) old.categories.push(category); return; }
    spans.set(key, { start: from, end: to, quote: text.slice(utfStart, utfEnd), categories: [category] });
  };
  const scan = (category, pattern, group = 0) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[group];
      const at = match.index + (group ? match[0].indexOf(value) : 0);
      add(category, at, at + value.length);
    }
  };
  // Both common path syntaxes. Quoted paths retain embedded spaces. Unquoted
  // paths stop at punctuation that normally separates prose/code expressions.
  scan('path', /["'`]((?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\r\n"'`]+)["'`]/gu, 1);
  scan('path', /(?<![A-Za-z0-9_.-])(?:[A-Za-z]:[\\/]|(?:\.{1,2}\/)|(?:\/)?[A-Za-z0-9_.-]+[\\/])[^\s"'`<>|,;，；。(){}\[\]]+/gu);
  scan('identifier', /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?(?=\s*\()/gu);
  scan('identifier', /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)/gu);
  scan('identifier', /\b[A-Za-z_$][A-Za-z0-9$]*(?:_[A-Za-z0-9_$]+)+\b/gu);
  scan('identifier', /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[a-z][A-Z])[A-Za-z0-9_$]*\b/gu);
  scan('identifier', /`([A-Za-z_$][A-Za-z0-9_$]*)`/gu, 1);
  scan('error', /\b(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception)|E[A-Z_-]*\d[A-Z0-9_-]*|E_[A-Z0-9_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOENT|EACCES|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+)\b/gu);
  scan('error', /\b(?:Error|ERROR|errno|code|HTTP)[\s:=#-]+[A-Z0-9][A-Z0-9_.-]*(?:\s*:\s*[^\r\n;；。]{1,240})?/gu);
  scan('parameter', /(?<![\w$])["']?[A-Za-z_$][\w$.-]*["']?(?:\s*(?:=|:|<=|>=|<|>)\s*)(?:["'][^\r\n"']{1,240}["']|[-+]?(?:\d+(?:\.\d+)*|\.\d+)(?:[eE][-+]?\d+)?(?:\s*(?:%|KiB|MiB|GiB|KB|MB|GB|ms|sec|tokens|chars))?|[A-Za-z_][A-Za-z0-9_./:@+-]*)/gu);
  // Keep an original paragraph/sentence with explicit failure wording. This is
  // evidence of what was reported, never an inferred cause or permanent ban.
  for (const match of text.matchAll(/(?:证实无效|确认无效|尝试.{0,80}(?:无效|失败|不成功)|试过.{0,80}(?:无效|失败)|(?:executed|tried|attempted|ran).{0,100}(?:failed|did not work|ineffective)|(?:失败|未成功|无效方案|dead end|did not work|failed))/giu)) {
    const lineStart = Math.max(text.lastIndexOf('\n', match.index - 1) + 1, match.index - 600);
    const next = text.indexOf('\n', match.index + match[0].length);
    let lineEnd = next === -1 ? text.length : next;
    lineEnd = Math.min(lineEnd, match.index + match[0].length + 600);
    // Avoid cutting surrogate pairs at bounded window edges.
    const safeStart = lineStart > 0 && /[\uDC00-\uDFFF]/u.test(text[lineStart]) ? lineStart - 1 : lineStart;
    const safeEnd = lineEnd < text.length && /[\uDC00-\uDFFF]/u.test(text[lineEnd]) ? lineEnd + 1 : lineEnd;
    add('failure_evidence', safeStart, safeEnd);
  }
  return [...spans.values()].sort((left, right) => left.start - right.start || left.end - right.end)
    .map(span => ({ ...span, start: span.start + baseOffset, end: span.end + baseOffset, categories: span.categories.sort() }));
}

/** Check source coverage by position rather than substring presence: repeated
 * identifiers in a different location cannot cover the omitted occurrence. */
export function entityCoverage(entities, selectedSpans) {
  if (!Array.isArray(entities) || !Array.isArray(selectedSpans)) throw new TypeError('coverage requires arrays');
  const merged = [];
  for (const span of [...selectedSpans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new TypeError('Invalid selected source span');
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return entities.map(entity => ({ ...entity, selected: merged.some(span =>
    span.start <= entity.start && span.end >= entity.end) }));
}
