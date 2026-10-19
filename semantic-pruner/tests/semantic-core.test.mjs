import test from "node:test";
import assert from "node:assert/strict";
import {
  splitLosslessly, validateBoundaries, planSemanticChunks, indexLosslessLines,
} from "../lib/semantic-core.mjs";

const cpLength = (text) => Array.from(text).length;
function assertLossless(text, chunks, limit) {
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(cpLength(chunk) > 0);
    assert.ok(cpLength(chunk) <= limit);
  }
}

test("empty, exact-limit, and invalid limits have explicit contracts", () => {
  assert.deepEqual(splitLosslessly("", 1), []);
  assert.deepEqual(splitLosslessly("abcd", 4), ["abcd"]);
  assert.equal(validateBoundaries("", [], 4), true);
  assert.equal(validateBoundaries("", [0], 4), false);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, "4"]) {
    assert.throws(() => splitLosslessly("abc", invalid), RangeError);
    assert.equal(validateBoundaries("abc", [3], invalid), false);
  }
});

test("Unicode offsets count supplementary characters once and preserve raw text", () => {
  const text = "A😀B𠮷C\r\nD";
  assertLossless(text, splitLosslessly(text, 3), 3);
  assert.equal(validateBoundaries(text, [3, 6, 8], 3), true);
  assert.equal(validateBoundaries(text, [3, 6, text.length], 3), false);
  assert.deepEqual(splitLosslessly("😀😀😀", 1), ["😀", "😀", "😀"]);
});

test("validation rejects gaps in coverage, overlap, invalid values, and oversized chunks", () => {
  assert.equal(validateBoundaries("abcdef", [3, 6], 3), true);
  for (const invalid of [[3], [0, 3, 6], [3, 3, 6], [4, 6], [3, 7], [3.5, 6], [NaN, 6], [6, 3], "3,6"]) {
    assert.equal(validateBoundaries("abcdef", invalid, 3), false);
  }
});

test("fallback prefers paragraph boundaries in the final half-window", () => {
  const text = "alpha\n\nbeta gamma delta";
  const chunks = splitLosslessly(text, 12);
  assert.equal(chunks[0], "alpha\n\n");
  assertLossless(text, chunks, 12);
});

test("fallback recognizes fence delimiters and keeps CRLF when possible", () => {
  const text = "intro\r\n```js\r\nconst a=1;\r\n```\r\noutro\r\n";
  const chunks = splitLosslessly(text, 18);
  assertLossless(text, chunks, 18);
  assert.equal(chunks[0], "intro\r\n```js\r\n");
  for (let i = 0; i < chunks.length - 1; i += 1) {
    assert.ok(!(chunks[i].endsWith("\r") && chunks[i + 1].startsWith("\n")));
  }
});

test("arbitrarily long single lines hard-split without omissions", () => {
  const text = "x".repeat(101) + "😀".repeat(17);
  assertLossless(text, splitLosslessly(text, 7), 7);
});

test("model boundaries are offsets only; result is sliced from the original source", async () => {
  const text = "AAA😀BBBBCCCCDDDD";
  let calls = 0;
  const result = await planSemanticChunks(text, {
    maxChunkChars: 5,
    decideBoundaries: async (payload) => {
      calls += 1;
      assert.equal(payload.text, text);
      assert.equal(payload.startOffset, 0);
      assert.equal(payload.endOffset, cpLength(text));
      return [4, 8, 12, 16];
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.usedModel, true);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.fallbackWindows, 0);
  assert.deepEqual(result.boundaries, [4, 8, 12, 16]);
  assertLossless(text, result.chunks, 5);
});

test("invalid model boundaries and rejected decisions fall back without losing text", async () => {
  const text = "one\n\ntwo three four five";
  for (const decideBoundaries of [
    async () => [2, 1, cpLength(text)],
    async () => [cpLength(text)],
    async () => ({ boundaries: [5, 10, 15, 20] }),
    async () => { throw new Error("private adapter error must not be exposed"); },
  ]) {
    const result = await planSemanticChunks(text, { maxChunkChars: 6, decideBoundaries });
    assertLossless(text, result.chunks, 6);
    assert.equal(result.usedModel, false);
    assert.equal(result.fallbackWindows, 1);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.warnings[0].includes("private"));
  }
});

test("fixed windows enforce a finite call budget and shift relative offsets correctly", async () => {
  const text = "😀".repeat(45);
  const seen = [];
  const result = await planSemanticChunks(text, {
    maxChunkChars: 5,
    decideBoundaries: async ({ startOffset, endOffset, text: windowText }) => {
      seen.push([startOffset, endOffset, cpLength(windowText)]);
      return [5, 10, 15, 20];
    },
  });
  assert.deepEqual(seen, [[0, 20, 20], [20, 40, 20]]);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.boundaries, [5, 10, 15, 20, 25, 30, 35, 40, 45]);
  assertLossless(text, result.chunks, 5);
});

test("short inputs and optional deterministic operation make no model calls", async () => {
  const short = await planSemanticChunks("abc", { maxChunkChars: 3,
    decideBoundaries: () => { throw new Error("must not call"); } });
  assert.equal(short.modelCalls, 0);
  assert.deepEqual(short.chunks, ["abc"]);
  const fallback = await planSemanticChunks("abc😀defghij", { maxChunkChars: 3 });
  assert.equal(fallback.modelCalls, 0);
  assertLossless("abc😀defghij", fallback.chunks, 3);
});

test("already aborted signals skip all model calls and preserve the source", async () => {
  const controller = new AbortController();
  controller.abort();
  const text = "x".repeat(45);
  const result = await planSemanticChunks(text, { maxChunkChars: 5,
    signal: controller.signal,
    decideBoundaries: () => { throw new Error("must not call"); } });
  assert.equal(result.modelCalls, 0);
  assertLossless(text, result.chunks, 5);
});

test("abort races a non-settling decision and prevents further calls", async () => {
  const controller = new AbortController();
  let calls = 0;
  const text = "x".repeat(45);
  const result = await planSemanticChunks(text, { maxChunkChars: 5,
    signal: controller.signal,
    decideBoundaries: () => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    } });
  assert.equal(calls, 1);
  assert.equal(result.modelCalls, 1);
  assertLossless(text, result.chunks, 5);
});

test("line references retain empty lines and bound long single-line subparts", () => {
  const text = "a\r\n\n" + "😀".repeat(8) + "\nlast";
  const records = indexLosslessLines(text, 4);
  assert.equal(records.map((record) => record.text).join(""), text);
  assert.deepEqual(records.map((record) => record.id), ["1:1", "2:1", "3:1", "3:2", "3:3", "4:1"]);
  let offset = 0;
  for (const record of records) {
    assert.equal(record.startOffset, offset);
    assert.ok(record.endOffset - record.startOffset <= 4);
    assert.equal(record.endOffset - record.startOffset, cpLength(record.text));
    offset = record.endOffset;
  }
  assert.equal(offset, cpLength(text));
  assert.deepEqual(indexLosslessLines("", 4), []);
});
