// Browser tests. Serves ./bundle with the same strict CSP as manifest.json,
// swaps Anna's SDK for tests/mock-sdk.js, and drives the real screen.
//
//   node tests/e2e.mjs            run all scenarios
//   SHOTS=dir node tests/e2e.mjs  also save screenshots to dir
//
// Needs Playwright with Chromium installed. The loader prefers a
// project-local install (npm i -D playwright + npx playwright install
// chromium) and falls back to a PLAYWRIGHT_DIR env var for environments
// that ship Playwright elsewhere on disk.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'bundle');

async function loadChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    const req = createRequire(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/x.js');
    return req('playwright').chromium;
  }
}
const chromium = await loadChromium();

// Pick the installed browser binary. Recent Playwright defaults to
// chrome-headless-shell, but on networks where that download fails the
// full chromium binary is still on disk — use it as a fallback so e2e
// still runs. Returns undefined to let Playwright pick its own default.
function findBrowserExecutable() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(dir)) return undefined;
  const entries = fs.readdirSync(dir).filter((d) => d.startsWith('chromium'));
  for (const e of entries) {
    const cand = path.join(dir, e, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(cand)) return cand;
  }
  for (const e of entries) {
    const cand = path.join(dir, e, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(cand)) return cand;
  }
  return undefined;
}

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

let serveSdk = true;
const server = http.createServer((rq, rs) => {
  const url = new URL(rq.url, 'http://x').pathname;
  // Browsers auto-request /favicon.ico. Return a 204 to keep console clean.
  if (url === '/favicon.ico') { rs.writeHead(204); return rs.end(); }
  let file;
  if (url === '/static/anna-apps/_sdk/latest/index.js') {
    if (!serveSdk) { rs.writeHead(404); return rs.end('no sdk'); }
    file = path.join(here, 'mock-sdk.js');
  } else {
    file = path.join(bundle, url === '/' ? 'index.html' : url);
    if (!file.startsWith(bundle)) { rs.writeHead(403); return rs.end(); }
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      console.error(`e2e 404: ${url}`);
      rs.writeHead(404); return rs.end('not found');
    }
    rs.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain', 'content-security-policy': CSP });
    rs.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: findBrowserExecutable() ?? undefined });

// ---- helpers -----------------------------------------------------------------

const seedItem = (i, trapId, over = {}) => ({
  id: `seed${i}`,
  createdAt: Date.now() - i * 3600 * 1000,
  question: `Seed question ${i}. A passage about ${['volcanoes', 'sleep', 'bridges', 'coral reefs', 'printing', 'tides'][i % 6]} and what it shows.`,
  picked: `The answer that always claims everything about item ${i}.`,
  right: 'The careful answer.',
  trapId,
  whyTempting: 'It sounds confident.',
  trapWords: ['always'],
  rule: 'Strong words need strong proof.',
  check: 'Can I point to the line?',
  whyRight: 'It only says what the text says.',
  drills: [0, 1, 2].map((d) => ({
    stem: `Seed drill ${d + 1}`,
    options: ['One', 'Two', 'Three', 'Four'],
    correct: 1,
    trapOption: 2,
    explanations: ['No.', 'Yes.', 'Too strong.', 'Off topic.'],
  })),
  mastered: false,
  ...over,
});

