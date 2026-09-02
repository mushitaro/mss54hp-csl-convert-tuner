# Implementation Notes — DME Link, Checksum & Flashing

Working memo for the **transport and flashing** layers: how this app talks to the DME, how the
checksum works, and what has and has not been proven on real hardware. Protocol facts and design
decisions that are expensive to re-derive.

Last updated: 2026-07 (after the first successful real-vehicle write).

> **This file used to be titled "…& Tuning Pipeline" and never contained one.** The tuning logic —
> what the log channels mean, why PATCH writes the bytes it writes, how the VE correction is
> derived, and how the EGT correction is handled — lives in
> **`docs/ecu-logic/60-tuning-logic.md`**. Start there for anything above the byte layer.
>
> The rest of `docs/ecu-logic/` covers the other side of the wire: what the 0401 DME itself does
> (load path, EGT correction, idle control, the FRA bug, binary lineage), starting at
> `docs/ecu-logic/00-glossary.md`.

**Where things are in this file.** §9 is 560 lines — 40 % of the document — and is a closed
investigation kept for its dead-hypothesis log. Its conclusion is in the box at the top of §9;
you do not need to read the rest unless you are re-opening the baud-rate question.

| § | Topic |
|---|---|
| 1 | What is verified on real hardware |
| 2 | Module map |
| 3 | DS2 protocol essentials (framing, login, timeouts) |
| 4 | Partial BIN layout |
| 5 | **Checksum — CRC-16/ARC**, and the ordering rule every writer must obey |
| 6 | Write / flashing flow and its safety gates |
| 7 | Identity (VIN / AIF / software number) |
| 8 | **Live measurement block layouts** (the log channels) |
| 9 | Baud rate — *closed*, see the box at its head |
| 10–11 | UX state machine, known limitations |
| 12 | K-line instability on the car |
| 13 | Flash counter read + reset |
| 14 | Android — WebUSB / FTDI |

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

Everything runs at **9600 baud**. A full read takes **~124 s** (measured 2026-07-28; the "~70 s" this
line used to claim is not reproducible — see §9). A full write is ~4 min.

The table above is the **desktop / Web Serial** transport. The Android / WebUSB-FTDI transport (§14)
shares every layer above the bytes, so what needs separate verification is only the transport itself:

| Capability (Android, WebUSB + FTDI) | Status |
|---|---|
| `claimInterface` on Chrome for Android | ✅ Verified on a real phone — the gating unknown |
| Identity read | ✅ Verified on real DME |
| Partial BIN read (65536 B) | ✅ Verified — **65528/65536 bytes checked against the ECU's own stored checksums**, 126.5 s / 518 B/s |
| Live polling + datalog | ✅ Verified on real DME (544 samples) |
| Reconnect after key cycle | ✅ Verified on real DME |
| Partial BIN write (flash) | ✅ **Verified on the car (2026-08-09)** — full erase → write → verify over WebUSB |
| Break recovery (BI bit) | ❌ Untested |
| `SIO_RESET` receive-flush polarity (2 vs 1) | ❌ Untested — 2 is the libftdi 1.5 value, assumed |
| Backgrounding / screen-off endurance | ❌ Untested |
| Baud boost to 38400 | ❌ Untested on this transport (now cheap: no port transition) |

---

## 2. Module map

Regenerated 2026-08-18 from the tree. Ten modules were missing from the previous version.

