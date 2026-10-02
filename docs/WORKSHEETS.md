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
`serve-targets.html` (make sure it ends in `.html`, not `.txt`).

If the first answer is not right, say what is wrong in plain words and ask it to try
again. It keeps the rules from the prompt.

Every prompt ends with the same STYLE block, which matches the app: Geneva gold, charcoal,
cream.

### 1. Serve targets

```
Write me a single self-contained HTML file. It is a tennis serve-practice worksheet for a
college team app called Geneva Tennis. All CSS and JavaScript must be inline in that one
file. No images, no fonts, no libraries, nothing loaded from the internet. It must open
correctly by double-clicking it in Chrome.

WHAT IT DOES
Six targets: Wide, Body and T, on the deuce side and on the ad side. For each target the
player hits ten real serves and taps In or Out once per serve. Show the count for the
current target, the in-percentage per target, the totals for first-serve practice, and the
best and worst target. Include an Undo button for a mis-tap and a notes box asking where the
misses went: net, long, or wide.

THE HARD RULE
Nothing in this page may be earnable without actually training. No aiming game, no power
meter, no timing bar, no points for tapping. The player is standing on a real court logging
serves they really hit. Anything winnable on the couch rewards the opposite of training.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <input type="hidden" data-k="deuce_t_in">. Use hidden inputs with data-k to store
counts the page works out itself. Do not use radio buttons, they save incorrectly here.
The host app writes saved values back into those elements and then fires a single
"change" event on the document, so the page must listen for "change" on the document and
redraw its totals from the input values. The page must not contain any saving code of its own.

STYLE
Dark. Page background #0B0B0D, body text #F4F1EA, cards #1C1C20 with a 1px border of
rgba(255,255,255,.10) and 12px corners. Geneva gold #C99A2C for the primary button with
#0B0B0D text on it (never white text on gold), #DAAF48 for small gold labels, muted text
#9C9CA9, optic yellow #DDF54A for the current target. System font stack, 15px base, content
capped at 430px wide and centred. Built for a phone held in one hand: the In and Out buttons
at least 60px tall, everything else at least 44px. Every button and state carries a word,
never colour alone.

COPY
Plain, short sentences in a coach's voice. No em-dashes. No exclamation marks.
```

### 2. Footwork and split-step circuit

```
Write me a single self-contained HTML file. It is a tennis footwork worksheet for a college
team app called Geneva Tennis. All CSS and JavaScript inline in that one file. No images, no
fonts, no libraries, nothing loaded from the internet. It must open correctly by
double-clicking it in Chrome.

WHAT IT DOES
A circuit of eight footwork drills: split-step on the feed, spider drill, crossover recovery,
shuffle to the alley and back, drop-step to the backhand, approach and split, figure eights
around two balls, and the hexagon jump. Each drill is a row with its name, the prescribed
sets and reps, and a tick box the player taps when that drill is genuinely done. Include a
real stopwatch showing elapsed minutes for the whole circuit, started by a Start button. At
the bottom, a 1 to 10 box for how the legs felt and a notes box for which direction was slow.

THE HARD RULE
Nothing in this page may be earnable without actually training. No timing minigame, no
points for tapping. The tick boxes record work done on a court; the clock is real elapsed time.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <input type="checkbox" data-k="drill_spider">. Use hidden inputs with data-k for
anything the page calculates, such as elapsed minutes. Do not use radio buttons. The host
app writes saved values back and then fires one "change" event on the document, so the page
must redraw its progress from the inputs on that event. No saving code of its own.

STYLE
(paste the same STYLE block as prompt 1, with "the current drill" in optic yellow)

COPY
Plain, short sentences in a coach's voice. No em-dashes. No exclamation marks.
```

### 3. Match reflection

```
Write me a single self-contained HTML file. It is a post-match reflection worksheet for a
college tennis team app called Geneva Tennis. All CSS and JavaScript inline in that one
file. No images, no fonts, no libraries, nothing loaded from the internet. It must open
correctly by double-clicking it in Chrome.

WHAT IT DOES
The player writes about a match they just played. Fields: opponent, school, date, score.
Then five short writing boxes: what the opponent did on big points, the pattern that won me
the most points, the pattern that lost me the most, what I did between points when I was
behind, and one thing to practise before the next match. Add a checklist: I used my
between-point routine, I knew the score before every point, I committed to my targets on
break points, I reset after errors. Keep it to one screen of scrolling on a phone.

THE HARD RULE
No score, no points, no badges. The value is the writing.

SAVING (this is the only technical contract)
Every value that should be saved must be on an element carrying a data-k attribute, for
example <textarea data-k="big_points"></textarea>. Do not use radio buttons. If the page
shows anything derived from the answers it must recalculate on the document "change" event.
No saving code of its own.

STYLE
(paste the same STYLE block as prompt 1; text boxes at least 16px font so the phone does not
zoom in)

COPY
Specific questions, not vague ones: "What did they serve to on break points?" beats "How did
you play?". No em-dashes. No exclamation marks.
```

### 4. Court sprints

```
Write me a single self-contained HTML file. It is a tennis conditioning worksheet for a
college team app called Geneva Tennis. All CSS and JavaScript inline in that one file. No
images, no fonts, no libraries, nothing loaded from the internet. It must open correctly by
double-clicking it in Chrome.

WHAT IT DOES
Six timed sprints, each touching every line of a singles court. A big Start and Stop button
runs a real stopwatch for the current sprint; stopping records the time to a tenth of a
second and moves on. Show every time in a list, the best, the average, and how much the
last sprint dropped off from the first. Include a rest timer between sprints. At the bottom,
a 1 to 10 box for how hard it felt.

THE HARD RULE
The clock measures real seconds of real running. No tapping game, no way to post a good time
sitting down.

SAVING (this is the only technical contract)
Put each recorded time in a hidden input with data-k, for example <input type="hidden"
data-k="sprint_1">. Do not use radio buttons. On the document "change" event the page must
rebuild the list, the best, the average and the drop-off from those inputs. No saving code.

STYLE
(paste the same STYLE block as prompt 1; the running clock large enough to read at arm's
length)

COPY
Plain, short sentences in a coach's voice. No em-dashes. No exclamation marks.
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
