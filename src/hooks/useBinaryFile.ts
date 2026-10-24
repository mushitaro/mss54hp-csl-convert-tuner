import { useMemo, useState } from 'react';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { readPatchStatus } from '@/lib/binary-engine/patcher';
import { buildImage, type PatchExtras } from '@/lib/binary-engine/buildImage';
import type { VEMap } from '@/lib/types';
import type { LlsTvEdit } from '@/lib/lls/ringGain';
import { MAP_DIMENSIONS } from '@/config/constants';
import { dialogText } from '@/lib/dialog-text';
import { downloadBlob, MIME_BIN } from '@/lib/download';

// The bag of derived tables a build carries moved to lib/binary-engine/buildImage.ts with the build
// itself; re-exported so every importer of the hook keeps one place to name it from.
export type { PatchExtras };

function getFormattedDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const H = String(now.getHours()).padStart(2, '0');
  const M = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}${H}${M}`;
}

/** Explicit toggle values for a load. Anything omitted falls back to detection-from-bytes
 *  (applyPatch / applyWotDisable) or to OFF (writeWarmup / restoreWotFuel). */
export type ToggleOverrides = {
  applyPatch?: boolean;
  applyWotDisable?: boolean;
  applyTankVentDisable?: boolean;
  /** K HOLD — `kl_rf_korr_rf_min` at 2.000. Omitted falls back to detection, like the patches above. */
  applyRfKorrHold?: boolean;
  writeWarmup?: boolean;
  /** @deprecated Retired with generateWOTMap. Read nowhere; see restoreWotFuel. */
  writeWot?: boolean;
  restoreWotFuel?: boolean;
  /** Put `kf_rf_soll` / `kf_rf_soll_kath` back to the CSL 0401 reference. Same shape as
   *  restoreWotFuel: one-way, no trace in the bytes, so OFF unless a caller says otherwise. */
  restoreVe?: boolean;
  restoreWarmup?: boolean;
  writeRfKorr?: boolean;
  writeVe?: boolean;
  writeShape?: boolean;
};

/**
 * The name a downloaded BIN was derived from, with everything `buildFileName` adds taken back off.
 *
 * Every marker the function writes has to be in the strip, or re-deriving a name it wrote nests
 * them: `_RFGATE40` was missing, so `X_PatchON_RFGATE40.bin` re-downloaded as
 * `X_PatchON_RFGATE40_PatchON_RFGATE40.bin` — the outer markers right, the inner ones a claim about
 * bytes that may no longer carry it. Repeated until nothing changes, so a name that already nested
 * under the old strip comes back clean in one download rather than one per layer. `_RFGATE40`
 * stays in the pattern although nothing writes it any more, for exactly those files.
 */
export function derivedBaseName(name: string): string {
  let prev: string;
  let out = name;
  do {
    prev = out;
    // Both prefixes, or re-downloading a file this function already named would nest them
    // ("Tune_..._Base_...") and the outer prefix would win while the inner one lingers.
    out = out.replace(/^(?:Tune|Base)_\d{12}_/, '');
    out = out.replace(/(_PatchON|_PatchOFF|_LTFT&MAPOFFPached)(_TEVOFF)?(_KHOLD|_RFGATE40)?$/, '');
  } while (out !== prev);
  return out;
}

/**
 * Whether a write carries a DERIVED TABLE rather than only configuration.
 *
 * ONE expression, because there were four and they disagreed. The filename prefix, the hub's label,
 * the confirmation dialog and the flash record each asked this question separately, and each one
 * had been written when the answer was "is there a VE map". Every mode added since produces a tune
 * with no VE map behind it, and each addition had to remember four places:
 *
 *   - `tunedRfKorr` and `tunedShape` were remembered;
 *   - `calibrationEdits` was remembered, and the write handler's own comment says the record must
 *     read the extras rather than the absence of a map;
 *   - `tunedIdleTv` was NOT, so an idle tune downloaded as `Base_...` and flashed as `tuned: false`;
 *   - `tunedLlsTv` was NOT, so the hub offered WRITE PATCH-OFF over a tuned KF_LLS_TV.
 *
 * `ラベルは約束` — a button that says PATCH-OFF while sending a derived table, and a file called
 * Base_ that contains one, are the same defect said twice. Asking once is what stops the next mode
 * having to find all four.
 *
 * `writeWarmup` joined on 2026-10-24, for the same reason in a fifth place. WARMUP's table is built
 * FROM the tuned map (`buildImage`, `if (newMap && writeWarmup)`), and it used to ride in on ALPHA-N:
 * with ALPHA-N armed by default, a WARMUP armed alone was rare enough that nobody saw it file as
 * `Base_`, leave its session a draft and confirm as "no tune". ALPHA-N now loads OFF, and the hub's
 * ring counts an armed WARMUP as an armed tune (lib/hub/ringAction.ts) — so this has to as well, or
 * the ring would say WRITE over a write that calls itself configuration. Optional only so the
 * scripts that predate it keep their meaning (absent = not armed); both callers in the app pass it.
 */
export function writeClaimsTune(
  newMap: VEMap | null,
  writeVe: boolean,
  extras?: PatchExtras,
  writeWarmup?: boolean,
): boolean {
  return (writeVe && !!newMap)
    || (!!writeWarmup && !!newMap)
    || !!extras?.tunedRfKorr
    || !!extras?.tunedShape
    || !!extras?.tunedIdleTv
    || !!extras?.tunedLlsTv?.length
    || (extras?.calibrationEdits?.edits.length ?? 0) > 0;
}

export function useBinaryFile() {
  const [binaryFile, setBinaryFile] = useState<File | null>(null);
  /** The idle proposal: `KF_LLS_TV` in duty per cent, 13x10. Held here so the panel can show what
   *  it derived and so a reload clears it, and armed into the next write by the block above. */
  const [tunedIdleTv, setTunedIdleTv] = useState<number[][] | null>(null);
  const [tunedLlsTv, setTunedLlsTv] = useState<readonly LlsTvEdit[] | null>(null);
  const [binaryBuffer, setBinaryBuffer] = useState<ArrayBuffer | null>(null);
  const [currentMap, setCurrentMap] = useState<VEMap | null>(null);
  const [initialMapData, setInitialMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));

  /**
   * The CAR IMAGE — the bytes the ECU holds as far as this session knows: its last real flash, or
   * the BASE when it never wrote (lib/db/carImage.ts resolves it; the page sets it here on every
   * load and after every write). Null means "the BASE", which is the right reading for a session
   * that has not written and the only one available before a session is open.
   *
   * Held here rather than in the page for two reasons. `buildPatchedBuffer` starts every build from
   * it, so DOWNLOAD TUNED, SAVE's TUNED and WRITE send the same bytes without each caller having to
   * remember which image to start from. And `patchStatus` below is read off it: the hub's readouts
   * and every "is this in the ECU" question mean the car, not the BASE the derivations read.
   *
   * Set in the same tick as the BASE by `uploadBinary` / `loadFromBuffer`, so no render pairs one
   * session's BASE with another session's car.
   */
  const [carImage, setCarImage] = useState<ArrayBuffer | null>(null);

  // What the bytes IN THE CAR say, as opposed to what the toggles are asking for. Derived on every
  // change of either image rather than stored by the load, because the car image moves without a
  // load now — a write updates it in place and the BASE stays the BASE.
  //
  // The floor is reported both ways. `rfKorrHeld` is K HOLD as the bytes have it, the twin of the
  // toggle below. `rfKorrGateDropped` has no toggle any more — RF GATE is retired — and is kept
  // because a car carrying the drop is replayed through it until a write takes it out.
  const patchStatus = useMemo(
    () => (binaryBuffer ? readPatchStatus(carImage ?? binaryBuffer) : null),
    [binaryBuffer, carImage]);
  const [applyPatch, setApplyPatch] = useState<boolean>(false);

  // [EXPERIMENTAL] UI Controls
  const [applyWotDisable, setApplyWotDisable] = useState<boolean>(false); // Default OFF
  /** Tank ventilation held shut. Default OFF — this is an emissions device, and the only reason to
   *  touch it is a tuning run that has to be put back afterwards. */
  const [applyTankVentDisable, setApplyTankVentDisable] = useState<boolean>(false);
  /** K HOLD: `kl_rf_korr_rf_min` at 2.000, so the rf_korr gate never opens and the DME runs
   *  rf_korr ≡ 1.000 — a VE log that the lambda loop's ramp after a K step cannot contaminate.
   *  Default OFF and seeded from the bytes on load, like TANK VENT; the hub arms it with PATCH.
   *  Every OFF is a real restore to stock — see BinaryPatcher.setRfKorrGateFloor. */
  const [applyRfKorrHold, setApplyRfKorrHold] = useState<boolean>(false);
  const [writeWarmup, setWriteWarmup] = useState<boolean>(false); // Default OFF
  /** Put `KF_TI_N_RF_VL` back to the community reference. Default OFF like every other write —
   *  but unlike the others this one only ever RESTORES, so arming it cannot invent a calibration. */
  const [restoreWotFuel, setRestoreWotFuel] = useState<boolean>(false);
  /**
   * The two Alpha-N tables, put back to the CSL 0401 reference.
   *
   * Separate toggles rather than one, because they are separate tables at separate addresses with
   * separate axes — `kf_rf_soll` at 0xD356 and `kf_rf_soll_kath` at 0xD770 — and a campaign
   * routinely moves one without the other. Folding them into a single RESTORE would make going
   * back to a known warm table cost the cold one as well.
   *
   * Default OFF like every write toggle, and for the stronger of the two reasons this codebase
   * gives: these leave no trace in the bytes to re-detect, so a value carried over from a previous
   * binary would silently overwrite a table nobody asked about.
   */
  const [restoreVe, setRestoreVe] = useState<boolean>(false);
  const [restoreWarmup, setRestoreWarmup] = useState<boolean>(false);
  // Default OFF like the two above. This one rewrites KF_RF_KORR_DRREL, which changes fuelling
  // across the whole cold-exhaust region — it is not something a build should arm on its own.
  const [writeRfKorr, setWriteRfKorr] = useState<boolean>(false);
  /**
   * The VE map itself, behind a toggle like everything else it is written beside — and, like every
   * other write toggle, OFF on every load (operator, 2026-10-24).
   *
   * It used to be implicit: a derived map was written whenever it existed, which made VE the one
   * table the WRITE manifest could not speak for. Putting it behind a row fixed that, and the row
   * stays.
   *
   * From 2026-08-30 it started ARMED, on the argument that VE is the only table this app exists to
   * produce, so someone who drove and opened WRITE is there to write it and ticking the row as well
   * was a tax. That held while a session was one run. Since 7b1ebc5 a session keeps several, and
   * the armed default turned into the opposite tax: the hub's ring offered WRITE the moment the
   * first run derived a map, and START TUNE for the second run could not be reached at all (「同じ
   * セッションで2個以上取れるようにしてあるはずなのに、画面がWRITEを要求していてSTART TUNEできない」).
   * Option A, approved: after a run the ring is START TUNE, and writing the tune is the explicit act
   * of arming this row. The ring counts it (lib/hub/ringAction.ts), and the notice line under the
   * ring says so while a derived map waits unarmed — so the step is asked for by name, not hidden.
   *
   * A stored DRAFT whose settings are current reopens under the arming it saved (`seedToggles`,
   * lib/db/carImage.ts); every other load — a fresh upload or READ, NEXT's child, a draft whose
   * settings predate its last flash, an archived session — opens with this OFF. For an archived one
   * that is also the safety half it always was: its map is re-derived on reopen under today's
   * rules, which is not the map in the car, and with the build starting from the car image an
   * armed ALPHA-N would re-send it under a patch change nobody meant as a tune.
   */
  const [writeVe, setWriteVe] = useState<boolean>(false);
  /** Whether the SHAPE repair's cells go into the next write. Off by default and reset with
   *  every load, like every other derived artefact: these cells carry no direct measurement,
   *  so writing them is a decision the operator takes each time rather than one that persists
   *  quietly across sessions. */
  const [writeShape, setWriteShape] = useState<boolean>(false);

  /**
   * Loads a BASE and seeds every toggle — and, with it, the session's CAR IMAGE.
   *
   * `carImageIn` is the bytes the ECU holds for this session (lib/db/carImage.ts); omitted, the BASE
   * is the car, which is what a fresh upload or a READ is. It is set in the same tick as the BASE so
   * no render pairs them across sessions, and the toggles an override does not name are detected
   * from IT rather than from the BASE: a toggle describes what the next write leaves in the car, and
   * a toggle that matches the car's bytes is one the write gate reads as "nothing to change".
   */
  const uploadBinary = async (file: File, overrides?: ToggleOverrides, carImageIn?: ArrayBuffer | null) => {
    try {
      const buffer = await file.arrayBuffer();
      const parser = new BinaryParser(buffer);
      const map = parser.getVETable();

      setBinaryFile(file);
      setBinaryBuffer(buffer);
      setCarImage(carImageIn ?? null);
      setCurrentMap(map);
      setInitialMapData(map.data); // Store initial map data for comparison

      // What the CAR's bytes say — `patchStatus` reads the same thing off the same image once this
      // render lands; here it seeds the toggles an override leaves open.
      //
      // TANK VENT seeds from the valve byte alone (`tankVentDisabled`), never from K_TE_TMOT: a car
      // patched before that byte existed has the valve shut and K_TE_TMOT stock, seeds ON, and the
      // build from it differs from the car by exactly the missing byte — so the hub offers WRITE
      // PATCH-ON and that write leaves both bytes patched.
      //
      // The floor is detected the same way, and it has to be: this curve is an INPUT to every later
      // derivation (readEgtTables -> EgtTables.rfKorrMin -> gateOpen / RfKorrLatch / rfKorrCensus),
      // so a car that is held must say so rather than let the app interpret its own drives through
      // a gate the car was not running. The retired drop is detected and never re-armed.
      const det = readPatchStatus(carImageIn ?? buffer);

      // Detection off the bytes is right when a BASE arrives fresh (upload / DME read), but wrong
      // when reopening a draft whose saved settings are the operator's pending intent: the page
      // passes those as overrides (lib/db/carImage.ts, seedToggles).
      setApplyPatch(overrides?.applyPatch ?? (det.mapOff && det.tempLimit));
      setApplyWotDisable(overrides?.applyWotDisable ?? det.wotDisabled);
      setApplyTankVentDisable(overrides?.applyTankVentDisable ?? det.tankVentDisabled);
      setApplyRfKorrHold(overrides?.applyRfKorrHold ?? det.rfKorrHeld);
      // These two leave no detectable trace in the bytes, so there is nothing to fall back on:
      // default them OFF on every load. Otherwise they persist from the previous session and
      // silently inject derived warmup/WOT tables into an unrelated binary.
      setWriteWarmup(overrides?.writeWarmup ?? false);
      setRestoreWotFuel(overrides?.restoreWotFuel ?? false);
      setRestoreVe(overrides?.restoreVe ?? false);
      setRestoreWarmup(overrides?.restoreWarmup ?? false);
      setWriteRfKorr(overrides?.writeRfKorr ?? false);
      // SHAPE keeps the "no trace in the bytes" rule of the three above: OFF on every load.
      // So does VE since 2026-10-24 — see its declaration. Armed by default, the first run's map
      // held the hub's ring on WRITE and the session's next run could not be started; arming it is
      // now the step that says "write this tune", and only a current draft's saved choice
      // (seedToggles) brings it back ON.
      setWriteVe(overrides?.writeVe ?? false);
      setWriteShape(overrides?.writeShape ?? false);
      setTunedIdleTv(null);
      setTunedLlsTv(null);

      return map;
    } catch (e) {
      alert(dialogText().parseBinaryFailed(e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  /**
   * The bytes the next WRITE would send — and DOWNLOAD TUNED, and SAVE's TUNED, which are the same
   * call so they cannot differ. The composition is `buildImage` (lib/binary-engine/buildImage.ts);
   * this resolves its inputs from the hook's state.
   *
   * `source` is the image the build starts from, and it defaults to the CAR IMAGE: a write changes
   * the car, so it is built on the car — the BASE stays the reference every derivation read, and is
   * passed as the restore fallback. In a session that never wrote the two are the same image and
   * this is the build it always was.
   *
   * `settings` overrides the live toggle state. Needed because this reads that state through a
   * closure: a caller that restores toggles and rebuilds in the same handler would otherwise hash
   * the pre-restore values and "verify" nothing.
   */
  const buildPatchedBuffer = (
    newMap: VEMap | null,
    settings?: ToggleOverrides,
    extras?: PatchExtras,
    source?: ArrayBuffer | null,
  ): ArrayBuffer | null => {
    if (!binaryBuffer) return null;
    return buildImage({
      source: source ?? carImage ?? binaryBuffer,
      base: binaryBuffer,
      newMap,
      toggles: {
        applyPatch: settings?.applyPatch ?? applyPatch,
        applyWotDisable: settings?.applyWotDisable ?? applyWotDisable,
        applyTankVentDisable: settings?.applyTankVentDisable ?? applyTankVentDisable,
        applyRfKorrHold: settings?.applyRfKorrHold ?? applyRfKorrHold,
        writeWarmup: settings?.writeWarmup ?? writeWarmup,
        restoreWotFuel: settings?.restoreWotFuel ?? restoreWotFuel,
        restoreVe: settings?.restoreVe ?? restoreVe,
        restoreWarmup: settings?.restoreWarmup ?? restoreWarmup,
        writeVe: settings?.writeVe ?? writeVe,
      },
      extras,
    });
  };

  /** `newMap` is required, not optional, so that adding a caller cannot silently default to
   *  claiming a tune. It decides the prefix only — the bytes come from buildPatchedBuffer. */
  const buildFileName = (newMap: VEMap | null, extras?: PatchExtras): string => {
    const dateStr = getFormattedDate();
    let baseName = binaryFile?.name.replace(/\.bin$/i, '') || 'tune';

    // Clean up existing prefixes/suffixes to avoid duplication like "Tune_..._Tune_..." — see
    // derivedBaseName for every marker it takes back off.
    baseName = derivedBaseName(baseName);

    // PATCH or WOT TH: both rewrite DME logic in place, so either one alone means these bytes are
    // patched and the name has to say so. This is the same expression that decides whether the
    // DOWNLOAD PATCH-ON button appears, which is what keeps the button and the file it produces from
    // contradicting each other. writeWarmup / restoreWotFuel are excluded on purpose — they inject derived
    // TABLES rather than patching logic, and they are already implied by the `Tune_` prefix, since
    // buildPatchedBuffer only ever applies them when there is a map to derive them from.
    const patchSuffix = (applyPatch || applyWotDisable) ? '_PatchON' : '_PatchOFF';
    // Its own marker, not folded into _PatchON. The MAP/LTFT and WOT patches are reversible from
    // the driver's seat and affect nothing outside the tune; this one leaves an emissions device
    // switched off. A file that gets emailed around, or found on a disk a year later, should say so
    // in the one piece of metadata that always travels with it.
    const tevSuffix = applyTankVentDisable ? '_TEVOFF' : '';
    // Its own marker too, and for the sharper version of the same argument: a BIN carrying K HOLD
    // has no cold-exhaust enrichment at all and more ignition advance at part load. A file that
    // turns up later with no way to tell is a file that gets flashed for a normal drive.
    const holdSuffix = applyRfKorrHold ? '_KHOLD' : '';
    // `Tune_` iff a derived table actually went into the bytes — which is the manifest's answer,
    // not the derivation's. A map that exists but whose WRITE VE toggle is off contributes nothing
    // and must not name the file; an RF KORR or SHAPE grid alone contributes plenty and used to
    // ship as `Base_` — the same lie in the other direction. Without any of them the artifact is
    // the BASE with the logic toggles applied: real (it is the PATCH-ON BIN you flash for a log
    // run), but not a tune.
    const claimsTune = writeClaimsTune(newMap, writeVe, extras, writeWarmup);
    const prefix = claimsTune ? 'Tune' : 'Base';
    return `${prefix}_${dateStr}_${baseName}${patchSuffix}${tevSuffix}${holdSuffix}.bin`;
  };

  const downloadBin = (newMap: VEMap | null, extras?: PatchExtras) => {
    const patchedBuffer = buildPatchedBuffer(newMap, undefined, extras);
    if (!patchedBuffer) return;

    // Through the shared helper rather than a second copy of the same eight lines. The copy
    // carried the same synchronous-revoke defect, and would have kept it after the fix next door:
    // one export path means one place for both the revoke deadline and the download notice.
    downloadBlob(patchedBuffer, buildFileName(newMap, extras), MIME_BIN);
  };

  // Loads a buffer as if it were freshly uploaded/read from the DME, reusing uploadBinary's
  // parsing + patch-status detection. Pass `overrides` when the toggles are known from a saved
  // session rather than inferable from these bytes.
  const loadFromBuffer = async (
    buffer: ArrayBuffer, fileName: string, overrides?: ToggleOverrides, carImageIn?: ArrayBuffer | null,
  ) => {
    const file = new File([buffer], fileName, { type: 'application/octet-stream' });
    return uploadBinary(file, overrides, carImageIn);
  };

  /** Drops the loaded binary and everything read out of it. A new session with no BASE must not
   *  inherit the previous one's map: its tabs would stay live and CURRENT MAP would show a binary
   *  that session doesn't have. */
  const clear = () => {
    setBinaryFile(null);
    setBinaryBuffer(null);
    setCurrentMap(null);
    setInitialMapData(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
    // The car goes with the BASE: a session without one has no car image either, and the next
    // load sets both together.
    setCarImage(null);
    setApplyPatch(false);
    setApplyWotDisable(false);
    setWriteWarmup(false);
    setRestoreWotFuel(false);
    // The ones that were missing. Every toggle uploadBinary sets on load must be reset here for
    // the same reason: the next BASE this session loads inherits whatever survives this list, and
    // what survived was the tank-vent disable and the rf_korr arming — the exact "next BASE is
    // built with the previous session's patches" failure the two lists exist to prevent. One
    // omission here already shipped once (`_TEVOFF` on an unrelated binary).
    setApplyTankVentDisable(false);
    setApplyRfKorrHold(false);
    setWriteRfKorr(false);
    // Back to the DEFAULT — this list exists so the next BASE starts where a fresh load would, and
    // a fresh load leaves VE unarmed (2026-10-24; it armed it before). Whatever the default is, it
    // is set here and in uploadBinary alike, or the second binary of a session behaves differently
    // from the first, which is the class of bug this list was written to end rather than to join.
    setWriteVe(false);
    setTunedIdleTv(null);
  };

  return {
    binaryFile,
    binaryBuffer,
    carImage,
    setCarImage,
    currentMap,
    initialMapData,
    patchStatus,
    applyPatch,
    setApplyPatch,
    applyWotDisable,
    applyTankVentDisable,
    setApplyTankVentDisable,
    applyRfKorrHold,
    setApplyRfKorrHold,
    setApplyWotDisable,
    writeWarmup,
    setWriteWarmup,
    restoreWotFuel,
    setRestoreWotFuel,
    restoreVe,
    setRestoreVe,
    restoreWarmup,
    setRestoreWarmup,
    writeRfKorr,
    setWriteRfKorr,
    writeVe,
    setWriteVe,
    writeShape, setWriteShape,
    tunedIdleTv,
    setTunedIdleTv,
    tunedLlsTv,
    setTunedLlsTv,
    uploadBinary,
    loadFromBuffer,
    clear,
    buildPatchedBuffer,
    buildFileName,
    downloadBin,
  };
}
