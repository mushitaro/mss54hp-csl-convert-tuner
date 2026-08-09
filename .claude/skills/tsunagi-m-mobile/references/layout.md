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

**The second trap: below the breakpoint, navigating is two moves, not one.** Selecting a destination has to set the destination *and* bring its pane forward, because above 900px the second half is a no-op and below it, it is the entire visible effect. The hand-written path usually gets this right — it is the one someone clicked through. The programmatic ones are where it goes missing: here, START TUNE armed the lambda destination and the first sample released it, correctly, while the screen stayed on the dashboard and drew the trim the run existed to measure behind it. The move looked implemented, and was, on one axis. Any code that changes the destination without a user gesture needs both halves.

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

**And when that is still not enough, split the pane rather than shave the number.** Shrinking a floor buys tens of pixels; the budget above is short by hundreds. If one pane is carrying two unrelated things — a picture and a control surface — make them two destinations and leave the wide layout stacked as it was. Measured here: the 3D view went from a 48px strip to 292px of its own at 851×393, and the control panel stopped needing the shaved floor at all. One more entry in the switch is cheaper than either half staying unusable.

**Then gate it on the condition that actually failed.** The breakpoint you already have is a convenient place to hang it and is usually the wrong one. This split was reached for from a height budget and hung off the width breakpoint, so it also applied to portrait — where nothing was fighting: 360×800 stacked gives the surface 431px *and* the panel its full 268, no scrolling. Splitting that took away a working simultaneous view and charged a tap for it.

```
                 stacked                    split
360×800    3D 431 + panel 268 together   GRAPH 699 / DASH 268    ← lost something
851×393    3D  48 + panel 244  broken    GRAPH 292 / DASH 248    ← the case it was for
```

So the query is `(max-width: 899px) and (max-height: 560px)` — one media query, not the width variant plus a height override, because two variant utilities of equal specificity are settled by whatever order Tailwind emits them in and this one decides whether a control is reachable. Write it out literally at each use; an interpolated class name is generated by nobody.

### A `max-height` says nothing about how the bands inside it divide it

A fixed-height box with bands stacked in it needs a second decision that is easy to forget: **which band yields.** State only the outer cap and the answer is whatever the bands' own `flex` values happen to imply, which is usually "the one whose content is data-dependent wins, and the last one falls off the bottom".

The menu sheet was three bands under one `max-h`, two of them `shrink-0`. Connected, the readouts grew — a VIN, an AIF, a software version, a session label — and took 314px of a 360px sheet:

```
683x400 connected   readouts 314   list   0   destinations 0/8   ✕ 8px BELOW the screen
683x400 fixed       readouts 109   list 218   destinations 5/8   ✕ inside
```

**The way out of a container must not be a function of how long a VIN is.** So: `shrink-0` belongs only on the band that must never move — here the close row — and every other band gets `min-h-0`. That releases the shrink they already had, and the squeeze is shared in proportion to what each band asked for.

And when a cap turns out not to matter, take it out. `max-h-[45%]` and `max-h-[42svh]` on that band produced **byte-identical measurements**, because the flex pass had already brought it below either one. A rule that never fires reads like a rule that is holding something up.

### `flex-initial` is for a pane that shares

`flex-initial` means *take what my content needs and never grow*, which is exactly right when a control panel sits above a picture that stretches to fill whatever it is given — without it the panel donates its slack to the visualiser.

When the picture is not there, that same value throws the slack away. On the split layout the leftover height fell off the bottom of the pane and held the centred control cluster above centre by an amount that **grew with the viewport**:

```
683x400  -18px      720x450  -43px      flex-initial, nothing to share with
683x400   +8px      720x450   +8px      flex-1 under the split query — and height-independent
```

The residual +8 is the real asymmetry between what sits above and below it; the fix is that the number stopped being a function of the screen. Gate the growth on the same query that decided the pane was alone (`(max-width:899px) and (max-height:560px)`), not on the width breakpoint.

A destination with nothing in it is worse than one that is greyed out — disable it when its content does not exist, and bounce off it if the content goes away while you are standing there. **Rotating counts as going away**: the destination itself can stop existing under someone's feet, and the state pointing at it has to land somewhere real.

And re-check the mount gate every time the arrangement changes. "The graph is on screen" was one condition, then two, and is now three — selected on a split layout, above the controls on a wide one, stacked in the other pane on a narrow tall one. Miss a branch and you get either a blank box or the invisible-pane bug back.

## Reserved space

The house rule, already stated in several places in the app: **a thing that appears and disappears must not change the size of anything.**

- Give it a declared height it keeps when empty — the notice line is `h-[14px]` whether or not it says anything, the sub-action row is `h-[46px]` in every state including none.
- Or mount it always and toggle `invisible` — the dashboard wings do this, because mounting them on read changed the cluster's natural size and the auto-fit rescaled the dial under the user's finger mid-read.
- Or position it absolutely out of flow — the live telemetry readout floats over the visualizer so the panel below is identical whether logging or stopped.

A loading placeholder is subject to this too: fill the box, do not size to content.

## Breakpoint discipline

One breakpoint, used for one decision. This app's is `min-[900px]`, and it means *both panes fit side by side*. Everything else — what is in the footer, whether the menu exists, which chrome is visible — hangs off that same line.

