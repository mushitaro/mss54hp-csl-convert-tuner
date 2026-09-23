import { useState } from 'react';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { BinaryPatcher } from '@/lib/binary-engine/patcher';
import { IDLE_WRITE_SEALED } from '@/lib/idle/seal';
import { readIdleTables } from '@/lib/idle/idleTables';
import { composeLlsTv } from '@/lib/lls/composeLlsTv';
import type { LlsTvEdit } from '@/lib/lls/ringGain';
import { writtenVeGrid, type ShapeArm } from '@/lib/ve-calculator/composeVeGrid';
import { applyCalibrationEdits } from '@/lib/calibration/apply';
import type { CalEdit, RunSpan } from '@/lib/calibration/edits';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { VECalculator } from '@/lib/ve-calculator/calculator';
import type { VEMap } from '@/lib/types';
import { MAP_DIMENSIONS } from '@/config/constants';
import { dialogText } from '@/lib/dialog-text';
import { downloadBlob, MIME_BIN } from '@/lib/download';

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
  applyRfKorrGateDrop?: boolean;
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

/** Tables that are not derived from the VE map and so cannot be rebuilt from it. */
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
 */
export function writeClaimsTune(
  newMap: VEMap | null,
  writeVe: boolean,
  extras?: PatchExtras,
): boolean {
  return (writeVe && !!newMap)
    || !!extras?.tunedRfKorr
    || !!extras?.tunedShape
    || !!extras?.tunedIdleTv
    || !!extras?.tunedLlsTv?.length
    || (extras?.calibrationEdits?.edits.length ?? 0) > 0;
}

export type PatchExtras = {
  /** The back-calculated KF_RF_KORR_DRREL, 6 x 12 physical values. Null writes nothing. */
  tunedRfKorr?: number[][] | null;
  /** The idle valve duty proposal, `KF_LLS_TV` as 13 x 10 physical per cent. Null writes nothing.
   *  Reaches a byte since 2026-09-03 — see lib/idle/seal.ts for what opened it. */
  tunedIdleTv?: number[][] | null;
  /**
   * The micro-throttle ring solve, as an edit list rather than a grid.
   *
   * An edit list and not a table because it has to be COMPOSED with `tunedIdleTv` — the two
   * derivations share `KF_LLS_TV`, and a second full grid here would mean whichever ran last won,
   * which is the defect `composeVeGrid` exists to stop happening on `kf_rf_soll`. Carrying the
   * cells it claims lets `composeLlsTv` give every cell exactly one owner.
   */
  tunedLlsTv?: readonly LlsTvEdit[] | null;
  /**
   * The SHAPE repair's grid and the cells it owns.
   *
   * Applied AFTER `composeVeGrid`, and that order is the point: a repair is defined as moving only
   * cells no derivation measured, so by construction it cannot land on a cell the derivation owns.
   * Composing first and overwriting after makes that ordering explicit rather than relying on the
   * repair's own bookkeeping to have been right.
   */
  tunedShape?: ShapeArm | null;
  /**
   * The CALIBRATION tab's generic edits — self-contained raw runs, plus the byte spans the
   * ARMED table writers own for this build. Applied LAST before applyChecksumCorrection, and
   * apply skips any edit overlapping a span: the arbitration lives on the byte side, not only
   * in the manifest's row locks (see lib/calibration/apply.ts).
   */
  calibrationEdits?: { edits: CalEdit[]; conflictSpans: RunSpan[] } | null;
};

/**
 * What the correction table is allowed to hold, as written.
 *
 * The floor is the important one: below 1.000 the table would LEAN the mixture at exactly the
 * condition BMW chose to enrich, which is the thing 20-egt-correction.md says not to do. The
 * tuner already clamps to the same range; this repeats it at the byte boundary so no future
 * caller can route around it.
 */
const RF_KORR_WRITE_BOUNDS = { min: 1.0, max: 1.40 };

