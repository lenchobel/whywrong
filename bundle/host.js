// host.js: the ONLY file that talks to the Anna runtime.
//
// If Anna's SDK differs from what is assumed here, fix it in this file and
// nowhere else. The three calls below are pinned to the documented surface:
//   1. SDK import -> AnnaAppRuntime.connect()
//   2. anna.llm.complete({ messages, systemPrompt, maxTokens, ... }) -> reply.content.text
//   3. anna.storage.get({ key }) / anna.storage.set({ key, value })
// See:
//   https://anna.partners/developers/apps/app-ui-sdk.md
//   https://anna.partners/developers/apps/llm-and-agent.md
//   https://anna.partners/developers/reference/host-api-llm.md
//   https://anna.partners/developers/reference/host-api-storage.md
//
// The SDK module is fetched dynamically so a missing host (tests, broken
// network) doesn't crash the bundle; a globalThis.AnnaAppRuntime binding is
// honoured as a fallback for the unit-test path.

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
      let Runtime = null;
      try {
        const mod = await import(/* @vite-ignore */ SDK_URL);
        Runtime = mod?.AnnaAppRuntime || mod?.default?.AnnaAppRuntime || null;
      } catch {
        // No SDK reachable (Node unit tests, offline). Fall back to the
        // global binding if a host page (tests, harness) injected one.
      }
      if (!Runtime && globalThis.AnnaAppRuntime?.connect) {
        Runtime = globalThis.AnnaAppRuntime;
      }
      if (typeof Runtime?.connect !== 'function') {
        throw new HostError('no_runtime', 'This app has to run inside Anna. Open it from the Anna marketplace or with anna-app dev.');
      }
      const anna = await Runtime.connect();
      if (!anna?.llm?.complete || !anna?.storage?.get || !anna?.storage?.set) {
        throw new HostError('no_runtime', 'This app has to run inside Anna. Open it from the Anna marketplace or with anna-app dev.');
      }
      sdk = anna;
      return sdk;
    })().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

// ---- helpers that read whatever shape comes back ----------------------------
// Per the host-api-llm reference, the documented LLM-complete response is:
//   { role: 'assistant', content: { type: 'text', text }, model, stopReason, usage, _meta? }
// The defensive branches cover a bare string and a string content field —
// nothing else is part of the public surface.