The rule is one query per decision, not one query in total. A second decision gets a second query rather than a reinterpretation of the first: *is there height to stack* is a different question from *do both panes fit*, and answering it with the width breakpoint is what produced the portrait regression above. What the rule forbids is a third number that means the same thing as one you already have — 560 here is the visualiser floor's own threshold, reused, not invented.

When you need the same fact in JavaScript (to gate a mount, not just to hide a box), read it from the same query rather than duplicating the number:

```ts
useSyncExternalStore(subscribe, () => matchMedia('(min-width: 900px)').matches, () => true)
```

`useSyncExternalStore` rather than an effect, so the first client render already has the right answer instead of painting the wrong branch and correcting it.

The same shape covers anything else the app reads from outside React — a `localStorage` preference such as a remembered grid size reads exactly like the media query above, with a server snapshot of the default. It is also the form the lint rules want: `react-hooks/set-state-in-effect` rejects the read-on-mount-and-`setState` version, and it is right to, because storage is a store and subscribing to it is the honest description. Same-tab writes need their own notification — `storage` only fires in *other* tabs — so keep a listener set beside the reader and call it after writing. Return a primitive from the snapshot, or the store re-renders forever.

## PWA install and update

- A **web app manifest is what the install path reads.** `icons.icon` alone feeds the browser tab; without a manifest Android picks its own default glyph no matter how good your SVG is. It wants a 192 and a 512 PNG.
- **`maskable` is a separate file, not a second purpose on the same one.** Android crops maskable icons to the launcher's shape and guarantees only the central 80%. Give that variant the mark at ~60% of the canvas (its diagonal then clears the circle) against ~72% for the plain one. Declaring one file as both gets the full-size version cropped.
- **Check `src/app/favicon.ico`.** Next's starter default ships there and is emitted *ahead* of `/icon.svg` with explicit `sizes` and `type`, so browsers prefer it. It is easy to ship someone else's logo for a year without noticing.
- **`statusBarStyle: 'black'`, not `'black-translucent'`**, and leave `viewportFit` alone, unless every top-edge container pads by `env(safe-area-inset-*)`. Turning either on by itself moves content *under* the notch rather than away from it.
- **Update detection:** fetch the entry document with `cache: 'no-store'` and compare its `<script src>` list against the one this page loaded. Framework builds emit hashed chunk names, so different names mean a different build. No version file to keep in step, and it works with or without a worker. Check on mount, on an interval, and on `visibilitychange` — returning to the app is when a stale build matters and when the check is cheapest. Fail silent and read as "no update": this runs in a garage with no signal, and a false alarm about updates while someone is reading an ECU is worse than saying nothing.

## Offering an update through an offline cache

An offline-first worker and an in-app reload button are each correct on their own and quietly cancel each other out. Cache-first serves the navigation from disk, and an install-time policy of *no* `skipWaiting()` — right, because swapping the JS under someone mid-write is the failure it prevents — leaves the new worker parked in `waiting`. So the row says "Update available — reload", `location.reload()` repaints the same build, and the row still says it. **Measured exactly that: control reload → old build, every time.**

Detection is not what breaks. A precache keyed `/index.html` does not answer a fetch for `/`, so the check still reaches the network. It is the *taking* that breaks, and the button must do more than reload:

```js
await reg.update();                              // the browser may not have looked yet
const waiting = reg.waiting ?? awaitInstalled(reg.installing);
waiting.postMessage({ type: 'SKIP_WAITING' });   // sw: self.skipWaiting() on this message only
await once(navigator.serviceWorker, 'controllerchange');
location.reload();
```

What the no-`skipWaiting` policy objects to is the swap being **automatic**. A button the user pressed is the consent it was missing, so ask for it there and nowhere else — the worker still waits for everybody who did not ask.

**Every step falls through to a plain reload, on one shared deadline.** No network, no worker, an update that turned out not to exist, a `controllerchange` that never arrives — the user asked for a reload and must get one. Verified: no update 1.6s, offline 2.6s, cold start with the network cut still renders.

**Resolve navigations to the shell, not to the request.** `caches.match(request)` looks obviously right and breaks the first time anything launches the app with a query string — `?resume=1` from a launcher, a tracking parameter, a deep link — because that exact URL was never cached, so the navigation goes to the network and offline it simply fails. Match the fixed entry document instead:

```js
if (request.mode === 'navigate') {
  const cached = await caches.match('/index.html');   // NOT caches.match(request)
  return cached ?? fetch(request);
}
```

That is also what lets the query survive: it reaches the app on `location.search` without ever having to exist in the cache. Pair it with the rule above — do **not** add `/` to the precache, because update detection depends on that path missing and reaching the network.

**Test it against a server that behaves like your host.** `serve` has cleanUrls on, so `/index.html` 301s to `/index`; `cache.add()` follows that and stores a response with `redirected: true`, and a redirected response may not satisfy a navigation. Every reload under the worker then fails with `net::ERR_FAILED` — in the harness only, and it looks exactly like a bug in the worker. Thirty lines of `node:http` that serve the file at its own path with a 200 is the fix. The test that is worth having is the whole loop: serve build A, let the worker claim the page, swap the directory to build B, press the row, and assert on which chunk hash the page ends up running.
