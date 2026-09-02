# MSS54HP CSL CONVERT /// TUNER

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

This tool is built on work that others published first. Each entry below names that work, and what
in this application rests on it.

**[Pavlo](https://nam3forum.com/forums/member/1552-pavlo)** — who published the method in the first
place, in [the thread this application automates](https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability).
Everything below is what made automating it possible; this is the thing being automated. Without the
starting point there would have been nothing to build.

**[karter16](https://nam3forum.com/forums/member/9797-karter16)** — the source this tool owes the
most to. Three distinct bodies of work, all of them published freely:

- **[MSS54 DS2 Tool](https://github.com/karter16/MSS54-DS2-Tool-Public)** — the reference
  implementation of the DS2 protocol against this DME. The following files in this repository are
  ports of it, and say so at the top of each file: `src/lib/dme-link/ds2.ts` (frame format, control
  bytes, programming segments, baud-switch payloads, adaptation masks),
  `src/lib/dme-link/flashCounter.ts` (the boot-field layout, the `K16.` prep marker, the 30-per-
  processor limit), `src/lib/dme-link/webSerialDmeLink.ts` (the erase → write → verify sequence, the
  seed/key login, the service-block restore), `src/lib/dme-link/serviceBlockReport.ts`, and
  `src/lib/dme-link/liveValueBlocks.ts`. Where this app diverges, the reason is written in a comment
  next to the divergence rather than left silent.
- **`CSL_0401_Karter16_v3_6_publish.xdf`** — the TunerPro definition. Every calibration address and
  scaling in `src/lib/ecu-items/` and `src/config/constants.ts` traces back to it.
- **The 0401 disassembly** ([notes thread](https://nam3forum.com/forums/forum/special-interests/coding-tuning/287069-csl-0401-program-binary-disassembly-notes),
  [repo](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes)) — the Ghidra output and the
  named RAM symbols behind everything in `docs/ecu-logic/` — the exhaust-temperature correction
  path, the filling regulator, the idle controller and the FRA adaptation defect — as is the rule
  that λ = 1 must not be chased in the region that correction covers.

**[Bry5on](https://nam3forum.com/forums/member/5503-bry5on)** — validation on their own car, and the
publication of what it taught, warning included: flattening `KF_RF_KORR_DRREL` and driving it, the
control group for the FRA adaptation defect, the CAN logging work and the knock-frame decoding. It
is evidence a disassembly cannot give, and the safe-side defaults in this application rest on
reports of that kind.

**[terra](https://nam3forum.com/forums/member/1465-terra)** — the original CSL-conversion partial,
and the early fixes the community built upon it. The BASE this application reads and writes descends
from them.

**The NA M3 Forums CSL-conversion thread** —
[thread 242281](https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability),
where the methodology grew. Years of reports and corrections are stacked on top of Pavlo's first
post, and much of what this application defaults to rests on them.

**BMW / Bosch Funktionsrahmen** — the 39 function-specification documents that make the disassembly
readable. Quoted by section number in `docs/ecu-logic/90-sources.md`.

A per-claim map of which statement rests on which source is kept in
[`docs/ecu-logic/90-sources.md`](docs/ecu-logic/90-sources.md), which distinguishes what was
*reported by the community* from what was *derived here and remains unverified*.

## Overview

This application integrates the various tuning processes for the E46 M3 CSL Conversion currently shared in the community into a single, streamlined workflow.

The method is based on the [methodology shared on NA M3 Forums](https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability).

First of all, I would like to express my gratitude to everyone who contributes daily to the research and publication of the CSL CONVERT tuning methodology.

### Integrated Processes

The tool automates and combines the following steps:

1. **Disabling MAP & LTFT compensation** (replacing TunerPro steps)
2. **RO (Relative Opening) Correction** (replacing AQ_REL to AQ_REL_ALPHA_N Logfile Converter)
3. **Lambda Value Aggregation** (replacing MegaLogViewer)
4. **Tuning VE Calculation** (replacing "VE Tuning With Lambda Integrators" spreadsheet)
5. **VE Comparison vs. Stock CSL**
6. **VE Table Editing** (replacing TunerPro steps)
7. **Re-enabling MAP & LTFT compensation** (replacing TunerPro steps)
8. **Checksum correction** (replacing external checksum tools)
9. **Direct DME communication** — read, live logging, and flashing over a K+DCAN cable (replacing separate reader/flasher tools)
10. **DME adaptation reset** — clears the learned lambda and knock trims before a re-tune, so the next log is captured from a known baseline instead of one still shaped by the previous map. VANOS adaptation is read and shown but deliberately **not** cleared: clearing it makes the DME re-learn cam phase, and cam phase moves filling — the quantity the log exists to measure
11. **SHAPE** — the tuned table seen as a surface rather than as cells, and a repair for the cells
    the drive never visited. A road log cannot fill 480 cells evenly, so the gaps are interpolated
    from their measured neighbours and written as a *mode* on the ALPHA-N write rather than as a
    table of its own — it cannot reach the flash unless the measured write it modifies is armed
    first. It stays locked until the map has converged, because projecting a surface onto a map
    that is still moving makes the drive's noise look smooth, monotone and deliberate, which is a
    worse artefact than the bumps it removes
12. **Flash counter** — reads how many programming cycles the DME has left and can reset the counter, so a tool built around repeated flashes stops running into an invisible ceiling; includes a read-only inspection of the DME's identity records (VIN / AIF)

(The tool is completely free.)

## Two ways to use it

### A. File workflow — no cable required

Upload your **Partial BIN** and **TESTO LOG CSV**, then download the tuned BIN.
Checksums are corrected automatically. Works in any Chromium browser.

### B. Direct DME workflow — K+DCAN cable

Talks to the DME directly, so no separate reader/logger/flasher is needed:

```
CONNECTION → READ → [RESET ADAPT] → START TUNE → STOP → WRITE ─→ (ignition off 10s) → done
                                                            ├→ Download Tuned (verify in TunerPro first)
                                                            └→ Re-tune        (discard)
```

- **CONNECTION** — connects and shows VIN / AIF / software number / **flash counter**
- **READ** — reads the partial BIN straight out of the DME
- **RESET ADAPT** — available any time START TUNE is. Shows the DME's current learned adaptation
  values, then lets you clear them so the next log is captured from a known baseline rather than one
  still carrying over trims the previous map produced. This is the natural step right after a
  post-write reconnect, before starting the next tune. See
  [Technical Specifications](#technical-specifications--limitations) for exactly what is and isn't
  cleared.
- **START TUNE** — live-logs from the DME and updates the VE calculation in real time. There is no
  poll interval: requests are sent back-to-back, so the sample rate *is* the round-trip time. It is
  measured rather than assumed and shown live as **HZ** next to the sample count, and the run's mean
  rate is stored with the session and listed beside its point count.
- **STOP** — ends logging; you can then use **Download Tuned** to inspect the result before committing
- **WRITE** — flashes the tuned BIN (checksum corrected, then verified — QUICK or FULL, see Safety)

### What the next write contains

`WRITE` is not one thing any more. `PATCH` and `WRITE` flank the hub and `RESTORE` sits in the
corner beneath them; each opens a menu of rows, and underneath each word is a summary of whatever
that group currently contributes — so **"what will the next write contain" is answerable without
opening anything**.

- **WRITE** — the derived tables: `ALPHA-N` (the measured map, with `SHAPE` as a mode on it) and
  `WARMUP`. Each row states what it would write and, where it cannot, why.
- **PATCH** — the logic switches the ECU is left holding: MAP compensation, the LTFT window, the
  tank vent, the WOT threshold. These change what the DME *does*, not what a table says.
- **RESTORE** — putting a table back to the bytes the binary was loaded with. One row per table,
  each named in the ECU's own vocabulary, and locked against the write of the same table: whichever
  ran last would win, and a restore a tune can overwrite is not a restore.

A row that cannot act is disabled with its reason on it rather than hidden, and the central ring
will not offer WRITE at all when nothing is armed — an empty write is not an action, and offering
one is how a flash comes back byte-identical.

### If a log is interrupted

A run used to live only in memory until you pressed SAVE, so anything that reloaded the page took
the whole drive with it. Samples are now written to the browser every **5 seconds** while logging,
which is the most a crash can cost.

If the page goes away mid-run — a reload, a browser crash, the machine sleeping — the next time you
open the app it offers the run back, together with the BASE it was captured against (the samples
alone cannot rebuild a tune). The offer is kept until the session is saved or you decline it, so a
run that has *stopped* but not been saved is protected too — that window, while you are reading the
result and deciding, is exactly where a run is easiest to lose. Declining discards it.

Confirmed on a real vehicle: a deliberate reload mid-log, then recovered.

On a head unit, where the console cold-boots every time the key cycles, the run can come back without
being asked for at all — see [Coming back after the ignition goes off](#coming-back-after-the-ignition-goes-off).

### FLASH — how many writes the DME has left

The DME will only accept a limited number of programming cycles: **30 slots per processor**, tracked
in its own boot field. Every WRITE consumes one. Run out and it simply stops accepting programming,
which on a tool built around repeated flashes is a real ceiling — so the count is read at connect and
shown in the header next to VIN / AIF / SW:

```
FLASH 12/30
```

Normally one number, because a flash consumes a slot on both processors together. Both are still read
and compared, and if they ever disagree the field shows `master · slave` instead. It turns amber below
5 free slots. Hover for the per-processor detail.

**Clicking FLASH opens the counter detail**, which offers a read-only inspection of the service blocks
and the reset itself. The reset puts the counter back to `1/30` — the correct result, not an
off-by-one: the first slot stays marked as consumed by design. Read the safety section before using
it; this is the most destructive thing the app can do.

### Getting files back out

Two different things, so they are two different controls:

- **Download Tuned** (on the session bar, above the map) — builds the TUNED bytes **WRITE would send
  right now**, from the current map and the current toggle settings. This is the one to inspect in
  TunerPro before flashing, and the only way to export a tune you have not saved yet.
- **The download icons in the STARTUP session list** — each downloads what that session has
  **stored**: its **BASE** bytes, its **LOG** (as a Testo-format CSV that re-imports cleanly), and its
  **TUNED** bytes. Each sits on the column that names it, so there is no question which file you get.

Tuning sessions (BASE + tuned BIN + the paired log) are stored in the browser and can be reloaded or
compared from the **STARTUP** tab.

### Knowing where you still need to drive

Cells the log actually visited are tinted on the map, in three bands: **some data**, **enough to act
on** (10 samples), and **well covered** (30). The bands are absolute sample counts, not a fraction of
the busiest cell, because the question they answer — *have I gathered enough here yet* — has a fixed
answer per cell. Scaling them to the busiest cell made the whole map fade as one cell filled up, so
the map got darker the longer you drove, which is backwards for spotting the gaps you still have to
cover.

The tint is a threshold for *reading*, not for calculating: a cell with a single sample still produces
a correction. The bands tell you how thin the evidence under that correction is.

### The 3D view

The surface is drawn on the axes' **real values** — 600 RPM sits at 600 and 7900 at 7900, and the
same for load — so distance across the picture is engine speed and load, and the shape of the map is
where its values actually sit relative to one another. The low-load rows are packed close together
because they *are* close together; that crowding is information, not a rendering fault.

It is drawn from an evenly spaced resampling of the map rather than from the 24 × 20 cells directly.
That is a rendering detail with no effect on what is shown — the plotting library interpolates
between cells either way — but choosing the resolution ourselves is what keeps it from building a
366,561-vertex mesh for 480 numbers, which on a head unit froze the screen for over a minute.

### Reading a log

The chart and the row table always show the same slice of the log — one window, both views, one set
of row numbers — so clicking a point on the chart jumps to that row, whatever part of a long log you
are looking at. Logs longer than 2,000 points are shown a window at a time; the slider under the
chart moves it, and the readout beside it says which rows are on screen.

On a trackpad:

| Gesture | Effect |
|---|---|
| two fingers up/down, or pinch | zoom the chart |
| two fingers left/right | move through the log — the window on a long log, the zoomed view on a short one |
| click a point | mark it and jump the row table to it |
| **FIT** | undo the zoom and refit |

Zooming is chart-local, because it changes how magnified the data is rather than which data is
shown; the table has nothing to follow. Scrolling is not, which is why it moves the shared window
instead of just this chart's axis.

## On a phone or a head unit

The whole workflow — read, live tune, write — runs on a phone, and on an Android head unit in the
car. Below 900px the layout is not a shrunken desktop; it is arranged for one hand and short glances.

**One view at a time, chosen from the footer.** `MAP` is the tables, `DASH` is the connection and the
controls, and `GRAPH` appears as its own destination only when the screen is too short to stack the
3D view above the panel — on a tall phone in portrait the two stay together, because there is room
and splitting them would charge a tap for nothing.

**Everything else is behind the ///M button.** Session and vehicle readouts, downloads, the view list
and reload live in a sheet that opens upward from the footer. It is built to be *swept* rather than
aimed: press the button, slide to the entry you want, release. The lists run bottom-up so the first
entry sits nearest your thumb, and Close lands on the exact coordinates the press started on, so a
second tap closes what the first opened without moving your hand.

The controls that decide what gets written to the DME are never in that sheet. They stay on `DASH`,
visible, one tap apart.

**`−` / `＋` resize the map grid**, and they sit **on the grid** — on the statistics band above it
where there is room, and as a pill floating over the bottom-right of the grid where there is not.
They were in the header's far corner, which is the hardest place on a phone to reach and the worst
one for the single control here meant to be used while the car is moving. The setting is remembered
between launches. At the smallest step all 20 RPM columns fit on a head unit screen; at the largest
the numbers are readable at arm's length.

**Install it to the home screen** and it runs without browser chrome, starts with **no network at
all**, and keeps working in a garage with no signal. Because there is no address bar there is also no
pull-to-refresh — deliberately, since a stray downward swipe mid-log would otherwise cost the run —
so the menu carries its own reload. When a newer build exists it turns blue and pulses — in the
sheet's icon strip and, on the desk, in the header, where the glyph is replaced by the word
**UPDATE**. Pressing it actually takes the new build rather than repainting the cached one: the
download starts by itself the moment the update appears, and only the switch-over waits for you,
because swapping the page out mid-drive would take the running log and the DME link with it.

### Coming back after the ignition goes off

On a head unit the console usually cold-boots when the key cycles, which takes the browser with it.
Nothing is lost — sessions and interrupted runs live in the browser's own storage — but you would
normally land back on a first-run screen and have to find your way to where you were.

If the app is launched with **`?resume=1`**, it reopens the interrupted run directly and asks nothing.
That flag is set by the launcher on an Android head unit, which is the only thing that can know the
tuner was in front when the power went; the app supplies the other half, which is knowing *which*
session that means. Launched without the flag, nothing changes — you get the usual offer to restore.
If there is nothing to resume, it simply starts normally, which is the expected case rather than an
error.

## Usage

The app is hosted on GitHub Pages, so it can be used immediately without installation:
**[https://mss54hp-csl-convert-tuner.tsunagi.app/](https://mss54hp-csl-convert-tuner.tsunagi.app/)**

The source code is public, so please feel free to review or modify it:
[https://github.com/mushitaro/mss54hp-csl-convert-tuner/](https://github.com/mushitaro/mss54hp-csl-convert-tuner/)

Dialogs and prompts follow your **browser's language**: Japanese if it is set to Japanese, English
otherwise. Control names (WRITE, PATCH, TUNED, Max RO Delta …) stay in one form in both — they are
the same words the stored settings and the log columns use.

Implementation details (DS2 protocol, checksum algorithm, addresses, verification status) are
documented in [docs/implementation-notes.md](docs/implementation-notes.md).

The app processes everything in your own browser — BINs, logs and sessions are stored locally and are
not uploaded anywhere. The privacy policy is linked from the header, from the menu sheet, and from the
disclaimer shown on first use, and it is published in
[English](https://m3.tsunagi.app/en/privacy-policy#tuner) and
[Japanese](https://m3.tsunagi.app/privacy-policy#tuner) — the links follow your browser's language,
the same way the dialogs do. Section 9 covers this tool specifically: what it stores on your device,
what it reads from the DME (including the VIN), and the single request it makes to the network.

## ⚠️ Safety — please read before flashing

This tool can **erase and write your DME**. Flashing an ECU always carries risk.

- **The engine must be stopped.** Ignition ON, engine OFF. (The DME itself also refuses to program
  unless RPM and vehicle speed are zero.)
- **Keep power stable** during the write. A battery charger/maintainer is recommended.
- **Never disconnect the cable or cut power while writing.** The write cannot be cancelled once the
  erase has started — interrupting it can leave the DME in an unusable state.
- **Do not close or reload the tab while writing, resetting, or logging.** The app asks the browser
  to confirm before you leave during those operations. Read that as a speed bump, not a lock: it is
  the only mechanism a web page has, you can always confirm and leave anyway, the wording is the
  browser's and cannot be changed, and it does not appear at all for a killed process, an OS
  shutdown or a power cut. It also releases itself if an operation ever hangs, so a stuck state
  cannot trap the tab.
- A write takes **about 2½ minutes** at 9600 baud with the default QUICK verification, or **about
  4½ minutes** with FULL, which adds a byte-for-byte read-back of all 65536 bytes (measured at
  122.9 s). With **BOOST** armed on the Android path the write telegrams fall from ~68 s to roughly
  17 s, and the verification stays at the boosted rate too. The progress display shows the current
  stage (Erasing / Writing / Verifying). **This is normal — do not interrupt it.**
- **VERIFY: QUICK or FULL.** Every chunk's programming verify byte is checked either way; the mode
  chooses what happens after the last chunk.
  - **QUICK** asks the DME for its own encoding checksum (DS2 `0x0A`) — one exchange, ~50 ms. Its
    authority is the CRC-16/ARC values the ECU stores in its own flash, which cover 65528 of the
    pair's 65536 bytes. It cannot tell you *where* a mismatch is.
  - **FULL** does that *and* reads all 65536 bytes back and compares them. It is the only check that
    can name an offset.
  - The selector **opens on FULL for any DME it has not seen the two agree on**, so the first write
    to a given car takes the stronger proof. After that it opens on QUICK.
  - Which mode ran is recorded in the session's flash history and stated in the completion message —
    it never just says "verified".
- After a successful write, **turn the ignition OFF, wait 10 seconds, then back ON** so the DME
  reinitialises with the new data. The app prompts you for this.
- Use **Download Tuned** before writing if you want to inspect the exact bytes in TunerPro first — the
  downloaded file is byte-for-byte identical to what gets flashed.

### Resetting the flash counter — additional risk

The counter lives in flash and flash cannot be rewritten without an erase, so the reset erases and
rewrites the whole block it sits in — the same block that holds the VIN and the programming history.
On success those records are byte-for-byte unchanged. If power is lost part-way, they are gone.

- Takes about **1.5–2 minutes**. The same power rules as a WRITE apply, and they matter more here.
- A **BOOST** tick on the reset's own confirmation writes the 16 KB at 125000 instead of 9600, about
  four times faster. It is a **separate** switch from the write path's, on purpose: if this one fails
  the block that is erased is the service block, and its 16 KB were saved seconds earlier, so the
  recovery is the restore below. The data write has no such copy, and a tick made on the recoverable
  path must not still be armed on the other one.
- The block is **saved inside the browser before anything is erased**, and the reset refuses to start
  if that save fails. No file is produced — writing to the DME and exporting a file stay separate
  actions in this app.
- The reset also refuses if the AIF records are not present in what it just read, since a rewrite
  could only carry forward what it found.
- **If it is interrupted, do not run the reset again.** Leave the ignition on, leave the cable in,
  **do not close the browser**, and click **FLASH** again — a **Recover** action appears that writes
  the saved block back. Only a backup from the *same* DME is ever offered.

### Read the service info first — read-only

The FLASH dialog has a **read-only** inspection that dumps both service blocks and reports what is
actually in them: the addresses the DME itself reports for AIF/ZIF/DIF/BRIF, whether each block is
erased, the flash counter's raw bytes, and the parsed AIF slots with their VIN and software number.
It erases and writes nothing, and the 16 KB can be saved to a file.

This is the honest first step on any DME whose history is unclear — including the fairly common CSL
conversion case of a failed tune having wiped the AIF. It answers, from the DME's own pointers rather
than from assumption, whether the identity records are present and which processor holds them.

## Technical Specifications & Limitations

- **Supported BINs**: Only **0401 partial BINs** (65536 bytes — slave data block followed by master data block).
- **CSV Formats**: Supports semicolon-delimited (Testo output) and comma-separated (Spreadsheet output).
- **Headers**: CSV Header names must match Testo output EXACTLY.
- **Accuracy**: Calculations have been verified against manual tools at the cell level and confirmed to match perfectly.
- **Checksums**: **Now implemented.** CRC-16/ARC is recalculated automatically before every BIN download and every DME write — you do **not** need to correct checksums with external tools. The algorithm was verified byte-for-byte against a known-good stock partial BIN.
- **Every read is checked against the DME's own checksums.** The ECU stores checksums for its data blocks, and between them they cover the whole 64 KB. Each read is verified against those before the bytes are used, so a partial or corrupted read is caught at the point it happens rather than discovered later in a tune built on top of it. This is what makes a read *byte-exact* rather than merely complete.
- **Flashing**: **Now implemented**, using the BMW DS2 protocol over a K+DCAN (FTDI) cable, and verified on a real vehicle. Each written chunk is validated against the DME's programming verify byte, and the result is then confirmed either by the DME's own encoding checksum (QUICK) or by that plus a byte-for-byte read-back of the whole region (FULL) before the write is reported successful.
- **Adaptation reset**: Clears the DME's learned lambda trim (2 factors + 2 offsets) and knock adaptation (6 cylinders) — 10 values, decoded and displayed before and after the clear. VANOS adaptation (intake/exhaust) is decoded and shown alongside them but is **not** cleared, on karter16's advice ([thread 242281 #161](https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=363888#post363888)): nothing in this tuning process affects it, and forcing a re-learn moves cam phase, which moves filling. A separate VANOS-only clear exists for the max-power cam sweep, which does need it. This is a **scoped** clear (DS2 service 0x43, mask 0x07), not a diagnostic tool's full "Clear All": VANOS, throttle/pedal/EGAS, SMG clutch, detected-equipment and crank-wheel adaptations are left untouched, since the CSL's SMG-II clutch adaptation would otherwise need a full re-adaptation procedure to recover. Both the DS2 frame bytes and the field layout were verified against a decompiled reference tool. A snapshot of the values immediately before and after the clear is saved with the session. Not yet cross-checked against a real DME's actual post-clear values (only that the clear command and read-back path are correct) — verify the results look sane before relying on them.
- **Flash counter**: Read at connect from the DME's boot field — a run of 2-byte markers, 30 slots per processor, decoded with the same scan the reference tool uses. Resetting it erases and rewrites the 8 KB service block on **both** processors (the block also carrying the AIF, ZIF and VIN records), then reads all 16 KB back and compares byte-for-byte. The pre-erase block is stored in a separate browser database first, and the reset aborts if that fails. Three guards refuse to start: engine not stopped, a boot field still mid-programming, or a block found already erased by an earlier interrupted attempt — that last one matters because an erased block reads as a healthy `0/30 available` on the counter alone, so a naive retry would write the hole back and verify it. An interrupted reset is recovered by writing the saved block back (**Recover**, offered in place of a retry). A cleared counter reads `1/30`, not `0/30`: `0x0000` is the "consumed, keep looking" sentinel the scan walks over. **Confirmed on a real vehicle** (2026-07-28): the counter reads and the reset completes. A read-only inspection of both service blocks is also available and is the right first step on any DME with an unclear history.
- **When the link fails**: an echo mismatch is classified by **bit direction** rather than reported as
  a wall of hex. A K-line is open-collector, so a device physically cannot turn a 0 into a 1 — if
  every changed bit went 1→0, something pulled the line down during our own transmission (cable,
  connector, ground, adapter) and retrying cannot help. The dialog says so and shows a physical
  checklist instead of "check the connection and retry"; when the bytes instead parse as a stale
  reply read in the wrong place, that is a desync and a retry is the right advice. This does not make
  the link more reliable — it stops an afternoon going into retries that cannot succeed. Observed on
  a real vehicle with the engine *stopped*, which rules out ignition EMI as the sole cause; see
  [§12 of the implementation notes](docs/implementation-notes.md).
- **Speed**: everything runs at 9600 baud unless a faster rate can be reached **from inside a
  programming session**, which is the only state the DME accepts a rate switch in — and a
  programming session is opened by an **erase**. That one fact decides where each speed-up can exist
  and how dangerous it is.
  - **READ — `FAST ON`: ~123 s → 15–30 s.** A read erases nothing, so it makes a programming session
    of its own: it erases the Free Identifiers sector, restores it immediately, verifies the restore
    **byte for byte**, and only then asks for 125000. The switch is therefore attempted with the
    sector already back and already proven back, so a refused or silent switch costs the speed and
    nothing else. The bytes written back are re-read live seconds before the erase; the stored
    backup supplies addresses only, so a stale map can only preserve too much.
    **The first read on a DME takes that backup itself** — 16 KB, read-only, ~31 s — and is still
    faster end to end (~45–60 s) than a plain 9600 read. Every read after it is the 15–30 s alone.
    It also means a DME that has been read once has a recovery image without anyone having had to
    remember to make one.
  - **WRITE — `BOOST`: write telegrams ~68 s → ~17 s.** A write already erases, so the session is
    there for free. A write telegram measures **150 ms of request, 32 ms of DME programming, 11 ms
    of response** — 78 % wire, which is the part a rate can recover; the 32 ms of flash programming
    cannot be. Unlike FAST READ this switch is sent **with the data area erased**, so it is armed
    deliberately, resets to 9600 on every connect, and falls back to 9600 before a single write
    telegram if the DME accepts the switch and then goes quiet.
  - **FLASH COUNTER RESET — its own `BOOST`**, on that reset's confirmation. See the flash-counter
    section for why it is a separate switch rather than the same one.
  - **`QUICK VERIFY` is not a wire rate at all** — it removes a whole ~123 s read-back. See Safety.
  - **All three switches are Android-only.** They need a transport that can change baud on the
    already-open handle, because the switch is sent after the erase, where closing and reopening a
    port is the one thing that cannot be recovered from. That is the WebUSB FTDI path. On desktop
    Web Serial everything runs at 9600 and the controls that would offer otherwise are either not
    rendered or shown disabled with the reason on them.
  - **The read-rate selector is gone**, because the question it existed to ask has been answered.
    38400 is closed: the switch is accepted, the wire genuinely runs at 38400 (36.0–36.8 ms measured
    against a theoretical 36.1), and every attempt died inside the first 17 of 538 chunks over
    eleven attempts, with the ECU silent rather than corrupt. 125000 is unreachable from a plain
    read. The 9600 baseline is **122.9 s** for 64 KB, measured twice, identically.
    An earlier note here said 9600 was ~40 s slower than the wire accounted for and that 38400
    doubled the DME's turnaround. Both were the same artefact: the ECU warms up, so the head of a
    read shows ~110 ms of turnaround against ~40 ms once settled, and 38400 never survived long
    enough to reach the settled region it was being compared against.
  - Every read still reports its own elapsed time, throughput and **the rate it actually ran at** —
    a refused switch falls back silently, and without both numbers "refused" and "didn't help" look
    identical.
- **Browser compatibility**:
  - *File workflow*: any Chromium browser (Chrome / Edge / Opera).
  - *Direct DME workflow, desktop*: **Chrome / Edge / Opera** — it requires the Web Serial API, which Safari does not support and Firefox does not support out of the box.
  - *Direct DME workflow, Android*: **Chrome, with a USB OTG adapter.** Note that Chrome for Android does expose the Web Serial API, but only for Bluetooth serial-port emulation: a USB K+DCAN cable is invisible to it, so the app talks to the cable through WebUSB and the FTDI vendor protocol instead. Genuine FTDI chips only (FT232AM/BM/R); CH340 and other clone cables are not supported on Android.
  - *Android status*: **read, live log and write are all proven on the car.** A full 64 KB read took **126.5 s at 518 B/s**, against ~123 s / 530 B/s on desktop — 2.8% slower, so the transport costs essentially nothing. The image verified against **both of the ECU's own stored data checksums**, which together cover the whole 64 KB, so the read is byte-exact rather than merely plausible. The erase → write → verify cycle completed from a head unit on **2026-08-09**, which was the last path in this app carrying no hardware evidence. Still untested on Android specifically: break recovery, the receive-flush polarity, backgrounding endurance across a long write, and 38400 — none of them on the path that has now run. There is a bench page at **`/usb-check`** for those; it needs a bare FT232R breakout with TX and RX jumpered together, since a K+DCAN cable cannot self-echo on a desk (its K-line pull-up comes from the car).
  - *Writing from a phone*: proven, and it asks for more care than the desktop path. A write runs 4+ minutes, and if the screen switches off or you switch apps the connection can drop mid-write. The app holds a screen wake lock while writing and warns you before starting, but Android does not let a web page guarantee any of this. If a write does fail it always restarts from the erase, so re-running it is safe.
- **Live logging — the lambda trim proves itself, every eighth sample.** The short-term trim is read
  from four bytes of RAM rather than from a measurement block, which is what lets it be sampled at
  the log's own rate. An address that is right in a disassembly and wrong on this particular
  calibration would otherwise produce a whole drive of plausible, wrong trim — so the claim "these
  four bytes are `la_f_regler`" is not taken on trust: every eighth sample carries block 19's own
  copy of the same channel at the same instant, and the two are compared for the length of the
  drive rather than once at the start. A run whose gate does not hold says so instead of producing
  a map. RPM, relative opening and coolant temperature are confirmed against Testo logs as before.

## Important Note on Development

This application was developed **entirely with LLM assistance** (initially Gemini; the checksum, DME
communication and flashing features were added later with Claude). There has been **no manual code
review by a human**.

As a result, there may be unexpected bugs or redundant "spaghetti" code in some places. I have left
some of the redundant code as-is to preserve logic integrity.

**Disclaimer:** Use this tool at your own risk. The author assumes no responsibility for any damage
to your ECU, engine, or vehicle. This is especially important now that the tool can write to the DME
directly — please read the safety section above.

---

## Development (Local)

This is a [Next.js](https://nextjs.org) project.

```bash
npm run dev
```

Or double-click **`dev.cmd`** (Windows), which does the same and keeps its window open after the
server exits, so whatever it printed on the way out is still readable.

Open [http://localhost:5054](http://localhost:5054) with your browser to see the result. Note that
`localhost:5054` and `127.0.0.1:5054` are different origins to the browser, so each has its own
saved sessions — pick one and stay on it.

The DME features need a real K+DCAN cable and a secure context; `localhost` counts as secure, so
`npm run dev` is enough for hardware testing.

Testing the Android path against a dev server is the one case where that is not enough: a phone
reaching your machine at `http://192.168.x.x:5054` is **not** a secure context, so both
`navigator.usb` and `navigator.serial` are simply undefined there and the app will report that it
cannot reach a DME. Use `adb reverse tcp:5054 tcp:5054` so the phone sees it as its own `localhost`,
or test against the deployed HTTPS site. Adding `?transport=webusb` forces the WebUSB backend on any
platform, which is how the FTDI path can be exercised from a desktop bench rig rather than
first-run in a car (`?transport=webserial` forces the other way). A **PRACTICE** toggle in the DME panel simulates a DME
so the whole flow (read → live tune → write, plus the flash-counter reset) can be exercised offline
without a cable. The simulated DME keeps state, so a reset stays reset across re-reads the way a real
one would.