/**
 * What the idle valve duty is allowed to hold, as written.
 *
 * DUTY PER CENT, because the write target is `KF_LLS_TV`. It used to be kg/h — 11.0 to 40.0 — from
 * when the target was `KF_LLR_QVS_GRUND`, and those numbers were the second reason that map was
 * sealed: they would have clamped sixteen untouched cold cells on the way past.
 *
 * These are the valve's own rails, `K_LLS_TV_MIN` and `K_LLS_TV_MAX` as this lineage holds them.
 * The tuner re-derives both from the LOADED binary rather than trusting these — a different
 * calibration puts them elsewhere — so this is the last-resort rail at the byte boundary, for the
 * same reason RF_KORR_WRITE_BOUNDS is: so no future caller can route around the tuner's own clamp.
 *
 * Measured against the stock table before this was allowed to write anything: all 130 cells sit
 * inside 14..97, so applying these bounds to the whole table moves no cell the tuner did not.
 * `verify:idle` asserts that, so a re-vendored binary cannot quietly break it.
 */
const IDLE_TV_WRITE_BOUNDS = { min: 14.0, max: 97.0 };

export function useBinaryFile() {
  const [binaryFile, setBinaryFile] = useState<File | null>(null);
  /** The idle proposal: `KF_LLS_TV` in duty per cent, 13x10. Held here so the panel can show what
   *  it derived and so a reload clears it, and armed into the next write by the block above. */
  const [tunedIdleTv, setTunedIdleTv] = useState<number[][] | null>(null);
  const [tunedLlsTv, setTunedLlsTv] = useState<readonly LlsTvEdit[] | null>(null);
  const [binaryBuffer, setBinaryBuffer] = useState<ArrayBuffer | null>(null);
  const [currentMap, setCurrentMap] = useState<VEMap | null>(null);
  const [initialMapData, setInitialMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));

  // What the LOADED BYTES say, as opposed to what the toggles are asking for. Keeping wotDisabled
  // here — it used to be computed in uploadBinary and thrown away after seeding the toggle — is what
  // lets the hub compare the two and offer a write when they disagree.
  const [patchStatus, setPatchStatus] = useState<{ mapOff: boolean; tempLimit: boolean; wotDisabled: boolean; tankVentDisabled: boolean; rfKorrGateDropped: boolean } | null>(null);
  const [applyPatch, setApplyPatch] = useState<boolean>(false);

  // [EXPERIMENTAL] UI Controls
  const [applyWotDisable, setApplyWotDisable] = useState<boolean>(false); // Default OFF
  /** Tank ventilation held shut. Default OFF — this is an emissions device, and the only reason to
   *  touch it is a tuning run that has to be put back afterwards. */
  const [applyTankVentDisable, setApplyTankVentDisable] = useState<boolean>(false);
  /** `kl_rf_korr_rf_min` dropped to 0.400, so the rf_korr gate opens at 40 % filling instead of
   *  55-80 %. Default OFF — it is a measurement patch that widens where the DME enriches, and it
   *  comes back out after the drive. See BinaryPatcher.setRfKorrGateFloor. */
  const [applyRfKorrGateDrop, setApplyRfKorrGateDrop] = useState<boolean>(false);
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
   * The VE map itself, behind a toggle like everything else it is written beside — and the ONE
   * toggle that starts armed (operator, 2026-08-30).
   *
   * It used to be implicit: a derived map was written whenever it existed, which made VE the one
   * table the WRITE manifest could not speak for. Putting it behind a row fixed that, and the row
   * stays. What changes is only where it starts.
   *
   * The reason it may start armed while nothing else does is that VE is the ONLY table this app
   * exists to produce. Every other row is an extra taken deliberately — a patch, a restore, a
   * second table, a mode on this one. Someone who loaded a BASE, drove, and opened WRITE is there
   * to write the map they just derived; making them tick it as well is a step that has exactly one
   * sensible answer, and a step with one sensible answer is not a decision, it is a tax.
   *
   * ARMED IS NOT WRITTEN, and that is what makes this safe rather than a return to the implicit
   * behaviour. The row is disabled until a derivation exists, and `armedLabels` refuses a disabled
   * toggle however it is stored (verify:features), so a fresh BASE with no drive contributes
   * nothing. Past that, WRITE still names every table in the confirmation before any byte moves,
   * and the filename's Tune_/Base_ prefix still follows the manifest rather than the derivation.
   *
   * A stored session is untouched: `settings?.writeVe ?? writeVe` means an archived tune replays
   * under the arming it was built with, not under today's default.
   */
  const [writeVe, setWriteVe] = useState<boolean>(true);
  /** Whether the SHAPE repair's cells go into the next write. Off by default and reset with
   *  every load, like every other derived artefact: these cells carry no direct measurement,
   *  so writing them is a decision the operator takes each time rather than one that persists
   *  quietly across sessions. */
  const [writeShape, setWriteShape] = useState<boolean>(false);

  const uploadBinary = async (file: File, overrides?: ToggleOverrides) => {
    try {
      const buffer = await file.arrayBuffer();
      const parser = new BinaryParser(buffer);
      const map = parser.getVETable();

      setBinaryFile(file);
      setBinaryBuffer(buffer);
      setCurrentMap(map);
      setInitialMapData(map.data); // Store initial map data for comparison

      // Check patch status
      const isMapOff = parser.getMapCorrectionStatus();
      const tempVal = parser.getTempThreshold();
      const isTempHigh = tempVal >= 99;

      // Check WOT status
      const isWotDisabled = parser.getWOTThresholdStatus();
      // Detectable in the bytes, exactly like the WOT threshold — so a BIN that came off the car
      // with purge already disabled says so on the hub instead of quietly looking stock.
      const isTankVentDisabled = parser.getTankVentDisabled();
      // Detectable the same way, and it has to be: this curve is an INPUT to every later
      // derivation (readEgtTables -> EgtTables.rfKorrMin -> gateOpen / RfKorrLatch / rfKorrCensus),
      // so a BASE that arrives with the floor already dropped must say so rather than let the app
      // interpret its own drives through a gate the car was not running.
      const isRfKorrGateDropped = parser.getRfKorrGateFloorDropped();

      setPatchStatus({
        mapOff: isMapOff, // True if OFF
        tempLimit: isTempHigh,
        wotDisabled: isWotDisabled,
        tankVentDisabled: isTankVentDisabled,
        rfKorrGateDropped: isRfKorrGateDropped,
      });

      // Detection off the bytes is right when a BASE arrives fresh (upload / DME read), but wrong
      // when reopening a saved session: that loads the BASE, which is normally unpatched, so the
      // detected value would silently overwrite the settings the tune was actually built with.
      setApplyPatch(overrides?.applyPatch ?? (isMapOff && isTempHigh));
      setApplyWotDisable(overrides?.applyWotDisable ?? isWotDisabled);
      setApplyTankVentDisable(overrides?.applyTankVentDisable ?? isTankVentDisabled);
      setApplyRfKorrGateDrop(overrides?.applyRfKorrGateDrop ?? isRfKorrGateDropped);
      // These two leave no detectable trace in the bytes, so there is nothing to fall back on:
      // default them OFF on every load. Otherwise they persist from the previous session and
      // silently inject derived warmup/WOT tables into an unrelated binary.
      setWriteWarmup(overrides?.writeWarmup ?? false);
      setRestoreWotFuel(overrides?.restoreWotFuel ?? false);
      setRestoreVe(overrides?.restoreVe ?? false);
      setRestoreWarmup(overrides?.restoreWarmup ?? false);
      setWriteRfKorr(overrides?.writeRfKorr ?? false);
      // SHAPE keeps the "no trace in the bytes" rule of the three above: OFF on every load.
      // VE starts ARMED — see its declaration. Loading a BASE cannot write anything by itself, and
      // the row is disabled until there is a derivation to arm, so this is where the operator's
      // one sensible answer is already filled in rather than asked for.
      setWriteVe(overrides?.writeVe ?? true);
      setWriteShape(overrides?.writeShape ?? false);
      setTunedIdleTv(null);
    setTunedLlsTv(null);
      setTunedLlsTv(null);

      return map;
    } catch (e) {
      alert(dialogText().parseBinaryFailed(e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  // Applies all patches (VE table, experimental maps, logic patch, WOT threshold, checksum
  // correction) to a fresh clone of binaryBuffer and returns the resulting bytes. Shared by the
  // file-download flow and DB session saving, so both are guaranteed byte-identical.
  //
  // `settings` overrides the live toggle state. Needed because this reads that state through a
  // closure: a caller that restores toggles and rebuilds in the same handler would otherwise hash
  // the pre-restore values and "verify" nothing.
  const buildPatchedBuffer = (
    newMap: VEMap | null,
    settings?: ToggleOverrides,
    extras?: PatchExtras,
  ): ArrayBuffer | null => {
    if (!binaryBuffer) return null;

    const usePatch = settings?.applyPatch ?? applyPatch;
    const useWotDisable = settings?.applyWotDisable ?? applyWotDisable;
    const useTankVentDisable = settings?.applyTankVentDisable ?? applyTankVentDisable;
    const useRfKorrGateDrop = settings?.applyRfKorrGateDrop ?? applyRfKorrGateDrop;
    const useWarmup = settings?.writeWarmup ?? writeWarmup;
    const useRestoreWot = settings?.restoreWotFuel ?? restoreWotFuel;
    const useRestoreVe = settings?.restoreVe ?? restoreVe;
    const useRestoreWarmup = settings?.restoreWarmup ?? restoreWarmup;
    const useWriteVe = settings?.writeVe ?? writeVe;

    const patcher = new BinaryPatcher(binaryBuffer);

    // kf_rf_soll has exactly ONE writer, and everything that wants to change it passes through one
    // composition gated by its own toggle: an OFF toggle contributes null, and nothing contributing
    // means the table is not touched at all. Before composeVeGrid existed each workflow wrote the
    // whole grid itself with call order as the only arbitration, and the order ran opposite to the
    // comment describing it — so arming a second one reverted every corrected cell to BASE
    // (65-workflows.md, defect 1).
    /**
     * The grid that reaches `kf_rf_soll` — the derivation plus the SHAPE mode, in one call.
     *
     * `writtenVeGrid` rather than the composition and the overlay written out here, because the
     * WARMUP tab needs the same answer and computing it twice is how a screen and its bytes come
     * apart. Null when nothing is armed for the table, and the table is then not touched at all.
     */
    const written = writtenVeGrid(
      useWriteVe ? newMap?.data ?? null : null,
      extras?.tunedShape ?? null,
    );
    if (written) patcher.setVETableData(written);

    /**
     * WARMUP derives from THE GRID THAT IS BEING WRITTEN, not from the tuned map beside it.
     *
     * It used to take `newMap` unconditionally, and that quietly dropped the SHAPE repair: `newMap`
     * is the tuned grid before the overlay, and the shaped cells were overlaid onto a local copy of
     * it a few lines above and nowhere else. So a flash could carry a repaired `kf_rf_soll` and a
     * `kf_rf_soll_kath` interpolated from the UNREPAIRED one.
     *
     * That is not a rounding difference. `CSL_STOCK_WARMUP_LOAD` starts at 0.10 % and its first
     * fourteen rows sit at or below 3.20 % — exactly the openings SHAPE exists to repair — and
     * `generateWarmupMap` reads the main table by interpolation at exactly those openings. A
     * falling column that SHAPE just removed from the warm table would be interpolated straight
     * back into the cold one.
     *
     * `written` is null when nothing is armed for `kf_rf_soll`. WARMUP is then still allowed, from
     * `newMap`: it writes its own table at its own address, and arming it without arming the main
     * one is a legitimate thing to want. What it must never do is derive from a DIFFERENT grid than
     * the one going into the flash beside it.
     */
    if (newMap && useWarmup) {
      const source = written ? { ...newMap, data: written } : newMap;
      const warmupMap = new VECalculator().generateWarmupMap(source);
      patcher.setWarmupTable(warmupMap);
    }

    // Apply or Revert Logic Patch
    if (usePatch) {
      patcher.disableMapCorrection();
    } else {
      patcher.enableMapCorrection();
    }

    // The full-load fuel multiplier, put back to the community reference.
    //
    // Outside the `newMap` block on purpose, and one-way on purpose. This is a RESTORE: there is no
    // derived value to write and no "off" direction that means anything, so arming it writes the
    // reference and leaving it alone writes nothing. Anyone at any point in a tuning campaign can
    // therefore get back to a known table, which is the whole reason it exists — see
    // COMMUNITY_WOT_FUEL_RAW for the bug that made a known table worth having.
    if (useRestoreWot) patcher.restoreWotFuel();

    // The two Alpha-N tables, put back to the CSL 0401 reference.
    //
    // AFTER the composition and the warmup derivation above, and that order is the safety property
    // rather than an accident. Both write the same bytes those two do, so whichever runs last wins,
    // and a restore that could be overwritten by a tune is not a restore. The manifest also locks
    // the two sides against each other so the case never arises — but the arbitration must not live
    // only in the UI, because `settings` lets a caller reach this function with any pair of flags.
    //
    // One-way, like restoreWotFuel: false writes nothing rather than writing something else.
    if (useRestoreVe) patcher.restoreVeTable();
    if (useRestoreWarmup) patcher.restoreWarmupTable();

    // [EXPERIMENTAL] WOT Threshold Patch (Independent of Logic Patch)
    patcher.setWOTThreshold(useWotDisable);

    // Tank ventilation. Written unconditionally in BOTH directions, like the WOT threshold above
    // and unlike the derived maps: `false` restores the stock gain rather than leaving whatever
    // was there. That is what makes turning the toggle off an actual restore — the whole safety
    // story here is that the valve goes back, and a patch that only ever writes one way could not
    // deliver it. Before applyChecksumCorrection, with everything else.
    patcher.setTankVentDisable(useTankVentDisable);

    // The rf_korr gate floor. Both directions like the two above, and for a reason this one owns:
    // the app READS this curve back to decide which of a drive's samples the DME was correcting, so
    // leaving a stale drop in place would silently re-interpret every later log. Off restores the
    // six the binary was loaded with.
    patcher.setRfKorrGateFloor(useRfKorrGateDrop);

    // The back-calculated EGT correction. Threaded in explicitly rather than read off hook state
    // for the same reason `settings` is: a caller that rebuilds inside one handler would otherwise
    // hash a value the render has not caught up with.
    //
    // Not optional relative to the VE map it was built with. The 'tuned' VE mode divides by this
    // table, so a map written without it would be read by the DME through the OLD one and come out
    // lean by k_new/k_old — up to 27 % at the stock peak. page.tsx derives both from a single
    // value so the pair cannot come apart.
    if (extras?.tunedRfKorr) {
      const def = findEcuItem('KF_RF_KORR_DRREL');
      if (def?.kind === 'map') {
        patcher.setEcuMapValues(def, extras.tunedRfKorr, RF_KORR_WRITE_BOUNDS);
      }
    }

    /**
     * The idle valve duty — `KF_LLS_TV`, and the symbol here has to be the one the TUNER quantised
     * against or the bytes are rounded to a grid they are not stored on.
     *
     * It said `KF_LLR_QVS_GRUND` until 2026-09-03, months after the estimator had moved. Nothing
     * came of it only because the seal was shut and because a 13x10 proposal handed to a 5x6 writer
     * throws rather than corrupts. Both halves now name `KF_LLS_TV`; `verify:idle` asserts they
     * still agree, because "two places name the target" is exactly the shape that drifted.
     *
     * The guard sits at the byte boundary rather than only in the UI, so no caller can route
     * around it — see lib/idle/seal.ts for what opened it and what stays shut.
     */
    if (!IDLE_WRITE_SEALED && (extras?.tunedIdleTv || extras?.tunedLlsTv?.length)) {
      const def = findEcuItem('KF_LLS_TV');
      // The LOADED image, not the patcher clone: the composer needs the stock table to tell which
      // cells IDLE actually moved, and nothing earlier in this function touches KF_LLS_TV.
      const tables = readIdleTables(binaryBuffer);
      if (def?.kind === 'map' && tables) {
        /*
         * ONE writer, two derivations. IDLE moves the rows warm idle evidence reaches; the
         * micro-throttle solve rebuilds the rows its drive reached. Both land here, so the
         * arbitration is stated in `composeLlsTv` rather than decided by which branch ran last.
         *
         * `composeLlsTv` returns null when neither contributes anything, and then nothing is
         * written at all — which matters more here than on kf_rf_soll, because setEcuMapValues
         * clamps every one of the 130 cells it touches. A write of "no change" is still a write.
         */
        const composed = composeLlsTv(
          tables.llsTv.values,
          { idle: extras.tunedIdleTv ?? null, lls: extras.tunedLlsTv ?? null },
          { rpm: tables.llsTv.x, mlKgH: tables.llsTv.y },
        );
        if (composed) {
          patcher.setEcuMapValues(def, composed.values, IDLE_TV_WRITE_BOUNDS);
        }
      }
    }

    // CALIBRATION tab edits, last of the writers: nothing after them can clobber an edit on
    // unrelated bytes, and an edit overlapping an armed writer's span is skipped inside apply
    // rather than winning by call order.
    if (extras?.calibrationEdits?.edits.length) {
      applyCalibrationEdits(patcher, extras.calibrationEdits.edits, extras.calibrationEdits.conflictSpans);
    }

    // Recalculate checksum last, after all other patches have been applied
    patcher.applyChecksumCorrection();

    return patcher.getBuffer();
  };

  /** `newMap` is required, not optional, so that adding a caller cannot silently default to
   *  claiming a tune. It decides the prefix only — the bytes come from buildPatchedBuffer. */
  const buildFileName = (newMap: VEMap | null, extras?: PatchExtras): string => {
    const dateStr = getFormattedDate();
    let baseName = binaryFile?.name.replace(/\.bin$/i, '') || 'tune';

    // Clean up existing prefixes/suffixes to avoid duplication like "Tune_..._Tune_...". Both
    // prefixes have to be stripped, or re-downloading a file this function already named would
    // nest them ("Tune_..._Base_...") and the outer prefix would win while the inner one lingers.
    baseName = baseName.replace(/^(?:Tune|Base)_\d{12}_/, '');
    baseName = baseName.replace(/(_PatchON|_PatchOFF|_LTFT&MAPOFFPached)(_TEVOFF)?$/, '');

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
    // Its own marker too, and for the sharper version of the same argument: a BIN carrying this is
    // one the DME enriches on across a far wider part of the map than BMW allowed. A file that
    // turns up later with no way to tell is a file that gets flashed for a normal drive.
    const gateSuffix = applyRfKorrGateDrop ? '_RFGATE40' : '';
    // `Tune_` iff a derived table actually went into the bytes — which is the manifest's answer,
    // not the derivation's. A map that exists but whose WRITE VE toggle is off contributes nothing
    // and must not name the file; an RF KORR or SHAPE grid alone contributes plenty and used to
    // ship as `Base_` — the same lie in the other direction. Without any of them the artifact is
    // the BASE with the logic toggles applied: real (it is the PATCH-ON BIN you flash for a log
    // run), but not a tune.
    const claimsTune = writeClaimsTune(newMap, writeVe, extras);
    const prefix = claimsTune ? 'Tune' : 'Base';
    return `${prefix}_${dateStr}_${baseName}${patchSuffix}${tevSuffix}${gateSuffix}.bin`;
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
  const loadFromBuffer = async (buffer: ArrayBuffer, fileName: string, overrides?: ToggleOverrides) => {
    const file = new File([buffer], fileName, { type: 'application/octet-stream' });
    return uploadBinary(file, overrides);
  };

  /** Drops the loaded binary and everything read out of it. A new session with no BASE must not
   *  inherit the previous one's map: its tabs would stay live and CURRENT MAP would show a binary
   *  that session doesn't have. */
  const clear = () => {
    setBinaryFile(null);
    setBinaryBuffer(null);
    setCurrentMap(null);
    setInitialMapData(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
    setPatchStatus(null);
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
    setApplyRfKorrGateDrop(false);
    setWriteRfKorr(false);
    // Back to the DEFAULT, not to false — this list exists so the next BASE starts where a fresh
    // load would, and a fresh load arms VE. Resetting it to false here would make the second
    // binary of a session behave differently from the first, which is the class of bug this list
    // was written to end rather than to join.
    setWriteVe(true);
    setTunedIdleTv(null);
  };

  return {
    binaryFile,
    binaryBuffer,
    currentMap,
    initialMapData,
    patchStatus,
    applyPatch,
    setApplyPatch,
    applyWotDisable,
    applyTankVentDisable,
    setApplyTankVentDisable,
    applyRfKorrGateDrop,
    setApplyRfKorrGateDrop,
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
