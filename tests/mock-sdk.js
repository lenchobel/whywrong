// A stand-in for Anna's SDK, used only by the browser tests.
// Behaviour is controlled from the test through globalThis.__WW.
//
// Pinned to the documented surface:
//   - exports AnnaAppRuntime (matches the real SDK) so bundle/host.js's static
//     `import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js"`
//     resolves here.
//   - llm.complete(args) -> { content: { type: "text", text } }
//   - storage.get({ key }) -> { value, exists }
//   - storage.set({ key, value }) -> { ok: true } (legacy runtime_state shape)

const W = () => globalThis.__WW;

function defaultReply(args) {
  const body = args.messages[0].content;
  const picked = (body.match(/<picked_answer>\n([\s\S]*?)\n<\/picked_answer>/) || [])[1] || 'answer';
  const word = picked.split(/\s+/).find((w) => w.length > 6) || picked.split(/\s+/)[0];
  return JSON.stringify({
    ok: true,
    trap_id: 'too_extreme',
    why_tempting: 'The word ' + word + ' sounds like a stronger version of what the text says.',
    trap_words: [word],
    rule: 'Strong words need strong proof, so check the text for the exact line.',
    check: 'Can I point to the line that proves every strong word?',
    why_right: 'The right answer says only what the text supports.',
    drills: [0, 1, 2].map((i) => ({
      stem: 'Question about topic ' + (i + 1) + '. A short passage goes here, then the question is asked.',
      options: ['First choice ' + i, 'Second choice ' + i, 'Third choice ' + i, 'Fourth choice ' + i],
      correct: 1,
      trap_option: 2,
      explanations: ['This is not supported.', 'This matches the passage.', 'This is too strong for the passage.', 'This is off topic.'],
    })),
  });
}

const anna = {
  llm: {
    async complete(args) {
      const w = W();
      w.calls.push(args);
      const next = w.llm.length ? w.llm.shift() : { text: defaultReply(args) };
      if (next.error) throw new Error(next.error);
      if (next.hang) return new Promise(() => {});
      if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
      return { content: { type: 'text', text: next.text } };
    },
  },
  storage: {
    async get({ key } = {}) {
      const w = W();
      if (w.getFails) throw new Error('storage service unavailable');
      if (!w.store.has(key)) return { value: null, exists: false, etag: null };
      return { value: w.store.get(key), exists: true, etag: w.etag, generation: w.generation };
    },
    async set({ key, value, if_match } = {}) {
      const w = W();
      w.setCalls += 1;
      if (w.setFails) throw new Error('quota exceeded');
      // Simulate APS optimistic concurrency: if the caller passes an etag that
      // doesn't match the current one, surface precondition_failed instead of
      // clobbering. Tests that don't simulate a concurrent writer leave etag
      // unset so writes always succeed.
      if (if_match != null && if_match !== w.etag) {
        const err = new Error('precondition failed');
        err.code = 'precondition_failed';
        throw err;
      }
      // silentSet: set() reports OK but does NOT actually write — used to
      // verify that the bundle's read-back check catches a flaky backend.
      if (!w.silentSet) {
        w.store.set(key, value);
        w.generation = (w.generation || 0) + 1;
        w.etag = `W/"${w.generation}"`;
      }
      return { etag: w.etag, generation: w.generation, size_bytes: 0 };
    },
  },
};

// Match the real SDK's surface: bundle/host.js does `import { AnnaAppRuntime }
// from "/static/anna-apps/_sdk/latest/index.js"`, so this module must export
// the named binding `AnnaAppRuntime` with a `.connect()` method.
export const AnnaAppRuntime = {
  async connect() {
    return anna;
  },
};

// Back-compat exports for any test that imported the proxy directly.
export { anna };
export default anna;
