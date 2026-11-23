const plain = obj => obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.getPrototypeOf(obj) === Object.prototype;
function label(value, limit) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || Array.from(value).length > limit)
    throw new TypeError('Invalid fragment text');
  return value.trim();
}
function fields(value, empty = true) {
  if (!plain(value) || Object.keys(value).length > 16 || (!empty && !Object.keys(value).length))
    throw new TypeError('Expected named fragment facts');
  for (const [key, fact] of Object.entries(value)) {
    if (label(key, 64) !== key || !['string', 'number', 'boolean'].includes(typeof fact)) throw new TypeError('Invalid fact');
    if (typeof fact === 'string') label(fact, 256);
    if (typeof fact === 'number' && !Number.isSafeInteger(fact)) throw new TypeError('Expected integer fact');
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function shape(value, names) {
  if (!plain(value) || Object.keys(value).some(key => !names.includes(key))) throw new TypeError('Invalid fragment fields');
}
export function observation(value, evidence) {
  shape(value, ['scope', 'conditions', 'action', 'result', 'cue']);
  const cue = label(value.cue, 512);
  if (!evidence.includes(cue)) throw new TypeError('Fragment cue must be an exact source excerpt');
  return { scope: label(value.scope ?? 'conversation', 128), conditions: fields(value.conditions ?? {}),
    action: label(value.action, 128), result: fields(value.result, false), cue };
}
export function association(value) {
  shape(value, ['scope','context','cue','toward','after','browse','confirm','offset']);
  const query = { scope: label(value.scope ?? 'conversation', 128), context: fields(value.context ?? {}) };
  if (value.cue !== undefined) query.cue = label(value.cue, 512);
  if (value.toward !== undefined) query.toward = fields(value.toward, false);
  for (const key of ['after','confirm']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) throw new TypeError('Invalid fragment identifier');
    query[key] = value[key];
  }
  if (value.browse !== undefined && typeof value.browse !== 'boolean') throw new TypeError('Invalid browse flag');
  if (value.browse && value.confirm) throw new TypeError('Choose browse or confirm');
  if (!value.browse && !value.confirm && !query.cue && !query.toward && !query.after) throw new TypeError('Missing recall cue or target');
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) throw new TypeError('Invalid offset');
  return { ...query, browse: value.browse ?? false, offset: value.offset ?? 0 };
}
