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

test('complete passes { timeoutMs } as the documented second argument to llm.complete', async () => {
  let seenArgs, seenOpts;
  fakeAnna({ llm: { complete: async (args, opts) => { seenArgs = args; seenOpts = opts; return { content: { type: 'text', text: 'ok' } }; } } });
  await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, 12345);
  // The docs pin complete's signature as (args, opts?: {timeoutMs?: number}).
  assert.equal(typeof seenOpts, 'object', 'llm.complete was called with an opts object');
  assert.equal(seenOpts.timeoutMs, 12345, 'timeoutMs flows through to the SDK');
  // The request shape itself is unchanged.
  assert.equal(seenArgs.systemPrompt, 's');
  assert.deepEqual(seenArgs.messages, [{ role: 'user', content: 'hi' }]);
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
  // Use the default fakeAnna store so the read-back check passes; only spy
  // on set() so we can capture the args without changing behaviour.
  const store = fakeAnna();
  globalThis.AnnaAppRuntime = {
    async connect() {
      return {
        llm: { complete: async () => ({ content: { type: 'text', text: '' } }) },
        storage: {
          get: async ({ key }) => {
            if (!store.has(key)) return { value: null, exists: false };
            return { value: store.get(key), exists: true };
          },
          set: async (args) => { seen = args; store.set(args.key, args.value); return { ok: true }; },
        },
      };
    },
  };
  await saveNotebook(notebook);
  assert.equal(seen.key, 'notebook');
  assert.ok(Array.isArray(seen.value));
  assert.equal(seen.value[0].id, 'a');
});

test('saveNotebook turns a storage failure into a HostError', async () => {
  fakeAnna({ storage: { get: async () => ({ value: null, exists: false }), set: async () => { throw new Error('quota exceeded'); } } });
  await assert.rejects(saveNotebook(notebook), (e) => e instanceof HostError && e.code === 'storage_write');
});

// Bug 2: a save that returns OK but does not actually persist is the worst
// possible outcome — the screen shows "Saved to notebook" but the next reload
// is empty. saveNotebook must read back the stored value and compare.

test('saveNotebook throws save_not_stuck when set() reports OK but the read-back is missing', async () => {
  // set() returns OK but does NOT write to the store — same shape a flaky
  // APS backend or a write that is silently dropped would produce.
  fakeAnna({ storage: {
    get: async () => ({ value: null, exists: false }),
    set: async () => ({ ok: true }),
  } });
  // Stub console.warn so we can assert it's called with the [WhyWrong] tag.
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args);
  try {
    await assert.rejects(saveNotebook(notebook), (e) => e instanceof HostError && e.code === 'save_not_stuck');
    assert.ok(warns.some((a) => String(a[0]).startsWith('[WhyWrong]')), 'console.warn called with [WhyWrong] tag');
  } finally {
    console.warn = origWarn;
  }
});

test('saveNotebook throws save_not_stuck when set() returns OK but the read-back list differs', async () => {
  // set() returns OK; get() returns a list with different ids/mastered flags.
  fakeAnna({ storage: {
    get: async () => ({ value: [{ id: 'something-else', trapId: 'leap', question: '', picked: '', drills: [], mastered: false }], exists: true }),
    set: async () => ({ ok: true }),
  } });
  await assert.rejects(saveNotebook(notebook), (e) => e instanceof HostError && e.code === 'save_not_stuck');
});

test('saveNotebook succeeds when the read-back matches what was written (same ids and mastered flags)', async () => {
  fakeAnna({ storage: {
    get: async () => ({ value: notebook, exists: true }),
    set: async () => ({ ok: true }),
  } });
  await saveNotebook(notebook); // should not throw
});

// ---- Bug B: data loss across concurrent saves ------------------------------
// The notebook is one key, loaded once and rewritten whole on every save.
// Two tabs can clobber each other. Fix: re-read inside saveNotebook so the
// merge function sees the latest data, and use if_match so a write that races
// with another write fails fast and retries.