export function extractText(res) {
  if (typeof res === 'string') return res;
  if (!res || typeof res !== 'object') return '';
  if (res.content && typeof res.content === 'object' && typeof res.content.text === 'string') {
    return res.content.text;
  }
  if (typeof res.content === 'string') return res.content;
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
// Internal signature stays the same ({ system, messages, maxTokens, temperature })
// so callers (core.js) do not change; we translate `system` -> `systemPrompt`
// and `maxTokens` -> camelCase at the boundary.

export async function complete({ system, messages, maxTokens = 2600, temperature = 0.4 }, timeoutMs = LLM_TIMEOUT_MS) {
  const host = await connect();
  const req = { messages };
  if (system) req.systemPrompt = system;
  if (Number.isFinite(maxTokens)) req.maxTokens = maxTokens;
  if (Number.isFinite(temperature)) req.temperature = temperature;
  // Per the host-api-llm reference, complete's second argument is the documented
  // opts bag: { timeoutMs?: number }. The SDK per-namespace timeout default is
  // 180 000 ms (3 minutes); we override with our app-level cap (LLM_TIMEOUT_MS).
  // Our own withTimeout race stays in place as a belt-and-suspenders fallback
  // so a host that ignores opts still surfaces a clean 'timeout' HostError.
  const opts = Number.isFinite(timeoutMs) ? { timeoutMs } : undefined;
  let res;
  try {
    res = await withTimeout(
      Promise.resolve(host.llm.complete(req, opts)),
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
// Documented shapes (host-api-storage.md):
//   anna.storage.get({ key }) -> { value, etag, generation, exists }
//     missing key -> { value: null, exists: false }  (NO throw)
//   anna.storage.set({ key, value, if_match? }) -> { etag, generation, size_bytes }
// The default (scope='app', owner=self) bucket is per-(user, App) — see the
// reference page — so no scope arg is needed and other users of this App see
// a different bucket. APS supports optimistic concurrency via `if_match`:
// pass the etag from the most recent get/set and a concurrent write surfaces
// as `precondition_failed` instead of silently clobbering our row.
// Limits: key <= 1024 chars (<= 128 per segment); value any JSON; legacy
// runtime_state backend caps the whole bucket at 256 KiB; APS enforces a
// per-row byte cap and per-user entry/byte quota.

const SAVE_MAX_ATTEMPTS = 3;

export async function loadNotebook() {
  const host = await connect();
  let res;
  try {
    res = await host.storage.get({ key: NOTEBOOK_KEY });
  } catch (err) {
    throw new HostError('storage_read', 'Your notebook could not be loaded.', err);
  }
  // Branch on `exists` (NOT on `value`) — storing null is legal and round-trips.
  if (!res || res.exists === false) return [];
  return parseNotebook(res.value);
}

// `merge` is either a function (currentList) => nextList, or — for back-compat
// — a literal nextList. The merge-function form lets the caller describe the
// CHANGE it wants (add, toggle, delete by id) without rebuilding the whole
// list, which is what makes this safe under concurrent writers.
export async function saveNotebook(merge) {
  const apply = typeof merge === 'function' ? merge : () => merge;
  const host = await connect();
  for (let attempt = 0; attempt < SAVE_MAX_ATTEMPTS; attempt++) {
    let cur;
    try {
      cur = await host.storage.get({ key: NOTEBOOK_KEY });
    } catch (err) {
      throw new HostError('storage_read', 'Your notebook could not be saved.', err);
    }
    const current = (cur && cur.exists !== false) ? parseNotebook(cur.value) : [];
    const next = apply(current);
    const writeArgs = { key: NOTEBOOK_KEY, value: next };
    if (cur && cur.etag) writeArgs.if_match = cur.etag;
    try {
      await host.storage.set(writeArgs);
    } catch (err) {
      // Concurrent writer touched the row between our read and our write.
      // Retry: re-read, re-apply the merge against the fresh list, write again.
      if (err?.code === 'precondition_failed' && attempt < SAVE_MAX_ATTEMPTS - 1) continue;
      if (err?.code === 'precondition_failed') {
        throw new HostError('storage_conflict', 'Your notebook was being changed elsewhere. Please try again.', err);
      }
      throw new HostError('storage_write', 'Your notebook could not be saved.', err);
    }
    // A "Saved to notebook" button is a lie if the next reload is empty. Read
    // back and compare ids + mastered flags before reporting success.
    let res;
    try {
      res = await host.storage.get({ key: NOTEBOOK_KEY });
    } catch (err) {
      throw new HostError('save_not_stuck', 'It looked like it saved, but reading it back failed.', err);
    }
    if (!res || res.exists === false) {
      console.warn('[WhyWrong] save did not stick: storage reported OK but read-back was empty');
      throw new HostError('save_not_stuck', 'It looked like it saved, but it did not stick, so it may be gone when you close the app. Try again.');
    }
    const readback = parseNotebook(res.value);
    if (!sameNotebookShape(next, readback)) {
      console.warn('[WhyWrong] save did not stick: wrote', next.map(slimItem).join(','), 'read back', readback.map(slimItem).join(','));
      throw new HostError('save_not_stuck', 'It looked like it saved, but it did not stick, so it may be gone when you close the app. Try again.');
    }
    return;
  }
}

// True when every written item is present in the read-back with the same
// id and mastered flag (and no extra items snuck in). Order is NOT compared
// because some backends reorder on round-trip.
function sameNotebookShape(written, readback) {
  if (written.length !== readback.length) return false;
  for (const w of written) {
    const r = readback.find((x) => x.id === w.id);
    if (!r) return false;
    if (Boolean(r.mastered) !== Boolean(w.mastered)) return false;
  }
  return true;
}

const slimItem = (it) => `${it.id}${it.mastered ? '*' : ''}`;
