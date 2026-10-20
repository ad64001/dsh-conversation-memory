import { openConversation as open } from '../../library/lib/index.mjs';
export function openConversation(options) {
  const memory = open(options), append = memory.append.bind(memory);
  memory.append = record => {
    if (record.text.includes('archive_delay_marker')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    return append(record);
  };
  return memory;
}
