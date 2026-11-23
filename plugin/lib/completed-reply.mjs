// The durable response stays in the DSH session. For a closed text-only
// answer, this creates a distinct local assistant checkpoint at the same role.
// Never reuse the original model's replay identity or synthesize reasoning.
function checkpoint(message, provider, model) {
  const source = message.source;
  const replay = source?.replayState;
  const response = replay?.response;
  if (message.role !== 'assistant' || source?.kind !== 'model'
    || source.provider !== provider || source.model !== model || response?.kind !== 'pi-ai'
    || response.version !== 2 || response.api !== 'openai-completions' || response.stopReason !== 'stop'
    || response.provider !== provider || response.model !== model || response.containerId
    || !Array.isArray(message.content) || !Array.isArray(replay.blocks) || replay.blocks.length !== message.content.length) return message;
  let thinkingChars = 0;
  const visible = [];
  for (const [index, block] of message.content.entries()) {
    const meta = replay.blocks[index];
    if (meta?.type !== block.type || typeof block.text !== 'string'
      || Object.keys(block).some(key => key !== 'type' && key !== 'text')) return message;
    if (block.type === 'text' && Object.keys(meta).length === 1) visible.push(block);
    else if (block.type === 'reasoning' && meta.thinkingSignature === 'reasoning_content'
      && Object.keys(meta).every(key => key === 'type' || key === 'thinkingSignature')) thinkingChars += block.text.length;
    else return message;
  }
  if (thinkingChars < 256 || !visible.some(block => block.text.trim())) return message;
  return { ...message, source: { kind: 'model', provider: 'dsh-local', model: 'completed-reply-checkpoint' },
    content: [{ type: 'text', text: '[DSH local checkpoint of the previous assistant’s visible reply]\n' }, ...visible] };
}

export function withCompletedReplyCheckpoints(options) {
  if (options.model !== 'deepseek-v4.1-flash' || options.purpose && options.purpose !== 'agent'
    || !Array.isArray(options.messages)) return options;
  let laterUser = false, messages;
  for (let i = options.messages.length - 1; i >= 0; --i) {
    const message = options.messages[i];
    if (message.role === 'user' && message.source?.kind === 'user') laterUser = true;
    if (!laterUser || message.role !== 'assistant') continue;
    const archived = checkpoint(message, options.provider, options.model);
    if (archived !== message) {
      messages ??= options.messages.slice();
      messages[i] = archived;
    }
  }
  return messages ? { ...options, messages } : options;
}
