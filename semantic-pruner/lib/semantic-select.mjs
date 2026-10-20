import { splitLosslessly, indexLosslessLines } from './semantic-core.mjs';
import { detectEntities, entityCoverage } from './memory-entities.mjs';
import { auditCriticalSpans } from './critical-evidence.mjs';

export const SELECTION_DEFAULTS = Object.freeze({
  thresholdChars: 8192,
  targetChars: 5159,
  maxChunkChars: 8192,
  maxChunks: 32,
});
export const SELECTION_GAP_MARKER = '\n\n[... omitted; full source below ...]\n\n';
export const MAX_ITEM_CHARS = 256;
export const MAX_CHUNK_ITEMS = 1024;

const lengthOf = (text) => Array.from(text).length;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function formatSourceFooter(sourceRef) {
  return `\n\n[Full original: ${sourceRef}]`;
}

/** Race cancellation without requiring an injected judge to settle first. The
 * underlying operation still receives signal and must cancel its own transport.
 */
async function judgeOnce(judge, payload, signal) {
  if (signal?.aborted) return { status: 'aborted' };
  const work = Promise.resolve().then(() => {
    if (signal?.aborted) return { status: 'aborted' };
    return Promise.resolve(judge(payload)).then(
      (value) => ({ status: 'resolved', value }),
      error => ({ status: 'failed', code: /^[A-Z_]{1,50}$/.test(error?.code ?? '') ? error.code : 'SELECTION_UNAVAILABLE' }),
    );
  }).catch(() => ({ status: 'failed' }));
  if (!signal) return work;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve({ status: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function validSelection(selection, itemCount) {
  return Array.isArray(selection) && selection.every((range) =>
    range !== null && typeof range === 'object' && !Array.isArray(range) &&
    Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
    range.start >= 0 && range.end >= range.start && range.end < itemCount &&
    Number.isInteger(range.priority) && range.priority >= 1 && range.priority <= 5 &&
    (range.atomic === undefined || typeof range.atomic === 'boolean'));
}

function renderSelection(items, selected, footer) {
  const output = [];
  let inGap = false;
  for (let index = 0; index < items.length; index += 1) {
    if (selected[index]) {
      output.push(items[index].text);
      inGap = false;
    } else if (!inGap) {
      output.push(SELECTION_GAP_MARKER);
      inGap = true;
    }
  }
  output.push(footer);
  return output.join('');
}

/** Select exact source fragments under a whole-result code-point budget.
 *
 * judge({items,chunkIndex,chunkCount,targetChars,signal}) runs once per chunk.
 * Each item is {index,text,start,end}; offsets are global code-point offsets
 * [start,end). Returned {start,end,priority} ranges use chunk-local item indexes,
 * inclusive at both ends. Priority is 1..5, with 5 highest. Empty per-chunk
 * selections are valid. Any failed chunk leaves the entire original unchanged.
 * No model text is copied into the result, and no fragment is partially cut.
 */
export async function selectSemantically(text, {
  judge,
  sourceRef,
  thresholdChars = SELECTION_DEFAULTS.thresholdChars,
  targetChars = SELECTION_DEFAULTS.targetChars,
  maxChunkChars = SELECTION_DEFAULTS.maxChunkChars,
  maxChunks = SELECTION_DEFAULTS.maxChunks,
  signal,
} = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const inputChars = lengthOf(text);
  const stats = {
    inputChars, outputChars: inputChars, chunkCount: 0, modelCalls: 0,
    fragmentCount: 0, candidateItems: 0, selectedItems: 0,
    selectedChars: 0, omittedChars: 0, targetChars,
  };
  const unchanged = (reason, extra = {}) => ({
    changed: false, text, reason, stats: { ...stats, ...extra },
  });
  if (![thresholdChars, targetChars, maxChunkChars, maxChunks].every(positiveInteger) ||
    typeof judge !== 'function' ||
    (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
    return unchanged('invalid-config');
  }
  if (signal?.aborted) return unchanged('aborted');
  if (inputChars <= thresholdChars) return unchanged('under-threshold');
  if (typeof sourceRef !== 'string' || sourceRef.trim().length === 0) {
    return unchanged('source-ref-required');
  }
  const footer = formatSourceFooter(sourceRef);
  const gapChars = lengthOf(SELECTION_GAP_MARKER);
  const footerChars = lengthOf(footer);
  if (footerChars + gapChars >= targetChars) return unchanged('budget-too-small');
  const chunks = splitLosslessly(text, maxChunkChars);
  stats.chunkCount = chunks.length;
  if (chunks.length > maxChunks) return unchanged('max-chunks');
  // Defensive: chunk planning must never silently drop or change source text.
  if (chunks.join('') !== text || chunks.some((chunk) => lengthOf(chunk) > maxChunkChars)) {
    return unchanged('invalid-chunks');
  }
  const items = [];
  const chunkItems = [];
  let offset = 0;
  for (const chunk of chunks) {
    const local = indexLosslessLines(chunk, MAX_ITEM_CHARS).map((record, index) =>
      Object.freeze({ index, text: record.text,
        start: offset + record.startOffset, end: offset + record.endOffset }));
    chunkItems.push(Object.freeze(local));
    items.push(...local);
    offset += lengthOf(chunk);
  }
  stats.fragmentCount = items.length;
  if (items.map((item) => item.text).join('') !== text || offset !== inputChars) {
    return unchanged('invalid-chunks');
  }
  // Check the entire pass before dispatch: thousands of one-character lines
  // would make item metadata much larger than the bounded source chunk itself.
  if (chunkItems.some((local) => local.length > MAX_CHUNK_ITEMS)) {
    return unchanged('max-items');
  }
  const priorities = new Uint8Array(items.length);
  const modelCriticalRanges = [];
  const detectedEntities = detectEntities(text);
  let base = 0;
  for (let chunkIndex = 0; chunkIndex < chunkItems.length; chunkIndex += 1) {
    if (signal?.aborted) return unchanged('aborted', { failedChunkIndex: chunkIndex });
    stats.modelCalls += 1;
    const response = await judgeOnce(judge, Object.freeze({
      items: chunkItems[chunkIndex], chunkIndex, chunkCount: chunks.length,
      previousBackground: chunkIndex === 0 ? null : Object.freeze({
        readOnly: true, sourceRef,
        start: chunkItems[chunkIndex][0].start - Math.min(1024, lengthOf(chunks[chunkIndex - 1])),
        end: chunkItems[chunkIndex][0].start,
        text: Array.from(chunks[chunkIndex - 1]).slice(-1024).join(''),
      }),
      targetChars, signal,
    }), signal);
    if (response.status === 'aborted' || signal?.aborted) {
      return unchanged('aborted', { failedChunkIndex: chunkIndex });
    }
    if (response.status !== 'resolved') {
      return unchanged('judge-error', { failedChunkIndex: chunkIndex, modelErrorCode: response.code });
    }
    if (!validSelection(response.value, chunkItems[chunkIndex].length)) {
      return unchanged('invalid-selection', { failedChunkIndex: chunkIndex });
    }
    for (const range of response.value) {
      if (range.priority === 5 || range.atomic === true) modelCriticalRanges.push({ start: items[base + range.start].start, end: items[base + range.end].end });
      for (let index = range.start; index <= range.end; index += 1) {
        priorities[base + index] = Math.max(priorities[base + index], range.priority);
      }
    }
    base += chunkItems[chunkIndex].length;
  }
  const candidates = Array.from(priorities, (priority, index) => ({ priority, index }))
    .filter(({ priority }) => priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  stats.candidateItems = candidates.length;
  if (candidates.length === 0) return unchanged('no-candidates');

  const selected = new Uint8Array(items.length);
  let renderedChars = gapChars + footerChars;
  let selectedChars = 0;
  let selectedItems = 0;
  // Selected neighbours eliminate gap markers. This exact local cost calculation
  // avoids repeatedly rendering the whole result for every candidate.
  for (const { index } of candidates) {
    const leftOmitted = index > 0 && selected[index - 1] === 0;
    const rightOmitted = index + 1 < items.length && selected[index + 1] === 0;
    const gapDelta = Number(leftOmitted) + Number(rightOmitted) - 1;
    const itemChars = items[index].end - items[index].start;
    const nextChars = renderedChars + itemChars + gapDelta * gapChars;
    if (nextChars > targetChars) continue;
    selected[index] = 1;
    renderedChars = nextChars;
    selectedChars += itemChars;
    selectedItems += 1;
  }
  if (signal?.aborted) return unchanged('aborted');
  if (selectedItems === 0) return unchanged('budget-too-small');
  const output = renderSelection(items, selected, footer);
  const outputChars = lengthOf(output);
  if (outputChars > targetChars || outputChars !== renderedChars) {
    return unchanged('invalid-budget');
  }
  if (outputChars >= inputChars) return unchanged('no-reduction');
  const coverage = entityCoverage(detectedEntities, items.filter((_, index) => selected[index]));
  const selectedEntities = coverage.filter(entity => entity.selected).length;
  const selectedSpans = items.filter((_, index) => selected[index]).map(({ start, end }) => ({ start, end }));
  const criticalCoverage = auditCriticalSpans(text, selectedSpans, modelCriticalRanges);
  const evidenceCoverage = { sourceRef, detected: coverage.length, selected: selectedEntities,
    omitted: coverage.filter(entity => !entity.selected) };
  if (!criticalCoverage.accepted) return { ...unchanged(criticalCoverage.overflow ? 'critical-evidence-overflow' : 'critical-evidence-missing',
    { detectedEntities: coverage.length, selectedEntities, omittedEntities: coverage.length - selectedEntities }),
    coverage: evidenceCoverage, criticalCoverage };
  return {
    changed: true, text: output, reason: 'selected',
    selectedSpans, criticalCoverage,
    // Every omission still resolves to the saved full original. These audit
    // spans are not extra text injected outside the existing output budget.
    coverage: evidenceCoverage,
    stats: { ...stats, outputChars, selectedItems, selectedChars,
      omittedChars: inputChars - selectedChars, detectedEntities: coverage.length,
      selectedEntities, omittedEntities: coverage.length - selectedEntities },
  };
}
