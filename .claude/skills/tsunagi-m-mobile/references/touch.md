# Chrome, the menu sheet, and things a thumb has to hit

## Where the chrome goes

The header keeps only what has to be readable at a glance while driving: link state, which vehicle, which view. It is the worst place to put anything else — on a 360px phone the header content box is about 312px, and four groups competing for it means the `flex-1` one resolves to zero and takes a feature with it.

Everything else goes in a **footer**, because that is where the thumb is.

```
┌──────────────────────────────┐
│ ● WORDMARK…            V2 β  │  header: state, vehicle, identity
├──────────────────────────────┤
│                              │
│         content              │
│                              │
├──────────────────────────────┤
│  VIEW-A  VIEW-B   ///   ⚙ ⚙  │  footer: pane switch | MENU | panel triggers
└──────────────────────────────┘
```

Two details that are not obvious:

**MENU is centred absolutely, not by flex order.** The groups either side of it are two short words and three icons *today*. Centred by layout, it drifts the moment either changes width, and a control you reach for without looking has to be in the same place every time.

**The footer sits outside both panes.** Each pane hides the other, so anything living inside one takes the way out of the other with it.

**The pane switch wears the tab row's clothes** — same height, same letterspaced label, same 2px indicator — because it *is* navigation and should not read as a new kind of control. In a footer the indicator goes on the **top** edge; a bottom border lands on the screen edge, half-clipped, reading as nothing.

## The menu sheet

It opens from a button at the bottom centre, so everything in it is ordered outward from that point:

```
┌──────────────────────────────┐
│  ↻ RELOAD                    │  destructive, furthest from the thumb
│  SESSION / VEHICLE readouts  │  pinned, out of the sweep
├──────────────────────────────┤
│  DOWNLOAD  (reversed)        │  scrolls, opens at its own end
│  VIEW      (reversed)        │  first entry nearest the thumb
├──────────────────────────────┤
│              ✕               │  same coordinates as the button that opened it
└──────────────────────────────┘
```

- **Lists run bottom-up.** The first tab sits closest to the button and the list climbs away. Reversing the array is the whole implementation.
- **Readouts pin above the scroll.** They are consulted as much as navigated with, and scrolling them away to reach a tab meant they were never on screen at the moment you wanted them. **Pinned is a promise about position, not a licence to push the rest off the screen** — connected, these grew to 314px of a 360px sheet and took both the list and the close button with them. `layout.md` has the fix and the numbers.
- **The scroller opens at its own end**, so the rows worth reaching are the ones you see: `el.scrollTop = el.scrollHeight` on mount.
- **Close sits on the coordinates the press landed on.** Second tap closes what the first opened, thumb unmoved.
- **Disabled entries stay listed.** Which view does not exist yet is the same information as which one does.
- **Hide the scrollbar** (`scrollbar-width: none`). A rail down the edge of a 360px sheet is noise; a list that visibly runs past the fold already says what the bar would.

### Press, slide, release

The opening press carries through into a selection. Pointerdown opens the sheet and starts tracking; sliding highlights whatever row is under the finger; releasing runs it. Three things make it work and each one is a bug you would otherwise ship:

**Hit-test, do not listen.** The press started on the footer button, so that element holds the implicit pointer capture and the rows never see the move events. Find the row with `document.elementFromPoint(...).closest('[data-menu-key]')`.

**Dispatch `.click()` on the row rather than looking a handler up.** The row already owns its handler for the ordinary tap path; one way in means the two cannot drift apart.

**Require travel before it counts — about 12px.** Close is deliberately in the same place as the button that opens the sheet, so a press that never moves would release onto Close and shut what it just opened.

```js
const travelled = (e) => moved || (moved = Math.hypot(e.clientX - from.x, e.clientY - from.y) > 12);
```

**End the drag from the sheet, not from the button.** The scrim goes up on pointerdown and covers that button, so its own pointerup never fires. Leave the drag armed and the next release anywhere on the page reads as a selection — which is what "the button feels unreliable" turns out to be.

**Gate dismissal for ~400ms after opening.** On touch, letting go fires a compatibility `click` at the same coordinates a beat after pointerup, and Close is at those coordinates by design. `preventDefault` on the opening pointerdown does not reliably suppress it. Gate *only* Close and the scrim — the sweep path runs off pointerup and dispatches its own click, so it needs no gate.

