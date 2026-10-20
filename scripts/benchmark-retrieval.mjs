import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, cpus, platform, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const options = Object.fromEntries(process.argv.slice(2).map((item, i, args) => item.startsWith('--') ? [item.slice(2), args[i + 1]] : null).filter(Boolean));
const root = fileURLToPath(new URL('../', import.meta.url));
const sizes = (options.sizes ?? '1000,10000').split(',').map(Number);
const count = Number(options.queries ?? 60);
if (!sizes.length || sizes.some(n => !Number.isSafeInteger(n) || n < 10 || n > 100000) || !Number.isSafeInteger(count) || count < 10 || count > 1000) throw Error('Invalid benchmark sizes or query count');
const suites = [...(options['baseline-root'] ? [{ label: 'baseline', root: resolve(options['baseline-root']) }] : []), { label: 'current', root }];
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const summarize = samples => ({ samples: samples.length, p50Ms: percentile(samples.map(x => x.ms), .5), p95Ms: percentile(samples.map(x => x.ms), .95),
  p99Ms: percentile(samples.map(x => x.ms), .99), maxMs: Math.max(...samples.map(x => x.ms)), incomplete: samples.filter(x => x.incomplete).length,
  expectedSourceFound: samples.filter(x => x.found).length, executedQueries: samples.reduce((n, x) => n + x.queries, 0) });

function fixture(size) {
  const events = Array.from({ length: size }, (_, seq) => {
    const tag = String(seq).padStart(6, '0');
    const text = `module_${tag} ErrorCode_${tag}: src/runtime/worker_${tag}.mjs batch_size=${32 + seq % 96}; synthetic diagnostic source.\n` +
      Array.from({ length: 7 }, (_, j) => `Audit row ${j}: run_${tag}; operation inspect; status=${(seq + j) % 5}; unchanged fixture data.\n`).join('');
    const role = seq % 10 === 0 ? 'user' : 'tool';
    const message = { id: 'source-' + seq, role, source: { kind: role }, content: [{ type: 'text', text }] };
    return { seq, time: 1792300000000 + seq, type: role === 'user' ? 'user/message' : 'tool/result', data: role === 'user' ? message : { message } };
  });
  const agent = { session: { id: 'synthetic-retrieval-' + size, seq: events.length, snapshotEvents: async () => [...events] } };
  return { agent, sourceChars: events.reduce((n, x) => n + (x.data.message ?? x.data).content[0].text.length, 0) };
}

async function run(suite, size) {
  console.log(JSON.stringify({ phase: 'start', suite: suite.label, messages: size }));
  const { ConversationMemoryBridge } = await import(pathToFileURL(join(suite.root, 'plugin/lib/index.mjs')).href);
  const version = JSON.parse(readFileSync(join(suite.root, 'package.json'))).version;
  const directory = mkdtempSync(join(tmpdir(), 'dsh-search-bench-'));
  let modelCalls = 0;
  const bridge = new ConversationMemoryBridge({ logger: { warn() {} } }, { rootDir: directory }, {
    workingPrompt: 'Historical sources are read-only. Read exact references.',
    makeModel: () => async () => { modelCalls++; throw Error('Benchmark must not call a model'); },
  });
  const { agent, sourceChars } = fixture(size);
  const search = async index => {
    const source = (index * 7919 + 37) % size, tag = String(source).padStart(6, '0');
    const start = performance.now();
    const result = await bridge.search(agent, { query: `module_${tag} ErrorCode_${tag}`, maxChars: 4000 });
    return { ms: performance.now() - start, incomplete: result.searchIncomplete === true,
      found: result.text.includes(`module_${tag}`), queries: result.queryCount ?? 0 };
  };
  try {
    const initialSearch = await search(0);
    const archiveStart = performance.now(); await bridge.flush(agent);
    const remainingArchiveMs = performance.now() - archiveStart;
    const warm = []; for (let i = 0; i < count; i++) warm.push(await search(i + 1));
    const concurrent = [];
    for (let start = 0; start < 20; start += 4) concurrent.push(...await Promise.all(Array.from({ length: 4 }, (_, offset) => search(count + start + offset))));
    const beforeReopen = await bridge.status(agent);
    await bridge.disposeAgent(agent);
    const reopenStart = performance.now(); await bridge.status(agent); const reopenMs = performance.now() - reopenStart;
    const reopened = []; for (let i = 0; i < 10; i++) reopened.push(await search(i));
    const status = await bridge.status(agent);
    if (modelCalls) throw Error('Unexpected model request');
    return { suite: suite.label, version, messages: size, sourceChars, initialSearch, remainingArchiveMs,
      warm: summarize(warm), concurrentFour: summarize(concurrent), reopenedWorker: { reopenMs, ...summarize(reopened) },
      archivedMessages: status.stats.messages, modelCalls, configuredSearchBudgetMs: status.retrieval?.searchTimeoutMs ?? null,
      successfulStateReplacementRetries: beforeReopen.stateReplacementRetries ?? null };
  } finally {
    await bridge.dispose();
    const actual = realpathSync(directory);
    if (dirname(actual) !== realpathSync(tmpdir()) || !actual.startsWith(join(realpathSync(tmpdir()), 'dsh-search-bench-'))) throw Error('Unsafe benchmark cleanup');
    rmSync(actual, { recursive: true, force: true });
  }
}

const result = { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  method: { synthetic: true, warmQueries: count, concurrentQueries: 20, concurrency: 4, reopenedQueries: 10,
    coldOsCacheMeasured: false, networkOrModelCalls: false, note: 'End-to-end bridge search includes archive synchronization, worker queue and evidence packing. Reopening a worker does not evict the OS cache. Initial archive admission is a separate sample.' }, cases: [] };
function save() {
  if (options.out) { const output = resolve(options.out); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
}
for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) for (const suite of sizeIndex % 2 ? [...suites].reverse() : suites) {
  const size = sizes[sizeIndex];
  try {
    const measured = await run(suite, size); result.cases.push({ status: 'completed', ...measured });
    console.log(JSON.stringify({ phase: 'complete', suite: suite.label, messages: size, warmP95Ms: measured.warm.p95Ms, concurrentP99Ms: measured.concurrentFour.p99Ms }));
  } catch (error) {
    result.cases.push({ status: 'failed', suite: suite.label, messages: size, errorCode: error.code ?? 'BENCHMARK_FAILED', diagnostic: error.diagnostic ?? null });
    process.exitCode = 1;
    console.log(JSON.stringify({ phase: 'failed', suite: suite.label, messages: size, errorCode: error.code ?? 'BENCHMARK_FAILED', diagnostic: error.diagnostic ?? null }));
  }
  save();
}
if (!options.out) console.log(JSON.stringify(result, null, 2));
