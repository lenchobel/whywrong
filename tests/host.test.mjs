import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, complete, loadNotebook, saveNotebook, connect, HostError, _resetForTests } from '../bundle/host.js';

const notebook = [{
  id: 'a', createdAt: 1, question: 'q', picked: 'p', right: '', trapId: 'leap', whyTempting: 'w',
  trapWords: [], rule: 'r', check: 'c', whyRight: '', drills: [], mastered: false,
}];

// Mirror the documented SDK surface so bundle/host.js talks to it the same way
// the real runtime would:
//   AnnaAppRuntime.connect() -> anna
//   anna.llm.complete(args) -> { content: { type: 'text', text } }
//   anna.storage.get({ key }) -> { value, exists }
//   anna.storage.set({ key, value }) -> { ok: true }
function fakeAnna(over = {}) {
  const store = new Map();
  const anna = {
    llm: {
      complete: async () => ({ content: { type: 'text', text: 'hello' } }),
    },
    storage: {
      get: async ({ key }) => {
        if (!store.has(key)) return { value: null, exists: false };
        return { value: store.get(key), exists: true };
      },
      set: async ({ key, value }) => { store.set(key, value); return { ok: true }; },
    },
    ...over,
  };
  globalThis.AnnaAppRuntime = {
    async connect() {
      return anna;
    },
  };
  return store;
}

beforeEach(() => {
  _resetForTests();
  delete globalThis.AnnaAppRuntime;
});

// The docs pin the LLM response to MCP shape: { content: { type: 'text', text } }.
// Defensive cases (string, plain content) are covered but the documented one
// must work.
test('extractText returns the documented content.text', () => {
  assert.equal(extractText({ content: { type: 'text', text: 'hello' } }), 'hello');
  assert.equal(extractText({ content: 'c' }), 'c');
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
});

test('connect fails with a clear message when the app is not running inside Anna', async () => {
  await assert.rejects(connect(), (err) => err instanceof HostError && err.code === 'no_runtime' && /inside Anna/.test(err.message));
});

test('connect can be retried after a failure', async () => {
  await assert.rejects(connect(), /inside Anna/);
  fakeAnna();
  assert.ok(await connect());
});

test('complete sends systemPrompt + maxTokens + messages in the documented shape', async () => {
  let seen;
  fakeAnna({ llm: { complete: async (args) => { seen = args; return { content: { type: 'text', text: 'answer' } }; } } });
  const out = await complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out, 'answer');
  assert.equal(seen.systemPrompt, 'sys');
  assert.deepEqual(seen.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(typeof seen.maxTokens, 'number');
  assert.equal(seen.max_tokens, undefined, 'snake_case max_tokens must not be sent');
});

test('complete omits systemPrompt when no system text is given', async () => {
  let seen;
  fakeAnna({ llm: { complete: async (args) => { seen = args; return { content: { type: 'text', text: 'ok' } }; } } });
  await complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.systemPrompt, undefined);
  // maxTokens / temperature have app-level defaults; we always send them so
  // the LLM gets a stable JSON-friendly config.
  assert.equal(typeof seen.maxTokens, 'number');
  assert.equal(typeof seen.temperature, 'number');
});

test('complete turns a failed AI call into a HostError', async () => {
  fakeAnna({ llm: { complete: async () => { throw new Error('upstream 500'); } } });
  await assert.rejects(complete({ system: 's', messages: [] }), (e) => e instanceof HostError && e.code === 'llm_failed');
});

test('complete turns an empty reply into a HostError', async () => {
  fakeAnna({ llm: { complete: async () => ({ content: { type: 'text', text: '   ' } }) } });
  await assert.rejects(complete({ system: 's', messages: [] }), (e) => e.code === 'llm_empty');
});

test('complete turns an empty content object into a HostError', async () => {
  fakeAnna({ llm: { complete: async () => ({ content: { type: 'text', text: '' } }) } });
  await assert.rejects(complete({ system: 's', messages: [] }), (e) => e.code === 'llm_empty');
});

test('complete gives up when the AI takes too long', async () => {
  fakeAnna({ llm: { complete: () => new Promise(() => {}) } });
  await assert.rejects(complete({ system: 's', messages: [] }, 30), (e) => e instanceof HostError && e.code === 'timeout');
});

// Per docs, storage.get returns { value: null, exists: false } on a missing key
// (no throw). loadNotebook must surface that as an empty list.
test('loadNotebook returns an empty list when nothing has been saved yet', async () => {
  fakeAnna();
  assert.deepEqual(await loadNotebook(), []);
});

test('loadNotebook reads a saved notebook array directly', async () => {
  fakeAnna({ storage: { get: async ({ key }) => ({ value: notebook, exists: true }), set: async () => ({ ok: true }) } });
  assert.equal((await loadNotebook()).length, 1);
});

test('loadNotebook handles a JSON-string stored value', async () => {
  fakeAnna({ storage: { get: async ({ key }) => ({ value: JSON.stringify(notebook), exists: true }), set: async () => ({ ok: true }) } });
  assert.equal((await loadNotebook()).length, 1);
});

test('loadNotebook handles a wrapped { items } value', async () => {
  fakeAnna({ storage: { get: async ({ key }) => ({ value: { items: notebook }, exists: true }), set: async () => ({ ok: true }) } });
  assert.equal((await loadNotebook()).length, 1);
});

test('loadNotebook treats damaged data as an empty notebook instead of crashing', async () => {
  fakeAnna({ storage: { get: async ({ key }) => ({ value: '{{{ broken', exists: true }), set: async () => ({ ok: true }) } });
  assert.deepEqual(await loadNotebook(), []);
});

test('loadNotebook reports real storage failures instead of pretending the notebook is empty', async () => {
  fakeAnna({ storage: { get: async () => { throw new Error('storage service unavailable'); }, set: async () => ({ ok: true }) } });
  await assert.rejects(loadNotebook(), (e) => e instanceof HostError && e.code === 'storage_read');
});

test('saveNotebook stores an array directly (SDK serialises) and a later load gets it back', async () => {
  const store = fakeAnna();
  await saveNotebook(notebook);
  // Stored value is the raw array, NOT a stringified JSON blob.
  assert.ok(Array.isArray(store.get('notebook')));
  assert.equal((await loadNotebook()).length, 1);
});

test('saveNotebook sends { key, value } with the array as value', async () => {
  let seen;
  fakeAnna({ storage: {
    get: async ({ key }) => ({ value: null, exists: false }),
    set: async (args) => { seen = args; return { ok: true }; },
  } });
  await saveNotebook(notebook);
  assert.equal(seen.key, 'notebook');
  assert.ok(Array.isArray(seen.value));
  assert.equal(seen.value[0].id, 'a');
});

test('saveNotebook turns a storage failure into a HostError', async () => {
  fakeAnna({ storage: { get: async () => ({ value: null, exists: false }), set: async () => { throw new Error('quota exceeded'); } } });
  await assert.rejects(saveNotebook(notebook), (e) => e instanceof HostError && e.code === 'storage_write');
});
