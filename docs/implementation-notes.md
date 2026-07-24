# Implementation Notes — DME Link, Checksum & Tuning Pipeline

Working memo for the live-DME features. Captures the protocol facts and design decisions that are
expensive to re-derive, and records exactly what has and has not been proven on real hardware.

Last updated: 2026-07 (after the first successful real-vehicle write).

---

## 1. Verification status

| Capability | Status |
|---|---|
| Connect + DS2 seed/key login | ✅ Verified on real DME |
| Identity read (VIN / AIF / software number) | ✅ Verified on real DME |
| Partial BIN read (65536 B) | ✅ Verified on real DME |
| Live measurement polling (RPM / RO / temp) | ✅ Verified on real DME |
| Checksum correction (CRC-16/ARC) | ✅ Verified byte-exact against a real stock BIN |
| Partial BIN write (flash) | ✅ **Verified — engine started and runs** |
| Read-back verification after write | ✅ Verified (write completes only if every byte matches) |
| Baud boost to 38400 | ❌ Untested |
| Baud boost to 125000 | ❌ **Failed on real hardware** (see §9) |

Everything runs at **9600 baud**. A full read takes ~70 s; a full write ~4 min (write ~2.5 min +
read-back verify ~70 s).

---

## 2. Module map

```
src/lib/dme-link/
  types.ts              DmeLink interface, TransferPhase/TransferProgress, DmeLinkError
  ds2.ts                DS2 framing, XOR checksum, seed/key, memory payloads,
                        write-response parsing, baud specs, MSS54HP address layout
  identity.ts           System address table, AIF entries, VIN (packed 6-bit), ZIF program number
  liveValueBlocks.ts    Live measurement block field layouts + decoding
  webSerialTransport.ts navigator.serial wrapper (open/close/reopen/read/write/purge)
  webSerialDmeLink.ts   Real DME implementation (login, read, write, live polling)
  mockDmeLink.ts        Offline simulator — mirrors the real flow incl. phases, no cable needed
src/lib/checksum/
  crc16.ts              CRC-16/ARC
  dmeDataChecksum.ts    MSS54HP data-pair checksum analyse/correct
src/lib/db/             IndexedDB session store (tuned BIN + paired log)
src/lib/field-registry/ Log data-channel metadata (labels/units/format/visibility)
src/hooks/useDmeLink.ts Connection state machine + progress throttling
```

Protocol details below were derived by analysing an existing native reference tool for this ECU
family (kept locally in `reference/`, which is **gitignored** — it is third-party software and must
not be committed). The notes here record the *facts* needed for interoperability, not that code.

---

## 3. DS2 protocol essentials

The MSS54 uses BMW's **DS2**, *not* KWP2000/ISO-14230. There is no 5-baud or fast-init handshake —
just open the port and exchange frames.

- **Port**: 9600 baud, 8 data bits, **even** parity, 1 stop bit (8E1).
- **Frame**: `[Address][Length][Control/Status][Payload…][XOR checksum]`
  - `Length` counts the whole frame. Minimum 4 bytes.
  - Checksum = XOR of every byte except itself.
  - Default MSS54 address: `0x12` (18).
- **Half-duplex K-line**: the DME echoes back everything you transmit. **Every exchange must read
  and discard `len(request)` echo bytes before reading the real response.** This is the single most
  important framing detail.
- **Positive response**: `Control/Status == 0xA0`. Others: `0xA1` busy, `0xA2` rejected,
  `0xB0` parameter error, `0xB1` function error, `0xFF` NAK.

### Control bytes used

| Control | Purpose |
|---|---|
| `0x06` | Read memory — payload `[segment, addr(3, BE), count]` |
| `0x07` | Write memory — payload `[segment, addr(3, BE), count, data…]`, max **123** data bytes |
| `0x0B` | Read I/O status (live measurement blocks) — payload `[selection]` (1 byte) |
| `0x0D` | Read system-specific addresses (pointer table) |
| `0x90` | Login: seed request / key submit |
| `0x91` | Baud-rate switch |
| `0x9E` | Keep-alive (tester present) |
| `0x9F` | End diagnostic mode |

### Login (seed/key)

1. Send `0x90` with payload `"BMW"` + access-level byte (default `5`) → `[0x42,0x4D,0x57,0x05]`.
2. A **5-byte** positive response = already unlocked, done.
3. A **46-byte** positive response = a seed. Compute the key from the *whole 46-byte frame*:
   ```
   key = 0
   for i in 0..3:
       idx  = (accessLevel + i) % frame[1]        // frame[1] is the Length byte (46)
       term = frame[idx] + frame[18+i] + frame[41+i]
       key  = (key << 8) | (term & 0xFF)
   ```
