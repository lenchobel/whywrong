// A stand-in for Anna's SDK, used only by the browser tests.
// Behaviour is controlled from the test through globalThis.__WW.

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

export const anna = {
  llm: {
    async complete(args) {
      const w = W();
      w.calls.push(args);
      const next = w.llm.length ? w.llm.shift() : { text: defaultReply(args) };
      if (next.error) throw new Error(next.error);
      if (next.hang) return new Promise(() => {});
      if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
      return { text: next.text };
    },
  },
  storage: {
    async get(key) {
      const w = W();
      if (w.getFails) throw new Error('storage service unavailable');
      if (!w.store.has(key)) throw new Error('Key not found');
      return { key, value: w.store.get(key) };
    },
    async set(key, value) {
      const w = W();
      w.setCalls += 1;
      if (w.setFails) throw new Error('quota exceeded');
      w.store.set(key, value);
      return { key, value };
    },
  },
};

export default anna;
