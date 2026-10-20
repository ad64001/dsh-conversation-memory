import { openConversation as open } from '../../library/lib/index.mjs';
import { setTimeout as delay } from 'node:timers/promises';
export function openConversation(options) {
  const memory = open(options), recall = memory.recall.bind(memory);
  memory.recall = async args => {
    if (args.query === 'slow_token') await delay(3000);
    args.signal?.throwIfAborted();
    return recall(args);
  };
  return memory;
}