4. Send `0x90` with the key as 4 big-endian bytes. Positive response = unlocked.

Re-login before read and before write — the session can lapse (implemented in both paths).

### Timeouts in use

| Operation | Timeout |
|---|---|
| Normal response (read/login/identity) | 2 s |
| Write chunk response | **15 s** (flash programming is slow to reply at 9600) |
| Erase | 65 s |

---

## 4. MSS54HP partial BIN layout ("0401 partial BIN")

The app's BIN is the **DataTune pair**: 65536 bytes = **slave first, then master**.

| Block | DS2 address | Length | Offset in file |
|---|---|---|---|
| Slave data | `0xA00000` | 32768 | `0x0000` |
| Master data | `0x200000` | 32768 | `0x8000` |

- **Read** uses segment `0` for both blocks, 122-byte chunks.
- **Write** uses segment `2` (see §6).

Addresses come from the reference's binary-layout model: the DS2 address is
`(subsegment_nibble << 20) | offset`, where the DataTune block nibble is `2` for master and
`2 + 8 = 10 (0xA)` for slave — hence `0x200000` / `0xA00000`.

---

## 5. Checksum — CRC-16/ARC (verified byte-exact)

**Algorithm**: CRC-16/ARC — polynomial `0x8005` reflected (`0xA001`), init `0`, no final XOR.

Two slots in the 65536-byte data pair, each 16-bit **big-endian**, each followed by `FF FF` padding
(the padding is part of validity):

| Slot | Checksum offset | Padding |
|---|---|---|
| Slave | `0x3FFC` | `0x3FFE..0x3FFF` |
| Master | `0xBFFC` | `0xBFFE..0xBFFF` |

**Input construction is not the obvious contiguous range** — each half is CRC'd over a swapped
window pair (32764 bytes):

```
slaveInput  = image[0x4000..0x8000)  ++ image[0x0000..0x3FFC)
masterInput = image[0xC000..0x10000) ++ image[0x8000..0xBFFC)
```

> Note: the simpler MSS54 (non-HP) scheme — `0xF0` prepended to 16380 bytes — does **not** match
> this BIN. It was tested and rejected against real data.

**Verification against the user's real stock BIN** (`211323000401PD31_Community_Patch_v1_Partial.bin`,
65536 B): stored == calculated for both slots — slave `0xC987`, master `0x7BC2`, padding `FF FF` ✅.

Correction is applied **last**, after every other patch, in `useBinaryFile.buildPatchedBuffer()`:

```
clone original → setVETable(tuned map) → warmup/WOT (optional)
  → MAP/LTFT logic patch → WOT threshold → applyChecksumCorrection()
```

`applyChecksumCorrection()` no-ops for buffers that aren't exactly 65536 bytes.

**The downloaded BIN and the bytes sent to the DME are the same buffer** — both call
`buildPatchedBuffer(newMap)`. So verifying the download in TunerPro verifies exactly what gets
flashed.

---

## 6. Write (flashing) flow

### Programming constants

| Name | Value |
|---|---|
| Write segment | `2` |
| Erase segment | `6` |
| Finish / pre-clean segment | `15` (`0x0F`) |
| Data programming session address | `0xA02000` |
| Finalize address | `0` |

### Sequence

1. **Re-login** (purge + seed/key refresh).
2. **Erase** — `0x07` seg `6` @ `0xA02000`, empty body, 65 s timeout.
   - Normal flow erases **directly**. The `0x0F` "pre-clean" is sent **only if the erase fails**,
     then the erase is retried once — sending pre-clean unconditionally wastes a flash-counter slot.
3. **Write slave**, then **write master** — `0x07` seg `2`, 122-byte chunks.
4. **Finalize** — `0x07` seg `15` @ `0`.
5. **Read-back verify** — read both blocks (segment 0) and compare byte-for-byte. Any mismatch
   throws; the write is only reported successful if every byte matches.

### Write-response validation (safety-critical)

A positive DS2 status **alone does not mean the cells were programmed.** Every write response body
must be parsed and checked:

```
payload = [segment, addr(3, BE), writtenCount, verifyByte]     // ≥ 6 bytes
```

- `segment` must equal the requested segment
- `nextAddress24` must equal `address + count`
- `writtenCount` must equal the requested count
- **`verifyByte` must be `1`** ("programming OK")

For *control* commands (erase/finalize) `verifyByte` of `1` **or** `8` is accepted, and an **empty
payload is a legitimate ack**.

