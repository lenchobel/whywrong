# WhyWrong design

## Subject, audience, job
A school student has just got a multiple-choice question wrong. They want to know
why the wrong answer looked right, and get practice so it does not happen again.
They are probably on a phone, tired, and a bit annoyed at themselves. The screen
has one job: show the trap that caught them, in the answer they actually picked.

## Direction: a marked-up worksheet on grid paper
School notebooks are grid paper, navy ballpoint, and a yellow highlighter. The
diagnosis works like a teacher's marking: the exact words that fooled the student
are highlighted in their own answer. That highlight is the one memorable thing
in the design. Everything around it stays quiet.

## Tokens

Color
- Paper `#F3F6FB`: page background, with a faint grid (`#E1E8F3`).
- Sheet `#FFFFFF`: one white worksheet, not a stack of cards.
- Ink `#182747`: navy ink for text. Muted `#56658A` (5.8:1 on white).
- Ballpoint blue `#2451D6`: actions and focus (6.5:1 on white).
- Highlighter `#FFE14D`: only ever marks trap words, and the top trap in Patterns.
- Marking red `#B42323` and green `#0F6B56`: wrong and right marks. Never the
  only signal; a text label always goes with them.

Type (system fonts only, so nothing has to load inside Anna's sandbox)
- Exam text, answers, rules: Charter / Iowan Old Style / Georgia. It looks like a
  printed exam paper, and the student's own question is set the same way.
- Interface: the system sans. Sentence case everywhere. No all-caps labels.
- Scale: 13, 15, 17, 20, 26, 32, 38. Serif body has more line height than sans.

Layout
- One column, left aligned, up to 880px. Sections are separated by rules.
- On wide screens the "why it was tempting" note sits in the margin next to the
  picked answer, like a teacher's note. On phones it stacks under it.
- Tabs are underlined text, not pills. Two corner radii only: 6px and 10px.

Motion
- One moment: when a diagnosis arrives, the highlighter sweeps across the trap
  words. Nothing else moves on its own. Reduced motion draws it at once.

## Review against the defaults
The first idea was a red-pen "teacher's marking" look. It sat too close to the
cream, serif and terracotta look that generated designs fall into, so the red was
cut down to small wrong marks and the highlighter became the accent instead.

Avoided on purpose: cream page with terracotta accent; dark page with acid
accent; broadsheet columns; rows of identical rounded cards with soft shadows;
gradient washes; all-caps eyebrow labels; monospace data labels; arrows on
buttons; middle-dot strings; numbered 01/02/03 markers; emoji as icons; an
accented single word in a headline.

Numbers only appear where the content is a real sequence: the three practice
questions and the A to D answer letters.

## Quality floor
- Works from 360px wide up. No sideways scroll. Every control is at least 44px tall.
- Visible keyboard focus. Ctrl or Cmd + Enter submits the form.
- Errors say what happened and what to do, in plain words, with no raw error text.
- Every screen has loading, empty and error states.
- Nothing from the AI or the student is ever inserted as HTML.

## Not done yet
- No dark mode.
- System fonts vary by device. If you want one exact typeface later, add the
  font files to `bundle/fonts/` and load them with `@font-face` from the bundle
  itself, since outside font sites are blocked.
