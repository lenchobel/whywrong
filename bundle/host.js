// host.js: the ONLY file that talks to the Anna runtime.
//
// If Anna's SDK differs from what is assumed here, fix it in this file and
// nowhere else. Check these three calls against docs/app-ui-sdk.md,
// docs/host-api-llm.md and docs/host-api-storage.md:
//   1. how the SDK is imported          (connect)
//   2. anna.llm.complete(...) arguments and the shape of what comes back
//   3. anna.storage.get(key) / anna.storage.set(key, value)

import { parseNotebook } from './core.js';

const SDK_URL = '/static/anna-apps/_sdk/latest/index.js';
const NOTEBOOK_KEY = 'notebook';
export const LLM_TIMEOUT_MS = 90000;

export class HostError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

let sdk = null;
let connecting = null;

// Only used by tests, to reset between runs.
export function _resetForTests() {
  sdk = null;
  connecting = null;
}

export function connect() {
  if (sdk) return Promise.resolve(sdk);
  if (!connecting) {
    connecting = (async () => {
      let found = null;
      try {
        const mod = await import(SDK_URL);
        found = mod.anna || mod.default || null;
      } catch {
        // fall through to the global check below
      }
      if (!found && globalThis.anna && typeof globalThis.anna === 'object') found = globalThis.anna;
      if (!found?.llm?.complete || !found?.storage?.get || !found?.storage?.set) {
        throw new HostError('no_runtime', 'This app has to run inside Anna. Open it from the Anna marketplace or with anna-app dev.');
      }
      sdk = found;
      return sdk;
    })().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

// ---- helpers that read whatever shape comes back ----------------------------

export function extractText(res) {
  if (typeof res === 'string') return res;
  if (!res || typeof res !== 'object') return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.output_text === 'string') return res.output_text;
  if (typeof res.content === 'string') return res.content;
  if (Array.isArray(res.content)) {
    return res.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  if (typeof res.message?.content === 'string') return res.message.content;
  if (typeof res.choices?.[0]?.message?.content === 'string') return res.choices[0].message.content;
  if (typeof res.result === 'string') return res.result;
  if (res.result && typeof res.result === 'object') return extractText(res.result);
  return '';
}

function withTimeout(promise, ms, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HostError(code, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- AI ---------------------------------------------------------------------

export async function complete({ system, messages, maxTokens = 2600, temperature = 0.4 }, timeoutMs = LLM_TIMEOUT_MS) {
  const host = await connect();
  let res;
  try {
    res = await withTimeout(
      Promise.resolve(host.llm.complete({ system, messages, max_tokens: maxTokens, temperature })),
      timeoutMs,
      'timeout',
      'The AI took too long to answer.',
    );
  } catch (err) {
    if (err instanceof HostError) throw err;
    throw new HostError('llm_failed', 'The AI could not answer right now.', err);
  }
  const text = extractText(res);
  if (!text.trim()) throw new HostError('llm_empty', 'The AI sent back an empty answer.');
  return text;
}

// ---- Storage ----------------------------------------------------------------

const MISSING = /not.?found|no such|missing|does not exist|doesn't exist|404|no value/i;

export async function loadNotebook() {
  const host = await connect();
  let res;
  try {
    res = await host.storage.get(NOTEBOOK_KEY);
  } catch (err) {
    if (MISSING.test(String(err?.message || err))) return [];
    throw new HostError('storage_read', 'Your notebook could not be loaded.', err);
  }
  if (res && typeof res === 'object' && !Array.isArray(res) && 'value' in res) res = res.value;
  return parseNotebook(res);
}

export async function saveNotebook(list) {
  const host = await connect();
  try {
    await host.storage.set(NOTEBOOK_KEY, JSON.stringify(list));
  } catch (err) {
    throw new HostError('storage_write', 'Your notebook could not be saved.', err);
  }
}