| verifyByte | Meaning |
|---|---|
| 1 | programming OK |
| 2 | verify failed |
| 3 | cells were not erased before programming attempt |
| 4 / 5 | copying/backing up AIF / ZIF not possible |
| 6 | boot-mode field management error |
| 7 | program programming session active |
| 8 | data programming session active |
| 9–11 | hardware/program reference implausible or mismatched |
| 12 | program incomplete |
| 13 / 14 | data reference implausible / mismatched |
| 15 | data incomplete |

### Even alignment

Flash writes must start at an **even address** and have an **even length**. Our fixed 122-byte
chunking over an even-based, even-length 32768-byte block satisfies this automatically (last chunk
= 72 bytes, also even). Fully-erased (all-`0xFF`) chunks are skipped — after the erase those cells
already read `0xFF`, so re-writing them is a wasted program cycle.

### Safety gates (deliberately lighter than the reference tool)

1. **Checksum auto-correction** — always, no opt-out.
2. **One confirmation dialog** before flashing (engine off / stable power).
3. **Read-back verification** — byte-for-byte.
4. **Post-write dialog** — key OFF → wait 10 s → key ON, then auto-disconnect (the power cycle ends
   the DME session anyway).
5. Write is **not cancellable** (cancelling after erase would leave the ECU half-programmed).
6. The tuned session is auto-saved to the DB on success.

Deliberately **not** implemented (kept simple by choice): mandatory tracked-backup gate, power
monitoring, flash-counter warnings, strict DME-identity backup matching, multi-step typed
confirmations.

> **The DME enforces engine-off itself**: erase/write is rejected with `0xA2` unless RPM/vehicle
> speed are zero. The confirmation dialog is a courtesy, not the only guard.

---

## 7. Identity (VIN / AIF / software number)

1. `0x0D` → response payload is a flat array of **3-byte** pointer entries (`[high, mid, low]`,
   big-endian 24-bit). Entry *i* is at payload offset `i*3`. A pointer of `0x000000` or `0xFFFFFF`
   means unavailable.
2. Pointer indices and read lengths:

   | Index | Field | Read length |
   |---|---|---|
   | 15 | DIF (data reference) | 48 |
   | 16 | ZIF backup | 26 |
   | 18 | BRIF (hardware reference) | 24 |
   | 19 | ZIF (supplier info) | 78 |
   | 20 | **AIF (user info)** | **660** (fixed, not from the length table) |

3. **AIF** = 14 × 46-byte entries (+16-byte tail). An entry is blank if all `0x00` or all `0xFF`.
   The **last non-blank entry** is the most recent programming record.

   | Bytes | Field |
   |---|---|
   | 0–12 | **VIN** |
   | 14–15 | programming date (packed) |
   | 17–21 | software number ("data stand") |
   | 23–25 | program number |
   | 44 | mileage (× 600 km) |

4. **VIN decoding** (bytes 0–12 = 104 bits): if all 13 bytes are printable ASCII, treat as ASCII.
   Otherwise it's **packed 6-bit**: skip the first 2 bits, then read **17 characters × 6 bits**,
   MSB-first across byte boundaries, indexing `"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"`.
   *(Round-trip tested: `WBSBL93453PN12345` encodes and decodes back identically.)*

5. **ZIF**: BMW program number = bytes **57–63** (7-byte ASCII, repeated 3× for redundancy).
   Variant detection = first 8 raw bytes as ASCII: `21132200` → MSS54, `21132300`/`21132500` → MSS54HP.

---

## 8. Live measurement blocks

Request: `0x0B` with a **single** payload byte = selection. Offsets below index the **response
payload**. Physical value = `add + raw * scale`.

### Selection 3 — "Standard Measurements" (35 bytes)

| Offset | Symbol | Field | Format | Scale | Add |
|---|---|---|---|---|---|
| 0 | `n` | **RPM** | u16 BE | 1.0 | 0 |
| 8 | `rf` | relative filling (%) | u16 BE | 0.1 | 0 |
| 11 | `tmot` | **coolant temp (°C)** | u8 | 1.0 | **−48** |
| 16 | `ub` | battery voltage (V) | u8 | 0.1 | 0 |
| 20 | `aq_rel` | **relative opening (%)** | u16 BE | 0.46511627906976744 | 0 |
| 27 / 29 | `wdk1` / `wdk2` | throttle position (%) | i16 BE | 0.1 | 0 |

