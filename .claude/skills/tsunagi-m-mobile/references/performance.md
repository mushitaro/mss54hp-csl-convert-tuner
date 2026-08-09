# Why it feels broken, and what it actually was

Every number here is from a Chromium profile at 4× CPU throttle on a 360×800 phone profile. They are recorded because the *ranking* is the useful part — the thing that felt slow was never the thing being blamed.

## Attribute before you optimise

"The menu is slow" was, in order: not the menu, not React, not style, not layout, not paint. It was a chart in a pane the user could not see.

```
React reconciliation + commit      31–59 ms
Style recalc (11 passes)          ~130 ms
Layout (7 passes)                  ~50 ms
Plotly                            >96% of a 3.8–4.3 s interaction
```

Two tools settle this in minutes, and guessing does not:

- **`PerformanceObserver` on `longtask`**, registered via `addInitScript` + an exposed binding. Tells you *how many* blocking tasks and how long.
- **CDP Profiler**, 200µs sampling, read by self time. Tells you *whose* they are, by function.

`Performance.getMetrics` deltas across the interaction (`ScriptDuration`, `RecalcStyleDuration`, `LayoutDuration`) separate "JS" from "the browser" in one number each.

Then **A/B it in the live page** before changing source: stub the suspect (`window.Plotly.react = () => {}`), re-measure, and you have the saving before you have written anything.

## The four that actually mattered

### 1. Work happening in an invisible pane

The one-pane-at-a-time pattern keeps both panes laid out (`invisible`, not `display:none`) so switching is cheap. The cost is that **the hidden pane is still live** — its components are mounted and re-rendering.

Selecting a view also switched to the map pane, so every tab pick rebuilt the dash pane's 3D surface behind `visibility: hidden`. Gating the mount on the pane being on screen: **3770/4257/3887 ms → 258–395 ms.**

```jsx
const dashOnScreen = wideLayout || narrowPane === 'dash';
{dashOnScreen && activeTab === 'x' && <Visualizer … />}
```

Whenever you adopt the invisible-pane pattern, audit what is mounted inside it. Charts, canvases, observers, anything with a `useEffect` that polls.

### 2. A mesh far larger than the data

Plotly sizes a surface mesh from the *spacing* of its coordinates: `estimateScale` takes `1 + arrayLCM(spacings)`, clamped at `MAX_RESOLUTION = 720`. Feed it irregular axes — RPM at 600, 870, 1100, 1300, 1400 … 7900 — and it returns a scale of 36×21 and bilinearly upsamples a 24×20 map into **723×507 = 366,561 vertices for 480 numbers**.

Build the surface on **cell indices** and put the real values back as tick labels:

```js
x: mapData.xAxis.map((_, i) => i),
// scene.xaxis: { tickmode: 'array', tickvals: indexX, ticktext: mapData.xAxis.map(String) }
```

Scale 8×8, mesh 193×161, one update **1338–1496 ms → 169–371 ms**.

This changes the picture: axes become evenly spaced rather than value-proportional. For a map read cell by cell that is arguably better — it matches the 2D grid beside it, whose columns are a flat width regardless of value, and the proportional version squeezed the whole low end into a sliver. **Flag it as a visual change when you make it.** Do not slip it in.

### 3. Fresh objects defeating memoisation

`react-plotly` calls `Plotly.react()` on every render, and `data`/`layout` rebuilt inline are new objects every pass — so opening a menu diffed a 3D surface. Memoise the payload *and* the component.

The subtle half: **props built inline at the call site defeat the memo you just added.** `mapData={{ ...base, data: derived }}` is a new object every render, so `React.memo` compares a new reference and re-renders anyway. Lift those to `useMemo` where they are derived.

### 4. Automatic table layout

A grid with no `table-fixed` makes the browser measure every cell before it can settle a column. With 480 cells that was a **6.9s task** the first time the pane appeared and ~1.3s after.

```jsx
<table className="table-fixed" style={{ width: `${cols * 50 + 64}px` }}>
```

State the width. `table-fixed` with `w-full` divides the container between the columns and collapses the horizontal scroll the grid depends on.

**And when that grid needs to zoom, multiply the numbers — do not `transform: scale()` it.** Scaling is the obvious way and it breaks the thing that makes a 20×24 grid readable at all: a transform on an ancestor becomes the containing block for `position: sticky`, so the row and column headers stop sticking to the scroll port and start sticking to the table. Multiplying the cell width, the head width, the font size and its line-height keeps the headers pinned *and* keeps `table-fixed` on the fast path — the 6.9s stays gone. Verified at each step after scrolling 200px across and 120px down:

```
683x400  zoom 0.6  cell 30px  font  7.2px  20/20 columns  sticky ok
         zoom 1.0  cell 50px  font 12.0px  12    columns  sticky ok
         zoom 1.6  cell 80px  font 19.2px   7    columns  sticky ok
```

Scale the line-height with the font or tall glyphs clip: `text-xs` is 12/16, and overriding only `font-size` leaves the 16 behind.

## What to do with what is left

Some work cannot be made cheap. Mounting a chart still blocks for around a second. **That is fine as long as it does not look like a crash** — and a black rectangle that does not respond looks exactly like one.

Two parts, and the second is the one people skip:

```jsx
// 1. something to show
{ready ? <Plot … /> : <ChartLoading />}

// 2. an actual frame to show it in
const [readyFor, setReadyFor] = useState(-1);
const ready = readyFor === nonce;
useEffect(() => {
  let inner = 0;
  const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setReadyFor(nonce)); });
  return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
}, [nonce]);
```

Mount the placeholder and the blocking child in the same commit and the browser never gets a frame in which to paint the placeholder — the screen just stops. **Two rAFs guarantee one painted frame** before the thread goes away. Measured: placeholder paints, then the main thread blocks 518ms.

Use a CSS `transform` animation for the spinner. `animate-spin` is compositor-driven, so it **keeps turning while the main thread is blocked** — which is the difference between "working" and "hung".

Also: `dynamic()` imports default to no `loading:`. The first switch to a chart tab renders an empty box for as long as the chunk takes, with nothing to say so. Give every heavy dynamic import a loading component.

## A checklist for "it feels slow"

1. Reproduce at 4× throttle at 851×393 and 360×800. If you cannot reproduce it, instrument rather than guess — the first measurement of this app's "slow menu" was 9.3s on the first open and 200ms after, which is a completely different bug from the one being reported.
2. Count longtasks. One 2.5s task is a different problem from twenty 50ms ones.
3. Attribute by self time. Name the function before you touch anything.
4. Check what is mounted but invisible.
5. A/B the suspect in the live page. Get the saving before writing the fix.
6. Re-measure, and record the before/after in the commit.
7. Re-check the wide layout has not moved.