async function open({ width = 1000, height = 900, seed = null, getFails = false, setFails = false, silentSet = false, setTooLarge = false, reducedMotion = 'no-preference', llm = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.addInitScript(({ seed, getFails, setFails, silentSet, setTooLarge, llm }) => {
    globalThis.__WW = { llm, calls: [], store: new Map(), setCalls: 0, getFails, setFails, silentSet, setTooLarge };
    if (seed) globalThis.__WW.store.set('notebook', JSON.stringify(seed));
  }, { seed, getFails, setFails, silentSet, setTooLarge, llm });
  await page.goto(BASE);
  await page.waitForSelector('#examples .link');
  return { page, ctx, problems };
}

const runSample = async (page, n = 0) => {
  await page.locator('#examples .link').nth(n).click();
  await page.click('#go');
};
const waitResult = (page) => page.waitForSelector('#result .trap-name', { timeout: 5000 });
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(1600); // let the highlighter sweep finish
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
const shotEl = async (page, selector, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(1600);
  await page.locator(selector).first().screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const storeNotebook = (page) => page.evaluate(() => {
  // The bundle now stores the raw array (storage.set({value: array})); the
  // legacy fallback is a JSON string. Accept both.
  const v = globalThis.__WW.store.get('notebook');
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return JSON.parse(v);
  return [];
});
const callCount = (page) => page.evaluate(() => globalThis.__WW.calls.length);

const good = () => JSON.stringify({
  ok: true, trap_id: 'half_right', why_tempting: 'First half is true.', trap_words: [], rule: 'Every part must be right.', check: 'Check each part.', why_right: '',
  drills: [0, 1, 2].map(() => ({ stem: 'Q', options: ['a1', 'b2', 'c3', 'd4'], correct: 0, trap_option: 1, explanations: ['e1', 'e2', 'e3', 'e4'] })),
});

// ---- scenarios -----------------------------------------------------------------

const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  pass  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
  }
}
const clean = (problems) => assert.deepEqual(problems, [], 'no console errors or CSP violations');

console.log('WhyWrong browser tests');

await scenario('happy path: diagnose, practice, save, notebook, mark, patterns', async () => {
  const { page, ctx, problems } = await open();
  await runSample(page, 0);
  await waitResult(page);
  assert.equal((await page.textContent('#result .trap-name')).trim(), 'Too extreme');
  assert.ok((await page.locator('.answer.wrong .hl').count()) >= 1, 'trap words highlighted');
  assert.equal(await page.locator('.drill').count(), 3);
  await shot(page, 'desktop-result');
  await shotEl(page, '.answers', 'closeup-answers');

  // drill 1: pick the trap option (index 2)
  const d1 = page.locator('.drill').nth(0);
  await d1.locator('.opt').nth(2).click();
  assert.match(await d1.locator('.feedback').textContent(), /Not this one/);
  assert.equal(await d1.locator('.opt.is-right').count(), 1);
  assert.equal(await d1.locator('.opt.is-wrong').count(), 1);
  assert.equal(await d1.locator('.opt-tag').nth(2).textContent(), 'Your pick, the trap');
  await shotEl(page, '.drill', 'closeup-drill');
  // drill 2: pick the right one
  const d2 = page.locator('.drill').nth(1);
  await d2.locator('.opt').nth(1).click();
  assert.match(await d2.locator('.feedback').textContent(), /Right\./);
  assert.equal(await d2.locator('.opt.is-trap').count(), 1);
  // drill 3: pick the right one
  await page.locator('.drill').nth(2).locator('.opt').nth(1).click();
  assert.match(await page.textContent('.drill-summary'), /You got 2 of 3/);

  await page.getByRole('button', { name: 'Save to notebook' }).click();
  await page.getByRole('button', { name: 'Saved to notebook' }).waitFor();
  assert.equal((await page.textContent('#nb-count')).trim(), '1');
  const saved = await storeNotebook(page);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].trapId, 'too_extreme');

  await page.click('.tab[data-view=notebook]');
  assert.equal(await page.locator('#view-notebook .entry').count(), 1);
  await page.locator('[data-act=toggle]').click();
  assert.equal((await page.locator('[data-act=toggle]').textContent()).trim(), 'Still tricky');
  assert.equal((await storeNotebook(page))[0].mastered, true);
  await shot(page, 'desktop-notebook');

  await page.click('.tab[data-view=patterns]');
  assert.match(await page.textContent('#view-patterns'), /1 mistake in the last 7 days/, 'Patterns shows from the first saved mistake (Bug 2 fix)');
  assert.match(await page.textContent('#view-patterns'), /Save a few more/, 'Patterns hints that more mistakes are needed for a real pattern');
  clean(problems);
  await ctx.close();
});

await scenario('keyboard: Ctrl+Enter submits from the question box', async () => {
  const { page, ctx } = await open();
  await page.locator('#examples .link').nth(1).click();
  await page.focus('#f-question');
  await page.keyboard.press('Control+Enter');
  await waitResult(page);
  await ctx.close();
});

