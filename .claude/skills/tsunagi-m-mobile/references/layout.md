# Shell, viewport units and panes

## Viewport units: `svh`, and only `svh`

```css
/* body */  min-height: 100svh;
/* main */  height: 100svh;  /* + overflow-hidden */
```

Three units, three behaviours, and only one of them is right for an app shell that never scrolls:

| unit | is | breaks because |
|---|---|---|
| `vh` | the **largest** viewport, chrome retracted | the body outgrows the page by exactly the height of the address bar, and the whole document scrolls |
| `dvh` | whatever it is **right now** | a layout built while the bar was hidden loses its own bottom when the bar returns — and with no scroll, permanently |
| `svh` | the **smallest** it ever gets | nothing. Some space goes unused when the bar retracts, which is the correct trade for a shell sized to fit |

If you find yourself reaching for `dvh` because "it tracks the real viewport" — that is the property that breaks it. Tracking means changing, and changing means the bottom of a non-scrolling layout can move off screen.

`vh` and `dvh` are still fine for things that are *capped* rather than *sized*: `max-h-[min(70dvh,420px)]` on a popover is measuring available room, not committing a layout to it.

## Pull-to-refresh

```css
html, body { overscroll-behavior: none; }
```

A page that never scrolls has nothing local to do with a downward swipe, so it hands the gesture to the browser. On Android that is reload. For a tool mid-session with a device, reload is not a refresh — it drops the connection, the recording in progress and anything unsaved.

**Turning this off removes the only reload the installed app had.** In standalone there is no browser chrome and therefore no reload button. Put one in the menu, and see the update-detection note below.

## One pane at a time

Below the split breakpoint, two panes is two unusable panes. On a 360×800 phone a 38.2/61.8 split left the grid 217px — six of twenty columns.

The pattern:

```jsx
<div className="grid flex-1 min-h-0 min-[900px]:flex min-[900px]:flex-row overflow-hidden">
  <div className={`[grid-area:1/1] flex min-[900px]:[grid-area:auto] ${active === 'a' ? '' :
      'invisible pointer-events-none min-[900px]:visible min-[900px]:pointer-events-auto'} …`}>
```

Both panes occupy the same cell; the inactive one is `invisible`. Above the breakpoint they go back to being flex siblings and nothing changes.

**`invisible`, not `hidden`, and this is the whole point.** `display:none` discards layout, so every switch makes the browser solve the incoming pane from scratch. Measured at 4× CPU throttle: 1098ms for a 480-cell grid, 1300ms for a 3D surface, against 110ms for a view carrying neither. With `invisible` both stay laid out and a switch is 245–287ms.

The same device already exists in this codebase as `PhaseStack`/`PhaseLayer` in `DialogFrame.tsx`, used so a dialog cannot change height between phases. Same reasoning, different axis.

**The trap it creates:** an invisible pane is still a live pane. Anything mounted in it keeps working where nobody can see it. See `performance.md` — this cost 3.8 seconds per tab change.

## Vertical budgets

Short landscape is where height runs out, and it runs out silently — a panel scrolls its own action row out of reach and nothing looks wrong in a screenshot.

Write the budget down when you touch it:

```
851×393 landscape:
  393 − 48 header = 345 pane
  345 − 44 pane header = 301 content
  visualizer floor 76 + panel 244 = 320   →  19px over, panel scrolls
```

When a floor and a control fight over the same pixels, the control wins. A 3D chart reads at any size; the toggle that arms a write does not. Make the *picture's* floor responsive rather than letting it push the controls out:

```jsx
min-h-[48px] [@media(min-height:560px)]:min-h-[140px]
```

## Reserved space

The house rule, already stated in several places in the app: **a thing that appears and disappears must not change the size of anything.**

- Give it a declared height it keeps when empty — the notice line is `h-[14px]` whether or not it says anything, the sub-action row is `h-[46px]` in every state including none.
- Or mount it always and toggle `invisible` — the dashboard wings do this, because mounting them on read changed the cluster's natural size and the auto-fit rescaled the dial under the user's finger mid-read.
- Or position it absolutely out of flow — the live telemetry readout floats over the visualizer so the panel below is identical whether logging or stopped.

A loading placeholder is subject to this too: fill the box, do not size to content.

## Breakpoint discipline

One breakpoint, used for one decision. This app has exactly `min-[900px]`, and it means *both panes fit side by side*. Everything else — what is in the footer, whether the menu exists, which chrome is visible — hangs off that same line.

When you need the same fact in JavaScript (to gate a mount, not just to hide a box), read it from the same query rather than duplicating the number:

```ts
useSyncExternalStore(subscribe, () => matchMedia('(min-width: 900px)').matches, () => true)
```

`useSyncExternalStore` rather than an effect, so the first client render already has the right answer instead of painting the wrong branch and correcting it.

## PWA install and update

- A **web app manifest is what the install path reads.** `icons.icon` alone feeds the browser tab; without a manifest Android picks its own default glyph no matter how good your SVG is. It wants a 192 and a 512 PNG.
- **`maskable` is a separate file, not a second purpose on the same one.** Android crops maskable icons to the launcher's shape and guarantees only the central 80%. Give that variant the mark at ~60% of the canvas (its diagonal then clears the circle) against ~72% for the plain one. Declaring one file as both gets the full-size version cropped.
- **Check `src/app/favicon.ico`.** Next's starter default ships there and is emitted *ahead* of `/icon.svg` with explicit `sizes` and `type`, so browsers prefer it. It is easy to ship someone else's logo for a year without noticing.
- **`statusBarStyle: 'black'`, not `'black-translucent'`**, and leave `viewportFit` alone, unless every top-edge container pads by `env(safe-area-inset-*)`. Turning either on by itself moves content *under* the notch rather than away from it.
- **Update detection without a service worker:** fetch the entry document with `cache: 'no-store'` and compare its `<script src>` list against the one this page loaded. Framework builds emit hashed chunk names, so different names mean a different build. Check on mount, on an interval, and on `visibilitychange` — returning to the app is when a stale build matters and when the check is cheapest. Fail silent and read as "no update": this runs in a garage with no signal, and a false alarm about updates while someone is reading an ECU is worse than saying nothing.
