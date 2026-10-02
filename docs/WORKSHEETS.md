# Writing a new worksheet

For the coach. No coding needed. Gemini writes the file, you check it in a browser, your
developer puts it in the app.

---

## What a worksheet is here

One `.html` file. That is the whole thing: the layout, the colours and any counting it
does all live in that single file.

Two places it opens:

1. **On your computer.** Double-click the file and it opens in Chrome like a web page.
   That is how you check it before anyone else sees it.
2. **Inside the app.** The Locker tab renders the same file. The athlete fills it in,
   taps Save, and you read what they wrote from your Progress list.

No image files, no second file, nothing downloaded from the internet. If it needs
anything that is not inside the file, it will look broken on a phone with no signal.

---

## The one technical rule

**Every box you want saved carries `data-k`.**

That is it. The app injects the saving code itself, so the file never mentions the app.

```html
<input type="number" data-k="ft_made" min="0" max="10">
<textarea data-k="notes"></textarea>
<label><input type="checkbox" data-k="warmup"> Warm up done</label>
```

`data-k` is just a short name for that box. Pick a different one for every box. When the
athlete opens the worksheet again, the app writes their saved answers back into the
boxes with matching names, so a half-finished sheet picks up where it left off.

Four things that follow from that, worth telling Gemini:

- **Anything can carry it**: text boxes, number boxes, dropdowns, checkboxes, and hidden
  boxes the page uses to remember a score it worked out itself.
- **No radio buttons.** They save the wrong answer. Use a dropdown or checkboxes.
- **After the app restores the answers it fires one `change` event on the document.** If
  the page adds up totals, it must recalculate when that event fires, or a returning
  athlete sees their numbers back but a total of zero.
- **Empty boxes and unticked boxes are not saved**, and a sheet is capped at 200 saved
  boxes. Nothing real gets near that.

The whole file has to stay under 900 KB, which is enormous for a page of text.

---

## The house rule that matters more than any of it

**Nothing the app rewards can be earnable without training.**

No aiming game. No power meter. No points for tapping. A shot somebody can make on the
couch rewards the opposite of what you sell. If a worksheet has a reward in it, the
reward attaches to a real rep on a real court, logged one tap at a time, or to real
elapsed minutes on a real clock.

Every Gemini prompt below already says this. Leave it in.

---

## How a finished file actually gets into the app

**There is no upload button in the app today.** The Locker tab says so. Two routes exist:

| Route | Who does it | How long until it is live |
| --- | --- | --- |
| **Baked into the app** | Your developer runs `npm run worksheets` and ships a build | Next app release |
| **Published to the database** | Written straight into the `workflows` collection in Firebase | Right away, no new release |

**The realistic one for you is the first.** Email the `.html` file to your developer and
say which it is. The second route means hand-typing a document into the Firebase console,
which is fiddly and easy to get wrong.

If anyone does take that second route, the document needs four things: `name`, `html`,
`cadence` and `sizeBytes`. Leaving `name` off is the one that hurts, because the Locker
sorts the list by it and a document without it stops the list loading for everybody.

Worth knowing: if a worksheet is published to the database under the same id as one that
ships in the app, the published one wins. That is the upgrade path, and it is why you can
fix a worksheet later without waiting for an app release.

---

## Ready-to-paste Gemini prompts

Open Gemini, paste one of these, and it writes the file. Then tell it to give you the
result as a downloadable `.html` file, or copy what it prints into Notepad and save it as
`free-throws.html` (make sure it ends in `.html`, not `.txt`).

If the first answer is not right, say what is wrong in plain words and ask it to try
again. It keeps the rules from the prompt.

### 1. Free-throw routine

