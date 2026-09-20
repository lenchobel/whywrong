import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, complete, loadNotebook, saveNotebook, connect, HostError, _resetForTests } from '../bundle/host.js';

const notebook = [{
  id: 'a', createdAt: 1, question: 'q', picked: 'p', right: '', trapId: 'leap', whyTempting: 'w',
  trapWords: [], rule: 'r', check: 'c', whyRight: '', drills: [], mastered: false,
}];

function fakeAnna(over = {}) {
  const store = new Map();
  globalThis.anna = {
    llm: { complete: async () => ({ text: 'hello' }) },
    storage: {
      get: async (k) => { if (!store.has(k)) throw new Error('Key not found'); return { key: k, value: store.get(k) }; },
      set: async (k, v) => { store.set(k, v); return { key: k, value: v }; },
    },
    ...over,
  };
  return store;
}

beforeEach(() => {
  _resetForTests();
  delete globalThis.anna;
});

test('extractText understands the reply shapes an AI host might use', () => {
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText({ text: 'a' }), 'a');
  assert.equal(extractText({ output_text: 'b' }), 'b');
  assert.equal(extractText({ content: 'c' }), 'c');
  assert.equal(extractText({ content: [{ type: 'text', text: 'd1' }, { type: 'text', text: 'd2' }] }), 'd1d2');
  assert.equal(extractText({ message: { content: 'e' } }), 'e');
  assert.equal(extractText({ choices: [{ message: { content: 'f' } }] }), 'f');
  assert.equal(extractText({ result: { text: 'g' } }), 'g');
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

test('complete passes the request through and returns the text', async () => {
  let seen;
  fakeAnna({ llm: { complete: async (args) => { seen = args; return { content: [{ text: 'answer' }] }; } } });
  const out = await complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out, 'answer');
  assert.equal(seen.system, 'sys');
  assert.equal(seen.messages[0].content, 'hi');
  assert.equal(typeof seen.max_tokens, 'number');
});

test('complete turns a failed AI call into a HostError', async () => {
  fakeAnna({ llm: { complete: async () => { throw new Error('upstream 500'); } } });
  await assert.rejects(complete({ system: 's', messages: [] }), (e) => e instanceof HostError && e.code === 'llm_failed');
});

test('complete turns an empty reply into a HostError', async () => {
  fakeAnna({ llm: { complete: async () => ({ text: '   ' }) } });
  await assert.rejects(complete({ system: 's', messages: [] }), (e) => e.code === 'llm_empty');
});

test('complete gives up when the AI takes too long', async () => {
  fakeAnna({ llm: { complete: () => new Promise(() => {}) } });
  await assert.rejects(complete({ system: 's', messages: [] }, 30), (e) => e instanceof HostError && e.code === 'timeout');
});

test('loadNotebook returns an empty list when nothing has been saved yet', async () => {
  fakeAnna();
  assert.deepEqual(await loadNotebook(), []);
});

test('loadNotebook reads a saved notebook whichever way storage returns it', async () => {
  const raw = JSON.stringify(notebook);
  fakeAnna({ storage: { get: async () => ({ value: raw }), set: async () => ({}) } });
  assert.equal((await loadNotebook()).length, 1);
  _resetForTests();
  fakeAnna({ storage: { get: async () => raw, set: async () => ({}) } });
  assert.equal((await loadNotebook()).length, 1);
  _resetForTests();
  fakeAnna({ storage: { get: async () => ({ value: notebook }), set: async () => ({}) } });
  assert.equal((await loadNotebook()).length, 1);
});

test('loadNotebook treats damaged data as an empty notebook instead of crashing', async () => {
  fakeAnna({ storage: { get: async () => ({ value: '{{{ broken' }), set: async () => ({}) } });
  assert.deepEqual(await loadNotebook(), []);
});

test('loadNotebook reports real storage failures instead of pretending the notebook is empty', async () => {
  fakeAnna({ storage: { get: async () => { throw new Error('storage service unavailable'); }, set: async () => ({}) } });
  await assert.rejects(loadNotebook(), (e) => e instanceof HostError && e.code === 'storage_read');
});

test('saveNotebook stores JSON and a later load gets it back', async () => {
  const store = fakeAnna();
  await saveNotebook(notebook);
  assert.equal(typeof store.get('notebook'), 'string');
  assert.equal((await loadNotebook()).length, 1);
});

test('saveNotebook turns a storage failure into a HostError', async () => {
  fakeAnna({ storage: { get: async () => ({ value: '[]' }), set: async () => { throw new Error('quota exceeded'); } } });
  await assert.rejects(saveNotebook(notebook), (e) => e instanceof HostError && e.code === 'storage_write');
});