This one is easy to miss in testing: synthetic mouse events do not produce a compatibility click. Test with real touch (`isMobile: true` + `touchscreen.tap`, or CDP `Input.dispatchTouchEvent`).

### What does not go in the menu

**Anything that writes.** The controls that decide what gets sent to the device — the arming toggles, the start/stop, the write itself — stay together and visible, one tap apart. A control whose state changes what goes into the device does not belong behind something you have to open. This is the rule to push back on if someone asks for a "cleaner" screen.

### And the mirror image: the menu is mobile-only

The sheet hangs off the same breakpoint the footer does, so a control that lives **only** in it does not exist above that line. Not harder to reach — absent. Nothing renders it, and there is no second copy to fall back on.

That is how this app ended up with no reload anywhere at 900px and up: the row was written for the sheet, the sheet is `min-[900px]:hidden`, and installed as a TWA there is no browser chrome to reload from either. It reads as a mobile improvement right up until someone runs it on a head unit.

So every time something moves into the sheet, ask what the wide layout just lost — and check it by measuring, not by reading the JSX, because the JSX looks fine:

```js
[...document.querySelectorAll('button, a')]
    .filter(el => /reload|flash|export/i.test(el.textContent) && el.getBoundingClientRect().height > 0)
```

Run it across the viewport list. An empty result at 1440×900 for something the app cannot work without is the finding.

## Tap targets

**Size by what renders, not by what you wrote.** Measure the on-screen box.

The classic failure: a control inside an auto-fit `transform: scale()`. Designed 36×20, floor 0.4, rendered **14×8**. The label that was the only thing distinguishing READ from WRITE inside an 80px dial rendered at **3.2px**.

- **A scale floor is a promise about the smallest a control may become.** If it renders something unoperable, the floor is wrong. 0.4 → 0.8 here, and the shortfall went to the picture above, which is elastic.
- **Padding cancelled by an equal negative margin** grows the hit box without moving anything: `py-3 -my-3`. Rows stacked directly against each other get `py-2` instead, or they overlap and steal each other's taps.
- **Watch `-mx-*` on a `w-full` box.** It widens by the margin on both sides but only the left one moves the origin, so the content centre shifts. Two centred buttons sat 8px left of centre this way.
- **Anchor pseudo-element knobs to the thing they slide in.** A toggle knob positioned `top-[2px] left-[2px]` resolves against the nearest positioned ancestor — add padding to the wrapping `<label class="relative">` and the knob leaves the pill. Put `relative` on the pill.

Measured, after: arming toggles 14×8 → 42×35, filter rows ~15px tall → 39, dial 32 → 64px.

## A tooltip is not a delivery mechanism

**There is no hover.** So a `title` is not "the full text, available on demand" — on a phone it is text that does not exist. Write it if you like for the desk; never let it be the only copy of something the reader needs.

This is the expensive one, because it fails silently and only for the people who are not testing. In this app the sentence explaining **why a control was locked** existed solely as a `title`. On a desk it looked complete. In the car it was blank, and **two complete test drives were recorded and thrown away** before anyone could see which condition had not been met.

The audit is mechanical: grep for `title=` and, for each, ask *does a phone user need this to decide what to do next?* If yes, it must be rendered.

- **Render it into a reserved slot** — the layout is already stable there (`tsunagi-m-design` → Layout stability), so a line that appears and disappears cannot move anything.
- **Make it short enough not to truncate.** A reserved row is one line: `RF KORR: NEEDS PATCH ON`, not a paragraph. The paragraph stays in `title` for the mouse.
- **Show it only when it is actionable.** A lock reason before the user has done anything is noise; the same line after a run is the answer to the only question they have.
- The same applies to a disabled control's reason, an error's detail, and any "why is this greyed out" — see also the SAVE cell that dropped its own reason on the floor because the label was hard-coded.

## A native dialog cannot be told how tall to be

`alert` and `confirm` size themselves to their text. That is fine for a line, and on a short viewport it is a trap for anything longer: the box grows, the buttons go below the fold, and the dialog becomes a thing you scroll to answer — or, more often, answer without reading. On this app the two worst offenders were the instructions shown when a run ends and **the confirmation before writing to the ECU**, which is the last thing between a tap and a flash.