```
Write me a single self-contained HTML file. It is a basketball free-throw worksheet for
a youth training app called Geneva Tennis. All CSS and JavaScript must be inline in
that one file. No images, no fonts, no libraries, nothing loaded from the internet. It
must open correctly by double-clicking it in Chrome.

WHAT IT DOES
Ten rounds of ten free throws. For each round the athlete taps a Made button or a Missed
button, one tap per real serve on a real court. Show which round they are on, the makes in
the current round, the running total out of 100, and the percentage. Show their longest
streak of makes. Include an Undo button for a mis-tap. Include a notes box at the bottom
asking where the misses went: short, long, left or right.

THE HARD RULE
Nothing in this page may be earnable without actually training. No aiming, no power
meter, no timing bar, no points for tapping, no game of skill of any kind. The athlete
is standing at a line logging shots they really took. Anything winnable on the couch
rewards the opposite of what this business sells.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <input type="number" data-k="ft_made_1">. Use hidden inputs with data-k to store
counts the page works out itself. Do not use radio buttons, they save incorrectly here.
The host app writes saved values back into those elements and then fires a single
"change" event on the document, so the page must listen for "change" on the document and
redraw its totals from the input values, otherwise a returning athlete sees a zero total
over restored numbers. The page must not contain any saving code of its own.

STYLE
Dark. Page background #08080C, body text #E8E8EE, cards #131318 with a 1px border of
rgba(255,255,255,.10) and 12px corners. Brand red #E60C20 for the primary button, #FF3A41
for small red labels, muted text #9C9CA9, a highlight yellow #FFD34D for the current cue.
System font stack, 15px base, content capped at 430px wide and centred. Built for a phone
held in one hand. The Made button at least 60px tall, everything else tappable at least
44px. Every button and every state carries a word or an icon, never colour alone, because
roughly 8 in 100 boys are red-green colourblind.

COPY
Plain, short sentences in a coach's voice. No em-dashes anywhere. No exclamation marks.
```

### 2. Ball-handling circuit

```
Write me a single self-contained HTML file. It is a basketball ball-handling worksheet
for a youth training app called Geneva Tennis. All CSS and JavaScript inline in that
one file. No images, no fonts, no libraries, nothing loaded from the internet. It must
open correctly by double-clicking it in Chrome.

WHAT IT DOES
A circuit of eight stationary and on-the-move handling drills: two-ball pound, figure
eights, cone weave left hand only, snatch-backs, hesitation into pull-up, full-court
change of pace, and two more you choose. Each drill is a row with its name, the
prescribed sets and reps, and a tick box the athlete taps when that drill is genuinely
done. Include a real stopwatch showing elapsed minutes for the whole circuit, started by
a Start button. At the bottom, a 1 to 10 box for how the hands felt and a notes box for
which hand was worse today.

THE HARD RULE
Nothing in this page may be earnable without actually training. No aiming, no power
meter, no timing minigame, no points for tapping. The tick boxes record work done at a
court. The clock is real elapsed time, not a countdown the athlete can win. Anything
winnable on the couch rewards the opposite of what this business sells.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <input type="checkbox" data-k="drill_pound">. Use hidden inputs with data-k for
anything the page calculates, such as elapsed minutes. Do not use radio buttons, they
save incorrectly here. The host app writes saved values back into those elements and then
fires a single "change" event on the document, so the page must listen for "change" on
the document and redraw its progress from the inputs, otherwise a returning athlete sees
their ticks restored but the progress line still reading zero. The page must not contain
any saving code of its own.

STYLE
Dark. Page background #08080C, body text #E8E8EE, cards #131318 with a 1px border of
rgba(255,255,255,.10) and 12px corners. Brand red #E60C20 for the primary button, #FF3A41
for small red labels, muted text #9C9CA9, highlight yellow #FFD34D. System font stack,
15px base, content capped at 430px wide and centred. Phone first. Every tap target at
least 44px tall. A completed drill shows a tick and struck-through text, not just a
colour change, because roughly 8 in 100 boys are red-green colourblind.

COPY
Plain, short sentences in a coach's voice. No em-dashes anywhere. No exclamation marks.
```

### 3. Film study sheet