```
src/lib/dme-link/
  types.ts              DmeLink interface, TransferPhase/TransferProgress, DmeLinkError
  ds2.ts                DS2 framing, XOR checksum, seed/key, memory payloads,
                        write-response parsing, baud specs, MSS54HP address layout
  identity.ts           System address table, AIF entries, VIN (packed 6-bit), ZIF program number,
                        MSS54/MSS54HP variant detection
  blockDecoder.ts       Field formats shared by the live-value and adaptation block tables
  liveValueBlocks.ts    Live measurement block field layouts + decoding (selections 3 / 19 / 83)
  adaptationBlocks.ts   Adaptation block layouts, cleared-value expectations, clear masks
  ramMap.ts             Control-0x06 RAM windows and signals — the torque cluster and the
                        lambda trim the fast VE profile reads instead of block 19
  flashCounter.ts       Service-block layout, counter analysis, reset image, warning levels
  fastEntry.ts          FAST READ preservation plan (what must survive the sector erase)
  serviceBlockReport.ts Service-block dump analysis, for inspection rather than repair
  verifyPolicy.ts       Which write-verify mode this ECU has earned
  transferTiming.ts     Per-exchange instrument: medians, per-exchange-kind breakdown, samples
  linkEventLog.ts       Phase-level narrative of the operation in flight
  byteTransport.ts      ByteTransport contract + platform detection + transport factory
  bufferedByteTransport.ts  Shared receive buffer, parked waiter, readExact (both backends)
  webSerialTransport.ts navigator.serial wrapper — desktop backend
  webUsbFtdiTransport.ts    FTDI vendor protocol over WebUSB — Android backend (§14)
  webSerialDmeLink.ts   Real DME implementation (login, read, write, live polling, fast entry)
  mockDmeLink.ts        Offline simulator — mirrors the real flow incl. phases, no cable needed
  mockDrive.ts          The simulated drive the mock's telemetry comes from
src/lib/log-engine/
  logProfile.ts         What a run is FOR: its exchange list, its cost, its fallback, the truth
                        gate on the RAM lambda trim
  filter.ts             The sample filters and the drop census; the resumable pass a live run uses
  axisBracket.ts        Where a value sits on a calibration axis — one rule, five former copies
  lambdaGates.ts        FR 5.01 conditions under which la_f_regler means nothing
  parser.ts / serializer.ts   Log CSV in and out
  rate.ts               Measured sample rate, in seconds whatever the column's unit
src/lib/ve-calculator/
  calculator.ts         Binning, the VE derivation, the warmup/WOT tables
  egtTables.ts          KF_RF_KORR_DRREL and friends, read from the binary rather than assumed
  rfKorrTuner.ts        Back-calculates the correction table; owns the census the panel reads
  rfKorrRoutes.ts       Agreement between the two ways of reaching rf_korr
src/lib/binary-engine/
  parser.ts             Reads the maps and the patch state out of a BIN
  patcher.ts            Every writer, and what "restore" restores
src/lib/checksum/
  crc16.ts              CRC-16/ARC
  dmeDataChecksum.ts    MSS54HP data-pair checksum analyse/correct
src/lib/db/             IndexedDB session store (tuned BIN + paired log + live-run recovery)
src/lib/session-sync/   The deployment's store: sessions, diagnostics, wording
src/lib/field-registry/ Log data-channel metadata (labels/units/format/visibility)
src/hooks/useDmeLink.ts Connection state machine, progress throttling, the link snapshot async
                        handlers read instead of a frozen prop
src/hooks/useLiveRun.ts A datalog in progress: samples, durability, flush pacing, the readout store
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
| Recycling segment | `14` (`0x0E`) — flash-counter reset only, see §13 |
| Finish / pre-clean segment | `15` (`0x0F`) |
| Data programming session address | `0xA02000` |
| Finalize address | `0` |

> **Note on `0xA02000`.** The reference `Ds2ProgrammingControl.cs` uses `10502144` = **`0xA04000`**,
> not `0xA02000`. Both are inside the same slave DataBlock subsegment (nibble `0xA`) and differ only
> in the offset within it. `0xA02000` is what this app has actually flashed a real vehicle with,
> read-back verification included — and a skipped erase cannot survive that check, since NOR flash
> only clears bits (the DME would answer verify byte `3`, "cells were not erased", on the first
> chunk). The proven value therefore stays. Don't align it to the reference without re-proving it
> on a car.

### Sequence

1. **Re-login** (purge + seed/key refresh).
2. **Erase** — `0x07` seg `6` @ `0xA02000`, empty body, 65 s timeout.
   - Normal flow erases **directly**. The `0x0F` "pre-clean" is sent **only if the erase fails**,
     then the erase is retried once — sending pre-clean unconditionally wastes a flash-counter slot.
3. **Write slave**, then **write master** — `0x07` seg `2`, 122-byte chunks.
4. **Finalize** — `0x07` seg `15` @ `0`.
5. **Verify** — see the next section. QUICK (default once earned) or FULL.

### Verification — two modes, and what each one actually proves (2026-08-11)

There are **three independent layers**, and the mode chooses only whether the third one runs.

| Layer | What it proves | QUICK | FULL |
|---|---|---|---|
| ① per-telegram verify byte | the DME programmed that chunk's cells and passed its own internal check (`1` = OK; `2` = verify failed, `3` = cells not erased, …) | always | always |
| ② `0x0A` encoding checksum | the DME's **own** stored CRC-16/ARC values match its own flash. The two data slots cover **65528 of 65536 bytes**; the remaining 8 *are* the slots, which a match verifies | ✅ | ✅ |
| ③ 64 KB read-back | the bytes we sent equal the bytes it returns, and **where** any mismatch is | ✖ | ✅ |

`0x0A` was defined in `ds2.ts` from the start and **never called**, exactly like the
`maxTelegramLength` decoder and `Ds2BaudRate.Baud38400`. It is the substance of the reference tool's
`ProgrammingVerificationMode.QuickVerify`, which is **that tool's default** — the reason it does not
read 64 KB back after every flash.

- Request `12 04 0A 1C` (4 bytes) → response `12 05 A0 xx ck` (5 bytes). **One exchange, ~50 ms**,
  against **122.9 s** for the read-back of the same region. That is ~45% of a flash.
- **A set bit means FAULTED.** bit0 boot master · bit1 program master · **bit2 data master** ·
  bit4 boot slave · bit5 program slave · **bit6 data slave**. A tune write judges bits 2 and 6 only
  (`DATA_TUNE_CHECKSUM_BITS`), matching the reference's `DataChecksumBits`. A program-area fault is
  a real fact about the ECU but not one this write caused, so it is reported, never thrown on.

**What QUICK cannot do**, stated plainly because the UI states it too: it cannot say *where* a
mismatch is, and it cannot catch a corruption that happens to preserve CRC-16 (1 in 65536, and only
reachable at all if ① passed on every chunk first).

**The assumption QUICK rests on, and how it is discharged.** Nothing in the reference or the 0401
disassembly says whether the DME recomputes its checksum on demand or answers from a value cached at
boot. If it cached, a post-write "clean" would be the same answer it gives for a botched write. So:

- `0x0A` is **also read at connect**, into `DmeIdentity.encodingChecksum` — the before half of a
  before/after pair. It is read-only, four bytes, and cannot fail a connection.
- `verifyPolicy.ts` keeps, per VIN, whether a **FULL** write has completed on that ECU *and* its
  checksum came back clean. Until that has happened the VERIFY selector **opens on FULL**. The user
  can still choose QUICK; the point is that the first write to an unfamiliar DME does not silently
  take the cheaper proof.
- Under QUICK a missing or refused `0x0A` is a **failure**, not a warning: "the data was written and
  every telegram reported programming OK, but nothing has confirmed the result." Under FULL it is
  recorded and the write stands on the byte comparison, which is the stronger check and already ran.

> **These assertions do not exist in this repository.** The paragraphs below describe a
> scripted-DME harness that was written during development and never committed; `scripts/`
> holds no such file, and `npm run verify:*` does not run one. What each paragraph says about
> the CODE is still accurate and worth reading — what is NOT true is that anything checks it
> automatically. `verify:ds2` covers the framing, the seed/key, the echo classification and
> the verify byte; everything that needs a DME to answer is unchecked.

The claim these paragraphs were written to support is about the telegram *trace and count*
rather than the outcome — which is what would prove QUICK skipped the read-back rather than merely
reporting that it had: QUICK sends **0** read telegrams and FULL sends **538**; the
checksum is asked exactly once in both; bit 2 set throws and names "Data master" without naming the
clean slave area; `0xB0` throws under QUICK with the re-run-with-FULL advice and passes under FULL
with the reason recorded; a double erase failure chains both messages and emits no write telegram.

The mode is carried into `FlashRecord.verifyMode`, the completion dialog and the uploaded diagnostic
record, all using the same words. A write verified two different ways must not be describable by one.

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
2. **One confirmation dialog** before flashing (engine off / stable power). It names the verify mode
   and the resulting duration, because the mode changes what "verified" will mean afterwards and the
   moment to say so is before the erase.
3. **Verification** — per-telegram verify byte and the DME's `0x0A` checksum always; the
   byte-for-byte read-back under FULL. See the verification section above.
4. **Post-write dialog** — key OFF → wait 10 s → key ON, then auto-disconnect (the power cycle ends
   the DME session anyway).
5. Write is **not cancellable** (cancelling after erase would leave the ECU half-programmed).
6. The tuned session is auto-saved to the DB on success.

Deliberately **not** implemented (kept simple by choice): power monitoring, strict DME-identity
backup matching, multi-step typed confirmations. (Flash-counter reading and its warning colors now
exist — see §13. The mandatory tracked-backup gate exists only for the flash-counter reset, which
cannot proceed without one, not for the tune write.)

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
| 2 | `LLR_N_SOLL` | idle speed target (rpm) | u16 BE | 1.0 | 0 |
| 4 / 6 | `ML` / `TL` | air mass / load signal | u16 BE | — | — |
| 8 | `rf` | **relative filling (%)** — AFTER the EGT correction | u16 BE | 0.1 | 0 |
| 10 | `tan` | intake air temp (°C) | u8 | 1.0 | −48 |
| 11 | `tmot` | **coolant temp (°C)** | u8 | 1.0 | **−48** |
| 12 | `toel` | oil temp (°C) | u8 | 1.0 | −48 |
| 14 | `tabg` | **exhaust gas temp (°C)** | **i8** | **16.0** | 0 |
| 15 | `t_umg` | ambient temp (°C) | u8 | 1.0 | −48 |
| 16 | `ub` | battery voltage (V) | u8 | 0.1 | 0 |
| 20 | `aq_rel` | **relative opening (%)** | u16 BE | **200/65536** (`0.0030517578125`) | 0 |
| 27 / 29 | `wdk1` / `wdk2` | throttle position (%) | i16 BE | 0.1 | 0 |

`rf` and `tabg` are decoded by `liveValueBlocks.ts`; the rest of the added rows are listed because
they are in the same response and cost nothing to add later. Their offsets come from the 0401
disassembly (`ds2_handler` `case 0x1c`, payload offset = array index − 3) — see
`docs/ecu-logic/20-egt-correction.md` §7.1, including the one unresolved inconsistency in that
derivation and the on-car check that settles it.

`tabg` is the DME's `TABG >> 4` as a **signed** byte, i.e. 16 °C per count over a −55…1250 °C
sensor range. It is a gating and monitoring channel, not a precision measurement.

`aq_rel` is the **same physical quantity** as the Testo CSV's *"relativer Oeffnungsquerschnitt"* —
i.e. our `rawLoad`. That mapping is what makes live tuning feed the existing VE pipeline unchanged.

Its scale is **200/65536**, not the reference catalogue's `0.46511627906976744`. The offset is right
— RPM and tmot decode correctly beside it — but that tool scales `aq_rel` to its own % convention,
about 150x larger, which puts idle at 38 % and cruise over 200 %. Checked against a real Testo log:
every *relativer Oeffnungsquerschnitt* value there is exactly `raw * 200/65536`, so idle reads ~0.25
and cruise ~1, which is what the load axis is in.

### Selection 19 — "Operating Measurements" (90 bytes)

| Offset | Symbol | Field | Format | Scale |
|---|---|---|---|---|
| 38 | `tetv` | tank-vent valve pulse time (ms) | u16 BE | 0.002 |
| 40 | `la_f_regler1` | lambda controller factor, bank 1 | u16 BE | 1/32768 (`3.0517578125e-05`) |
| 42 | `la_f_regler2` | lambda controller factor, bank 2 | u16 BE | 1/32768 |
| 62 | `tefc_ll_st` | tank-vent idle functional-check state | u8 | 1 |
| 88 | `tefc_ed` | tank-vent diagnostic handle | u8 | 1 |
| 89 | `la_freeze_flag` | recorded, not interpreted | u8 | 1 |

`la_f_regler1/2` stand in for the CSV's *Lambdaintegrator 1/2* (`stft1`/`stft2`); neutral trim ≈ 1.0.
**Block 3 contains no lambda/STFT data.**

### Selection 83 — EGAS freeze-frame (52 bytes)

**Not telemetry.** The buffer at `0xFFDA48` is filled on the first EGAS event and latched; every
later event only increments byte 0. On a healthy car it reads 52 zero bytes for as long as you care
to poll it. Read by `readEgasFreezeFrame` as a diagnostic, and by nothing else — the inertia run
reads block 3 plus a RAM chunk instead. See `EgasMeasurement` in types.ts.

### RAM reads (control 0x06) as a live channel

The eight predefined blocks are the whole of what `0x0B` can give, and two things a run needs are
either absent from them or expensive:

| What | Where | Why |
|---|---|---|
| `MD_DYN_ST`…`MD_IND_NE` | segment 0x01, `0xFF8180` +40 B | Indicated torque for the inertia run; block 83 turned out to be a fault frame |
| `LA_F_REGLER1/2` | segment 0x01, `0xFF80CA` +4 B | The one channel a VE log needs from block 19, at 4 bytes instead of 90 |

The lambda-trim read is the fast VE profile. Its address comes from the 0401 master disassembly,
which is evidence and not proof, so a run opens by checking it against block 19 itself — RAM, block,
RAM, three times, 5 % agreement plus a plausibility band, two of three — and falls back to reading
both blocks if the car disagrees. Block 19 stays on a 1/8 lane for the four channels that exist
nowhere else, which re-checks the claim for free for the whole drive. See `ramMap.ts` and
`LAMBDA_TRUTH_GATE` in `logProfile.ts`.

### What a sample costs

`expectedHz(profile.exchanges)` is the one place this is stated; the numbers below come from it.

| Profile | Exchanges | Modelled | Measured |
|---|---|---|---|
| VE (fast) | block 3 + RAM 4 B + block 19 at 1/8 | **4.7 Hz** | — (WP6) |
| VE (fallback) | block 3 + block 19 | 3.0 Hz | 2.95 Hz (#904) |
| EGT (retired) | block 3 | 7.5 Hz | 6.60 Hz (#903) |
| INERTIA | block 3 + RAM 40 B | 4.4 Hz | — |

Wire at 9600 8E1, plus the DME's own turnaround: 83 ms for a block read, 35 ms for a RAM read. The
model omits transport latency deliberately, so it sits above a measured rate and the gap is the
transport's — see `DME_TURNAROUND_MS`. The FTDI latency timer drops from 16 ms to 4 ms for the
duration of a run and back afterwards.

Every exchange other than block 3 is best-effort: a failure leaves its channels **undefined**, never
1.0. `1.0` is a real measurement meaning "the controller wanted no correction", and handing it back
for an exchange that did not happen is the same lie as calling `la_f_regler` "Lambda".

> ⚠️ The STFT mapping is decoded correctly per the block definition, but whether `la_f_regler`
> numerically matches the Testo logger's *Lambdaintegrator* has **not** been cross-checked against a
> known-good log. Since the VE correction math consumes `stft`, validate this before trusting
> live-tuned output.

---

## 9. Web Serial constraints & the baud-rate finding

> **CLOSED. The conclusion, in full:**
> **9600 is the only rate this DME implements.** 38400 opens and negotiates but the DME does not
> answer at it; 125000 fails on real hardware. Raising the baud produced no speed-up because the
> residual time is the DME's own per-block turnaround, not the line rate. A full read is **~124 s**
> at 9600 and that is at the DME's floor — the remaining lever is not software.
>
> Everything below is the investigation that established this, including the hypotheses that turned
> out to be wrong. It is kept because re-opening this question without it would mean repeating the
> same dead ends on a car. **You do not need to read it to work on this app.**
>
> Sub-sections headed `ANSWERED` / `CLOSED` / `FINAL` / `Current state` are successive restatements
> of the same conclusion as evidence accumulated; they are not separate findings.

Confirmed against the [WICG Web Serial spec](https://wicg.github.io/serial/):

1. **There is no way to change baud on an open port.** `SerialPort` exposes only
   `getInfo/open/setSignals/getSignals/close/forget` (+ `readable`/`writable`/`connected`).
   No `reconfigure()`/`setOptions()` → **close + reopen is mandatory**. The native reference changes
   baud in place (`FT_SetBaudRate`) and never closes — this is the fundamental gap.
   *This constraint is specific to Web Serial.* The WebUSB/FTDI backend added for Android issues
   `SET_BAUD_RATE` on the open handle exactly as the reference does, so it has no port transition at
   all — see §14.
2. **Baud rate is unrestricted**: *"A positive, non-zero value…"*. Non-standard rates like 125000 are
   spec-legal, and FTDI computes the divisor for arbitrary rates. **The Windows COM-port dropdown is
   irrelevant** — it only sets a default for apps that don't specify a rate.
3. **DTR/RTS state on open/close is unspecified** by the spec, and Chrome is known to toggle them on
   open (the classic "opening the port resets my Arduino" problem). The reference explicitly holds
   `DTR = false, RTS = false` and never toggles them.

### Baud rates

Switch = `0x91` with a 4-byte payload: **24-bit big-endian rate + constant `0x19`**. The encoding is
generic, so any rate can be *requested*; whether the DME accepts it is a separate question.

| Rate | Payload | Check | Status |
|---|---|---|---|
| 9600 | `[0, 37, 128, 25]` | `0x002580` | **Proven on the car.** Default; no switch attempted at all |
| 38400 | `[0, 150, 0, 25]` | `0x009600` | **Proven on the car** (2026-07) |
| 125000 | `[1, 232, 72, 25]` | `0x01E848` | **Fails on the car.** The reference's programming rate |

57600 / 76800 / 115200 are ours, derived from the payload encoding; the reference defines only the
other three. On a real vehicle they produced no *perceived* speed-up, and they were deleted on that
basis — then restored, because that reasoning was wrong. "It didn't feel faster" cannot distinguish

- the DME **refusing** the switch (`trySwitchBaud` returns false, the read silently runs at 9600), from
- the DME **accepting** it while something else dominates the transfer time.

Deleting them threw away the experiment instead of running it. **144000** is separately known not to
work.

The fix is to stop inferring. `getLastReadBaud()` reports the rate a read actually ran at, and
`useDmeLink` raises a non-error **warning** whenever that differs from what was selected — shown in
the DME notice line, in amber, without painting the status dot red. A refused switch is a normal,
harmless outcome; being unable to tell that it happened was the defect.

The expensive failure is the DME *accepting* a rate neither side can run, which desyncs the link until
the ignition is cycled.

### 38400 works, 125000 does not — what that rules out

**The close/reopen hypothesis is dead.** This section used to argue that the mandatory
`close()`/`open()` pulses DTR/RTS and disturbs the K-line, and predicted that *if that were the cause,
38400 would fail identically*. 38400 was then confirmed working on the car. The reopen is not the
variable; **the rate is.**

The observed 125000 failure: the DME **accepted** the switch (ACKed) and the port **did** reopen — the
failure was a plain timeout on every subsequent exchange, not an open error. The restore-to-9600
request then also had to travel at the broken rate, so it failed too, leaving both sides desynced
until the ignition was cycled.

**FTDI divisors are exact for both rates**, so the chip's capability is not the issue (3 MHz base,
14-bit integer + 3-bit fractional divisor):

| Rate | 3 MHz / rate | Representable? |
|---|---|---|
| 38400 | 78.125 | 78 + 1/8 — exact, 0% error |
| 125000 | 24.0 | integer — exact, 0% error |

That leaves two candidates, not mutually exclusive:

**(a) The transport layer.** The reference calls `FT_SetBaudRate(handle, 125000)` straight into
`ftd2xx.dll` (`FtdiD2xxTransport.ApplySettings`), programming the divisor directly. This app goes
Web Serial → OS VCP driver → `SetCommState`. 125000 is a **non-standard** rate (outside the
9600/19200/38400/57600/115200 ladder); non-standard values are where VCP drivers — and especially
CH340 / counterfeit-FTDI cables — reject or silently snap to something else. 38400 being standard and
125000 not matches the observation exactly.

**(b) K-line rise time.** The K-line is single-wire open-collector with a pull-up, so edges are
RC-limited. With ~1 kΩ pull-up and ~2 nF of harness + cable capacitance, the 10–90% rise is ≈4.4 µs:

| Rate | Bit period | Rise time as a fraction of it |
|---|---|---|
| 38400 | 26 µs | ~17% — comfortable |
| 125000 | 8 µs | ~55% — broken |

The existing "144000 doesn't work" note fits the same ceiling.

### What the 125000 failure actually looks like

Captured on the car:

```
Timed out waiting for 2 byte(s) (received 0)
```

Two bytes is the **response header** read, which comes *after* the echo read has already succeeded.
So at 125000 the host transmits and reads back its own K-line echo correctly — the local UART is
self-consistent at that rate — and then the DME says **nothing at all**. Not garbled: zero bytes.

That reshapes the diagnosis, and retires an earlier suggestion recorded here: `classifyEchoMismatch()`
cannot help with this failure, because there is no mismatched echo to classify. Its 1→0 versus 0→1
test only applies when bytes come back wrong, not when none come back.

Silence rather than corruption points at **(a)** over **(b)**: a signal-integrity problem generally
mangles bytes, whereas nothing arriving is what you see when the far end is not at that rate at all —
the DME ACKed the switch at 9600 and then either never moved or could not sustain it. (A rise time
too slow to trigger the receiver's start-bit detection would also produce zero bytes, so **(b)** is
weakened, not eliminated.)

### Current state

`READ [9600 ▼]` selector in the DME panel, **default 9600** (no switch attempted at 9600 — the proven
path). Everything above it is opt-in. On failure the local port is force-restored to 9600 so a
reconnect / ignition cycle recovers instead of silently hanging.

**38400 has completed a read at least once, but currently fails part-way** (see below); 125000 does not
run at all. Whether anything between them is accepted is still open — the notice above is what will
answer it, one read at a time. Note that the reference tool never uses anything but 9600 and 125000,
so nothing above 9600 here has precedent to lean on.

### Why raising the baud produced no speed-up (2026-07-28)

Reported from the car: 57600 felt no faster than 9600, and desktop tools feel roughly twice as fast
even at 9600. The cause was in `readExact`, which waited like this:

```ts
await new Promise(r => setTimeout(r, 2));   // polled until enough bytes were buffered
```

Browsers **clamp nested `setTimeout` to ~4 ms**, so that loop could sit on bytes that had already
arrived for up to a full clamp period. A DS2 exchange calls `readExact` three times — echo, header,
body — so the floor was roughly 12 ms per 122-byte chunk, ~540 chunks per read, i.e. **6–7 seconds of
pure timer latency** independent of baud. At 9600 the wire needs ~150 ms per chunk and that hides;
at 57600 the wire drops to ~26 ms and the fixed cost becomes the dominant term, which is exactly the
shape of "it didn't get faster".

`readExact` is now event-driven: the pump wakes a parked waiter the instant the byte count is
satisfiable, with a single timer for the deadline rather than one per poll. Measured against a fake
pump, a late arrival is now served ~2 ms after it lands instead of up to a clamp period later, and a
latched break wakes the reader immediately instead of waiting out the full timeout.

**Reads now report their own measured throughput** in the DME notice line
(`9600 baud · 64 KB / 124.0 s · 530 B/s`), in slate for a plain result and amber with `REFUSED` when a
switch was rejected. Comparing rates is now arithmetic, not impression — which matters, because an
impression is what previously led to three rates being deleted on a wrong conclusion.

That line spent one round of testing rendered at `text-[9px]` in `slate-500` and truncated, and was
reported from the car as "nothing appeared". It was appearing; it could not be read. Now 11px in
`slate-300`, with the message shortened to `<baud> · <size> / <time> · <rate>` so the numbers survive
truncation — leading is pinned to the 14px row so the larger font still cannot grow the panel into the
visualizer, which is the constraint that made it 9px in the first place. A measurement nobody can read
is not a measurement.

### The FTDI latency timer — and a correction

The chip buffers received bytes and hands them to the host when either a 62-byte USB packet fills or
its **latency timer** expires. Default 16 ms. Per DS2 chunk two receives are short of a full packet —
the 9-byte echo, and the 2-byte tail of the 126-byte response — so the timer is paid roughly twice
per chunk. The reference sets it to the minimum at open: `FT_SetLatencyTimer(handle, 1)`
(`FtdiD2xxTransport`).

**Correction (2026-07-29): this used to say "which is also what the community advises", as if 1 ms
were the known-right answer. It is not, and three primary sources say so:**

- FTDI's own **AN_107**: the valid range is 1–255 ms, "although **1 ms is not recommended as this is
  the same as the USB frame length**".
- The **D2XX Programmer's Guide** documents `FT_SetLatencyTimer`'s valid range as **2–255, default 16**
  — so the reference's `FT_SetLatencyTimer(handle, 1)` is outside D2XX's own documented range, even
  though the silicon accepts it. Parity with the reference is not a target here.
- The **Linux kernel reverted** an 8-year-old 1 ms default (`ftdi_sio`, Johan Hovold): a status header
  is sent whenever the timer expires *including when the buffer is empty*, so an idle open port
  generated a two-byte message every millisecond. Interrupt rate dropped 1 kHz → 62.5 Hz.

At 9600 8E1 a byte takes 1.146 ms, longer than a 1 ms timer, so a 126-byte response is carried by
**~126 IN transfers at 1 ms versus ~9–10 at 16 ms** — and the 62-byte packet-full trigger never fires
either way (62 bytes takes 71 ms at this rate). What 1 ms buys is only the *tail*: the last byte hits
the wire at the same instant regardless, and the timer merely bounds how long it then sits in the
chip. That is **≤15 ms per transaction, bought with ~14× the USB transactions** — and every one of
those is a `reader.read()` resolution on the same thread as React.

**2–4 ms is the predicted sweet spot**, and the way to find it is a sweep (1 → 4 → 8 → 16), not a
single 1→16 flip. A flip that lands slower would be misread as "hypothesis dead" when the real answer
is "overshot the tail cost".

**Correction to an earlier claim here:** this was described as something Web Serial cannot reach and
therefore a permanent advantage for native tools. That is wrong. The latency timer is a *driver-level
property of the device*, set in Device Manager → Port Settings → Advanced → Latency Timer, and it
applies to whichever application opens the port — Chrome included. The only difference is that D2XX
programs it itself while the VCP path inherits whatever the driver is configured with.

**On the Android/WebUSB backend it is set to 16 — the chip default — and deliberately not lower.**
Two reasons, and neither is the tail latency this section was originally about:

1. Android has no Device Manager, so nothing sets it for us: without an explicit
   `SET_LATENCY_TIMER` the device simply runs at its 16 ms default. The call is there to make the
   value *stated* rather than inherited, not to lower it.
2. The 2–4 ms prediction above does not transfer. It assumed Web Serial, where the browser process
   drains the endpoint into the mojo pipe independently of us. On WebUSB **our own read loop is the
   only thing draining the endpoint, on the same thread as React** — and the chip emits a 2-byte
   status packet on every timer expiry whether or not it carries data. So the latency timer sets the
   renderer's idle wakeup rate: 62.5/s at 16 ms, 1000/s at 1 ms. That is precisely the regression
   the Linux kernel reverted (quoted above), arriving on the main thread instead of in a driver.

The sweep result stands either way: the timer was measured on the car and changed nothing. 8 is the
only other value worth trying; 1 is not a candidate.

### Measured on the car (2026-07-28) — and two dead hypotheses

Real numbers, with the latency timer confirmed at **1 ms** and **unchanged for the life of the
project**:

| Rate | Result |
|---|---|
| 9600 | **123.7 s / 124.0 s** (530 B/s), reproducible |
| 38400 | **times out mid-read**, after ~10% on one attempt and ~3% on the next |
| 57600 | ran, no improvement reported |

Theoretical floor at 9600 (538 chunks × 144 wire bytes × 11 bits ÷ 9600) is **~83 s**, so ~40 s —
about 75 ms per chunk — is still unaccounted for.

**Dead hypothesis 1: "the ~70 s figure regressed to 124 s when the latency timer changed."** The timer
was never changed. Whatever produced the "~70 s" that this document previously reported as measured,
it is not comparable to the 124 s above; treat 124 s as the first trustworthy figure and the earlier
number as unreliable.

**Dead hypothesis 2: "1 ms fragments the stream into per-byte USB packets and that is the 40 s."** The
arithmetic still holds — at 9600 a byte takes 1.15 ms to arrive, longer than a 1 ms timer, so the chip
really does emit roughly one packet per byte — but it cannot be *the regression*, because nothing
regressed: this is simply how it has always run. It remains a plausible contributor to the standing
40 s gap and is worth testing by raising the timer, but it explains no change over time.

**The test has a predicted direction, and it is the counter-intuitive one.** With the timer already at
1 ms, the component everyone reaches for first — waiting out the timer at the tail of a short receive —
costs at most 1 ms × 2 bursts = **~2 ms per chunk, ~1 s per read**. It is already eliminated; it is not
the 40 s. What 1 ms *does* buy at 9600 is ~126 packet completions per response instead of ~9, each one
a wakeup that has to cross from the driver through Chromium's serial service into the renderer, where
D2XX would have accumulated them inside `FT_Read`. So raising the timer to 16 ms should make the read
**faster**, not slower, and by roughly 126→9 wakeups × 538 chunks. If it does, the 75 ms/chunk is
per-wakeup cost and the ceiling is the VCP path itself. If it does not move, that hypothesis is dead
too and the remaining candidate is DME turnaround (P2), which the reference pays identically — see the
missing baseline below.

**The missing baseline.** Nothing here has ever been compared against the reference tool's own wall
clock over the same region. Its 512 KiB full read has a ~665 s wire floor (4298 chunks × 154.7 ms); the
measured duration divided by 4298 is the number that says whether ~75 ms/chunk is our overhead or just
what an MSS54 costs. Until that exists, this gap is *unattributed*, not *explained*, and the transport
should not be refactored for it.

**38400 fails differently than assumed.** It is not silent from the moment of the switch — it reads
successfully for 3–10% of the transfer and then stops answering. That is the signature of the
intermittent K-line fault in §12 (or of errors accumulating faster at higher rate), not of a DME that
never moved to the new baud. The earlier note here that it looked "exactly like 125000" was wrong:
125000 produced zero bytes immediately.

### What the reference actually does for comms (2026-07-29)

Read late — the flash-counter work ported `Core`, not the transport, and the two open questions above
were being chased without it. Findings, from `decompiled-source/Transports` and `Core/Ds2Client.cs`:

**The reference has two transports, and only one of them is fast.**

| | `FtdiD2xxTransport` | `SerialPortTransport` |
|---|---|---|
| Path | `ftd2xx.dll` direct, no COM port | `System.IO.Ports.SerialPort` (VCP) |
| Latency timer | `FT_SetLatencyTimer(handle, 1)` at open | **no such call anywhere** |
| Receive buffer | `FT_SetUSBParameters(4096, 4096)` | `ReadBufferSize = 4096` |
| Timeouts | `FT_SetTimeouts(1000, 1000)` | `ReadTimeout = ReadTimeout = 1000` |
| Control lines | untouched | `DtrEnable = false; RtsEnable = false` |

So the reference does not depend on the Device Manager latency setting at all — it programs the chip
itself, on the D2XX path only. Web Serial can never take that path. A reference benchmark taken over
D2XX is therefore **not** a like-for-like baseline for this app; one taken over its COM-port transport
is.

**The DS2 layer, by contrast, is already the same as ours** — this was worth confirming and is now
ruled out as a source of overhead:

| | Reference | Here |
|---|---|---|
| Chunk size | `DefaultChunkSize = 122` | `readChunkSize: 122` — see the correction below |
| Inter-telegram delay | `CommandDelay = TimeSpan.Zero`, never assigned anywhere | none ✅ |
| Echo | read back, compared byte-for-byte | same (plus mismatch classification) ✅ |
| Frame read | 2-byte header, then `len - 2` | same (plus an address guard it lacks) ✅ |
| Response timeout | 1000 ms, restarted on every partial read | 2000 ms, one deadline per phase |
| Chunk retry | 5 attempts, flat 1 s + purge | 5 attempts, escalating + resync |

Two differences that are *ours to fix*, both now fixed:

1. **`bufferSize` was never passed to `port.open()`** — the Web Serial default is 255 bytes. Now
   `RX_BUFFER_BYTES = 4096`. **Demoted, and the original reasoning here was wrong:** `bufferSize` is
   *not* the OS or FTDI driver receive buffer and does not correspond to `FT_SetUSBParameters`.
   Chromium passes it to `mojo::CreateDataPipe` as `capacity_num_bytes` — it is the ring between the
   browser process and the renderer — and `serial_io_handler_win.cc` never calls `SetupComm()`, so the
   driver's buffers stay at their Device Manager defaults regardless. The "292 ms at 9600 / 73 ms at
   38400 main-thread stall budget" framing that used to be here does not follow and has been removed.
   This is a **fragility fix, not a bandwidth fix** (reads have been reported to stall outright at 255,
   WICG/serial#164), and it is no longer the leading explanation for the 38400 failure.
2. **The bulk read was the least patient retry path in the codebase** — flat 300 ms × 4 = 1.2 s, where
   the reference gives 4 s and where our own `adaptationExchangeWithRetry` already escalates and
   lengthens after a break, with a comment explaining that a fresh reader just re-latches a disturbed
   line. The bulk read never learned it. Now `hasReadError() ? 400 : 300` × attempt — 4 s after a
   break, matching the reference exactly.

**Correction: 122 is not a limit, and the ✅ above was asserting the wrong thing.** Matching the
reference is not the same as being right. `Ds2MemoryReader`'s constructor accepts any chunk size up to
255; 122 is its undocumented *default*, with no stated reason anywhere in the tree. Our own framing
allows more: `buildDs2Frame` caps a frame at 255 bytes and a read response is
`[addr][len][status][N][cksum]`, so **N ≤ 251**. BMW's own SGBD job `FLASH_LESEN` uses 120. And the DME
publishes its real ceiling in the system address table at index 21 — a value the reference ships a
decoder for (`"{value[0]} byte max DS2 telegram length"`) and **never calls**. We now read it during
identify and report it; nothing branches on it yet.

Worse, `chunkSize` was a *single* constant shared by the read loop and the write loop. Writes cap at
123 and that cap is enforced only by a runtime throw inside `buildWriteMemoryPayload` — which fires on
the first chunk, i.e. **after `writePartialBinInner` has already erased the ECU**. Split into
`readChunkSize` / `writeChunkSize` with a module-load invariant (≤123, even, even block bases) plus a
pre-erase `assertWriteChunkingLegal`. Note the write side has nothing to gain either way: flash writes
need an even length at an even address under a 123 cap, so **122 is already the maximum legal write
chunk**. Only the read side can grow.

**The flash-write path had no retry at all** (fixed 2026-07-29). `readMemoryChunkWithRetry` was ported
from `Ds2MemoryReader` and its neighbour `Ds2MemoryProgrammer.WriteChunkWithRetryAsync` — 5 attempts,
1 s, purge — was not, so `writeBlock` called `writeMemoryChunk` bare. Since `writePartialBinInner`
erases before it writes, **one lost telegram failed the entire flash on an already-erased ECU**, with
nothing to catch it. The most exposed path in the codebase was the only one without the protection the
paths around it had.

Now `writeChunkTelegramWithRetry`: 5 attempts, escalating 300 ms (400 after a break) × attempt, with
`resyncTransport` between — which touches only the read side, so it sends nothing to the DME and
cannot disturb the programming session it runs inside. **Validation stays outside the retry loop**, the
same split the reference uses: a timeout means the telegram never landed and re-sending is right, but
a verify byte of "verify failed" or "cells not erased" means the DME tried and could not, and
re-asking would hide failing flash behind a success. The reference catches only `TimeoutException` for
exactly this reason. `sendProgrammingControl` (erase/finalize) is still not retried, also matching.

The behaviour, stated rather than checked (see the note in §6): a clean write sends one telegram;
two lost telegrams then success completes instead of failing; it gives up after exactly 5; and
verify-failure, DME rejection, and a next-address mismatch each send exactly one telegram and are
reported rather than masked.

**Correction: the reference does not use 38400.** `Ds2BaudRate.Baud38400` is defined and has **zero
call sites** in the entire tree; every `TrySwitchToProgrammingBaudAsync` goes to 125000, and always
from inside a programming session (after an erase or a fast-entry finalize), never from a plain
diagnostic session as we do. The premise that 38400 was blessed by the reference was wrong — it is an
unused constant. This does not explain a failure 40 chunks *after* a successful switch, but it does
mean nothing above 9600 here has precedent.

**The reference also has a reliability escape hatch we lack:** `AllowedDs2MemoryBlockSizes = {122, 96,
64, 32}`, user-selectable. Not implemented here. Worth having as a *diagnostic*: if 38400 completes at
64 and fails at 122, the cause is burst-length-dependent (buffer or physical layer), not baud-dependent.

### ANSWERED (2026-07-29, real vehicle): the residual is the DME, and 9600 is at its floor

A five-point latency sweep at 9600 with DIAG on. The latency value does not have to be taken on trust —
`echoLatency` (write → first byte back) reproduces the driver setting directly, which is also the
instrument validating itself:

| echoLat | timer | rx/chunk | turnaround | responseWire | parked | total | read |
|---|---|---|---|---|---|---|---|
| 1.9 ms | ~1 | **135** | 53.5 | 141.7 | 196.8 | **196.9** | 105.9 s |
| 1.9 ms | ~2 | 98 | 53.2 | 141.8 | 197.7 | 197.8 | 106.4 s |
| 3.8 ms | 4 | 49 | 63.1 | 140.0 | 199.5 | 199.7 | 107.4 s |
| 7.8 ms | 8 | 27 | 64.1 | 143.7 | 200.2 | 200.5 | 107.9 s |
| 15.8 ms | 16 | **14** | 64.3 | 143.8 | 208.1 | **208.2** | 112.0 s |

**The per-wakeup-cost hypothesis is dead, and the prediction recorded above it was wrong.** This
document predicted that raising the timer would make the read *faster*, by roughly the 126→9 drop in
wakeups. Wakeups did drop as predicted — 135 → 14, a factor of 9.6 — and the read got **5.7% slower**.
Per-`reader.read()` cost is not the residual. 1–2 ms is the best setting of the five, marginally, and
for the opposite reason to the folklore: not because wakeups are cheap, but because the tail latency
it avoids is the only thing the timer actually controls.

**There is no host-side overhead to remove.** `parked / total = 99.9%` in every run: the read is spent
waiting for bytes that have not arrived yet. `write` is **0.10 ms**, so WICG/serial#123 write-splitting
is not happening either — that candidate is also dead.

**The residual has a name: DME turnaround, ~53 ms per exchange.** Last echo byte → first response byte,
53.5 ms at a 1 ms timer, rising to 64.3 ms at 16 ms — i.e. it tracks the timer with an offset of about
11 ms, exactly as the tail-latency model says it must, which is a second internal check on the
instrument. Meanwhile `responseWire` is 141.7 ms against a theoretical 144.4: **the link genuinely runs
at 9600 and the wire is already at its floor.**

Per chunk, 196.9 ms is roughly 141.7 wire + ~53 DME + ~2 us. (The lanes are independent medians so they
do not sum exactly.) Across 538 chunks that is ~76 s of wire and ~29 s of ECU think time. **We are
about 1% of it.** 9600 is finished; nothing on this side can move it.

**The DME publishes `maxTelegramLength = 132`** — read for the first time by anyone here, since the
reference ships the decoder and never calls it. That means a max read payload of **128 bytes, not 251**.
So the chunk lever is worth 538 → 512 exchanges: 26 × ~53 ms ≈ 1.4 s out of 106 s, **about 1.3%**. The
plan to grow the read chunk toward the 251-byte framing limit is dead on arrival — 122 was very nearly
right, by accident, and the escape hatch is only worth building downward as a reliability tool.

Sampled byte-arrival gaps show the mechanism plainly. At a 1 ms timer: 134 gaps of ~1.0 ms (one USB
packet per byte, since a byte takes 1.146 ms) with a single 101 ms gap where the DME was thinking. At
16 ms: `16, 0, 16, 0, …` — one packet per timer tick carrying ~14 bytes.

**So the only remaining lever is baud** — and the next session established that there is no lever
there either: the DME implements exactly 9600 / 38400 / 125000, 38400 dies within 17 chunks every
time, and 125000 needs a flash-erasing procedure to reach. See "CLOSED" below.

### CLOSED (2026-07-29, second vehicle session): 9600 is the only rate this DME implements

**The ECU rejects anything outside 9600 / 38400 / 125000.** Asked for 19200 it answered **DS2 status
0xB0, PARAMETER_ERROR** — validating the value against a fixed list and refusing. Seven rates had been
offered here (10400/14400/19200/28800 below 38400, 57600/76800/115200 above) on the reasoning that the
0x91 payload encodes an arbitrary 24-bit value. It does; the DME does not accept one. Expressible and
implemented are different things, and only the first had ever been checked. Removed.

That also closes a much older loose end. 57600 was reported from the car long ago as "no faster than
9600, and no message appeared" — true, and for exactly this reason: silently refused, silently fell
back. Those rates were deleted once on that impression and restored on the argument that an impression
cannot separate a refused switch from an unhelpful one. It cannot; the impression was right anyway.
The report now records `requestedBaud` and `switchOutcome`, so a refused switch is a fact in the file
instead of a colour on a notice line.

**Correction: 38400 does NOT double the DME's turnaround.** That claim, recorded above from the first
38400 session, was an artifact of comparing 38400's first-17-chunk median against 9600's whole-read
median. The ECU has a warm-up. In a completed 9600 read the sampled chunks show:

| sampled chunks | longest gap (= turnaround) |
|---|---|
| 0–4 (head) | 103.7 / 118.7 / 102.1 / 117.6 / 121.0 ms |
| 269–273 (middle) | **39.2 / 43.0 / 41.9 / 38.5 / 42.1 ms** |
| median over all 538 | 53.1 ms |

So the settled turnaround is ~40 ms and the head of a read is ~110 ms; 53 ms is the blend. Every 38400
attempt died within 17 chunks — entirely inside the warm-up — and its 111–116 ms is indistinguishable
from 9600's 102–121 ms at the same position. **The gap experiment was therefore testing a phenomenon
that does not exist**, which is why 0/5/10/20/40 ms changed neither the turnaround (104–121 ms
throughout) nor the death position (chunk 0/1/7/9/17).

What 38400 actually does: the switch is accepted, the wire genuinely runs at 38400 (36.0–36.8 ms
measured against a theoretical 36.1), and then the ECU stops answering — zero bytes, not a corrupted
frame. Death at chunk 0/1/7/9/17 across five runs is what a roughly 10%-per-chunk failure probability
looks like, i.e. a link that is marginal at that rate rather than one that breaks at a specific point.

**Measured baseline, same day, same car:** 9600 completes in **122.9 s**, twice, identically. (The
106.5 s quoted earlier was reconstructed from medians and understated it; `elapsedMs` is now measured.)
A 20 ms gap costs 13.5 s of that, as arithmetic demands. **This is the floor, and there is nothing
above it to reach.**

### Two things only this app has to do, and what was done about them

Comparing the baud-switch path against the reference turned up one structural difference that is
forced on us and one that simply had not been noticed.

**Forced: we close and reopen the serial port to change baud.** The reference calls
`transport.ConfigureAsync(...)` — `SerialPort.BaudRate = …` on VCP, `FT_SetBaudRate` on D2XX — on the
still-open handle, then purges and waits 200 ms (`ShellSessionService.cs:1323-1346`). It never closes
the port. Web Serial has no in-place baud change, so `reopen()` must do `close()` + `open()`. **Every
boosted read therefore begins with a port transition that no other DS2 tool produces**, and 9600 never
sees it because 9600 sends no switch at all. That matches the failures being exclusive to boosted rates
and clustered in the first chunks. It cannot be removed, only made less disruptive.

**Update: on the Android/WebUSB backend it *is* removed.** `SET_BAUD_RATE` goes to the open handle,
the read loop never stops, and DTR/RTS are never re-driven — the app does exactly what the reference
does. That makes 38400 free to re-test there. It is **not** a prediction that 38400 will now work:
the FINAL section below rules out this transition along with everything else host-side, and attributes
the residue to the physical line. Re-test it because it is cheap, not because it is expected.

**Not forced: we never touched DTR/RTS.** The reference explicitly de-asserts both
(`DtrEnable = false; RtsEnable = false`). We left them at whatever Chromium's `open()` leaves, on every
open *and* every reopen — so the close/open cycle above was also moving two control lines that, on some
K+DCAN cables, gate the K-line transceiver. Now `deassertControlLines()` sets them explicitly after
both `open()` and `reopen()`, so crossing a baud switch no longer changes them. Best-effort: a cable
that rejects `setSignals` must not fail the connection.

**And a 0x91 ACK is now verified rather than trusted.** A positive response means the DME agreed to
switch; it is not evidence that both ends landed on the same rate. Nothing checked, so a switch that
did not hold was discovered 2% into a 538-chunk read, as a failure, having thrown the read away. One
keep-alive (two attempts, ~300 ms) now settles it immediately, and on silence the link drops back to
9600 and reads there. If the cause is "we moved and the DME did not", that recovers completely — the
user gets a finished read instead of nothing, and `switchOutcome` records
`accepted, then the link went silent — fell back to 9600`.

**Both were then tested on the car, and neither rescues 38400.** 9600 completed in 123.2 s with the
control lines de-asserted — identical to the 122.9 s baseline, so the change is safe and free. 38400
reported `switchOutcome: accepted`, passed the liveness probe, ran at a measured 35.9 ms against a
theoretical 36.1 — and died at chunk 4. The probe worked exactly as designed and correctly said the
link was alive, because it was; it is insurance against a switch that never held, not a cure for one
that holds and then fails.

### FINAL: 9600, ~123 s, and the remaining lever is not software

> **Superseded in its last clause on 2026-08-15.** Everything below about the 0x91 switch *sent from
> an ordinary read* still holds, and 9600 is still the floor for one. A lever was found, and it is
> software — it is just not a baud rate. See **"REOPENED AND ANSWERED"** at the end of this section.

Six 38400 attempts died at chunks **0, 1, 4, 7, 9, 17** of 538. That is not a specific breaking point;
it is a roughly 14%-per-chunk failure rate, under which surviving 538 chunks has probability ~0. The
link genuinely runs at 38400 and then the ECU stops answering — zero bytes, never a corrupted frame.

Ruled out, each by measurement rather than argument: the FTDI latency timer (135 → 14 wakeups per
chunk changed nothing, and 16 ms was 5.7% *slower*), inter-telegram gap (0/5/10/20/40 ms moved neither
turnaround nor survival), the receive buffer, DTR/RTS, host-side overhead (`parked/total` 99.9%,
`write` 0.10 ms), read chunk size (the DME publishes a 132-byte maximum, so 122 → 128 is worth 1.3%),
and every intermediate baud (0xB0 PARAMETER_ERROR — the ECU implements only 9600/38400/125000).

The per-chunk budget at 9600 is ~141.7 ms of wire against a theoretical 144.4, plus ~40 ms of settled
DME turnaround (~110 ms during the first few chunks, at either rate). **This app is about 1% of it.**

What remains is physical: §12 documents real breaks and exclusively-1→0 bit corruption on this car *at
9600*. A link already marginal at 9600 has no headroom at four times the rate. The checklist there —
engine-off vs running, connector, ground, a different cable — is the only thing left that could change
the answer, and none of it is code.

**The one measurement that collapses the 38400 question** is already in our own error text: the latched
`pumpError.name`, printed by `readExact` as `Serial read failed: <name> (<message>)`.

- `BufferOverrunError` → the Mojo pipe ran dry of room; the `bufferSize` fix above should end it
- `ParityError` / `FramingError` → physical layer (K-line rise time, §12); retry patience and a smaller
  chunk are mitigations, not cures
- `Timed out waiting for N byte(s) (received M)` with no latched error → the DME stopped answering;
  transport is exonerated, look at the 0x91 switch and the session state instead

### CLOSED AGAIN (2026-08-13, Android/WebUSB + block-size sweep): 38400 is finished

The two loose ends §9 left open have both been run on the car, and both are negative.

**The port transition was not the cause.** §9's "two things only this app has to do" argued that Web
Serial's forced `close()`/`open()` on a baud change is a disturbance no other DS2 tool produces, and
that it could not be removed. On the Android/WebUSB backend it *is* removed — `SET_BAUD_RATE` goes to
the open handle, the read loop never stops, DTR/RTS are never re-driven. **38400 dies there
identically.** That retires the last host-side suspect.

**Block size does not rescue it either.** karter16's build journal reports 38400 working outside
programming mode *"provided the block size wasn't too big"*, and every attempt to that point had been
at 122. Swept across the reference's own `{122, 96, 64, 32}`:

| attempts | died at exchange (of 538) |
|---|---|
| desktop Web Serial, 122 | 0, 1, 4, 7, 9, 17 |
| Android WebUSB, 122–32 | 0, 0, 0, 1, 3, 5, 6, 15, 22, 23, 116 |

Every one of them `Timed out waiting for 2 byte(s) (received 0)` after all five retries — the DME
stops answering, never a corrupted frame — and **the death position does not track the block size**.
The best run (116 exchanges, 21.6%) was at 122, the largest. Per-exchange median at 38400 was 159 ms
against 9600's 209 ms, so the wire really was faster; it simply never survived.

karter16's own verdict on the same experiment: it "wasn't stable enough to make an actual feature".
Agreed, measured, and closed. The BLK selector has been removed — a knob proven to change nothing
costs a trip to the vehicle every time someone wonders. The constructor option and the finding stay
in `DS2_READ_BLOCK_SIZES`.

**And 125000 was never reachable from a read.** From the same journal: the DME only accepts it
*"when the DME is in programming mode"*, and *"the bootloader lacks mechanisms for entering
programming mode via DS2 except through valid flash wipe commands"*. Every `TrySwitchToProgrammingBaudAsync`
in the reference is inside a programming session for exactly that reason. Asking for it from the READ
selector was structurally wrong, not badly timed — no settle would ever have helped.

**So the read is finished at 9600/122, ~126 s on Android and ~123 s on desktop, and the remaining
speed work is entirely on the write path** — where the erase puts the DME in programming mode as a
side effect of what the operation already does.

### Instrumentation (2026-07-29)

Rather than keep guessing at the 75 ms, `transferTiming.ts` decomposes it per chunk, behind a **DIAG**
toggle next to PRACTICE, off by default. It splits: time inside `write()`, echo latency, **DME
turnaround** (last echo byte → first response byte), response wire time against theory, parked vs
draining time, and **rx events per chunk** — how many times the serial stack woke us. Medians, not
means, because one retried chunk carries 300–1600 ms of deliberate settle. The notice line gains a
short numeric tail; a TIMING button saves the full report, including sampled byte-arrival gaps, as
JSON.

**rx events per chunk is the decisive number.** ~135 means per-byte-arrival cost is real and the
latency timer is the lever. ~10 means that hypothesis is dead and the residual is per-exchange or
DME-side. And if **turnaround** dominates, the residual is the ECU thinking — the reference pays it
identically and no host-side change here can recover it.

The instrument is built not to measure itself: preallocated `Float64Array` lanes sized once, no
allocation or string formatting during the transfer, one boolean compare on the disabled path, and
collection armed only between a read's start and end so it is inert on the flash-write path.

### Out of scope, and why

- **WebUSB + the FTDI vendor protocol — rejected on Windows, adopted on Android.** Technically the
  closest thing to a D2XX equivalent a browser can reach: the vendor requests for baud divisor, line
  properties and `SET_LATENCY_TIMER` are all documented and there are (unmaintained) JS
  implementations. On **Windows the rejection stands, unchanged**: Chromium claims USB devices there
  through **WinUSB**, an FTDI cable is bound to `ftdibus.sys`, and rebinding it with Zadig **removes
  the COM port**, which breaks INPA / Tool32 / ISTA until it is swapped back. The cable has to keep
  working for everything else, so desktop keeps Web Serial.

  **None of that reasoning reaches Android**, and that is where it now runs (`webUsbFtdiTransport.ts`).
  There is no `ftdibus.sys` to displace, no COM port to lose, and no INPA/Tool32/ISTA sharing the
  cable. It is also not a preference there but the only option: **Chrome for Android 138+ does expose
  `navigator.serial`, but it enumerates only Bluetooth RFCOMM serial-port emulation** — a USB K+DCAN
  cable never appears in its picker, so Web Serial is present and useless. See §14.
- **A local native helper** (WebSocket or native-messaging bridge to `ftd2xx.dll`). The only path to
  true D2XX parity. Costs a signed installer, per-OS builds, a firewall prompt, and localhost TLS —
  and FTDI's guidance is that VCP and D2XX cannot be used on one device simultaneously, which would
  need confirming first. Recorded as the fallback; not planned.
- **125000 baud.** Not a rate to probe. In the reference it is reachable *only* after a "fast entry"
  procedure that reads, backs up, and then **erases flash 0x4000–0x5FFF on both processors**, restores
  the live spans, and verifies — before the 0x91 switch is even sent (`ReadService.TryEnterFastReadModeAsync`).
  Sending the switch from a plain diagnostic session, as we do, is not the same operation.
- **A Worker for the read pump — deferred, not rejected.** `navigator.serial` *is* exposed to
  DedicatedWorker (Chrome 89+, `getPorts()` available; only `requestPort()` is Window-only), so this is
  buildable. Two constraints if it is ever done: move the **whole link**, not just the transport (one
  exchange is 1 write + 3 `readExact`, so a remote transport puts main-thread jank back into the
  per-chunk critical path), and do **not** transfer `port.readable` — transferred streams clone every
  chunk through a MessagePort, which is strictly worse than today. Gated on the measurement: worth its
  price only if host overhead is still large after the latency timer is optimal.

### REOPENED AND ANSWERED (2026-08-15): the lever was a programming session, not a baud rate

Every measurement above asks the same question — *can this read go faster at this rate* — and the
answer stayed no. The question was too narrow. **The DME accepts 0x91 only from inside a programming
session, and a programming session is opened by an erase.** A read erases nothing, so an ordinary
read can never be in the state where 125000 is available. That is why 125000 "ACKs and then times
out" (§9 above): the ACK is the parameter being accepted, and the silence is the DME never having
been in the mode that implements it.

So the read makes a session of its own. `enterFastReadMode` erases the **Free Identifiers** sector —
the one sector whose contents this app can reconstruct — restores it immediately, verifies the
restore **byte for byte**, and only then asks for 125000.

    9600, plain read       122.9 s
    FAST READ              15-30 s

**The ordering is the whole safety argument**, and it is the opposite of the write path's:

1. *Reversible* — build the plan, live-read every span, check the prep marker. A failure here is
   recorded and the read continues at 9600; not one byte has changed.
2. *Destructive* — recycle-only, erase master, erase slave, restore every span, verify every span.
3. *Free* — recycle-off, finalize, then 0x91. **By the time the switch is attempted the sector is
   back and proven back**, so a refused or silent switch costs the read and nothing else. The write
   path sends its switch with the data area erased; this one sends it with nothing outstanding,
   which is why it is the safer of the two despite erasing more.

The seed supplies **addresses only**. The bytes written back are re-read live seconds before the
erase, so a stale map can only make the plan preserve too much — never write yesterday's identity
over today's.

**The first read on a DME takes its own backup (2026-08-31).** Arming used to be a procedure: open
the FLASH dialog, inspect, take a backup, and FAST READ arms on the *next* connect. Nothing in that
was a decision — there is no reason to decline a recovery artefact — and a step nobody is told about
is a step nobody performs. `useDmeLink.read` now reads the 16 KB itself when no seed exists (~31 s,
read-only, no erase), stores it, and arms in the same session:

    31 s backup + 15-30 s read  =  ~45-60 s   against 122.9 s for a plain read

So even the first read is faster, and a DME that has been read once has the image
`restoreServiceBlock` recovers from without anyone having had to remember to make one. Skipped in
PRACTICE, and on any transport that cannot change baud on the open handle — there the 31 s would arm
nothing.

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

- **Speed**: everything at 9600. Read ~124 s measured; write ~2½ min with QUICK verification, ~4½
  with FULL (the read-back is 122.9 s of it). The read side is at the DME's floor and closed — see
  §9. The write side's own floor is **not yet measured**: the instrument now covers it (§15) but no
  vehicle run has produced a write report, so the per-chunk flash programming time — the part a baud
  boost could never recover — is still the ~110 ms/chunk back-derived from a README sentence.
- **STFT cross-check**: `la_f_regler` vs Testo *Lambdaintegrator* not validated (§8).
- **Write baud**: write is always 9600. The reference boosts to 125000 **inside the programming
  session, immediately after the erase** (`TuneWriteExecutor.cs:67`, best-effort — it continues at
  9600 if the switch is refused). **This is now the only remaining speed lever anywhere in the app**,
  the read having been closed at 9600 (see §9's 2026-08-13 entry). karter16's journal confirms both
  halves of why: the DME accepts 125000 only *"when the DME is in programming mode"*, and the
  bootloader offers no way in *"except through valid flash wipe commands"* — which the tune write
  performs anyway. Still not attempted here, and the reason to be careful is unchanged: the switch
  can only be sent at the moment failure is most expensive, i.e. on an already-erased ECU.
  **The payoff is now measured rather than guessed. The DME programs a chunk in 32 ms and the
  request takes 150 ms on the wire, so a write telegram is 78% wire and a boost is worth roughly
  4× — not the 2.2× estimated while the programming time was assumed to be ~110 ms** (§15).
  One arithmetic caveat to carry into it: `SIM_SYNCR = 0xD700` puts the DME's SCI at
  `f_sys/(32×SCBR)`, where 125000 is not exactly representable, so host and ECU may sit ~4.9% apart
  even when the switch is accepted. `requestWire` against `theoreticalRequestWire` is the check that
  says whether the request really moved.
- **The datalog's per-exchange constants are one drive from being settled.** `kind: 'log'` is armed
  by both run kinds now and the report carries a per-exchange-kind breakdown (`byExchange`), so one
  drive says what block 3, block 19 and a RAM read each really cost instead of one median over all
  three. `DME_TURNAROUND_MS` states two constants — 83 ms for a block read, 35 ms for a RAM read —
  and the second is from traces rather than from a summary. Until that drive, the model is expected
  to sit above the measured rate and the gap is the transport's; see §8.
- **Chromium only**: Chrome/Edge/Opera on desktop (Web Serial), Chrome on Android (WebUSB, §14). The
  file-upload workflow remains the fallback for every other browser and must keep working.
- **The Android backend's WRITE path is proven** (2026-08-09), from the head unit on the car: the
  full erase → write → verify cycle completed over WebUSB. That was the last transport-level path
  carrying no hardware evidence, so reading, live logging and writing are now all measured on the
  vehicle over both backends. Still untested on this path: break recovery, the `SIO_RESET` flush
  polarity, backgrounding/endurance across a long write, and 38400 — `/usb-check` is the bench probe
  for those, and none of them is on the happy path that has now run.
- **IndexedDB is best-effort storage** — the browser can evict it. File download remains the durable
  artifact.
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

---

## 13. Flash counter (read + reset)

Ported from the reference `DmeFlashCounter.cs` and `ClearFlashCounterExecutor.cs`. Pure logic lives
in `src/lib/dme-link/flashCounter.ts`; the DS2 work is in `webSerialDmeLink.ts`.

### Where it lives

**Not** in the identity response. It is a 256-byte run of 2-byte big-endian markers at offset `0x800`
inside the 8 KB **Free Identifiers (service info) block** — the same block that holds AIF, ZIF and the
VIN records. Addresses follow `Ds2ProgrammingSubsegment.CreateAddress` = `(nibble << 20) | offset`,
where FreeIdentifiers is nibble `0` and the slave processor adds `8`:

| Item | DS2 address | Length |
|---|---|---|
| Master service block | `0x000000` | 8192 |
| Slave service block | `0x800000` | 8192 |
| Master counter | `0x000800` | 256 |
| Slave counter | `0x800800` | 256 |
| Clear-prep marker (both) | block base `+0x900` | 4 |

Limit is **30 slots per processor**. Reading is an ordinary `0x06` memory read (segment `0`), done at
connect alongside VIN/AIF/SW — six chunk reads, ~1.5 s at 9600. A failure leaves
`DmeIdentity.flashCounter` **null**, which is a different fact from `0/30` and is rendered as `-`.

### Decoding

Walk 2-byte markers until one isn't `0x0000`; everything before it is a consumed slot.

```
i = 0
do { marker = (data[i] << 8) | data[i+1]; i += 2 } while (marker === 0 && i < 254)
i -= 2
used = trunc(i / 4)
```

Two porting traps:

- It is a **do/while**. A region whose first marker is already non-zero still advances `i` and backs
  it out, landing on 0 used. A `while` loop changes that.
- `i` steps by 2 but a slot is 4 bytes, so `i / 4` is not always an integer. C# integer division
  truncates; JS does not. **`Math.trunc` is required** or a field caught mid-programming reports a
  fractional count.

Marker meanings: `0xFFFF` available · `0x00FF` data programming active · `0xFF00` program programming
active · anything else full/unknown.

### What a real service block actually contains (2026-07-28)

Measured on a real vehicle with the read-only inspector, and worth recording because guessing at it
caused a chain of wrong decisions:

```
AIF 0x001D50 -> lies in: master     DIF 0x203FB8   BRIF 0x103FD2
ZIF 0x531B90                        ZIF backup 0x401E00

