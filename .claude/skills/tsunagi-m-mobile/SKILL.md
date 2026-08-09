---
name: tsunagi-m-mobile
description: TSUNAGI/M house rules for making an instrument-style web app usable on a phone — app shell and viewport units, one-pane-at-a-time layout, the bottom footer and thumb-swept menu sheet, touch target sizing, readout alignment, PWA install and update, and the specific performance traps that make a tuner feel broken in a car. Use this whenever work touches mobile or phone layout, a footer or hamburger or bottom sheet, tap targets, safe areas, pull-to-refresh, PWA install or home-screen icons, 100vh/dvh/svh, "it feels slow" or "it froze" on a phone, or any responsive change to a TSUNAGI/M app — and use it before writing the CSS, not after, because most of these rules are corrections to the obvious first attempt.
---

# TSUNAGI/M on a phone

These are conventions from an app that is held in one hand, in a car, sometimes while the engine is running and always while it is connected to something that can be damaged. That context is what most of these rules are downstream of. If you are working on a TSUNAGI/M app that is not in a car, the reasoning still mostly holds — replace "while driving" with "while distracted" and the rules land in the same place.

## The one rule everything else follows from

**Measure it in a browser before you believe it, and measure it again after you change it.**

Almost every rule below started life as a plausible-sounding guess that turned out to be wrong by a factor of four. A designed 36×20 toggle rendered at 14×8. A "slow menu" was a 3D chart rebuilding behind `visibility: hidden`. A panel "just needing a bit more height" needed 494px against a 420px literal nobody had measured.

`scripts/probe.mjs` is a Playwright harness for exactly this — it takes a URL, a viewport list, and a snippet, and reports real numbers. Use it rather than writing a new one each time. CPU-throttle at rate 4 to approximate a mid-range phone; rate 6 exaggerates. `scripts/serve-like-pages.mjs` serves a static export the way the host does, and `scripts/update-check.mjs` proves an installed app can actually take a new build.

**It only sees the screen in front of it.** A change that removes something which *used to be* on screen alongside something else leaves the probe completely clean — no scroll, no overflow, nothing under 40px. That is the shape of the worst regression in this codebase's history, and `--watch` exists for it: name the boxes that have to coexist and it reports which of them are up at once.

**The "before" number usually has to be built.** A regression argued from the current tree is an opinion; the previous commit is the evidence.

```bash
git worktree add --detach ../before <sha>
cp -al node_modules ../before/node_modules   # hardlinks: seconds, and near-zero disk
```

Copy — do not symlink. Turbopack rejects a symlinked `node_modules` outright (`Symlink node_modules is invalid, it points out of the filesystem root`). Build both, serve them on two ports, run the same probe against each. That is what turned "portrait feels worse" into *431 + 268 together* against *699 one at a time*, which is an argument rather than a feeling.

Two viewports matter more than the rest, and neither is the one people test:

| | why |
|---|---|
| **851×393** | an ordinary phone in landscape. Short, not narrow. Every vertical budget breaks here first |
| **360×800** | portrait. Where a two-pane layout stops being a layout |

And after any mobile change, **re-check 1440×900 and confirm it did not move**. Say so in the commit with the numbers.

## Reading order

Start here, then read the file that matches what you are touching:

- **`references/layout.md`** — app shell, viewport units, the one-pane-at-a-time pattern, reserved space. Read before changing any container, height, or breakpoint.
- **`references/touch.md`** — footer, menu sheet, thumb sweep, tap targets, readout alignment. Read before adding or moving any control.
- **`references/performance.md`** — the specific things that make this kind of app feel broken, with the measured cost of each. Read the moment anyone says "slow", "frozen", or "laggy".

## The short version

**Shell.** `100svh`, never `vh`, and not `dvh` either. The app is sized to fit rather than to scroll, so it wants the smallest viewport the browser will ever show — `dvh` grows when the address bar retracts and the layout loses its own bottom when the bar comes back. `overscroll-behavior: none` on html and body: on a page that never scrolls, a downward swipe goes straight to Chrome's reload, and mid-session that costs the link, the log and the unsaved work.

**A reload button has to actually reload.** Turning pull-to-refresh off removes the only reload an installed app had, so it needs one of its own — and once an offline cache is in front of it, `location.reload()` returns the build already on disk, which is the one the button offered to replace. Ask the waiting worker to take over first, then reload, and let every step fall through to a plain reload on a deadline.

**One pane at a time below 900px.** Two panes sharing a phone is two unusable panes. Put them in one grid cell (`[grid-area:1/1]`) and make the inactive one `invisible`, not `display:none` — it stays laid out, so switching is a paint instead of a full re-solve. Then remember what that implies: **anything mounted in the invisible pane is still running.** Gate expensive children on the pane actually being on screen.

**Chrome lives at the bottom.** The header keeps only what has to be glanceable while driving — link state, which vehicle, which view. Everything else goes behind one control in a footer, centred absolutely so it is in the same place regardless of what sits either side of it.

**The menu is swept, not aimed.** It opens from the bottom centre, its lists run bottom-up so the first entry is nearest the thumb, and Close sits on the exact coordinates the press landed on. Press, slide, release — one gesture. Destructive things go at the far end, off the sweep entirely.

**Never put a write-path control behind a menu.** The controls that decide what gets sent to the device stay together and visible: one tap apart, no disclosure, no scrolling. A menu is a place for navigation and readouts. And check the mirror image: the menu is mobile-only chrome, so anything that lives *only* there does not exist above the breakpoint at all — which is how this app ended up with no reload of any kind at 1440×900.

**Size targets by what renders, not by what you wrote.** A scale floor is a promise about the smallest a control may become. If your floor renders the thing that arms a write at 14×8px, the floor is wrong, not the phone.

**Announce what you cannot make fast.** If a frame is going to be dropped, paint something first that says so — and give the browser an actual frame to paint it in before the thread goes away. A black rectangle that does not respond reads as a crash.

## Where the palette and motion rules live

Colour, status semantics and motion are TSUNAGI/M-wide rather than mobile-specific, and they are already written down in the app itself — `src/app/globals.css` carries the palette doctrine as comments beside the tokens. The parts that keep coming up on mobile:

- Dark only. Set `color-scheme: dark` in CSS **and** emit the viewport meta — the CSS property is what cascades into native controls, and mobile UAs ignore author styling on `<option>` entirely. Without it a `<select>` opens a full-screen white sheet at night.
- `animate-spin` means *a device operation is in flight*. `animate-pulse` means *armed / busy / caution*. They never stack on one element.
- 150ms is the house transition. 200/300/500 exist as deliberate exceptions; do not add a fourth.
- Before adding an entry animation, check it emits CSS. `animate-in fade-in zoom-in-95` is in this codebase five times and produces nothing — there is no `tailwindcss-animate`.

## Working style

State the measurement in the code comment, not just the conclusion. "`z-[5]`, because `z-10` is the thead and `z-20` is the corner cell" survives a refactor; "fix stacking" does not. The same goes for commit messages — the numbers before and after are what let the next person tell a fix from a preference.

When a rule here conflicts with what the app already does, prefer the app and say so. These are conventions distilled from one codebase; they are not a specification.
