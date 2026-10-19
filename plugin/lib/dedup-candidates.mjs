// Mechanical source packaging only. These boundaries make no relevance,
// duplication or supersession decisions; the current model selects every ID.
const cp = value => Array.from(value).length;
const HEADER = /^\[([^\]\r\n]{1,256})\]\s+(?:(source|user-original|entity|constraint|decision|fact|failure|correction|state|inference)\b|(上一段原文背景)\s+for=\[([^\]\r\n]{1,256})\])/;
const TARGET = 768;

function paragraphs(text, start) {
  const result = [];
  let offset = start;
  let pending = '', fence = null;
  const flush = () => {
    if (!pending) return;
    const end = offset + cp(pending);
    const previous = result.at(-1);
    if (previous && cp(previous.text) + cp(pending) <= TARGET) {
      previous.text += pending; previous.end = end;
    } else result.push({ start: offset, end, text: pending });
    offset = end; pending = '';
  };
  // Keep complete quoted/unquoted paragraphs and fenced code blocks with all
  // separators. Oversized atomic paragraphs stay visible but ineligible rather
  // than turning half a negation, identifier or condition into a candidate.
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    pending += line[0];
    const value = line[0].replace(/^\s*> ?/, '').trimEnd();
    const marker = value.match(/^[\t ]*(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (fence === null && /^[\t ]*(?:>[\t ]*)?\r?\n$/.test(line[0])) flush();
  }
  flush();
  return result;
}

function ordinaryParts(text, start) {
  const points = Array.from(text), headers = [];
  let position = 0;
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const header = line[0].match(HEADER);
    if (header) headers.push({ start: position, headerEnd: position + cp(line[0]), ref: header[1], backgroundFor: header[4] });
    position += cp(line[0]);
  }
  if (!headers.length) return paragraphs(text, start);
  const result = [];
  if (headers[0].start) result.push(...paragraphs(points.slice(0, headers[0].start).join(''), start));
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index], end = headers[index + 1]?.start ?? points.length;
    const block = points.slice(header.start, end).join('');
    const contextStarts = headers.slice(0, index).filter(other => other.backgroundFor === header.ref).map(other => start + other.start);
    if (header.backgroundFor !== undefined) {
      result.push({ start: start + header.start, end: start + end, text: block, context: true, backgroundFor: header.backgroundFor });
      continue;
    }
    if (header.headerEnd === end) {
      result.push({ start: start + header.start, end: start + end, text: block, context: true, contextStarts, citationRef: header.ref });
      continue;
    }
    if (end - header.start <= TARGET) {
      result.push({ start: start + header.start, end: start + end, text: block, contextStarts, citationRef: header.ref });
      continue;
    }
    const context = { start: start + header.start, end: start + header.headerEnd,
      text: points.slice(header.start, header.headerEnd).join(''), context: true, contextStarts, citationRef: header.ref };
    result.push(context);
    for (const body of paragraphs(points.slice(header.headerEnd, end).join(''), start + header.headerEnd)) {
      result.push({ ...body, contextStarts: [...contextStarts, context.start], citationRef: header.ref });
    }
  }
  return result;
}

/** Return a lossless ordered partition. Required boundaries are authoritative
 * exact ranges supplied by the caller, never discovered semantically here. */
export function partitionDedupSource(source, requiredUnits = []) {
  const points = Array.from(source.text), result = [];
  const required = [...requiredUnits].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const unit of required) {
    if (unit.start > at) result.push(...ordinaryParts(points.slice(at, unit.start).join(''), at));
    const header = unit.text.match(HEADER);
    result.push({ start: unit.start, end: unit.end, text: unit.text, requiredRef: unit.ref,
      citationRef: header?.[1], backgroundFor: header?.[4] });
    at = unit.end;
  }
  if (at < points.length) result.push(...ordinaryParts(points.slice(at).join(''), at));
  if (!result.length && points.length === 0) return [];
  return result;
}

export default partitionDedupSource;
