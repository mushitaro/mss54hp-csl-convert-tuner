# MSS54HP CSL CONVERT /// TUNER

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

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
10. **DME adaptation reset** — clears the learned lambda, knock, and VANOS trims before a re-tune, so the next log is captured from a known baseline instead of one still shaped by the previous map
11. **Flash counter** — reads how many programming cycles the DME has left and can reset the counter, so a tool built around repeated flashes stops running into an invisible ceiling; includes a read-only inspection of the DME's identity records (VIN / AIF)

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
- **WRITE** — flashes the tuned BIN (checksum corrected, then read-back verified)

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
- A write takes **about 4 minutes** at 9600 baud (write ~2.5 min + read-back verify ~70 s). The
  progress display shows the current stage (Erasing / Writing / Verifying). **This is normal — do not
  interrupt it.**
- After a successful write, **turn the ignition OFF, wait 10 seconds, then back ON** so the DME
  reinitialises with the new data. The app prompts you for this.
- Use **Download Tuned** before writing if you want to inspect the exact bytes in TunerPro first — the
  downloaded file is byte-for-byte identical to what gets flashed.

### Resetting the flash counter — additional risk

The counter lives in flash and flash cannot be rewritten without an erase, so the reset erases and
rewrites the whole block it sits in — the same block that holds the VIN and the programming history.
On success those records are byte-for-byte unchanged. If power is lost part-way, they are gone.

- Takes about **1.5–2 minutes**. The same power rules as a WRITE apply, and they matter more here.
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
- **Flashing**: **Now implemented**, using the BMW DS2 protocol over a K+DCAN (FTDI) cable, and verified on a real vehicle. Each written chunk is validated against the DME's programming verify byte, and the whole region is read back and compared byte-for-byte before the write is reported successful.
- **Adaptation reset**: Clears the DME's learned lambda trim (2 factors + 2 offsets), knock adaptation (6 cylinders), and VANOS adaptation (intake/exhaust) — 12 values, decoded and displayed before and after the clear. This is a **scoped** clear (DS2 service 0x43, mask 0x47), not a diagnostic tool's full "Clear All": throttle/pedal/EGAS, SMG clutch, detected-equipment and crank-wheel adaptations are left untouched, since the CSL's SMG-II clutch adaptation would otherwise need a full re-adaptation procedure to recover. Both the DS2 frame bytes and the field layout were verified against a decompiled reference tool. A snapshot of the values immediately before and after the clear is saved with the session. Not yet cross-checked against a real DME's actual post-clear values (only that the clear command and read-back path are correct) — verify the results look sane before relying on them.
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
- **Speed**: DME communication defaults to 9600 baud, where a full read takes **~124 s measured** (530 B/s) — about 40 s more than the wire alone accounts for, and that gap is currently unexplained. Faster rates are selectable but **none is reliable yet**: 38400 has both completed and, more recently, timed out 3–10% into a read; 125000 fails outright (the DME accepts the switch, then answers nothing); 57600 / 76800 / 115200 are unconfirmed. If the DME refuses a rate the read silently falls back to 9600, so every read now reports its own elapsed time, throughput and the rate it actually used — otherwise "refused" and "didn't help" look identical. Writes always run at 9600 regardless.
- **Browser compatibility**:
  - *File workflow*: any Chromium browser (Chrome / Edge / Opera).
  - *Direct DME workflow*: **Chrome / Edge / Opera desktop only** — it requires the Web Serial API, which Safari does not support and Firefox does not support out of the box.
- **Live logging caveat**: live values are decoded from the DME's measurement blocks. RPM, relative opening and coolant temperature are confirmed, but the lambda-controller factor used as the STFT input has **not** been cross-checked against a known-good Testo log. Validate it before relying on live-tuned output.

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
`npm run dev` is enough for hardware testing. A **PRACTICE** toggle in the DME panel simulates a DME
so the whole flow (read → live tune → write, plus the flash-counter reset) can be exercised offline
without a cable. The simulated DME keeps state, so a reset stays reset across re-reads the way a real
one would.
