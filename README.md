# WhyWrong

## What it is

WhyWrong is a study app that helps you understand why a multiple-choice
answer looked right when it wasn't. You paste the question, the answer
you picked, and the right answer. WhyWrong names the trap that caught
you, shows the exact words that fooled you, explains the rule in plain
language, and writes three new practice questions for the same trap.

It's built as an Anna app, so it runs inside Anna — no install, no
account beyond your Anna one, and your notebook is saved with Anna's
storage.

## How a student uses it

1. Open WhyWrong in Anna.
2. Paste the question you got wrong and the answer you picked. Add the
   right answer if you have it.
3. Read the diagnosis: which trap it was, the rule, and the words that
   tricked you.
4. Answer the three new practice questions WhyWrong writes for the
   same trap, with feedback on every choice.
5. Tap **Save to notebook**. Open **Patterns** to see which trap
   catches you most and the one rule that beats it.

## Screenshots

![Diagnosis screen](store/screenshot-1-diagnosis.png)
![Practice questions](store/screenshot-2-practice.png)
![Notebook](store/screenshot-3-notebook.png)
![Patterns](store/screenshot-4-patterns.png)
![Phone layout](store/screenshot-5-phone.png)

Cover image:

![WhyWrong cover](store/cover.png)

## Privacy

WhyWrong only sends the question you paste to Anna's AI to write the
feedback. Your notebook is stored in your Anna account. The app does
not collect personal details, run ads, or share data. Full details in
[PRIVACY.md](PRIVACY.md).

## For developers

A student pastes a multiple-choice question they got wrong and the answer they
picked. The app names the trap that caught them, explains the rule in plain
words, and writes three new practice questions for that trap. Mistakes go into a
private notebook, and a Patterns page shows which trap catches them most.

It is a UI-only Anna app: the screen runs in Anna's sandbox, the AI comes from
Anna's host AI, and the notebook is saved with Anna's storage. There is no
server, no outside API key, and no browser localStorage.

### What is here

```
app.json            store listing
manifest.json       permissions and UI settings (schema 2)
bundle/
  index.html        the screen
  style.css         the look (see DESIGN.md)
  core.js           trap list, AI prompt, strict checking of the AI's reply, notebook rules
  host.js           the ONLY file that talks to Anna (AI + storage)
  app.js            the screen logic
  samples.js        two original example questions
tests/
  core.test.mjs     43 tests for the logic and host adapter (with host.test.mjs)
  host.test.mjs
  e2e.mjs           18 browser tests with a strict CSP and a mock Anna
  mock-sdk.js       stand-in for Anna's SDK, tests only
DESIGN.md           design plan and what was avoided
```

### Run it

```
npm test                    # logic tests, no install needed (Node 22)
npm run test:e2e            # browser tests, needs Playwright + Chromium
anna-app validate --strict  # the real check. Run this first.
anna-app login --host https://anna.partners
anna-app dev                # opens the app with the REAL AI
```

