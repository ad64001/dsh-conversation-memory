import { detectEntities } from './memory-entities.mjs';

const keyStatement = /(?:失败|未成功|没有.{0,24}(?:迁移|执行|完成|写入)|不得|禁止|不能|不要|只读|停止|暂停|取消|撤销|纠正|更正|改为|尚未|未完成|failed|failure|not\s+(?:completed|successful|allowed)|did\s+not|no\s+(?:rows?|records?)\s+(?:were\s+)?(?:migrated|written)|do\s+not|must\s+not|read[- ]?only|cancel(?:led)?|stop(?:ped)?|correction|supersed|retract|unfinished|unresolved)/iu;
const controlParameter = /\b(?:max_tokens|batch_size|retry(?:_limit)?|timeout|readonly|threshold|budget|allow(?:ed)?|deny|force|overwrite|lockGeneration|driver)\s*(?:=|:|<=|>=|<|>)/iu;
const length = text => Array.from(text).length;

/** Conservative guard, not a semantic completeness claim. Bounded overflow
 * rejects pruning; exact original evidence remains the fallback.
 */
export function criticalEvidence(text) {
  const ranges = [];
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const end = offset + length(line);
    if (keyStatement.test(line) || controlParameter.test(line)) ranges.push({ start: offset, end, kind: 'decision-or-condition' });
    offset = end;
  }
  for (const item of detectEntities(text)) {
    if (item.categories.some(kind => kind === 'error' || kind === 'failure_evidence')) ranges.push({ start: item.start, end: item.end, kind: 'error-or-failure' });
  }
  const unique = [...new Map(ranges.map(row => [`${row.start}:${row.end}`, row])).values()];
  return { ranges: unique, overflow: unique.length > 256 };
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
