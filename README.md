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

(The tool is completely free.)

## Two ways to use it

### A. File workflow — no cable required

Upload your **Partial BIN** and **TESTO LOG CSV**, then download the tuned BIN.
Checksums are corrected automatically. Works in any Chromium browser.

### B. Direct DME workflow — K+DCAN cable

Talks to the DME directly, so no separate reader/logger/flasher is needed:

```
CONNECTION → READ → [RESET ADAPT] → START TUNE → STOP → WRITE ─→ (ignition off 10s) → done
                                                            ├→ Write Bytes    (verify in TunerPro first)
                                                            └→ Re-tune        (discard)
```

- **CONNECTION** — connects and shows VIN / AIF / software number
- **READ** — reads the partial BIN straight out of the DME
- **RESET ADAPT** — available any time START TUNE is. Shows the DME's current learned adaptation
  values, then lets you clear them so the next log is captured from a known baseline rather than one
  still carrying over trims the previous map produced. This is the natural step right after a
  post-write reconnect, before starting the next tune. See
  [Technical Specifications](#technical-specifications--limitations) for exactly what is and isn't
  cleared.
- **START TUNE** — live-logs from the DME and updates the VE calculation in real time
- **STOP** — ends logging; you can then use **Write Bytes** to inspect the result before committing
- **WRITE** — flashes the tuned BIN (checksum corrected, then read-back verified)

### Getting files back out

Two different things, so they are two different controls:

- **Write Bytes** (on the session bar, above the map) — builds the bytes **WRITE would send right
  now**, from the current map and the current toggle settings. This is the one to inspect in TunerPro
  before flashing, and the only way to export a tune you have not saved yet.
- **The download icons in the STARTUP session list** — each downloads what that session has
  **stored**: its **BASE** bytes, its **LOG** (as a Testo-format CSV that re-imports cleanly), and its
  **TUNED** bytes. Each sits on the column that names it, so there is no question which file you get.

Tuning sessions (BASE + tuned BIN + the paired log) are stored in the browser and can be reloaded or
compared from the **STARTUP** tab.

## Usage

The app is hosted on GitHub Pages, so it can be used immediately without installation:
**[https://mss54hp-csl-convert-tuner.tsunagi.app/](https://mss54hp-csl-convert-tuner.tsunagi.app/)**

The source code is public, so please feel free to review or modify it:
[https://github.com/mushitaro/mss54hp-csl-convert-tuner/](https://github.com/mushitaro/mss54hp-csl-convert-tuner/)

Implementation details (DS2 protocol, checksum algorithm, addresses, verification status) are
documented in [docs/implementation-notes.md](docs/implementation-notes.md).

## ⚠️ Safety — please read before flashing

This tool can **erase and write your DME**. Flashing an ECU always carries risk.

- **The engine must be stopped.** Ignition ON, engine OFF. (The DME itself also refuses to program
  unless RPM and vehicle speed are zero.)
- **Keep power stable** during the write. A battery charger/maintainer is recommended.
- **Never disconnect the cable or cut power while writing.** The write cannot be cancelled once the
  erase has started — interrupting it can leave the DME in an unusable state.
- A write takes **about 4 minutes** at 9600 baud (write ~2.5 min + read-back verify ~70 s). The
  progress display shows the current stage (Erasing / Writing / Verifying). **This is normal — do not
  interrupt it.**
- After a successful write, **turn the ignition OFF, wait 10 seconds, then back ON** so the DME
  reinitialises with the new data. The app prompts you for this.
- Use **Write Bytes** before writing if you want to inspect the exact bytes in TunerPro first — the
  downloaded file is byte-for-byte identical to what gets flashed.

## Technical Specifications & Limitations

- **Supported BINs**: Only **0401 partial BINs** (65536 bytes — slave data block followed by master data block).
- **CSV Formats**: Supports semicolon-delimited (Testo output) and comma-separated (Spreadsheet output).
- **Headers**: CSV Header names must match Testo output EXACTLY.
- **Accuracy**: Calculations have been verified against manual tools at the cell level and confirmed to match perfectly.
- **Checksums**: **Now implemented.** CRC-16/ARC is recalculated automatically before every BIN download and every DME write — you do **not** need to correct checksums with external tools. The algorithm was verified byte-for-byte against a known-good stock partial BIN.
- **Flashing**: **Now implemented**, using the BMW DS2 protocol over a K+DCAN (FTDI) cable, and verified on a real vehicle. Each written chunk is validated against the DME's programming verify byte, and the whole region is read back and compared byte-for-byte before the write is reported successful.
- **Adaptation reset**: Clears the DME's learned lambda trim (2 factors + 2 offsets), knock adaptation (6 cylinders), and VANOS adaptation (intake/exhaust) — 12 values, decoded and displayed before and after the clear. This is a **scoped** clear (DS2 service 0x43, mask 0x47), not a diagnostic tool's full "Clear All": throttle/pedal/EGAS, SMG clutch, detected-equipment and crank-wheel adaptations are left untouched, since the CSL's SMG-II clutch adaptation would otherwise need a full re-adaptation procedure to recover. Both the DS2 frame bytes and the field layout were verified against a decompiled reference tool. A snapshot of the values immediately before and after the clear is saved with the session. Not yet cross-checked against a real DME's actual post-clear values (only that the clear command and read-back path are correct) — verify the results look sane before relying on them.
- **Speed**: All DME communication runs at 9600 baud. A full read takes ~70 s. Faster rates (38400 / 125000) are the only others the DME accepts and are selectable as an experiment, but they are **not working reliably** — the Web Serial API cannot change baud on an open port, and the required close/reopen appears to disturb the K-line. See the implementation notes for details.
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

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

The DME features need a real K+DCAN cable and a secure context; `localhost` counts as secure, so
`npm run dev` is enough for hardware testing. A **MOCK** toggle in the DME panel simulates a DME so
the whole flow (read → live tune → write) can be exercised offline without a cable.