`aq_rel` is the **same physical quantity** as the Testo CSV's *"relativer Oeffnungsquerschnitt"* —
i.e. our `rawLoad`. That mapping is what makes live tuning feed the existing VE pipeline unchanged.

### Selection 19 — "Operating Measurements" (90 bytes)

| Offset | Symbol | Field | Format | Scale |
|---|---|---|---|---|
| 40 | `la_f_regler1` | lambda controller factor, bank 1 | u16 BE | 1/32768 (`3.0517578125e-05`) |
| 42 | `la_f_regler2` | lambda controller factor, bank 2 | u16 BE | 1/32768 |

These stand in for the CSV's *Lambdaintegrator 1/2* (`stft1`/`stft2`); neutral trim ≈ 1.0.
**Block 3 contains no lambda/STFT data** — selection 19 is required for it.

Live polling = 2 round trips per sample (≈ 6–7 samples/s at 9600). Selection 19 is **best-effort**:
if it fails, trim falls back to 1.0 and RPM/RO/temp logging continues rather than killing the loop.

> ⚠️ The STFT mapping is decoded correctly per the block definition, but whether `la_f_regler`
> numerically matches the Testo logger's *Lambdaintegrator* has **not** been cross-checked against a
> known-good log. Since the VE correction math consumes `stft`, validate this before trusting
> live-tuned output.

---

## 9. Web Serial constraints & the baud-rate finding

