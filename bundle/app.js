// app.js: the screen. All text from the AI or the student goes in with
// textContent, never as HTML.

import {
  LIMITS, TRAPS, trapById, checkInput, diagnoseWith, splitHighlights,
  makeItem, addItem, removeItem, toggleMastered, filterItems, weekStats, allTimeStats, exportText,
} from './core.js';
import { connect, complete, loadNotebook, saveNotebook, HostError } from './host.js';
import { SAMPLES } from './samples.js';

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const state = {
  view: 'diagnose',
  notebook: null, // null until loaded
  notebookError: false,
  current: null, // { input, diagnosis, savedId }
  lastInput: null,
  busy: false,
  runtimeMissing: false,
  filters: { trapId: 'all', status: 'all', query: '' },
  armedDelete: null,
  armedReset: null,
};

// ---------------------------------------------------------------------------
// Helpers

function highlighted(text, words, { animate = false } = {}) {
  let n = 0;
  return splitHighlights(text, words).map((seg) => {
    if (!seg.hit) return seg.text;
    const span = h('span', { class: 'hl' }, seg.text);
    if (animate) span.style.setProperty('--i', String(n));
    n += 1;
    return span;
  });
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function focusHeading(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------------------
// Tabs

function showView(name, { focus = true } = {}) {
  state.view = name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-current', tab.dataset.view === name ? 'page' : 'false');
  }
  for (const id of ['diagnose', 'notebook', 'patterns']) {
    $(`#view-${id}`).hidden = id !== name;
  }
  if (name === 'notebook') renderNotebook();
  if (name === 'patterns') renderPatterns();
  if (focus) {
    const heading = $(`#view-${name} h1, #view-${name} h2`);
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }
}

function updateCount() {
  const badge = $('#nb-count');
  const n = state.notebook ? state.notebook.length : 0;
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

// ---------------------------------------------------------------------------
// Notebook storage

async function ensureNotebook() {
  if (state.notebook) return state.notebook;
  try {
    state.notebook = await loadNotebook();
    state.notebookError = false;
  } catch (err) {
    state.notebookError = true;
    throw err;
  } finally {
    updateCount();
  }
  return state.notebook;
}

async function persist(merge) {
  // `merge` is a function (currentList) => nextList. saveNotebook re-reads
  // inside, runs the merge against the fresh list, and writes with if_match
  // so a concurrent save from another tab or device is not clobbered.
  const next = await saveNotebook(merge);
  // Refresh the cached notebook from storage so the screen reflects the
  // post-merge state (including any concurrent changes we just merged in).
  state.notebook = await loadNotebook();
  updateCount();
}

// ---------------------------------------------------------------------------
// Diagnose form

const fields = {
  question: { input: () => $('#f-question'), error: () => $('#f-question-err') },
  picked: { input: () => $('#f-picked'), error: () => $('#f-picked-err') },
  right: { input: () => $('#f-right'), error: () => $('#f-right-err') },
};

function clearFieldErrors() {
  for (const f of Object.values(fields)) {
    f.error().hidden = true;
    f.error().textContent = '';
    f.input().removeAttribute('aria-invalid');
    f.input().closest('.field').classList.remove('invalid');
  }
}

function showFieldError(name, message) {
  const f = fields[name];
  f.error().textContent = message;
  f.error().hidden = false;
  f.input().setAttribute('aria-invalid', 'true');
  f.input().closest('.field').classList.add('invalid');
  f.input().focus();
}

function updateCounter() {
  const n = fields.question.input().value.length;
  const el = $('#f-question-count');
  if (n > LIMITS.question * 0.85) {
    el.hidden = false;
    el.textContent = `${n.toLocaleString('en-US')} of ${LIMITS.question.toLocaleString('en-US')} characters`;
    el.classList.toggle('over', n > LIMITS.question);
  } else {
    el.hidden = true;
  }
}

function setBusy(busy) {
  state.busy = busy;
  const go = $('#go');
  go.disabled = busy || state.runtimeMissing;
  go.textContent = busy ? 'Working' : 'Find the trap';
  $('#result').setAttribute('aria-busy', String(busy));
}

function clearStatus() {
  $('#status').replaceChildren();
}

function showWorking() {
  const text = h('p', { class: 'working-text' }, 'Reading your answer.');
  $('#status').replaceChildren(h('div', { class: 'working' }, text, h('div', { class: 'working-bar', 'aria-hidden': 'true' })));
  return (msg) => { text.textContent = msg; };
}

function showNotice({ info = false, lines, actions = [] }) {
  const box = h(
    'div',
    { class: `notice${info ? ' info' : ''}`, role: 'alert' },
    lines.map((l) => h('p', {}, l)),
    actions.length
      ? h('div', { class: 'actions' }, actions.map((a) => h('button', { type: 'button', class: 'btn small quiet', onclick: a.onClick }, a.label)))
      : null,
  );
  $('#status').replaceChildren(box);
  return box;
}

function fillForm({ question = '', picked = '', right = '' }) {
  fields.question.input().value = question;
  fields.picked.input().value = picked;
  fields.right.input().value = right;
  updateCounter();
}

function resetDiagnose() {
  fillForm({});
  clearFieldErrors();
  clearStatus();
  $('#result').replaceChildren();
  state.current = null;
  fields.question.input().focus();
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  clearFieldErrors();
  const checked = checkInput({
    question: fields.question.input().value,
    picked: fields.picked.input().value,
    right: fields.right.input().value,
  });
  if (!checked.ok) {
    showFieldError(checked.field, checked.message);
    return;
  }
  await runDiagnosis(checked.value);
}

async function runDiagnosis(input) {
  state.lastInput = input;
  state.current = null;
  $('#result').replaceChildren();
  setBusy(true);
  const setWorking = showWorking();
  const slow = setTimeout(() => setWorking('Still working. Writing three new questions takes a little while.'), 8000);
  try {
    const outcome = await diagnoseWith(complete, input);
    clearStatus();
    if (outcome.kind === 'ok') {
      state.current = { input, diagnosis: outcome.value, savedId: null };
      renderResult({ animate: true });
    } else if (outcome.kind === 'correct') {
      // Picked answer is actually right. Show an info notice only. No trap,
      // no drills, nothing saved.
      $('#result').replaceChildren();
      state.current = null;
      showNotice({
        info: true,
        lines: [
          "Good news: your answer looks right.",
          outcome.reason,
          'If the answer key says otherwise, add the right answer and try again so we can compare them.',
        ],
        actions: [{ label: 'Add the right answer', onClick: () => fields.right.input().focus() }],
      });
    } else if (outcome.kind === 'refused') {
      showNotice({
        info: true,
        lines: ["This doesn't look like a question and answer we can work with.", outcome.reason],
        actions: [{ label: 'Edit what I pasted', onClick: () => fields.question.input().focus() }],
      });
    } else {
      showNotice({
        lines: ["The AI's reply came back in a shape we couldn't use. Nothing was lost.", 'Try again. If it keeps happening, paste a shorter question.'],
        actions: [{ label: 'Try again', onClick: () => runDiagnosis(input) }],
      });
    }
  } catch (err) {
    clearStatus();
    const message = err instanceof HostError && err.code === 'timeout'
      ? 'The AI took too long to answer. Nothing was lost.'
      : err instanceof HostError && err.code === 'no_runtime'
        ? err.message
        : "The AI couldn't answer right now. Nothing was lost.";
    showNotice({
      lines: [message, 'Try again in a moment.'],
      actions: [{ label: 'Try again', onClick: () => runDiagnosis(input) }],
    });
  } finally {
    clearTimeout(slow);
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Result

function renderResult({ animate = false } = {}) {
  const { input, diagnosis } = state.current;
  const trap = trapById(diagnosis.trapId);
  const root = $('#result');
  root.classList.toggle('sweep', animate);

  const verdict = h(
    'section',
    { class: 'part', 'aria-labelledby': 'r-trap' },
    h('p', { class: 'trap-lead' }, 'The trap that caught you'),
    h('h2', { class: 'trap-name', id: 'r-trap' }, trap.name),
    h('p', { class: 'trap-blurb' }, trap.blurb),
  );

  const answers = h(
    'div',
    { class: 'answers' },
    h(
      'div',
      { class: 'answer wrong' },
      h('h3', {}, 'You picked'),
      h('p', { class: 'answer-text' }, highlighted(input.picked, diagnosis.trapWords, { animate })),
    ),
    h('aside', { class: 'margin-note' }, h('h4', {}, 'Why it was tempting'), h('p', {}, diagnosis.whyTempting)),
    input.right
      ? h(
          'div',
          { class: 'answer right' },
          h('h3', {}, 'The right answer'),
          h('p', { class: 'answer-text' }, input.right),
          diagnosis.whyRight ? h('p', { class: 'why-right' }, diagnosis.whyRight) : null,
        )
      : null,
  );

  const marked = h('section', { class: 'part', 'aria-label': 'Your answer, marked' }, answers);

  const rule = h(
    'section',
    { class: 'part', 'aria-labelledby': 'r-rule' },
    h('h3', { id: 'r-rule' }, 'The rule'),
    h('p', { class: 'rule-text' }, diagnosis.rule),
    h('div', { class: 'check-text' }, h('h3', {}, 'Next time, ask yourself'), h('p', {}, diagnosis.check)),
  );

  const drills = h(
    'section',
    { class: 'part', 'aria-labelledby': 'r-drills' },
    h('h3', { id: 'r-drills' }, 'Three more like it'),
    renderDrills(diagnosis),
  );

  const save = h('section', { class: 'part', 'aria-label': 'Save' }, renderSaveRow());

  root.replaceChildren(verdict, marked, rule, drills, save);
  focusHeading(root);
}

function renderDrills(diagnosis) {
  const wrap = h('div', { class: 'drills' });
  const summary = h('p', { class: 'drill-summary', 'aria-live': 'polite' });
  summary.hidden = true;
  let answered = 0;
  let correctCount = 0;

  diagnosis.drills.forEach((drill, i) => {
    const stemId = `drill-${i}`;
    const feedback = h('div', { class: 'feedback', 'aria-live': 'polite' });
    feedback.hidden = true;

    const buttons = drill.options.map((text, j) =>
      h(
        'button',
        { type: 'button', class: 'opt' },
        h('span', { class: 'opt-letter', 'aria-hidden': 'true' }, 'ABCD'[j]),
        h('span', { class: 'opt-text' }, h('span', {}, text)),
        h('span', { class: 'opt-tag' }),
      ),
    );

    const answer = (picked) => {
      const gotIt = picked === drill.correct;
      buttons.forEach((b, j) => {
        b.disabled = true;
        const tag = $('.opt-tag', b);
        if (j === drill.correct) {
          b.classList.add('is-right');
          tag.textContent = 'Right answer';
        } else if (j === picked) {
          b.classList.add('is-wrong');
          tag.textContent = 'Your pick';
        }
        if (j === drill.trapOption && j !== drill.correct) {
          b.classList.add('is-trap');
          tag.textContent = j === picked ? 'Your pick, the trap' : 'The trap';
        }
        if (j !== drill.correct && j !== picked && j !== drill.trapOption) b.classList.add('is-dim');
      });

      const L = (j) => 'ABCD'[j];
      const lines = [];
      if (gotIt) {
        lines.push(h('p', {}, h('strong', {}, 'Right. '), drill.explanations[drill.correct]));
      } else {
        lines.push(h('p', {}, h('strong', {}, 'Not this one. '), drill.explanations[picked]));
        lines.push(h('p', {}, h('strong', {}, `The right answer is ${L(drill.correct)}. `), drill.explanations[drill.correct]));
      }
      if (drill.trapOption !== picked) {
        lines.push(h('p', {}, h('strong', {}, `The trap was ${L(drill.trapOption)}. `), drill.explanations[drill.trapOption]));
      }
      feedback.replaceChildren(...lines);
      feedback.classList.toggle('good', gotIt);
      feedback.classList.toggle('miss', !gotIt);
      feedback.hidden = false;

      answered += 1;
      if (gotIt) correctCount += 1;
      if (answered === diagnosis.drills.length) {
        summary.textContent =
          correctCount === 3
            ? 'You got 3 of 3. You spotted the trap every time.'
            : correctCount === 0
              ? 'You got 0 of 3. That is normal at first. Read the rule again, then ask the check question on each choice.'
              : `You got ${correctCount} of 3. Read the explanation for the one that slipped by, then save this to your notebook.`;
        summary.hidden = false;
      }
    };

    buttons.forEach((b, j) => b.addEventListener('click', () => answer(j)));

    wrap.append(
      h(
        'div',
        { class: 'drill', role: 'group', 'aria-labelledby': stemId },
        h('h4', {}, `Question ${i + 1}`),
        h('p', { class: 'drill-stem', id: stemId }, drill.stem),
        h('ul', { class: 'opts' }, buttons.map((b) => h('li', {}, b))),
        feedback,
      ),
    );
  });

  wrap.append(summary);
  return wrap;
}

function renderSaveRow() {
  const row = h('div', { class: 'save-row' });
  const note = h('p', { class: 'save-note', role: 'status' });

  const paint = () => {
    row.replaceChildren();
    if (state.current.savedId) {
      row.append(
        h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Saved to notebook'),
        h('button', { type: 'button', class: 'link', onclick: () => showView('notebook') }, 'Open notebook'),
      );
    } else {
      row.append(h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save to notebook'));
    }
    row.append(h('button', { type: 'button', class: 'btn quiet', onclick: resetDiagnose }, 'Diagnose another'), note);
  };

  const save = async () => {
    note.textContent = '';
    const btn = $('.btn.primary', row);
    btn.disabled = true;
    btn.textContent = 'Saving';
    try {
      const list = await ensureNotebook();
      const full = list.length >= LIMITS.notebook;
      const item = makeItem(state.current.input, state.current.diagnosis);
      // Merge: re-read inside saveNotebook and place the new item on top,
      // so a save from another tab or device is not clobbered.
      await persist((current) => addItem(current, item));
      state.current.savedId = item.id;
      paint();
      if (full) note.textContent = `Your notebook holds ${LIMITS.notebook} mistakes, so the oldest one was removed.`;
    } catch (err) {
      paint();
      if (err instanceof HostError && err.code === 'save_not_stuck') {
        // The set() returned OK but the read-back differs — the storage
        // backend silently dropped the write. Keep the save button enabled
        // so the student can try again.
        note.textContent = err.message;
      } else if (err instanceof HostError && err.code === 'storage_conflict') {
        note.textContent = 'Your notebook was being changed elsewhere. Try again.';
      } else if (state.notebookError) {
        note.textContent = "Your notebook couldn't be loaded, so nothing was saved. Try again.";
      } else {
        note.textContent = "That didn't save. Try again.";
      }
    }
  };

  paint();
  return row;
}

// ---------------------------------------------------------------------------
// Notebook

function renderNotebook() {
  const root = $('#view-notebook');
  root.replaceChildren(h('h2', { id: 'h-notebook', tabindex: '-1' }, 'Your mistake notebook'));

  if (state.notebook == null) {
    if (state.notebookError) {
      root.append(
        h('div', { class: 'notice' }, h('p', {}, "Your notebook couldn't be loaded. Nothing was changed."),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small quiet', onclick: retryNotebook }, 'Try again'))),
      );
    } else {
      root.append(h('p', { class: 'lede' }, 'Loading your notebook.'));
      retryNotebook();
    }
    return;
  }

  if (state.notebook.length === 0) {
    root.append(
      h('div', { class: 'empty' },
        h('p', { class: 'lede' }, 'Nothing here yet. When you save a diagnosis, it shows up here so you can find it again before the exam.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => showView('diagnose') }, 'Diagnose a mistake'))),
    );
    return;
  }

  const search = h('input', {
    type: 'search', id: 'nb-search', 'aria-label': 'Search your notebook', placeholder: 'Search questions', value: state.filters.query,
  });
  const trapSel = h('select', { id: 'nb-trap', 'aria-label': 'Filter by trap' },
    h('option', { value: 'all' }, 'All traps'),
    TRAPS.map((t) => h('option', { value: t.id }, t.name)));
  trapSel.value = state.filters.trapId;
  const statusSel = h('select', { id: 'nb-status', 'aria-label': 'Filter by progress' },
    h('option', { value: 'all' }, 'All'),
    h('option', { value: 'open' }, 'Still tricky'),
    h('option', { value: 'mastered' }, 'Got it'));
  statusSel.value = state.filters.status;

  const count = h('p', { class: 'note-count', role: 'status' });
  const list = h('ul', { class: 'entries' });
  const notice = h('div', {});

  const paintList = () => {
    const shown = filterItems(state.notebook, state.filters);
    count.textContent = shown.length === state.notebook.length
      ? plural(state.notebook.length, 'mistake saved.', 'mistakes saved.')
      : `Showing ${shown.length} of ${state.notebook.length}.`;
    if (!shown.length) {
      list.replaceChildren(h('li', { class: 'entry' }, h('p', {}, 'Nothing matches. Clear the search or change a filter.')));
      return;
    }
    list.replaceChildren(...shown.map((it) => entryEl(it, { paintList, notice })));
  };

  search.addEventListener('input', () => { state.filters.query = search.value; paintList(); });
  trapSel.addEventListener('change', () => { state.filters.trapId = trapSel.value; paintList(); });
  statusSel.addEventListener('change', () => { state.filters.status = statusSel.value; paintList(); });

  const copyBtn = h('button', { type: 'button', class: 'btn small quiet', onclick: () => copyAll(notice) }, 'Copy notebook as text');

  root.append(h('div', { class: 'toolbar' }, search, trapSel, statusSel), count, notice, list, h('div', { class: 'actions' }, copyBtn));
  paintList();
}

async function retryNotebook() {
  try {
    await ensureNotebook();
  } catch {
    /* renderNotebook shows the error state */
  }
  if (state.view === 'notebook') renderNotebook();
  if (state.view === 'patterns') renderPatterns();
}

function entryEl(it, { paintList, notice }) {
  const trap = trapById(it.trapId);

  const fail = (err) => notice.replaceChildren(h('div', { class: 'notice', role: 'alert' }, h('p', {}, (err instanceof HostError && err.code === 'save_not_stuck') ? err.message : "That change didn't save. Try again.")));
  const change = async (next, after) => {
    try {
      await persist(() => next);
      notice.replaceChildren();
      paintList();
      if (after) after();
    } catch (err) {
      fail(err);
    }
  };

  const toggle = h('button', { type: 'button', class: 'btn small quiet', 'data-act': 'toggle' }, it.mastered ? 'Still tricky' : 'Got it');
  toggle.addEventListener('click', () =>
    change(toggleMastered(state.notebook, it.id), () => $(`#view-notebook li[data-id="${it.id}"] [data-act="toggle"]`)?.focus()));

  // Delete takes two taps. The first tap arms it, and it disarms itself after 4 seconds.
  const del = h('button', { type: 'button', class: 'btn small quiet' }, 'Delete');
  const disarm = () => {
    del.textContent = 'Delete';
    del.classList.remove('danger-armed');
    if (state.armedDelete === it.id) state.armedDelete = null;
  };
  del.addEventListener('click', () => {
    if (state.armedDelete === it.id) {
      state.armedDelete = null;
      change(removeItem(state.notebook, it.id), () => $('#nb-search')?.focus());
      return;
    }
    if (state.armedReset) state.armedReset();
    state.armedDelete = it.id;
    state.armedReset = disarm;
    del.textContent = 'Tap again to delete';
    del.classList.add('danger-armed');
    setTimeout(disarm, 4000);
  });

  return h('li', { class: `entry${it.mastered ? ' mastered' : ''}`, 'data-id': it.id },
    h('div', { class: 'entry-head' },
      h('span', { class: 'entry-trap' }, trap.name),
      h('span', { class: 'entry-meta' }, `${fmtDate(it.createdAt)}${it.mastered ? ', got it' : ''}`)),
    h('p', { class: 'entry-q' }, it.question),
    h('p', { class: 'entry-picked' }, 'You picked: ', highlighted(it.picked, it.trapWords)),
    h('details', {},
      h('summary', {}, 'See the rule'),
      h('div', { class: 'entry-more' },
        h('p', {}, it.whyTempting),
        h('p', {}, it.rule),
        h('p', {}, `Next time, ask yourself: ${it.check}`))),
    h('div', { class: 'entry-actions' },
      h('button', { type: 'button', class: 'btn small quiet', onclick: () => practiceAgain(it) }, 'Practice again'),
      toggle,
      del),
  );
}

function practiceAgain(it) {
  fillForm({ question: it.question, picked: it.picked, right: it.right });
  clearFieldErrors();
  clearStatus();
  state.current = {
    input: { question: it.question, picked: it.picked, right: it.right },
    diagnosis: { trapId: it.trapId, whyTempting: it.whyTempting, trapWords: it.trapWords, rule: it.rule, check: it.check, whyRight: it.whyRight, drills: it.drills },
    savedId: it.id,
  };
  showView('diagnose', { focus: false });
  renderResult();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyAll(notice) {
  const text = exportText(state.notebook);
  if (await copyText(text)) {
    notice.replaceChildren(h('div', { class: 'notice info', role: 'status' }, h('p', {}, 'Copied. Paste it into your notes app.')));
    return;
  }
  const box = h('textarea', { class: 'copybox', rows: '8', readonly: true, 'aria-label': 'Your notebook as text' });
  box.value = text;
  notice.replaceChildren(
    h('div', { class: 'notice info', role: 'status' }, h('p', {}, "Copying isn't allowed here. Select all the text below and copy it yourself."), box),
  );
  box.focus();
  box.select();
}

// ---------------------------------------------------------------------------
// Patterns

function renderPatterns() {
  const root = $('#view-patterns');
  root.replaceChildren(h('h2', { id: 'h-patterns', tabindex: '-1' }, 'Your patterns'));

  if (state.notebook == null) {
    if (state.notebookError) {
      root.append(
        h('div', { class: 'notice' }, h('p', {}, "Your notebook couldn't be loaded, so there's nothing to show yet."),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small quiet', onclick: retryNotebook }, 'Try again'))),
      );
    } else {
      root.append(h('p', { class: 'lede' }, 'Loading your notebook.'));
      retryNotebook();
    }
    return;
  }

  // Empty notebook: a friendly one-line nudge, no chart, no headline.
  if (state.notebook.length === 0) {
    root.append(
      h('div', { class: 'empty' },
        h('p', { class: 'lede' }, 'Save a mistake and this page shows which trap catches you most, plus the rule that beats it.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => showView('diagnose') }, 'Diagnose a mistake'))),
    );
    return;
  }

  // Pick the data window. If the last 7 days has any mistakes, use that;
  // otherwise fall back to the whole notebook so the page is never blank.
  const recent = weekStats(state.notebook);
  const useRecent = recent.total > 0;
  const stats = useRecent ? recent : allTimeStats(state.notebook);
  const windowText = useRecent ? 'in the last 7 days' : 'in your notebook';

  // With fewer than 3 mistakes the top trap is a hint, not a real pattern.
  // Still show the rule and bar so the screen has something to act on.
  const stillEarly = state.notebook.length < 3;
  const top = stats.top;

  const headline = stillEarly
    ? h('p', { class: 'big-line' },
        `So far you have ${plural(stats.total, 'mistake', 'mistakes')} ${windowText}. The trap so far: `,
        h('strong', {}, trapById(top.id).name),
        `. Save a few more and this page shows your real pattern.`)
    : h('p', { class: 'big-line' },
        `${capitalize(windowText)} you saved ${plural(stats.total, 'mistake', 'mistakes')}. The trap that got you most was `,
        h('strong', {}, trapById(top.id).name),
        ` (${top.count} of ${stats.total}).`);

  const max = stats.top ? stats.top.count : 1;
  const bars = stats.byTrap.map((row, i) => {
    const fill = h('div', { class: 'bar-fill' });
    fill.style.setProperty('--w', `${Math.round((row.count / max) * 100)}%`);
    return h('li', { class: `bar-row${i === 0 ? ' top' : ''}` },
      h('span', { class: 'bar-name' }, trapById(row.id).name),
      h('div', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'bar-count' }, String(row.count)));
  });

  root.append(
    headline,
    h('div', { class: 'part' },
      h('h3', {}, 'The rule that beats it'),
      h('p', { class: 'rule-text' }, trapById(top.id).rule),
      h('div', { class: 'check-text' }, h('h3', {}, 'Ask yourself'), h('p', {}, trapById(top.id).check))),
    h('ul', { class: 'bars', 'aria-label': `Mistakes by trap, ${windowText}` }, bars),
    h('p', { class: 'tally' }, `${plural(recent.stillTricky, 'mistake', 'mistakes')} in your notebook still marked tricky.`),
    stillEarly
      ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => showView('diagnose') }, 'Diagnose another mistake'))
      : null,
  );
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------------------------------------------------------------------------
// Start up

function init() {
  const examples = $('#examples');
  SAMPLES.forEach((s) => {
    examples.append(' ', h('button', {
      type: 'button', class: 'link',
      onclick: () => {
        fillForm(s);
        clearFieldErrors();
        clearStatus();
        $('#result').replaceChildren();
        state.current = null;
        $('#go').focus();
      },
    }, s.label));
  });

  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));

  $('#form').addEventListener('submit', onSubmit);
  $('#clear').addEventListener('click', resetDiagnose);
  for (const f of Object.values(fields)) {
    f.input().addEventListener('input', () => {
      f.error().hidden = true;
      f.input().removeAttribute('aria-invalid');
      f.input().closest('.field').classList.remove('invalid');
      updateCounter();
    });
    f.input().addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#form').requestSubmit();
    });
  }

  connect()
    .then(() => ensureNotebook())
    .catch((err) => {
      if (err instanceof HostError && err.code === 'no_runtime') {
        state.runtimeMissing = true;
        $('#go').disabled = true;
        showNotice({ lines: [err.message] });
      }
    });
}

init();
