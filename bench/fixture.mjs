import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const chars = value => Array.from(value).length;
const fill = (size, line = '例行巡检记录：缓存心跳正常，当前没有新增操作。\n') =>
  Array.from(line.repeat(Math.ceil(size / chars(line)))).slice(0, size).join('');

export function makeFixture({ id = 'alpha', noiseMessages = 100 } = {}) {
  const target = `src/runtime/${id}-session-index.mjs`;
  const functionName = `rebuild_${id}_index()`;
  const aTail = `用户已确认本轮目标文件 ${target}，入口 ${functionName}，参数 batch_size=256。上一动作是在该文件实现入口后，执行 rebuild-index；以接下段返回为准。\n`;
  const a = fill(4000 - chars(aTail)) + aTail;
  const bHead = `修改成功，但引发了新报错。rebuild-index 实际失败：RecoveryLockError: E_LOCK_MISSING，缺少 recovery.lock；当时 driver=v1、lockGeneration=0、batch_size=256。不要在相同条件下盲目重试该失败动作；先检查状态。这个失败不证明建立锁之后仍然失败。\n`;
  const b = bHead + fill(4000 - chars(bHead));
  const noise = Array.from({ length: noiseMessages }, (_, i) => ({
    role: 'tool', sourceKey: `heartbeat-${i}`, text: `巡检序号 ${i}：` + fill(520),
  }));
  return { id, noiseMessages, target, functionName, a, b, source: a + b, bHead, noise,
    totalChars: chars(a + b) + noise.reduce((n, item) => n + chars(item.text), 0),
    initial: { target, functionName, batchSize: 256, driver: 'v1', lockGeneration: 0 },
    initialFailureAction: { action: 'recover', file: target, batchSize: 256, generation: 0, reason: '历史执行夹具', refs: [] } };
}

/** No model-produced shell, path or code executes. All operations stay in a
 * newly created scratch directory; file arguments are equality checked against
 * the synthetic allowlist before any write.
 */
export class ScratchExecutor {
  constructor({ directory, initial }) {
    this.directory = path.resolve(directory);
    this.state = { ...initial, recovered: false };
    this.events = [];
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(path.join(this.directory, 'state.json'), JSON.stringify(this.state, null, 2));
  }
  patchState(patch) { Object.assign(this.state, patch); this.#persist(); }
  #persist() { writeFileSync(path.join(this.directory, 'state.json'), JSON.stringify(this.state, null, 2)); }
  execute(proposal, { phase = 'model', round = 0 } = {}) {
    const before = { ...this.state };
    const event = { phase, round, proposal, before, executed: false, ok: false };
    if (proposal.action === 'wait') {
      Object.assign(event, { ok: true, code: 'WAIT', text: '未执行恢复。' });
    } else if (proposal.action === 'inspect') {
      Object.assign(event, { executed: true, ok: true, code: 'INSPECTED', text:
        `只读核验：file=${this.state.target}，driver=${this.state.driver}，lockGeneration=${this.state.lockGeneration}，batch_size=${this.state.batchSize}；` +
        (this.state.lockGeneration ? 'recovery.lock 存在。' : '缺少 recovery.lock，RecoveryLockError: E_LOCK_MISSING 尚未解除。') });
    } else if (proposal.action === 'recover') {
      if (proposal.file !== this.state.target || proposal.batchSize !== this.state.batchSize || proposal.generation !== this.state.lockGeneration) {
        Object.assign(event, { code: 'WRONG_ARGUMENTS', text: '参数未通过本地 allowlist/state 校验，未执行。' });
      } else {
        event.executed = true;
        if (!this.state.lockGeneration) Object.assign(event, { code: 'E_LOCK_MISSING', text:
          `rebuild-index 实际失败：RecoveryLockError: E_LOCK_MISSING，缺少 recovery.lock；file=${this.state.target}，driver=${this.state.driver}，lockGeneration=0，batch_size=${this.state.batchSize}。` });
        else {
          this.state.recovered = true;
          writeFileSync(path.join(this.directory, 'recovered.json'), JSON.stringify({ file: this.state.target,
            batch_size: this.state.batchSize, lockGeneration: this.state.lockGeneration }, null, 2));
          Object.assign(event, { ok: true, code: 'RECOVERED', text:
            `rebuild-index 实际成功：file=${this.state.target}，batch_size=${this.state.batchSize}，lockGeneration=${this.state.lockGeneration}。` });
        }
      }
    } else Object.assign(event, { code: 'INVALID_ACTION', text: '不在操作白名单中，未执行。' });
    event.after = { ...this.state };
    this.events.push(event); this.#persist();
    writeFileSync(path.join(this.directory, 'events.json'), JSON.stringify(this.events, null, 2));
    return event;
  }
  verifyResult() {
    try { return JSON.parse(readFileSync(path.join(this.directory, 'recovered.json'), 'utf8')); } catch { return null; }
  }
}

export function validateProposal(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Expected proposal object');
  const allowed = ['action', 'file', 'batchSize', 'generation', 'reason', 'refs'];
  if (Object.keys(data).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(data, key))) throw new TypeError('Invalid proposal keys');
  if (!['inspect', 'recover', 'wait'].includes(data.action) || typeof data.reason !== 'string' || !data.reason.trim() || chars(data.reason) > 1000 ||
      !(data.file === null || typeof data.file === 'string') || !(data.batchSize === null || Number.isSafeInteger(data.batchSize)) ||
      !(data.generation === null || Number.isSafeInteger(data.generation)) || !Array.isArray(data.refs) ||
      data.refs.some(ref => !Number.isSafeInteger(ref) || ref < 1) || new Set(data.refs).size !== data.refs.length) throw new TypeError('Invalid proposal types');
  return data;
}

export function recentBudget(history, maxChars) {
  const chosen = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const block = `[recent-${i}] role=${history[i].role}\n${history[i].text}`;
    if (chars([...chosen, block].reverse().join('\n\n')) > maxChars) break;
    chosen.push(block);
  }
  return chosen.reverse().join('\n\n');
}
