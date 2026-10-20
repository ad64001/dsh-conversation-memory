import { openConversation as open } from '../../library/lib/index.mjs';
export function openConversation(options) {
  const memory = open(options), repair = memory.store.repairIndexBackgrounds.bind(memory.store);
  let migrations = 0;
  memory.store.repairIndexBackgrounds = () => {
    if (++migrations > 1) throw Object.assign(Error('Repeated full-store repair'), { code: 'REPEATED_REPAIR' });
    return repair();
  };
  return memory;
}
