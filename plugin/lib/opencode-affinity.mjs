import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const installed = new WeakMap();
function isGoEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'opencode.ai' && !url.username && !url.password
      && (!url.port || url.port === '443') && /^\/(?:zen\/go\/v1|inference\/go\/openai\/v1)\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Copy one request's immutable provider snapshot. Shared provider settings,
 * credentials, model routing and other concurrent conversations stay untouched. */
export function withOpenCodeSession(snapshot, options) {
  const id = options.sessionId;
  if (typeof id !== 'string' || !id || id.length > 512 || /[^\x21-\x7e]/.test(id)) return snapshot;
  const profile = snapshot.profiles.get(options.provider);
  const model = snapshot.models.getModel(options.provider, options.model);
  if (!profile || !isGoEndpoint(model?.baseUrl)) return snapshot;
  const headers = Object.fromEntries(Object.entries(profile.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'x-opencode-session'));
  headers['x-opencode-session'] = id;
  const profiles = new Map(snapshot.profiles);
  profiles.set(options.provider, { ...profile, headers });
  return { ...snapshot, profiles };
}

/** DSH 0.2.1's pi-ai adapter forwards sessionId to pi-ai, whose Chat Completions
 * route omits it from HTTP headers. Its per-call snapshot is the narrow boundary
 * where both the exact endpoint and the real conversation id are available. */
export function installOpenCodeAffinity(Adapter) {
  if (typeof Adapter?.prototype?.streamWithSnapshot !== 'function') throw new TypeError('Unsupported DSH pi-ai adapter');
  let state = installed.get(Adapter);
  if (!state) {
    const original = Adapter.prototype.streamWithSnapshot;
    const wrapper = function(options, snapshot) { return original.call(this, options, withOpenCodeSession(snapshot, options)); };
    state = { original, wrapper, count: 0 };
    installed.set(Adapter, state); Adapter.prototype.streamWithSnapshot = wrapper;
  }
  state.count++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--state.count) return;
    if (Adapter.prototype.streamWithSnapshot === state.wrapper) Adapter.prototype.streamWithSnapshot = state.original;
    installed.delete(Adapter);
  };
}

export async function loadPiAiRuntime() {
  let binding;
  try { binding = await import('../runtime-binding.mjs'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (binding?.piAiUrl) return import(binding.piAiUrl);
  if (!process.resourcesPath) throw new Error('DSH pi-ai runtime binding is unavailable');
  return import(pathToFileURL(join(process.resourcesPath, 'app.asar', 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href);
}