Master @ 0x000000, 8192 B   0xFF 98.1%   distinct 32   counter 15/30, marker 0xFFFF
Slave  @ 0x800000, 8192 B   0xFF 99.3%   distinct  2   counter 15/30, marker 0xFFFF
AIF: 2 of 14 slots populated, VIN and software number decode cleanly
```

Three things follow:

1. **Both addresses are right.** The master image yields a real VIN and software number, and the
   slave counter reads the same 15/30 as the master — two independent confirmations.
2. **The slave block normally holds nothing but the flash counter.** Two distinct byte values across
   8 KB: `0xFF` everywhere and `0x00` in the consumed counter markers. *Every* identity pointer
   resolves into master space.
3. A near-empty slave block is therefore **normal**, not damage.

**The old guard was wrong and blocked every healthy DME.** It asked "is everything outside the counter
erased?" of both blocks and refused on yes — which is precisely what a normal slave block looks like.
On the car it fired, and that firing was then misread as evidence the *address* was wrong, which is
why the whole feature was disabled for a day. Both conclusions were mistaken.

`hasIntactAif()` replaces it: check, only where the DME's own pointer says the AIF lives, that at
least one record is present. That is the thing the rewrite has to carry forward, so it is the thing
worth verifying — and it says nothing about how sparse the rest of the block is.

One genuine defect was found alongside it and is fixed: **the restore offered a PRACTICE backup to a
real car.** Both modes wrote to one store and the recovery list was unfiltered, so a `MOCKVIN…` record
appeared as the recovery source for a real ECU. Backups now record their origin, and
`listRestorableBackups(vin, mock)` returns only records whose VIN *and* origin match the connected
DME; the restore re-checks both immediately before writing.

### Read-only inspection

`readServiceBlocks()` + `buildServiceBlockReport()` dump both blocks and report the pointers, the
0xFF ratio, the distinct byte count, the raw counter head, and the parsed AIF slots. It writes
nothing. `aifLocation` is the load-bearing line: it distinguishes "the read is not landing", "the
records really are gone", and "this block is empty by design" — three situations that had been
collapsed into one assumption. Reachable from the FLASH dialog in every resting phase.

### Reset

**A cleared counter reads `1/30`, not `0/30`.** The reset image fills the 256 bytes with `0xFF` and
then zeroes the first 4: `0x0000` is the "consumed, keep looking" sentinel the scan walks over, so a
field of pure `0xFF` would leave no sentinel at all. 1/30 used, 29 remaining is the correct outcome.

The counter cannot be written in place (flash only goes 1→0 without an erase), so the whole service
block on **both** processors is read, rebuilt, erased and written back:

| # | Step | Control | Seg | Address | Notes |
|---|---|---|---|---|---|
| 0 | Read both blocks | `0x06` | `0` | `0x000000`, `0x800000` | 8192 each → the backup |
| 1 | Prep marker | `0x07` | `2` | base `+0x900` | `4B 31 36 2E` = ASCII `K16.`, only if currently all-`FF`, 30 s timeout |
| 2 | Recycle-only | `0x07` | `14` | `0x424151` (`"BAQ"`) | verify byte not required |
| 3 | Erase | `0x07` | `6` | `0x000000` | **one erase covers both processors**, 65 s |
| 4 | Write | `0x07` | `2` | `0x000000` → `0x800000` | 122-byte chunks, all-`FF` chunks skipped |
| 5 | Recycle-off | `0x07` | `14` | `0x424152` (`"BAR"`) | verify byte not required |
| 6 | Finalize | `0x07` | `15` | `0` | verify byte required |
| 7 | Verify | `0x06` | `0` | both blocks | byte-for-byte, any mismatch throws |

No separate programming-session entry beyond the seed/key re-login, and **no baud boost** (the
reference switches to 125000; this app's flash path has never done that on real hardware — see §9).
~1.5–2 min end to end at 9600.

> The reference has a **second** marker at the same `+0x900` offset, `50 60 70 33`, belonging to the
> Service Info restore and fast-entry read flows. Same address, different payload, different
> operation. Don't confuse them.

### Gates

| Layer | Condition |
|---|---|
| Control enabled | `dmeLink.state === 'connected'` — this excludes reading/writing/tuning/resetting by construction |
| Dialog | Both boot fields `available`; engine RPM `0` |
| Link | `assertConnected`; **neither service block already erased**; boot-field state re-checked; `onBackup` resolved |
| DME | rejects erase/write with `0xA2` unless RPM/speed are zero |

**The already-erased guard is the one that is not obvious.** If a reset dies between its erase and its
rewrite, the block reads back as all `0xFF` — and the counter alone reports that as a perfectly
healthy `0/30, available` (or `1/30, available` if the first slot got written). Nothing in the boot
field reveals that the AIF, ZIF and VIN records are gone. A second run would therefore take the
erased block as the ECU's "current contents", write it back as the plan, and verify it — turning a
recoverable interruption into a permanent, confirmed loss. `isServiceBlockErased()` tests the bytes
*outside* the counter and refuses, which is what makes "do not retry, restore the backup" true advice
rather than a hope.

Gated on the **link only**, deliberately *not* on `idleAction` like RESET ADAPT. The two look similar
and are not: clearing adaptations is about the log you are about to record, so it belongs to the
moment before START TUNE. The flash counter is about the DME's remaining programming life, and what
consumes it is WRITE — the same gate would hide it at `idleAction` `'write'` and `'writePatch'`, and
straight after CONNECTION, which are exactly the moments it matters.

### UI

**The header's FLASH field *is* the control** — clicking it opens the reset dialog. There is no
button for it in the hub's sub-action row: that row is for the workspace and the current run (discard
this log, clear what the DME learned before recording), while the counter is a property of the ECU
the header already states. Putting the reset on the number it changes leaves exactly one place to
look.

The field shows **one** number, not master and slave separately: a flash consumes a slot on both
processors together. The pair is still read and compared rather than assumed — the erase is a single
command but the two writes are separate, so a write that succeeds on master and fails on slave leaves
them permanently apart — and the display falls back to `master · slave/30` only when they actually
differ. Per-processor detail (used, left, marker, address) is on the tooltip.

### Backup is mandatory, and is not a file

`resetFlashCounter(onBackup, onProgress, boost?)` awaits `onBackup` with the 16384-byte
master+slave image **before any erase**, and does not catch its rejection. If the save fails, nothing is erased. That
block carries the VIN, AIF and ZIF, so it is the only recovery path if the rewrite is interrupted.

It is stored in a separate IndexedDB database (`mss54hp-tuner-backups`, store `serviceBlocks`, keyed
by timestamp) — separate because adding a store to the session DB would need a `DB_VERSION` bump,
which destroys every saved session, and because a reset can happen with no session open at all.

**The same store is what arms FAST READ**, and since 2026-08-31 the first bulk read fills it by
itself — see §9's *REOPENED AND ANSWERED*. So a DME that has been read once already has this
recovery image before anyone opens this dialog. That is a side effect of a speed-up, and it is the
more valuable half of it.

**It does not trigger a file download.** In this app, writing to the DME and producing a file are
separate, separately-chosen actions: WRITE never emits a file, and every download hangs off a control
that names what it exports (DOWNLOAD TUNED, the per-artifact buttons in the session list). A save
dialog appearing out of a vehicle write violates that, so the backup is silent.

### Recovering an interrupted reset

`restoreServiceBlock(pair, onProgress)` writes a saved backup back. It shares
`programServiceBlocks()` with the reset — same erase, same chunked write, same verifying read-back —
so the recovery path cannot drift from the path that caused the damage. What it drops is every guard
the reset has: no read first (the current contents *are* the damage), no backup (nothing left worth
saving), and no erased-block refusal (an erased block is the case it exists for). Whether the prep
markers need writing is read from the DME rather than inferred from the saved image, because those
two answers differ by definition here — the backup predates the erase that cleared them.

The flow reaches the user like this: the reset refuses, attaching `ServiceBlockErasedCause` to the
`DmeLinkError`; `useDmeLink.resetFlashCounter` returns `{ok: false, needsRecovery: true}`; the dialog
switches to a recovery phase that lists saved backups and offers **復旧を実行 / Recover** — and
offers no Retry at all, since retrying is the one action that makes the loss permanent.

> `needsRecovery` is returned from the call, deliberately **not** read off the `errorKind` prop. The
> dialog resumes from its `await` before React has re-rendered with the new prop value, so the prop
> is still the previous one at that moment. This was a real bug caught in testing: the dialog landed
> in the generic failure phase and offered Retry — precisely the wrong button.

`MockDmeLink.simulateInterruptedReset()` arms a one-shot failure just after the simulated erase, so
the whole loop can be rehearsed offline. Nothing in the UI calls it; it exists for tests.

### BOOST — its own flag, deliberately not the write path's (2026-08-31)

`resetFlashCounter` takes `boost` **per call**. Ticked, the 16 KB rewrite goes at 125000 instead of
9600, roughly four times faster; the two reads either side of it stay at 9600. The tick lives on the
reset's own confirmation screen, under the warnings and above the buttons.

It is **not** `this.writeBaud`, and that is the substance rather than the checkbox. The two switches
look like one decision and are not:

| | what is erased when the switch fails | a copy in hand |
|---|---|---|
| counter reset | the **service block** | **yes** — its 16 KB went to `onBackup` seconds earlier |
| data write | the **data area** | no |

Sharing one field would let a tick made on the recoverable path still be armed at the next flash on
the other one. `programServiceBlocks` still refuses a transport that cannot change rate in place, so
a tick that cannot be honoured costs the speed and nothing else. The RESTORE that shares that same
sequence passes 9600 unconditionally: it is the recovery for a block that is already damaged, and
the one path that has to work is not where an experiment belongs.

### After a reset

The connection is dropped and the user is told to key OFF → wait 10 s → key ON → reconnect, mirroring
the post-write teardown. The DME must re-initialise from the rewritten service block before anything
else is asked of it.

`MockDmeLink` models the counter as state (12/30 per processor, reset to 1/30) so PRACTICE rehearses
it faithfully — and answers `readEngineRpm()` with `0`, since a simulator has no engine. That method
is separate from `pollLiveMeasurement` on purpose: the mock's ~800 rpm idle is telemetry-shaped test
data for the datalog to plot, not a claim that something is turning, and one method could not
honestly serve both questions.

---

## 14. Android — WebUSB and the FTDI vendor protocol

**Status (2026-07-31): the read path is proven on the car. The write path is not.** See
§"What the vehicle run established" below for exactly which parts are now measured and which are
still untested.

### Why WebUSB and not Web Serial

Chrome for Android 138+ *does* expose `navigator.serial`. It is useless here: it enumerates only
**Bluetooth RFCOMM serial-port emulation**, so a USB K+DCAN cable never appears in its picker. There
is no feature test that distinguishes the two — the objects are identical and the difference shows
up as an empty chooser after the user has already tapped through a permission prompt. That is why
`detectTransportKind()` (`byteTransport.ts`) asks the platform by name, the only place in the app
that does. `?transport=webusb` / `?transport=webserial` overrides it, which is how the WebUSB path
can be driven from a desktop bench rig instead of first-run in a car.

The Windows objection in §"Out of scope" is untouched and still governs desktop.

### Structure

`WebSerialTransport` and `WebUsbFtdiTransport` both implement `ByteTransport` and both extend
`BufferedByteTransport`, which owns the receive buffer, the single parked waiter and `readExact` —
lifted verbatim out of the Web Serial transport rather than copied, because those semantics are the
subtlest thing in this layer and a second copy would drift. `WebSerialDmeLink` holds a
`ByteTransport`; all 21 of its transport calls are unchanged, and the DS2 layer knows nothing about
which backend it has.

### The constants, and why each is what it is

| Thing | Value | Why |
|---|---|---|
| `SET_DATA` | `0x0208` | 8E1. Same load-bearing reason as the Web Serial `parity: 'even'`: DS2's address `0x12` and ACK `0xA0` both have popcount 2, so an 8N1 receiver faults on effectively every frame. |
| `SET_MODEM_CTRL` | `0x0300` | DTR and RTS both de-asserted (mask bits 8/9 set, state bits 0/1 clear). Equivalent to `setSignals({dataTerminalReady:false, requestToSend:false})`. On some K+DCAN cables these gate the K-line transceiver, so inverted polarity = a cable that works on desktop and is silent on the phone. |
| `SET_BAUD_RATE` | 9600 → `0x4138`, 38400 → `0xC04E`, 125000 → `0x0018` (index 0) | 3 MHz base, integer divisor plus a 3-bit fractional code: `d8 = 24e6/baud`, `frac = [0,3,2,4,1,5,6,7][d8 & 7]`, `encoded = (d8>>3) | (frac<<14)`. All three are exact — zero baud error. `0x4138` and `0xC04E` match FTDI's published AN232B-05 table, which is the independent check on the derivation. |
| `SET_LATENCY_TIMER` | 16 | The chip default, stated rather than inherited (Android has no Device Manager to inherit from). **Not lowered** — see the correction in §"The FTDI latency timer". |
| `SIO_RESET` purge RX | 2 | libftdi ≤1.4 called this 1; libftdi 1.5 deprecated those names and ships `ftdi_tciflush()` using 2, because the old naming had RX and TX swapped. `/usb-check` step 6 tests both values empirically. |

A **three-entry lookup table, not a general converter**: `DS2_SELECTABLE_BAUDS` is exactly these
three and §9 records why it will not grow. Three audited constants cannot be subtly wrong. The table
is **recomputed and asserted at module load**, the same convention `ds2.ts` uses for its chunk sizes
— with no test runner in this project that is the only mechanism that can fail a wrong constant in
every environment, including production. A wrong divisor here is a garbled write to an ECU.

Chip family is gated on `deviceVersionMajor ∈ {2,4,6}` (FT232AM/BM/R). The H parts and FT-X use a
12 MHz base and a different index packing, so they are refused by name rather than silently
mis-clocked.

### The 2-byte status header — the part most likely to go wrong quietly

Every bulk IN **packet** (not every transfer) is prefixed with two bytes: modem status, then a 16550
line status. With a multi-packet transfer those headers are **interior**, not merely at offset 0.
Stripping only the leading pair yields a plausible-looking 64 KB BIN with two bytes of garbage every
64 — a failure that does not announce itself, which is why the acceptance test is a byte-comparison
against a desktop read of the same ECU rather than "it looked right".

Line-status bits map onto the **error names Web Serial produces**, because `readExact` prints the
name and §12's triage table is written against those spellings: BI → `BreakError`, FE →
`FramingError`, PE → `ParityError`, OE → `BufferOverrunError`, device gone → `NetworkError`.
Priority BI > FE > PE > OE, since a break implies the framing garbage around it. LSR bits are
latched-since-last-read, so line status is ignored on exactly one packet after open/reopen/recover —
otherwise recovery immediately re-latches the fault it just repaired.

### What is better here than on Web Serial

- **Baud changes in place.** One `SET_BAUD_RATE`, no close/open, no restarted pump, no control-line
  movement. This is the "forced" structural difference §9 says cannot be removed.
- **`purge()` reaches the chip.** It flushes the FTDI's own FIFO, not just the bytes already handed
  to us. It stays synchronous (fire-and-forget flush) because `resyncTransport` does not await it
  and `drainUntilQuiet` reads `bufferedLength()` immediately after.
- **Stopping the pump needs no cancellation.** The status heartbeat resolves the pending
  `transferIn` within one latency period, so clearing a flag is enough.

### What is worse, and it is a real hazard

With Web Serial the **browser process** drains the endpoint into a 4096-byte mojo pipe independently
of the renderer. With WebUSB **our read loop is the only thing draining the FT232R's 256-byte RX
FIFO, on the same thread as React.** At 9600 that is ~267 ms of headroom; a long main-thread stall
overruns the chip. The mitigation is that it is *detected* — it arrives as OE, latches a
`BufferOverrunError`, and the existing retry machinery handles it — rather than silently corrupting
a read. Exactly one transfer is kept in flight; queueing several is the usual throughput trick and
they almost certainly complete in order, but "almost certainly" reorders a flash payload.

### Long writes on a phone

`beforeunload` is honoured inconsistently on Chrome for Android, so `useUnloadGuard` is weaker there
and there is no stronger API to reach for. The gap is covered from three sides instead:
`useScreenWakeLock` removes the interruption that happens by itself (screen inactivity), 
`useHiddenWitness` records a backgrounding so a failure can name it instead of looking like a cable
fault, and `writeConfirm` states the extra rules on Android before the write starts.

### Verifying it

`/usb-check` is a standalone bench probe (it imports nothing from the link layer, so it cannot break
or be broken by what it validates). Use a **bare FT232R breakout with TX–RX jumpered** — a K+DCAN
cable will not self-echo on a desk, because its K-line pull-up comes from the vehicle on OBD pin 16.

1. Choose + identify — VID/PID and `bcdDevice` (clone chips are common; §12 already says to check).
2. **Open + `claimInterface`. This is the question that gates the whole project**: if Android's
   `ftdi_sio` holds the interface and Chrome cannot detach it, none of the rest matters.
3. Vendor requests both directions (`GET_LATENCY_TIMER` reads back what was set).
4. Loopback at all three rates — byte-exactness plus elapsed time against theory, which is what
   catches a wrong divisor.
5. TX break (`SET_DATA` bit 14) → the BI bit. The only bench-reachable exercise of break recovery.
6. RX flush polarity, 2 vs 1, measured rather than assumed.
7. Five-minute endurance with the screen on / off / app-switched / wake-locked — the empirical
   answer to "does Android freeze the tab mid-flash".

Then, on the car and in this order: identify at 9600 → a full 64 KB read → a datalog → and only then
a write. 38400 is free to re-test once reading is proven, but see §9: the residual there was
attributed to the physical line, not to the port transition this removes.

**On the acceptance test for the read, which turned out to have a better form than planned.** The
plan was to byte-compare an Android read against a desktop Web Serial read of the same ECU. Do that
if you like, but it is the weaker test and it is not what was used: **run `analyzeDataChecksum()` on
the image instead**. Comparing two reads can only show that they agree — a systematic transport
error would corrupt both identically and still compare equal. The MSS54HP data checksums are
independent of any read: they are CRC-16/ARC values the ECU itself stored in flash, and between them
the two slots cover **65528 of the image's 65536 bytes**. The remaining 8 bytes *are* the two
checksum slots (`0x3FFC-0x3FFF`, `0xBFFC-0xBFFF`), which the match itself verifies. So a valid pair
of checksums verifies the entire image against an external authority, and the two-bytes-every-64
failure mode this design most feared cannot survive it.

### What the vehicle run established (2026-07-31)

Chrome for Android, USB OTG, genuine FTDI K+DCAN, engine-off on a real E46 M3:

| | Result |
|---|---|
| `claimInterface` | **Passed.** Android's `ftdi_sio` did not hold the device; the gating unknown is answered. |
| 64 KB read at 9600 | **126.5 s / 518 B/s** — against the desktop's measured ~123 s / 530 B/s, i.e. **2.8% slower**. The transport costs essentially nothing. |
| Image integrity | **Both data checksums valid**: slave `0x5E62`, master `0xA650`, both with `FFFF` padding. Whole-image verification, per above. |
| Identity | VIN / AIF / software version parsed; session created. |
| Live polling / datalog | 544 samples captured, `logFinished` reached. |
| Reconnect after key cycle | Succeeded; WRITE armed. |
| Mobile UI | Usable in landscape — dialogs, header and tab strip all reachable. |

The valid checksums retire four of the risks §14 was written around, without needing the bench
probe: the **9600 divisor `0x4138`** is right (elapsed time matches theory), **`SET_DATA = 0x0208`**
(8E1) is right (an 8N1 receiver would fault on nearly every frame), **`SET_MODEM_CTRL = 0x0300`** has
the correct polarity (wrong, and the K-line transceiver never enables — no bytes at all), and the
**status-header stripping is correct at interior packet boundaries**.

Still untested, and listed in §11: the write path, break recovery, the flush polarity, backgrounding
endurance, and 38400.

---

## 15. Diagnostics — measuring the write, and getting the numbers off the phone (2026-08-11)

### The instrument now covers all three operations

`transferTiming.ts` was armed only by `readPartialBinInner`, so §9's whole investigation looked at
the bulk read and nothing else. Two operations were invisible, and both have levers the read does
not:

- **write** — a flash telegram's turnaround is the DME *programming cells*, not the DME *thinking*.
  That single number decides how much a baud boost could ever be worth on the write path, and until
  now it had only been back-derived from a README sentence (~110 ms/chunk, never measured).
- **log** — the live poll is the one path with real host-side work in it.

`TransferTimingReport` therefore carries a **`kind`** (`read` | `write` | `log`) and an explicit
**`responseBytes`**, because the theoretical wire time is computed differently per operation: a read
response carries the chunk (`chunkSize + 4`), a **write acknowledgement is a fixed 10 bytes** however
much was written. Deriving it from `chunkSize` for all three would have produced a plausible number
that quietly makes a healthy link look broken.

A new lane, **`hostGap`** (previous exchange end → next exchange start), is us and nothing else. ~0
on a bulk read. On the datalog it is where `flushLiveSamples` lands — a full `processLogData` plus a
full VE recalculation, synchronous, inside the sample callback and O(n) in run length — and on
Android that is not merely slow: our read loop is the only thing draining the FT232R's 256-byte FIFO
(§14), which gives ~267 ms of headroom at 9600 before an overrun.

**The write window is armed for the write telegrams only.** Not the erase (one exchange whose
turnaround is a flash sector erase, seconds long) and not the read-back (turnaround ~40 ms, the DME
thinking). All three in one median would blend three different physical quantities into the one
number the measurement exists to isolate. The erase is timed separately, by a plain stopwatch.

### What the first real write measured, and what it broke (2026-08-14)

Two writes on the car, both clean, 0 retries, and the number the whole baud question was waiting on:

| | verify | erase | write telegrams | verification | total |
|---|---|---|---|---|---|
| #1 | FULL | 1150 ms | 330 in 65.7 s | read-back **102.9 s** matched, checksum clean | ~170 s |
| #2 | QUICK | 1134 ms | 330 in 66.2 s | checksum clean | **~68 s** |

330, not 538: 39% of chunks were all-`0xFF` and skipped. The read-back is 103 s rather than the
standalone read's 126 s because it starts on a DME already warmed by 330 telegrams — the same
warm-up §9 documents, seen from the other side.

**`median.turnaround` = 32.0 ms.** That is the DME's per-chunk flash programming time, measured for
the first time; §11 had been carrying ~110 ms back-derived from a README sentence. The per-telegram
budget at 9600 reconciles exactly:

```
request  131 B x 1.1458 = 150.1 ms   78%
program  (DME)          =  32.0 ms   17%
response  10 B          =  11.5 ms    6%
                          -------
                           193.6 ms  (measured median 192.7 / 203.0)