Confirmed against the [WICG Web Serial spec](https://wicg.github.io/serial/):

1. **There is no way to change baud on an open port.** `SerialPort` exposes only
   `getInfo/open/setSignals/getSignals/close/forget` (+ `readable`/`writable`/`connected`).
   No `reconfigure()`/`setOptions()` → **close + reopen is mandatory**. The native reference changes
   baud in place (`FT_SetBaudRate`) and never closes — this is the fundamental gap.
2. **Baud rate is unrestricted**: *"A positive, non-zero value…"*. Non-standard rates like 125000 are
   spec-legal, and FTDI computes the divisor for arbitrary rates. **The Windows COM-port dropdown is
   irrelevant** — it only sets a default for apps that don't specify a rate.
3. **DTR/RTS state on open/close is unspecified** by the spec, and Chrome is known to toggle them on
   open (the classic "opening the port resets my Arduino" problem). The reference explicitly holds
   `DTR = false, RTS = false` and never toggles them.

### Supported baud rates (only these three)

Switch = `0x91` with a 4-byte payload: 24-bit big-endian rate + constant `0x19`.

| Rate | Payload | Check |
|---|---|---|
| 9600 | `[0, 37, 128, 25]` | `0x002580` = 9600 |
| 38400 | `[0, 150, 0, 25]` | `0x009600` = 38400 |
| 125000 | `[1, 232, 72, 25]` | `0x01E848` = 125000 |

**144000 is not supported by the DME** — the payload could encode it, but the ECU's UART won't
follow. Baud choice is the DME's to make, not ours.

### What happened with 125000

The DME **accepted** the switch (it ACKed) and the port **did** reopen at 125000 — the failure was a
plain timeout on every subsequent exchange, not an open error. Because the restore-to-9600 request
then also had to travel at the broken 125000, it failed too, leaving both sides desynced: every later
operation (including live polling on a fresh connect) timed out until the ignition was cycled.

**Leading hypothesis**: the mandatory `close()`/`open()` pulses DTR/RTS and disturbs the K-line
interface mid-session. If that's the cause, **38400 will fail identically** — the rate isn't the
variable, the reopen is.

### Current state

`READ [9600 ▼]` selector in the DME panel, **default 9600** (no switch is attempted at all at 9600 —
the proven path). 38400/125000 are opt-in experiments. On failure the local port is force-restored to
9600 so a reconnect / ignition cycle recovers instead of silently hanging.

**Next diagnostic step**: try 38400. Success → the issue was 125000-specific. Failure → the
close/reopen glitch is confirmed and baud switching is not viable via Web Serial; stay at 9600.
(If pursuing it: try `setSignals({dataTerminalReady:false, requestToSend:false})` immediately after
reopen to restore the reference's line state — but change one variable at a time.)

---

## 10. UX / state machine

Main ring button drives the whole flow:

```
CONNECTION → READ → START TUNE → STOP → WRITE ─→ (key off dialog) → disconnect → STARTUP
                                          └→ Download BIN  (verify in TunerPro first)
                                          └→ Re-tune       (discard; asks save/discard)
```

- **STARTUP** tab (default) lists saved sessions newest-first; each row's *Read* loads it and — when
  a DME is connected — arms the button to **START TUNE**.
- Live raw telemetry (RPM/RO/TEMP/SAMP/STFT) floats as an **absolute overlay** on the visualisation
  during tuning, so the panel layout is identical whether logging or stopped.
- Transfer stages are labelled (**Erasing… / Writing… / Verifying… / Reading…**) with continuous
  progress. Progress split reflects real durations at 9600: write 0–70 %, verify 70–100 %.
  *(A silent verify phase was previously mistaken for a freeze at 87 %.)*
- Progress state updates are throttled to ~10 Hz; phase changes and 100 % bypass the throttle.
- Filter/Alpha-N changes recompute **without** switching tabs.

---

## 11. Known limitations / TODO

- **Speed**: everything at 9600. Read ~70 s, write ~4 min. Baud boost unresolved (§9).
- **STFT cross-check**: `la_f_regler` vs Testo *Lambdaintegrator* not validated (§8).
- **Write baud**: write is always 9600 (the reference boosts to 125000 after erase). Deferred until
  baud switching is proven.
- **Chromium only**: Web Serial is Chrome/Edge/Opera desktop. The file-upload workflow remains the
  fallback for other browsers and must keep working.
- **IndexedDB is best-effort storage** — the browser can evict it. File download remains the durable
  artifact.
- **README is stale**: it still says checksum correction is "not yet included" and that flashing is
  "still researching". Both are now implemented and hardware-verified.
- `reference/` is gitignored third-party software — never commit it.

---

## 12. K-line instability on the car (2026-07 real-vehicle testing)

Two failures were captured on the vehicle, at seemingly random points in the session:

```
Serial read failed: Break received
Unexpected K-line echo — check the cable connection (sent 12 05 0b 06 1a, got 05 08 00 00 00)
```

### These are one physical event, not two bugs

Align the captured echo at lag +1 and every received byte is a strict **bitwise subset** of the byte
that was sent:

| sent | got | |
|---|---|---|
| `05` | `05` | — |
| `0B` | `08` | 2 bits 1→0 |
| `06` | `00` | 2 bits 1→0 |
| `1A` | `00` | 3 bits 1→0 |

**7 one-bits went 1→0. Zero of the 22 zero-bits went 0→1.** The K-line is open-collector: a device can
only pull it *low*, never drive it high. A corruption that is exclusively 1→0, followed by three
sustained `0x00` bytes (a held-low line is exactly the "break" condition), is the signature of
**something pulling the line down during our own transmission** — not of a software buffer desync.

Which of the two strings surfaces is a race: `readExact` tests `buffer.length < length` *before* it
tests `pumpError`, so already-buffered corrupt bytes are returned on one attempt and the latched break
throws on the next.

Decisively: the failing frame's selection `0x06` is the adaptation block read — **the one path that
already had drain + resync + three retries.** It failed anyway. No amount of software resilience
prevents this.

`classifyEchoMismatch()` in `ds2.ts` now performs this analysis automatically and puts the verdict in
the error message, so the next occurrence is self-diagnosing.

### What the software changes actually do

**Fixes (real defects):**
- A latched `pumpError` was only recoverable from the adaptation paths — every other recovery point
  was a bare `purge()`, which cannot clear it. One transient break therefore poisoned the *whole*
  session until a reconnect. All recovery points now use `resyncTransport()`.
- The live-poll loop had no end-of-session callback, so when it died on a link error the post-log
  teardown never ran: no disconnect, no key-cycle instruction — and because a partial log still
  produces a `newMap`, the hub silently re-armed to **WRITE**. The user was one click from flashing
  with the engine running. `startTuning` now reports the ending via `onEnd`, and both endings go
  through `finishLog()`.
- `writePartialBin` never cleared `aborted`. After a cancelled READ, a *fully successful* flash was
  reported as failed on the read-back verify — inviting a needless re-flash of a 20-year-old ECU.
- A failed write produced no user-facing message at all.

**Mitigations (do not mistake for cures):** the block-3 poll retry and the broadened resync reduce how
often a transient glitch is fatal. They do not repair a bad cable.

### Physical checklist for the next drive

Cheapest discriminator first:

1. **Compare engine-off (ignition on) vs engine-running failure rates.** If it only misbehaves with
   the engine running, it is ignition EMI on an unshielded cable — not the software.
2. Reseat the OBD plug; wiggle-test it while connected.
3. Try a different USB port, no hub.
4. Check the OBD port's ground and KL15 supply.
5. Note the adapter's FTDI VID/PID (`SerialPort.getInfo()`), since clone chips are common.
