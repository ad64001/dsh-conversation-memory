/** Lossless Unicode-code-point chunk planning. No API, summarization, or DSH access. */

const MODEL_WINDOW_MULTIPLIER = 4;

function requireText(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
}

function requireLimit(maxChunkChars) {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new RangeError("maxChunkChars must be a positive safe integer");
  }
}

function codePoints(text) {
  requireText(text);
  return Array.from(text);
}

function validOffsets(length, boundaries, maxChunkChars) {
  if (!Array.isArray(boundaries)) return false;
  if (length === 0) return boundaries.length === 0;
  let previous = 0;
  for (const boundary of boundaries) {
    if (
      !Number.isSafeInteger(boundary) || boundary <= previous ||
      boundary > length || boundary - previous > maxChunkChars
    ) return false;
    previous = boundary;
  }
  return previous === length;
}

/** End offsets are code points, strictly increasing, exclude 0, include text length.
 * A true result guarantees contiguous complete coverage with each segment <= limit.
 */
export function validateBoundaries(text, boundaries, maxChunkChars) {
  if (typeof text !== "string" || !Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    return false;
  }
  return validOffsets(Array.from(text).length, boundaries, maxChunkChars);
}

function lineCandidates(points) {
  const candidates = [];
  let start = 0;
  let fence = null;
  let previousBlank = false;
  while (start < points.length) {
    let end = start;
    while (end < points.length && points[end] !== "\n") end += 1;
    const next = end < points.length ? end + 1 : end;
    const body = points.slice(start, end).join("").replace(/\r$/, "");
    const blank = /^\s*$/.test(body);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    let fenceLine = false;
    if (marker) {
      const character = marker[1][0];
      if (fence === null) {
        fence = { character, length: marker[1].length };
        fenceLine = true;
      } else if (
        fence.character === character && marker[1].length >= fence.length &&
        /^\s*$/.test(marker[2])
      ) {
        fence = null;
        fenceLine = true;
      }
    }
    // Larger rank wins inside the final half-window. A fence delimiter is always
    // kept intact when a line boundary can be selected; oversized lines hard-split.
    let rank = fence === null ? 2 : 1;
    if (blank && fence === null) rank = 4;
    if (fenceLine) rank = 3;
    if (previousBlank && !blank && start > 0 && !fenceLine) {
      candidates.push({ offset: start, rank: fence === null ? 4 : 1 });
    }
    if (next > start) candidates.push({ offset: next, rank });
    previousBlank = blank;
    start = next;
  }
  candidates.sort((a, b) => a.offset - b.offset || a.rank - b.rank);
  return candidates;
}

function upperBound(candidates, offset) {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candidates[middle].offset <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fallbackOffsets(points, maxChunkChars) {
  const boundaries = [];
  const candidates = lineCandidates(points);
  let cursor = 0;
  while (cursor < points.length) {
    const hardEnd = Math.min(points.length, cursor + maxChunkChars);
    if (hardEnd === points.length) {
      boundaries.push(hardEnd);
      break;
    }
    const minimum = cursor + Math.max(1, Math.ceil(maxChunkChars / 2));
    let chosen = hardEnd;
    let bestRank = -1;
    for (let index = upperBound(candidates, hardEnd) - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate.offset < minimum) break;
      if (candidate.offset > cursor && candidate.rank > bestRank) {
        chosen = candidate.offset;
        bestRank = candidate.rank;
      }
    }
    // Preserve CRLF together if a hard split is necessary and the budget permits.
    if (bestRank < 0 && chosen - cursor > 1 && points[chosen - 1] === "\r" && points[chosen] === "\n") {
      chosen -= 1;
    }
    boundaries.push(chosen);
    cursor = chosen;
  }
  return boundaries;
}

function chunksAt(points, boundaries) {
  let start = 0;
  return boundaries.map((end) => {
    const chunk = points.slice(start, end).join("");
    start = end;
    return chunk;
  });
}

/** Deterministic paragraph/line/fence-aware fallback; concatenating the returned
 * strings reproduces text exactly. All lengths and cuts use Unicode code points.
 */
export function splitLosslessly(text, maxChunkChars) {
  requireLimit(maxChunkChars);
  const points = codePoints(text);
  return chunksAt(points, fallbackOffsets(points, maxChunkChars));
}