// Etag-aware mock that lets the test simulate a concurrent writer mutating
// the store between saveNotebook's internal read and write.
function fakeAnnaWithEtag(initialList) {
  const store = new Map();
  if (initialList) store.set('notebook', initialList);
  let gen = initialList ? 1 : 0;
  const anna = {
    llm: { complete: async () => ({ content: { type: 'text', text: 'ok' } }) },
    storage: {
      async get({ key } = {}) {
        if (!store.has(key)) return { value: null, exists: false, etag: null };
        return { value: store.get(key), exists: true, etag: `W/"${gen}"`, generation: gen };
      },
      async set({ key, value, if_match } = {}) {
        if (if_match != null && if_match !== `W/"${gen}"`) {
          const err = new Error('precondition failed');
          err.code = 'precondition_failed';
          throw err;
        }
        store.set(key, value);
        gen += 1;
        return { etag: `W/"${gen}"`, generation: gen, size_bytes: 0 };
      },
    },
  };
  globalThis.AnnaAppRuntime = { async connect() { return anna; } };
  return { store, anna };
}

const makeFixture = (id) => ({
  id, createdAt: 1000, question: 'q', picked: 'p', right: '', trapId: 'leap', whyTempting: 'w',
  trapWords: [], rule: 'r', check: 'c', whyRight: '', drills: [], mastered: false,
});

test('saveNotebook re-reads inside so a concurrent store change is not lost', async () => {
  const { store } = fakeAnnaWithEtag([makeFixture('a'), makeFixture('b')]);
  // "Another tab" adds a third item between our load and our save.
  store.set('notebook', [makeFixture('a'), makeFixture('b'), makeFixture('d')]);
  // saveNotebook receives a merge function. With the fix it must re-read,
  // run the merge against the fresh list, and not clobber 'd'.
  await saveNotebook((current) => [makeFixture('c'), ...current]);
  const final = store.get('notebook').map((x) => x.id);
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(final.includes(id), `kept ${id}`);
  assert.equal(final.length, 4);
});

test('saveNotebook uses if_match so a write that races with another write retries instead of clobbering', async () => {
  const { store, anna } = fakeAnnaWithEtag([makeFixture('a'), makeFixture('b')]);
  let setCalls = 0;
  const origSet = anna.storage.set;
  anna.storage.set = async (args) => {
    setCalls += 1;
    if (setCalls === 1) {
      // Simulate a second tab that wrote between our read and our write.
      // APS would surface this as precondition_failed because the row's
      // etag moved while we were holding the stale one.
      store.set('notebook', [makeFixture('a'), makeFixture('b'), makeFixture('d')]);
      // Bump the mock's generation so the original set() rejects our stale if_match.
      // We reach into the mock's gen by triggering a no-op set that does bump it.
      try { await origSet({ key: 'notebook', value: store.get('notebook') }); } catch { /* ignore */ }
      // Now retry with the (now stale) original args.
      return origSet(args);
    }
    return origSet(args);
  };
  await saveNotebook((current) => [makeFixture('c'), ...current]);
  // The first attempt's if_match was stale -> precondition_failed -> retry
  // that re-reads, merges, and writes the full [a, b, d, c] list.
  assert.ok(setCalls >= 2, 'retried after the race');
  const final = store.get('notebook').map((x) => x.id);
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(final.includes(id), `kept ${id}`);
  assert.equal(final.length, 4);
});

test('saveNotebook gives up after three precondition_failed races with storage_conflict', async () => {
  const { anna } = fakeAnnaWithEtag([makeFixture('a')]);
  anna.storage.set = async () => {
    const err = new Error('still racing');
    err.code = 'precondition_failed';
    throw err;
  };
  await assert.rejects(
    saveNotebook((current) => current),
    (e) => e instanceof HostError && e.code === 'storage_conflict',
  );
});

// ---- Notebook size: the backend rejects an over-cap write ------------------
// APS caps each row (value_too_large) and the legacy runtime_state bucket caps
// the whole state at 256 KiB (state_too_large). A full notebook must surface a
// clear message and never be reported as saved.

test('saveNotebook throws notebook_full when set() reports value_too_large', async () => {
  fakeAnna({ storage: {
    get: async () => ({ value: null, exists: false }),
    set: async () => { const e = new Error('row too large'); e.code = 'value_too_large'; throw e; },
  } });
  await assert.rejects(
    saveNotebook(notebook),
    (e) => e instanceof HostError && e.code === 'notebook_full' && e.message === 'Your notebook is full. Delete some old mistakes and try again.',
  );
});

test('saveNotebook throws notebook_full when set() reports state_too_large', async () => {
  fakeAnna({ storage: {
    get: async () => ({ value: null, exists: false }),
    set: async () => { const e = new Error('bucket too large'); e.code = 'state_too_large'; throw e; },
  } });
  await assert.rejects(
    saveNotebook(notebook),
    (e) => e instanceof HostError && e.code === 'notebook_full',
  );
});