```
Write me a single self-contained HTML file. It is a film study worksheet for a youth
basketball training app called Geneva Tennis. All CSS and JavaScript inline in that one
file. No images, no fonts, no libraries, nothing loaded from the internet. It must open
correctly by double-clicking it in Chrome.

WHAT IT DOES
The athlete watches one of their own games back and writes what they saw. Fields: who
they played, the date, and the minutes they played. Then five short writing boxes: three
possessions where the read was right, three where it was wrong, what the defence was
doing to them, one habit they can see on tape that they cannot feel on the floor, and one
thing to fix before the next game. Add a short checklist of things to watch for
specifically: first three steps after a pass, where their eyes are on the catch, closing
out under control, talking on defence. Keep the whole sheet to one screen of scrolling on
a phone.

THE HARD RULE
Nothing in this page may be earnable without actually doing the work. No score, no
points, no badges, no game of any kind. The value here is the writing, and it should read
like the athlete had to think. Anything winnable on the couch rewards the opposite of
what this business sells.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <textarea data-k="film_right"></textarea>. Do not use radio buttons, they save
incorrectly here. The host app writes saved values back into those elements and then
fires a single "change" event on the document, so if the page shows anything derived from
the answers, such as how many boxes are filled, it must recalculate on that event. The
page must not contain any saving code of its own.

STYLE
Dark. Page background #08080C, body text #E8E8EE, cards #131318 with a 1px border of
rgba(255,255,255,.10) and 12px corners. Brand red #E60C20 for accents, #FF3A41 for small
red labels, muted text #9C9CA9. System font stack, 15px base, content capped at 430px
wide and centred. Text boxes must be at least 16px font or the phone zooms in when the
athlete taps them. Every tap target at least 44px tall.

COPY
Plain, short sentences in a coach's voice. The prompts should be specific questions, not
vague ones: "What were they doing to take away your right hand?" beats "How did you
play?". No em-dashes anywhere. No exclamation marks.
```

### 4. Conditioning ladder

```
Write me a single self-contained HTML file. It is a basketball conditioning worksheet for
a youth training app called Geneva Tennis. All CSS and JavaScript inline in that one
file. No images, no fonts, no libraries, nothing loaded from the internet. It must open
correctly by double-clicking it in Chrome.

WHAT IT DOES
A suicide ladder: six runs, each one timed. A big Start and Stop button runs a real
stopwatch for the current run, and stopping it records that run's time to a tenth of a
second and moves to the next run. Show every recorded time in a list, the best run, the
average, and how much the last run dropped off from the first, which is the number that
actually says whether they are in shape. Include a rest timer between runs counting down
the prescribed rest. At the bottom, a 1 to 10 box for how hard it felt.

THE HARD RULE
Nothing in this page may be earnable without actually training. The clock measures real
seconds of real running. No tapping game, no rhythm bar, no way to post a good time
sitting down. The athlete can obviously lie to it, the same as any training log, but the
page must never make faking it into the fun part. Anything winnable on the couch rewards
the opposite of what this business sells.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute. Put
each recorded run time in a hidden input with data-k, for example <input type="hidden"
data-k="run_1">. Do not use radio buttons, they save incorrectly here. The host app
writes saved values back into those elements and then fires a single "change" event on
the document, so the page must listen for "change" on the document and rebuild the times
list, the best, the average and the drop-off from those inputs, otherwise a returning
athlete sees an empty sheet even though their times were saved. The page must not contain
any saving code of its own.

STYLE
Dark. Page background #08080C, body text #E8E8EE, cards #131318 with a 1px border of
rgba(255,255,255,.10) and 12px corners. Brand red #E60C20 for the Start and Stop button,
#FF3A41 for small red labels, muted text #9C9CA9, highlight yellow #FFD34D for the
current run. The running clock should be large and readable at arm's length on the floor,
because the athlete is bent over breathing when they look at it. System font stack,
content capped at 430px wide and centred. Start and Stop at least 60px tall, everything
else at least 44px. Every state carries a word, not just a colour, because roughly 8 in
100 boys are red-green colourblind.

COPY
Plain, short sentences in a coach's voice. No em-dashes anywhere. No exclamation marks.
```

---

## How to check it worked

Before you send it to anyone:

1. **Save the file with a `.html` ending**, somewhere you can find it again.
2. **Double-click it.** It should open in Chrome and look like the finished thing, dark
   background and all. If you get a wall of code instead, the file was saved as `.txt`.
   Rename it.
3. **Fill it in like an athlete would.** Tap every button. Tick every box. Type in every
   text box. Nothing should break, and no number should go negative or say NaN.
4. **Make the window narrow**, about as wide as a phone, by dragging its edge in. Nothing
   should run off the side or need sideways scrolling.
5. **Read every word out loud.** If a line does not sound like something you would say on
   a court, tell Gemini to rewrite it.
6. **Check the rule.** Is there any way to score well on this without going to a gym? If
   yes, it is not ready. Tell Gemini to remove that part.

When all six are right, email the file to your developer and say what it is for and how
often an athlete should fill it in: every session, every week, every quarter, or once.