Give the long ones the app's own frame, and get the direction right: **state the frame's height, scroll the body inside it, and keep the buttons part of the frame.** Then the box cannot leave the screen however long the message becomes. `DialogFrame` here is `min(84dvh,560px)` with the body scrolling; on a 400px viewport that caps at 336px with the buttons always inside it.

```
683x400  recovery dialog   560x270   in viewport   both buttons on screen   body overflow 0
683x400  end-of-run        560x324   in viewport   button on screen         document no-scroll
```

- **Keep the short ones native.** "No stored binary" is one line and moving it buys nothing; a wrapper around every notice is its own kind of mess.
- **Make it a promise, not a callback**, if the call sites are mid-sequence. `await ask(...)` reads the way `confirm(...)` did and preserves an ordering someone chose deliberately.
- **A confirm must not be dismissable by missing it.** No X, no backdrop click — there is no honest default for "write this to the ECU". An alert can be, since its only exit is the button anyway.
- **Check what the old blocking behaviour was holding up.** `alert` froze the main thread, and code was written around that — here a disconnect deliberately preceded it so the read pump could not be frozen behind the dialog. An awaited dialog does not block, so the comment explaining the order became wrong. Fix the comment; keep the order if it is independently right.

## Readout alignment

For a block of label/value readouts, "centred" alone is not enough:

```
    SESSION            ← heading centred

  ⌸ SESSION #1         ┐ one stated column width,
  BASE ⌸ VIN …0001     │ centred as a group,
  VIN   MOCKVIN0001    │ rows sharing one left edge
  AIF   MOCK-0401      ┘
```

**Give every readout block the same *stated* width.** `w-fit` sizes each block to its own longest line, so two blocks come out 98px and 164px wide — each dead centre, and therefore each starting at a different x. Two centred groups that disagree still give the eye nothing to read down.

```
w-[min(15rem,100%)] mx-auto
```

Labels get a fixed-width column and are **left**-aligned, so the heads line up rather than the tails.

**Controls inside a readout block stay centred**, like the other controls. The one thing in the block you press should not read as another row of the column above it.

## Popovers anchored to a footer

A panel hung `top-10` off a trigger near the bottom edge opens off screen; hung `right-0` off a 40px trigger, a 320px panel starts at −48 on a 360px screen. **When a popover opens upward, pin it to the viewport rather than to a trigger eight times narrower than itself:**

```jsx
openUp ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),Npx)] overflow-y-auto'
       : 'absolute right-0 top-10 w-[320px] max-h-[min(70dvh,Npx)]'
```

`72px` is the bottom anchor plus a top gap matching `inset-x-3`.

**Size `N` from the panel's measured natural content height, per panel.** A shared literal is a guess — three panels here needed 494, 532 and 172 against a 420 that nobody had measured, and one had a *second* scroller nested inside it overflowing 58px even on a desktop.

Some viewports cannot be satisfied: a 393px-tall window cannot show a 494px panel, and no height value changes that. Say so plainly rather than shaving numbers — the fix there is a content change (two-column controls, or a full-height sheet below some height), not a cap.

**And inside a scroll container the failure is not bad placement, it is an invisible open state.** For any row near the scroller's edge the menu clips away to nothing while its full-viewport scrim, transparent, goes on eating every touch — so the screen looks untouched and dead, and the only symptom the user can report is "scrolling stopped working". A scroll container cannot clip what it does not contain, so pin it as above, then three rules proven in `SessionList.tsx` (commit 27f8b38, verified at 375×812):

- **Tint the scrim on the narrow layout** — `bg-slate-950/60`, `min-[1280px]:bg-transparent`. An open state nobody can see is indistinguishable from a frozen app. No `backdrop-blur`: `performance.md` §5 measured that at ~1s of phone paint for nothing behind it.
- **Close on pointerDOWN, not click**, so the very swipe that tries to scroll dismisses it first instead of being swallowed whole.
- **A viewport-pinned sheet needs a header naming what it acts on.** It no longer sits beside its row, so nothing else says which session the actions will hit — redundant on the desk, where the anchored menu stays exactly as it was.
