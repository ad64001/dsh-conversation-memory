import { openConversation as open } from '../../library/lib/index.mjs';
import { setTimeout as delay } from 'node:timers/promises';
export function openConversation(options) {
  const memory = open(options), recall = memory.recall.bind(memory);
  memory.recall = async args => { await delay(55, undefined, { signal: args.signal }); return recall(args); };
  return memory;
}
