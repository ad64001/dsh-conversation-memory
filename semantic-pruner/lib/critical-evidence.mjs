import { detectEntities } from './memory-entities.mjs';

const keyStatement = /(?:失败|未成功|未执行|未写入|未迁移|为零|零条|没有.{0,24}(?:迁移|执行|完成|写入)|不得|禁止|严禁|不能|不要|只读|停止|暂停|取消|撤销|纠正|更正|改为|尚未|未完成|failed|failure|never\s+(?:overwrite|write|delete|execute|run)|not\s+(?:completed|successful|allowed)|did\s+not|no\s+(?:rows?|records?)\s+(?:were\s+)?(?:migrated|written)|do\s+not|must\s+not|read[- ]?only|cancel(?:led)?|stop(?:ped)?|correction|supersed|retract|unfinished|unresolved)/iu;
const controlKeys = /^(?:max_tokens|batch_size|retry(?:_limit)?|timeout(?:_ms)?|readonly|threshold|budget|allow(?:ed)?|deny|force|overwrite|lockGeneration|driver|success|status|exit_?code|exitCode|returncode|rowsAffected|rows_affected|affected_rows|rowCount|recordsWritten|error|errors)$/iu;
const controlParameter = /\b(?:max_tokens|batch_size|retry(?:_limit)?|timeout(?:_ms)?|readonly|threshold|budget|allow(?:ed)?|deny|force|overwrite|lockGeneration|driver|success|status|exit_?code|returncode|rowsAffected|rows_affected|affected_rows|rowCount|recordsWritten)\b["']?\s*(?:=|:|<=|>=|<|>)/iu;
const scopeLine = /^(?:\s*)(?:scope|target|object|task|project|resource|database|table|范围|对象|项目|任务|数据库|表)\s*[:：=]/iu;
const conditionLine = /^\s*(?:condition\s*[:：]|if\b|unless\b|when\b|条件\s*[:：]|如果|若|当)/iu;
const length = text => Array.from(text).length;

/** Conservative guard, not a semantic completeness claim. Bounded overflow
 * rejects pruning; exact original evidence remains the fallback.
 */
export function criticalEvidence(text) {
  const ranges = [];
  let scopes = [];
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const end = offset + length(line);
    const range = { start: offset, end, kind: 'decision-or-condition' };
    if (scopeLine.test(line)) scopes = [{ ...range, kind: 'scope' }];
    else if (conditionLine.test(line)) scopes.push({ ...range, kind: 'condition' });
    if (keyStatement.test(line) || controlParameter.test(line)) {
      ranges.push(...scopes, range);
      if (scopes.length) ranges.push({ start: scopes[0].start, end, kind: 'scope-or-condition-group' });
    }
    offset = end;
  }
  // Parse balanced JSON/JSONL objects, preserving the entire enclosing object
  // (including scope and call identifiers). Never use a reserialized substitute.
  let start = -1, depth = 0, quoted = false, escaped = false, invalidStructured = false;
  const hasControl = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => controlKeys.test(key) || hasControl(item));
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === '{' || char === '[') { start = index; depth = 1; quoted = false; escaped = false; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    if (char === '}' || char === ']') depth--;
    if (!depth) {
      const original = text.slice(start, index + 1);
      if (original.length > 65536) { if (controlParameter.test(original)) invalidStructured = true; }
      else try {
        if (hasControl(JSON.parse(original))) ranges.push({ start: length(text.slice(0, start)), end: length(text.slice(0, index + 1)), kind: 'structured-evidence-group' });
      } catch { if (controlParameter.test(original)) invalidStructured = true; }
      start = -1;
    }
  }
  if (start >= 0 && controlParameter.test(text.slice(start))) invalidStructured = true;
  for (const item of detectEntities(text)) {
    if (item.categories.some(kind => kind === 'error' || kind === 'failure_evidence')) ranges.push({ start: item.start, end: item.end, kind: 'error-or-failure' });
  }
  const unique = [...new Map(ranges.map(row => [`${row.start}:${row.end}`, row])).values()];
  return { ranges: unique, overflow: unique.length > 256 || scopes.length > 32 || invalidStructured };
}

export function auditCriticalSpans(text, selectedSpans, modelCriticalRanges = []) {
  const detected = criticalEvidence(text);
  const required = [...detected.ranges, ...modelCriticalRanges.map(row => ({ ...row, kind: 'model-critical-range' }))];
  if (detected.overflow || required.length > 512) return { accepted: false, overflow: true, required: required.length,
    missingCount: null, missing: [], truncated: true };
  const selected = selectedSpans.slice().sort((a, b) => a.start - b.start);
  const covered = range => {
    let cursor = range.start;
    for (const span of selected) { if (span.end <= cursor) continue; if (span.start > cursor) return false; cursor = Math.max(cursor, span.end); if (cursor >= range.end) return true; }
    return cursor >= range.end;
  };
  const missing = required.filter(row => !covered(row));
  return { accepted: !detected.overflow && !missing.length, overflow: detected.overflow,
    required: required.length, missingCount: missing.length, missing: missing.slice(0, 64), truncated: missing.length > 64 };
}

/** Defense at the native commit boundary, including injected selector adapters. */
export function auditCriticalOutput(text, output) {
  const detected = criticalEvidence(text), points = Array.from(text);
  if (detected.overflow) return { accepted: false, overflow: true, required: detected.ranges.length,
    missingCount: null, missing: [], truncated: true };
  const missing = detected.ranges.filter(row => !output.includes(points.slice(row.start, row.end).join('')));
  return { accepted: !detected.overflow && !missing.length, overflow: detected.overflow,
    required: detected.ranges.length, missingCount: missing.length, missing: missing.slice(0, 64), truncated: missing.length > 64 };
}