async function decideOnce(decideBoundaries, payload, signal) {
  if (signal?.aborted) return { status: "aborted" };
  let onAbort;
  const work = Promise.resolve().then(() => {
    if (signal?.aborted) return { status: "aborted" };
    return Promise.resolve(decideBoundaries(payload)).then(
      (boundaries) => ({ status: "resolved", boundaries }),
      () => ({ status: "failed" }),
    );
  }).catch(() => ({ status: "failed" }));
  if (!signal || typeof signal.addEventListener !== "function") return work;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve({ status: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** decideBoundaries({text,startOffset,endOffset,maxChunkChars,signal}) returns an
 * array of relative code-point END offsets, including window length. Each fixed
 * <= 4*limit window permits at most one call; <=limit windows need no model call.
 * Invalid/rejected/aborted decisions fall back without discarding original text.
 * Cancellation stops new calls and races pending work; the adapter must honor
 * signal to cancel its underlying operation. Only source slices become chunks.
 */
export async function planSemanticChunks(text, {
  maxChunkChars,
  decideBoundaries,
  signal,
} = {}) {
  requireLimit(maxChunkChars);
  const points = codePoints(text);
  if (decideBoundaries !== undefined && typeof decideBoundaries !== "function") {
    throw new TypeError("decideBoundaries must be a function when supplied");
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal when supplied");
  }
  if (decideBoundaries === undefined || points.length <= maxChunkChars) {
    const boundaries = fallbackOffsets(points, maxChunkChars);
    return { chunks: chunksAt(points, boundaries), boundaries, usedModel: false,
      modelCalls: 0, fallbackWindows: 0, warnings: [] };
  }
  const windowChars = Math.min(Number.MAX_SAFE_INTEGER, maxChunkChars * MODEL_WINDOW_MULTIPLIER);
  const boundaries = [];
  const warnings = [];
  let modelCalls = 0;
  let fallbackWindows = 0;
  let acceptedWindows = 0;
  let windowIndex = 0;
  for (let start = 0; start < points.length; start += windowChars, windowIndex += 1) {
    const end = Math.min(points.length, start + windowChars);
    const windowPoints = points.slice(start, end);
    let local;
    if (windowPoints.length <= maxChunkChars) {
      local = [windowPoints.length];
    } else {
      let decision;
      if (signal?.aborted) decision = { status: "aborted" };
      else {
        modelCalls += 1;
        decision = await decideOnce(decideBoundaries, {
          text: windowPoints.join(""), startOffset: start, endOffset: end,
          maxChunkChars, signal,
        }, signal);
      }
      if (decision.status === "resolved" && validOffsets(windowPoints.length, decision.boundaries, maxChunkChars)) {
        local = decision.boundaries.slice();
        acceptedWindows += 1;
      } else {
        local = fallbackOffsets(windowPoints, maxChunkChars);
        fallbackWindows += 1;
        const reason = decision.status === "resolved" ? "invalid-boundaries" : decision.status;
        warnings.push(`window ${windowIndex} [${start},${end}): ${reason}; kept original text`);
      }
    }
    for (const offset of local) boundaries.push(start + offset);
  }
  // Defensive final invariant: an unexpected internal error cannot yield partial
  // coverage. Reconstruct only from validated original-text code-point offsets.
  if (!validOffsets(points.length, boundaries, maxChunkChars)) {
    const safe = fallbackOffsets(points, maxChunkChars);
    return { chunks: chunksAt(points, safe), boundaries: safe, usedModel: false,
      modelCalls, fallbackWindows: fallbackWindows + 1,
      warnings: [...warnings, "final coverage validation failed; kept original text"] };
  }
  return { chunks: chunksAt(points, boundaries), boundaries, usedModel: acceptedWindows > 0,
    modelCalls, fallbackWindows, warnings };
}

/** Stable source references for a later selector: 1-based line/part numbers and
 * global code-point offsets. Newline bytes remain in records; oversized single
 * lines split into bounded sublines. Joining record.text is exactly the source.
 */
export function indexLosslessLines(text, maxPartChars = 1024) {
  requireLimit(maxPartChars);
  const points = codePoints(text);
  const records = [];
  let lineNumber = 1;
  let start = 0;
  while (start < points.length) {
    let lineEnd = start;
    while (lineEnd < points.length && points[lineEnd] !== "\n") lineEnd += 1;
    if (lineEnd < points.length) lineEnd += 1;
    let partNumber = 1;
    for (let partStart = start; partStart < lineEnd; partNumber += 1) {
      let partEnd = Math.min(lineEnd, partStart + maxPartChars);
      if (partEnd < lineEnd && partEnd - partStart > 1 && points[partEnd - 1] === "\r" && points[partEnd] === "\n") {
        partEnd -= 1;
      }
      records.push({ id: `${lineNumber}:${partNumber}`, lineNumber, partNumber,
        startOffset: partStart, endOffset: partEnd,
        text: points.slice(partStart, partEnd).join("") });
      partStart = partEnd;
    }
    start = lineEnd;
    lineNumber += 1;
  }
  return records;
}