```

**So the write is wire-bound, not programming-bound, and the earlier estimate that a boost would cap
around 2.2x is withdrawn.** At 125000 the same exchange is 11.5 + 32 + 0.9 = 44.4 ms, so 330
telegrams fall from 65.7 s to ~14.7 s and a QUICK write goes from ~68 s to roughly 17 s — about 4x.

**Round-trip byte-exactness, proven independently of the read-back.** Write #1 (patch OFF) sent
`cab93360…`; the standalone READ between the two writes returned a BASE whose sha256 is `cab93360…`;
write #2 (patch ON) then sent `07930701…`, which is bit-for-bit the hand-edited BIN that had been
loaded in the first place. The patch is a clean involution and the flash is exact in both
directions. A read-back verify compares against bytes held in the same process; this does not.

#### Three lanes were wrong on the write path, and one was missing

The lanes were modelled on a READ, whose request is 9 bytes and whose `write()` therefore resolves
long before any echo. A write telegram is 131 bytes and takes 150 ms to leave, so:

- **`echoLatency` reported −56.3 ms.** The first echo byte legitimately arrives before `write()`
  returns. A negative latency is not a small error; the quantity does not exist for that exchange.
  It is **NaN** now, which `JSON.stringify` renders as `null` and D1 stores as NULL.
- **`responseWire` reported 0.0** on one write and 12.7 on the next. A 10-byte acknowledgement
  arrives in a single rx wake, so first and last are the same instant. Also **NaN** now, gated on
  having seen at least two response events — 0.0 read as "the response transferred instantly".
- **`write` reported 71.7 ms**, against ~0.10 ms on a read. That one is *correct*: the transport
  back-pressures on a 131-byte payload. Only its documentation was wrong, which said any non-zero
  value pointed at WICG/serial#123 write-splitting.
- **`requestWire` did not exist.** 78% of a write exchange was invisible. It is first-echo-byte to
  last-echo-byte — our own request on the wire — with `theoreticalRequestWire` beside it, giving the
  write the same lie-detector `responseWire` gives the read. This is the lane to watch when 125000
  is attempted: it says whether the request really went out four times faster.

`median()` now skips NaN rather than sorting it, so one measurable exchange among unmeasurable ones
still produces the right answer. `turnaround` was never affected — it is measured from the last echo
byte and reconciles with the arithmetic above to within a millisecond, which is why the 32 ms stands.

The properties this rests on, stated rather than checked (see the note in §6): a short request keeps
every lane, a long one reports the two structurally-unmeasurable ones as absent, and NaN survives
serialisation as null.

### The 125000 boost on the write path (2026-08-14; run on the car 2026-08-29)

The measurement above is what justifies this: 78% of a write telegram is our own request on the
wire, so the rate is worth about 4x. It is also the most dangerous thing in the app, because the DME
only accepts `0x91` from inside a programming session and the only way into one is the erase. The
switch can therefore be attempted at exactly one moment — the moment the data area is gone.

The ordering in `writePartialBinInner` is what bounds it, and it is asserted on the telegram trace
rather than on the outcome, because "it fell back correctly" is only true if no flash data left at a
rate that had not just answered:

```
erase (9600) -> 0x91 -> keep-alive probe -> [silence?] -> back to 9600 -> first write telegram
```

Four ways out, in order of how much they cost:

1. **Refused** (`0xB0`): the port is never reopened, the write runs at 9600. Costs nothing.
2. **Accepted and alive**: every write telegram goes at 125000, and a `finally` hands the session
   back at 9600.
3. **Accepted then silent**: the probe fails, the link drops to 9600, and **zero** write telegrams
   have been sent. This is the case the harness exists for.
4. **Dead at both rates**: the write stops with the data area erased and throws a message that says
   so, plus the recovery — ignition off, 10 s, on, reconnect, WRITE again. `writePartialBin` always
   restarts from the erase, so re-running it is safe. Not a brick, but not unharmed either, and the
   confirm dialog says exactly that before the erase rather than after.

**Only offered on WebUSB/FTDI**, and the gate is a transport capability (`reopenIsInPlace()`), not a
platform test. Web Serial has to close and reopen the port to change rate; doing that on an erased
ECU is the one host-side risk with nothing to fall back on. `setWriteBaud` refuses the arming
outright on a transport that answers false, and `getWriteBaud` is read back into the selector — so
the panel can never show 125000 while the link sits at 9600.

**Armed on the live link, not at construction.** The first cut passed `writeBaud` as a constructor
option, which put the control in the disconnected panel beside READ. That is wrong twice: the
selector belongs on screen at the moment WRITE is pressed, and a dangerous mode you cannot see is
worse than one you cannot change. It now resets to 9600 on every connect, in `connect()` rather than
only in the `useState` initialiser, so it can never be inherited from a session the operator has
stopped thinking about.

The write timeout is derived from the rate (`programmingWriteTimeoutFor`: 3 s at >=125000, 10 s at
38400+, 15 s below), following the reference. A fixed 15 s at 125000 would wait 340 telegram-times
before admitting the link was gone.

Nine scenarios this is written to satisfy, stated rather than checked (see the note in §6): the
probe precedes the first write, a refused switch never reopens, an ACK-then-silent DME receives zero
telegrams at 125000, the dead-at-both-rates throw names the erased state and the recovery, and
arming after construction is what actually reaches the link.

**Run on the car, four times, all clean.** From the diagnostics store (`npm run db:diagnostics`),
every one `ok`, with the requested rate and the rate that ran agreeing:

| at | kind | baud | requested | median turnaround |
|---|---|---|---|---|
| 2026-08-29 09:11 | write | 125000 | 125000 | 15.8 ms |
| 2026-08-29 10:29 | write | 125000 | 125000 | 15.8 ms |
| 2026-08-30 06:01 | write | 125000 | 125000 | 15.8 ms |
| 2026-08-30 08:05 | write | 125000 | 125000 | 15.9 ms |

against **32.0 ms** on the two 9600 writes in the same store (2026-08-28 07:21, 2026-08-30 07:11).

**That 32 → 15.8 is worth staring at, because it should not have moved.** `turnaround` was described
here as the DME's own flash programming time, which a baud rate cannot touch. Part of the gap is the
10-byte acknowledgement — 10.4 ms of wire at 9600 against 0.8 ms at 125000 — but that accounts for
about 10 of the 16. The rest is unexplained, and the honest reading is that this lane is not purely
the DME thinking: something host- or driver-side scales with the rate as well. It does not change
what to do; it does mean **"32 ms of DME programming cannot be recovered" is an upper bound rather
than a measurement**, and the per-telegram decomposition in §15 should be re-derived from a boosted
run before it is quoted again.

### The event log

`linkEventLog.ts` — a bounded ring of phase-level lines: login, erase and its duration, the write
telegram summary, finalize, the verification verdict, and the failure verbatim. `TransferTiming`
answers "where did the milliseconds go"; this answers "what did we do, in what order, and what did
the ECU say", and that is the question asked first.

**Deliberately not a telegram trace.** Nothing in it is called per exchange — 538 strings on the
critical path of an operation that erases before it writes is exactly the instrument-inside-its-own-
measurement problem the timing file is built to avoid. A whole flash produces well under 20 lines.

### The store

Diagnostics upload themselves to D1 (`migrations/0003_diagnostics.sql`, `/api/diagnostics`), beside
sessions and behind the same bearer token.

Sessions sync on an explicit press, because a session is the user's work and a background task that
quietly gave up would be a lie about where their data is. A diagnostic is the opposite: **it is
worth most for the operations that FAILED**, which are exactly the ones that never produce a session
worth syncing — a flash that died at chunk 300 on an already-erased ECU had nowhere to be written
down. So it uploads by itself, best-effort and silent: `uploadDiagnostic` never throws, is never
retried, and a failed upload leaves the downloadable copy untouched. An upload must never become the
reason a flash reports a failure it did not have.

Published on **every** path including failure, and cleared at the *start* of each operation — the
same rule §9 paid for once, when a latency sweep came back as three byte-identical copies of the
previous run.

The list columns are denormalised out of the payload (`exchanges`, `elapsed_ms`, `baud`,
`requested_baud`, `median_turnaround`, `median_total`, `median_host_gap`) so a sweep can be ranked
without inflating a single row — and `requested_baud` sits beside `baud` because a refused switch
silently falls back, and without both, four candidate rates all read as "9600".

**R2 is deliberately not used.** A measured 301-exchange failed-write record, with a 300-sample gap
trace and its event log, compresses to **594 bytes** — three orders of magnitude inside D1's
1,000,000-byte per-value cap. A second store would buy nothing but something to keep in step, and a
diagnostic too big for this has stopped being a summary. The endpoint rejects one over 900 KB with
that sentence rather than letting D1 reject it generically.

`npm run db:diagnostics` lists the last 30 at a desk.