await scenario('bad input is stopped before any AI call, with a message on the right field', async () => {
  const { page, ctx } = await open();
  await page.click('#go');
  assert.match(await page.textContent('#f-question-err'), /Paste the question first/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-question');
  await page.fill('#f-question', 'A proper long question about something with enough words in it?');
  await page.click('#go');
  assert.match(await page.textContent('#f-picked-err'), /Add the answer you picked/);
  await page.fill('#f-picked', 'Some answer');
  await page.fill('#f-right', 'some   ANSWER');
  await page.click('#go');
  assert.match(await page.textContent('#f-right-err'), /same as the one you picked/);
  await page.fill('#f-question', '!!!! ???? #### $$$$ %%%%');
  await page.click('#go');
  assert.match(await page.textContent('#f-question-err'), /too short/);
  await page.fill('#f-question', 'word '.repeat(1000));
  assert.match(await page.textContent('#f-question-count'), /over|of 4,000/i);
  await page.click('#go');
  assert.match(await page.textContent('#f-question-err'), /4,000/);
  assert.equal(await callCount(page), 0, 'the AI was never called');
  await shot(page, 'field-error');
  await ctx.close();
});

await scenario('one bad reply is retried automatically and the student never sees it', async () => {
  const { page, ctx } = await open({ llm: [{ text: 'sorry, here is some prose instead' }] });
  await runSample(page, 0);
  await waitResult(page);
  assert.equal(await callCount(page), 2);
  assert.equal(await page.locator('.notice').count(), 0);
  await ctx.close();
});

// Bug C — verdict trust: when the AI insists the picked answer is correct
// but the student gave a different right answer, we retry once and surface
// the conflict so the student can ask their teacher.
await scenario('correct-conflict: AI says correct twice with a right-vs-picked conflict, screen surfaces the conflict notice', async () => {
  const correctText = JSON.stringify({
    ok: true, verdict: 'correct', why: 'Pick matches the passage.',
  });
  // The sample question already has a right answer that differs from picked.
  const { page, ctx, problems } = await open({ llm: [{ text: correctText }, { text: correctText }] });
  await runSample(page, 0);
  await page.waitForSelector('#status .notice.info', { timeout: 5000 });
  const notice = await page.textContent('#status');
  assert.match(notice, /AI thinks your answer says the same as the right answer/i);
  assert.match(notice, /check it with your teacher/i);
  assert.equal(await callCount(page), 2, 'retried once before showing the conflict');
  // Nothing saved; no save row.
  assert.equal(await page.locator('.save-row .btn.primary').count(), 0);
  assert.equal((await storeNotebook(page)).length, 0);
  clean(problems);
  await ctx.close();
});

// Bug 1: when the AI says the picked answer is correct, the screen shows an
// info notice with the reason, an "Add the right answer" button that focuses
// the right-answer box, no trap and no drills, nothing saved.
// The right answer is cleared before submitting: both samples ship a right
// answer that differs from their picked answer, and since Fix C that case
// retries once (exhausting the one-reply mock queue), so the plain
// correct-verdict path is only reachable without a right answer.
await scenario('correct verdict: info notice + add-the-right-answer button, no trap, no save', async () => {
  const correctText = JSON.stringify({
    ok: true, verdict: 'correct', why: 'The picked answer is supported by the passage, just like the right answer.',
  });
  const { page, ctx, problems } = await open({ llm: [{ text: correctText }] });
  await page.locator('#examples .link').nth(0).click();
  await page.fill('#f-right', '');
  await page.click('#go');
  await page.waitForSelector('#status .notice.info', { timeout: 5000 });
  const notice = await page.textContent('#status');
  assert.match(notice, /Good news: your answer looks right/);
  assert.match(notice, /supported by the passage/);
  assert.match(notice, /Add the right answer/);
  // No trap, no drills, no save row.
  assert.equal(await page.locator('#result .trap-name').count(), 0, 'no trap rendered');
  assert.equal(await page.locator('.drill').count(), 0, 'no drills rendered');
  assert.equal(await page.locator('.save-row .btn.primary').count(), 0, 'no save button rendered');
  // Only one AI call — no retry on a correct verdict.
  assert.equal(await callCount(page), 1, 'no retry on verdict:correct');
  // Nothing written to the notebook.
  assert.equal((await storeNotebook(page)).length, 0);
  // The button focuses the right-answer box.
  await page.getByRole('button', { name: 'Add the right answer' }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-right');
  clean(problems);
  await ctx.close();
});

// Bug 2 — save readback
await scenario('a set() that reports OK but does not store shows "did not stick" and never marks it saved', async () => {
  const { page, ctx, problems } = await open({ silentSet: true });
  await runSample(page, 0);
  await waitResult(page);
  await page.getByRole('button', { name: 'Save to notebook' }).click();
  // The button must NOT flip to "Saved to notebook" because the read-back
  // check failed.
  await page.waitForSelector('.save-note', { timeout: 5000 });
  const note = (await page.textContent('.save-note')) || '';
  assert.match(note, /did not stick/i, 'shows the "did not stick" warning');
  assert.equal(await page.locator('.save-row .btn.primary:has-text("Saved")').count(), 0, 'not marked as saved');
  assert.equal(await page.locator('.save-row .btn.primary:has-text("Save to notebook")').count(), 1, 'save button still available');
  // Notebook stays empty.
  assert.equal((await storeNotebook(page)).length, 0);
  // Tab count stays hidden (no saved items).
  assert.equal(await page.locator('#nb-count').isVisible(), false, 'count badge hidden when notebook is empty');
  clean(problems);
  await ctx.close();
});

// Notebook size: a set() that rejects with value_too_large (the notebook hit
// the backend's size cap) shows the "notebook is full" message and never
// marks the entry saved.
await scenario('notebook full: set() throws value_too_large, message shown, nothing saved', async () => {
  const { page, ctx, problems } = await open({ setTooLarge: true });
  await runSample(page, 0);
  await waitResult(page);
  await page.getByRole('button', { name: 'Save to notebook' }).click();
  await page.waitForSelector('.save-note', { timeout: 5000 });
  const note = (await page.textContent('.save-note')) || '';
  assert.match(note, /Your notebook is full\. Delete some old mistakes and try again\./);
  assert.equal(await page.locator('.save-row .btn.primary:has-text("Saved")').count(), 0, 'not marked as saved');
  assert.equal(await page.locator('.save-row .btn.primary:has-text("Save to notebook")').count(), 1, 'save button still available');
  assert.equal((await storeNotebook(page)).length, 0, 'nothing written to the notebook');
  clean(problems);
  await ctx.close();
});

// Bug 2 — Patterns page rendering for the various notebook states.
await scenario('patterns: empty notebook shows the friendly empty message', async () => {
  const { page, ctx, problems } = await open();
  await page.click('.tab[data-view=patterns]');
  await page.waitForSelector('#view-patterns .empty', { timeout: 5000 });
  const text = await page.textContent('#view-patterns');
  assert.match(text, /Save a mistake and this page shows/);
  assert.equal(await page.locator('#view-patterns .bars').count(), 0, 'no bar chart on empty');
  assert.equal(await page.locator('#view-patterns .big-line').count(), 0, 'no headline on empty');
  clean(problems);
  await ctx.close();
});

await scenario('patterns: one saved mistake shows the top trap and a "save a few more" hint', async () => {
  const seedOne = [{
    id: 's1', createdAt: Date.now(), question: 'A passage about traffic fees. Which statement is best supported?',
    picked: 'The fee eliminated traffic.', right: 'The fee reduced traffic.',
    trapId: 'too_extreme', whyTempting: 'Eliminated sounds stronger than the passage supports.',
    trapWords: ['eliminated'], rule: 'Strong words need strong proof.',
    check: 'Can I point to the line that proves every strong word?',
    whyRight: 'Traffic fell, but the passage never says it stopped.',
    drills: [], mastered: false,
  }];
  const { page, ctx, problems } = await open({ seed: seedOne });
  await page.click('.tab[data-view=patterns]');
  await page.waitForSelector('#view-patterns .bars', { timeout: 5000 });
  const text = await page.textContent('#view-patterns');
  assert.match(text, /1 mistake/);
  assert.match(text, /Too extreme/);
  assert.match(text, /save a few more/i);
  assert.match(text, /real pattern/i);
  clean(problems);
  await ctx.close();
});

await scenario('patterns: only old mistakes fall back to the whole notebook, not last 7 days', async () => {
  const veryOld = [{
    id: 'o1', createdAt: Date.now() - 60 * 86400000, // 60 days ago
    question: 'An old passage about traffic fees. Which statement is best supported?',
    picked: 'The fee eliminated traffic.', right: 'The fee reduced traffic.',
    trapId: 'too_extreme', whyTempting: 'Eliminated sounds stronger than the passage supports.',
    trapWords: ['eliminated'], rule: 'Strong words need strong proof.',
    check: 'Can I point to the line that proves every strong word?',
    whyRight: 'Traffic fell, but the passage never says it stopped.',
    drills: [], mastered: false,
  }];
  const { page, ctx, problems } = await open({ seed: veryOld });
  await page.click('.tab[data-view=patterns]');
  await page.waitForSelector('#view-patterns .bars', { timeout: 5000 });
  const text = await page.textContent('#view-patterns');
  assert.match(text, /in your notebook/i, 'falls back to whole-notebook language');
  assert.match(text, /Too extreme/);
  clean(problems);
  await ctx.close();
});

await scenario('two bad replies show a friendly error and Try again works', async () => {
  const { page, ctx, problems } = await open({ llm: [{ text: 'nope' }, { text: '{"ok":true,"trap_id":"bogus"}' }] });
  await runSample(page, 0);
  await page.waitForSelector('.notice');
  assert.match(await page.textContent('.notice'), /shape we couldn't use/);
  assert.equal(await page.locator('#result .trap-name').count(), 0, 'no fake diagnosis is shown');
  assert.equal(await callCount(page), 2);
  await shot(page, 'error-unusable');
  await page.getByRole('button', { name: 'Try again' }).click();
  await waitResult(page);
  assert.equal(await page.locator('.notice').count(), 0);
  assert.equal(await page.locator('#go').isDisabled(), false);
  clean(problems);
  await ctx.close();
});

await scenario('an AI error shows a plain message and Try again recovers', async () => {
  const { page, ctx } = await open({ llm: [{ error: 'upstream 503' }] });
  await runSample(page, 0);
  await page.waitForSelector('.notice');
  assert.match(await page.textContent('.notice'), /couldn't answer right now/);
  assert.doesNotMatch(await page.textContent('.notice'), /503|upstream/, 'no raw error text');
  await page.getByRole('button', { name: 'Try again' }).click();
  await waitResult(page);
  await ctx.close();
});

await scenario('when the AI says it is not a question, the reason is shown and the form is kept', async () => {
  const { page, ctx } = await open({ llm: [{ text: '{"ok": false, "reason": "There are no answer choices to work with."}' }] });
  await runSample(page, 0);
  await page.waitForSelector('.notice');
  assert.match(await page.textContent('.notice'), /no answer choices/);
  assert.notEqual(await page.inputValue('#f-question'), '');
  await ctx.close();
});

await scenario('loading state shows while waiting, and the button is locked', async () => {
  const { page, ctx } = await open({ llm: [{ hang: true }] });
  await runSample(page, 0);
  await page.waitForSelector('.working');
  assert.equal(await page.locator('#go').isDisabled(), true);
  assert.equal((await page.textContent('#go')).trim(), 'Working');
  assert.equal(await page.getAttribute('#result', 'aria-busy'), 'true');
  await shot(page, 'loading');
  await ctx.close();
});

await scenario('saving fails cleanly, keeps the result, and works on retry', async () => {
  const { page, ctx } = await open({ setFails: true });
  await runSample(page, 0);
  await waitResult(page);
  await page.getByRole('button', { name: 'Save to notebook' }).click();
  await page.waitForFunction(() => /didn't save/.test(document.querySelector('.save-note')?.textContent || ''));
  assert.equal(await page.getByRole('button', { name: 'Save to notebook' }).isEnabled(), true);
  assert.equal(await page.locator('#result .trap-name').count(), 1, 'result still on screen');
  await page.evaluate(() => { globalThis.__WW.setFails = false; });
  await page.getByRole('button', { name: 'Save to notebook' }).click();
  await page.getByRole('button', { name: 'Saved to notebook' }).waitFor();
  await ctx.close();
});

await scenario('if the notebook cannot be read, nothing is overwritten', async () => {
  const { page, ctx } = await open({ getFails: true, seed: [seedItem(1, 'leap')] });
  await runSample(page, 0);
  await waitResult(page);
  await page.getByRole('button', { name: 'Save to notebook' }).click();
  await page.waitForFunction(() => /nothing was saved/.test(document.querySelector('.save-note')?.textContent || ''));
  assert.equal(await page.evaluate(() => globalThis.__WW.setCalls), 0, 'storage.set was never called');
  await page.click('.tab[data-view=notebook]');
  assert.match(await page.textContent('#view-notebook'), /couldn't be loaded/);
  await page.evaluate(() => { globalThis.__WW.getFails = false; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForSelector('#view-notebook .entry');
  assert.equal(await page.locator('#view-notebook .entry').count(), 1, 'the existing entry is still there');
  await ctx.close();
});

await scenario('notebook: search, filters, delete needs two taps, copy has a fallback', async () => {
  const seed = [
    seedItem(0, 'too_extreme'), seedItem(1, 'half_right'), seedItem(2, 'half_right', { mastered: true }),
    seedItem(3, 'leap'), seedItem(4, 'too_extreme'),
  ];
  const { page, ctx, problems } = await open({ seed });
  await page.click('.tab[data-view=notebook]');
  await page.waitForSelector('#view-notebook .entry');
  assert.equal(await page.locator('#view-notebook .entry').count(), 5);
  assert.equal((await page.textContent('#nb-count')).trim(), '5');

  await page.fill('#nb-search', 'coral');
  assert.equal(await page.locator('#view-notebook .entry').count(), 1);
  await page.fill('#nb-search', 'zebra');
  assert.match(await page.textContent('#view-notebook .entries'), /Nothing matches/);
  await page.fill('#nb-search', '');
  await page.selectOption('#nb-trap', 'half_right');
  assert.equal(await page.locator('#view-notebook .entry').count(), 2);
  await page.selectOption('#nb-status', 'mastered');
  assert.equal(await page.locator('#view-notebook .entry').count(), 1);
  await page.selectOption('#nb-trap', 'all');
  await page.selectOption('#nb-status', 'all');

  const first = page.locator('#view-notebook .entry').first();
  await first.getByRole('button', { name: 'Delete' }).click();
  assert.equal(await page.locator('#view-notebook .entry').count(), 5, 'first tap deletes nothing');
  await first.getByRole('button', { name: 'Tap again to delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#view-notebook .entry').length === 4);
  assert.equal((await storeNotebook(page)).length, 4);
  assert.equal((await page.textContent('#nb-count')).trim(), '4');

  await page.getByRole('button', { name: 'Copy notebook as text' }).click();
  await page.waitForSelector('#view-notebook .notice');
  const t = await page.textContent('#view-notebook .notice');
  assert.ok(/Copied/.test(t) || (await page.locator('.copybox').count()) === 1, 'either copied or showed the fallback box');
  clean(problems);
  await ctx.close();
});

await scenario('practice again reopens the saved drills', async () => {
  const { page, ctx } = await open({ seed: [seedItem(1, 'leap')] });
  await page.click('.tab[data-view=notebook]');
  await page.getByRole('button', { name: 'Practice again' }).click();
  await page.waitForSelector('#result .trap-name');
  assert.equal((await page.textContent('#result .trap-name')).trim(), 'Needs a leap');
  assert.equal(await page.locator('.drill').count(), 3);
  assert.ok((await page.inputValue('#f-question')).startsWith('Seed question 1'));
  assert.equal(await page.getByRole('button', { name: 'Saved to notebook' }).count(), 1, 'already saved, so it is not saved twice');
  await ctx.close();
});

await scenario('patterns: top trap, rule, and bars from the last 7 days', async () => {
  const seed = [
    seedItem(0, 'half_right'), seedItem(1, 'half_right'), seedItem(2, 'half_right'),
    seedItem(3, 'leap'), seedItem(4, 'opposite'), seedItem(5, 'leap', { createdAt: Date.now() - 30 * 86400000 }),
  ];
  const { page, ctx } = await open({ seed });
  await page.click('.tab[data-view=patterns]');
  await page.waitForSelector('#view-patterns .bars');
  const text = await page.textContent('#view-patterns');
  assert.match(text, /Half right/);
  assert.match(text, /5 mistakes/);
  assert.equal(await page.locator('#view-patterns .bar-row').count(), 3);
  assert.equal(await page.locator('#view-patterns .bar-row.top').count(), 1);
  const w = await page.$eval('#view-patterns .bar-row.top .bar-fill', (el) => el.getBoundingClientRect().width);
  assert.ok(w > 20, 'top bar has real width');
  await shot(page, 'desktop-patterns');
  await ctx.close();
});

await scenario('AI text is shown as text, never as HTML', async () => {
  const evil = JSON.parse(good());
  evil.rule = '<img src=x onerror="window.__pwned=1"> rule';
  evil.why_tempting = '<script>window.__pwned=2</script> tempting';
  evil.drills[0].stem = '<b>bold</b> stem';
  const { page, ctx } = await open({ llm: [{ text: JSON.stringify(evil) }] });
  await runSample(page, 0);
  await waitResult(page);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#result img, #result script, #result b').count(), 0);
  assert.match(await page.textContent('#result'), /<img src=x/);
  await ctx.close();
});

await scenario('phone width: no sideways scroll, tap targets are 44px or more', async () => {
  const { page, ctx, problems } = await open({ width: 360, height: 780, seed: [seedItem(1, 'leap'), seedItem(2, 'half_right')] });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok((await overflow()) <= 0, 'form view');
  await runSample(page, 0);
  await waitResult(page);
  assert.ok((await overflow()) <= 0, 'result view');
  await shot(page, 'phone-result');
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, select, textarea, summary')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el: `${el.tagName.toLowerCase()}.${el.className}`, h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44));
  assert.deepEqual(small, [], 'every control is at least 44px tall');
  await page.click('.tab[data-view=notebook]');
  assert.ok((await overflow()) <= 0, 'notebook view');
  await shot(page, 'phone-notebook');
  await page.click('.tab[data-view=patterns]');
  assert.ok((await overflow()) <= 0, 'patterns view');
  clean(problems);
  await ctx.close();
});

await scenario('reduced motion: highlight is drawn at once with no animation', async () => {
  const { page, ctx } = await open({ reducedMotion: 'reduce' });
  await runSample(page, 0);
  await waitResult(page);
  const s = await page.$eval('.answer.wrong .hl', (el) => { const c = getComputedStyle(el); return { anim: c.animationName, size: c.backgroundSize }; });
  assert.equal(s.anim, 'none');
  assert.equal(s.size, '100% 100%');
  await ctx.close();
});

await scenario('with motion on, the highlighter sweep is running', async () => {
  const { page, ctx } = await open();
  await runSample(page, 0);
  await waitResult(page);
  const anim = await page.$eval('.answer.wrong .hl', (el) => getComputedStyle(el).animationName);
  assert.equal(anim, 'sweep');
  await ctx.close();
});

await scenario('outside Anna: a clear message and the button is disabled', async () => {
  serveSdk = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector('.notice');
    assert.match(await page.textContent('.notice'), /has to run inside Anna/);
    assert.equal(await page.locator('#go').isDisabled(), true);
    await ctx.close();
  } finally {
    serveSdk = true;
  }
});

// ---- report --------------------------------------------------------------------

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
