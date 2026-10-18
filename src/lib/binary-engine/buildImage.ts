/**
 * The one composition of a BIN this app sends: the image a build starts from, plus every armed row,
 * plus the checksum — as a pure function.
 *
 * ## Why it left the hook
 *
 * It lived inside `useBinaryFile.buildPatchedBuffer`, reading the toggles through a closure. That
 * was enough while there was one image to start from and one caller per press. The hub's write gate
 * asks the same question on every render instead — "what would WRITE send, and is it different
 * from what the car holds" (lib/db/carImage.ts) — and a memo cannot call a closure over a hook's
 * state without depending on all of it. So the composition is here, with every input an argument,
 * and the hook's `buildPatchedBuffer`, the download, SAVE, WRITE and the gate all call it. Two
 * copies of this order would be two answers to "what goes into the ECU", which is the defect the
 * WRITE manifest was built to end.
 *
 * ## The two images
 *
 *     source   what the build STARTS from — the CAR IMAGE, the bytes the ECU holds now
 *     base     the session's BASE — what every derivation was computed against
 *
 * They are the same image in a session that was never written, and then this is exactly the build
 * that used to start from the BASE. They differ once a write has gone out: a patch-only write from
 * a draft leaves the BASE as it was (the logs, the replay and the derived map all read it) while the
 * car holds the patches. Building that next write from the BASE would re-send the patches as if they
 * were new and offer a write for a car that already has every byte of it; building from the car
 * image changes exactly what the toggles changed — which is what lets "build = car image" mean
 * "nothing to write".
 *
 * `base` is used twice, both deliberately:
 *
 *   - as the patcher's restore FALLBACK, so turning a patch off over a car image that carries it
 *     puts back the car's own bytes rather than the community constants (BinaryPatcher.fallback);
 *   - as the STOCK reference `composeLlsTv` measures the idle proposals against. Those were derived
 *     from the BASE's KF_LLS_TV and are deltas on it; reading the car's table would apply them to
 *     a different starting point.
 *
 * ## No-change is identity
 *
 * Built from an image X with the toggles X's own bytes report and nothing else armed, this returns
 * X byte for byte: every logic writer keeps a byte that is not its own patch, the derived tables are
 * not touched when nothing is armed for them, and the checksum correction is idempotent on a valid
 * image. `verify:car-image` pins it for stock, PATCH-ON, K HOLD and WOT TH images — and pins that an
 * image carrying the pre-2026-10-18 TANK VENT patch is NOT returned unchanged, because that build
 * adds the missing K_TE_TMOT and that is exactly the write the hub has to offer.
 */
import { BinaryPatcher } from './patcher';
import { IDLE_WRITE_SEALED } from '@/lib/idle/seal';
import { readIdleTables } from '@/lib/idle/idleTables';
import { composeLlsTv } from '@/lib/lls/composeLlsTv';
import type { LlsTvEdit } from '@/lib/lls/ringGain';
import { writtenVeGrid } from '@/lib/ve-calculator/composeVeGrid';
import type { ShapeArm } from '@/lib/ve-calculator/composeVeGrid';
import { applyCalibrationEdits } from '@/lib/calibration/apply';
import type { CalEdit, RunSpan } from '@/lib/calibration/edits';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { VECalculator } from '@/lib/ve-calculator/calculator';
import type { VEMap } from '@/lib/types';

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

/** The toggles a build reads — every one of them, resolved by the caller. No defaults in here: a
 *  default is a decision, and the hook that owns the toggles is where it is taken. */
export interface BuildToggles {
  applyPatch: boolean;
  applyWotDisable: boolean;
  applyTankVentDisable: boolean;
  applyRfKorrHold: boolean;
  writeWarmup: boolean;
  restoreWotFuel: boolean;
  restoreVe: boolean;
  restoreWarmup: boolean;
  writeVe: boolean;
}

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

export interface BuildInput {
  /** The image the build starts from: the car image. See the file header. */
  source: ArrayBuffer;
  /** The session's BASE: the restore fallback and the idle composer's reference. */
  base: ArrayBuffer;
  newMap: VEMap | null;
  toggles: BuildToggles;
  extras?: PatchExtras;
}

export function buildImage({ source, base, newMap, toggles, extras }: BuildInput): ArrayBuffer {
  const patcher = new BinaryPatcher(source, base);

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
   * apart. Null when nothing is armed for the table, and the table is then not touched at all —
   * which, built from the car image, means the car's own table stays, whatever it is.
   */
  const written = writtenVeGrid(
    toggles.writeVe ? newMap?.data ?? null : null,
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
  if (newMap && toggles.writeWarmup) {
    const sourceMap = written ? { ...newMap, data: written } : newMap;
    const warmupMap = new VECalculator().generateWarmupMap(sourceMap);
    patcher.setWarmupTable(warmupMap);
  }

  // Apply or Revert Logic Patch. Both directions on every build: OFF keeps a byte that is not the
  // patch, so a build from the car image with PATCH off leaves an unpatched car exactly as it is.
  if (toggles.applyPatch) {
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
  if (toggles.restoreWotFuel) patcher.restoreWotFuel();

  // The two Alpha-N tables, put back to the CSL 0401 reference.
  //
  // AFTER the composition and the warmup derivation above, and that order is the safety property
  // rather than an accident. Both write the same bytes those two do, so whichever runs last wins,
  // and a restore that could be overwritten by a tune is not a restore. The manifest also locks
  // the two sides against each other so the case never arises — but the arbitration must not live
  // only in the UI, because the toggles reach this function as any combination a caller passes.
  //
  // One-way, like restoreWotFuel: false writes nothing rather than writing something else.
  if (toggles.restoreVe) patcher.restoreVeTable();
  if (toggles.restoreWarmup) patcher.restoreWarmupTable();

  // [EXPERIMENTAL] WOT Threshold Patch (Independent of Logic Patch)
  patcher.setWOTThreshold(toggles.applyWotDisable);

  // Tank ventilation — the valve gain and K_TE_TMOT, two bytes on one toggle (setTankVentDisable).
  // Written unconditionally in BOTH directions, like the WOT threshold above and unlike the derived
  // maps: `false` restores both rather than leaving whatever was there — the valve AND the purge
  // learning come back. That is what makes turning the toggle off an actual restore — the whole safety
  // story here is that the valve goes back, and a patch that only ever writes one way could not
  // deliver it. Before applyChecksumCorrection, with everything else.
  patcher.setTankVentDisable(toggles.applyTankVentDisable);

  // The rf_korr gate floor — K HOLD or stock. Both directions like the two above, and for a
  // reason this one owns: the app READS this curve back to decide which of a drive's samples the
  // DME was correcting, so a stale hold left in place would silently re-interpret every later log
  // and ship in the release BIN. Off restores the six the source was loaded with — the BASE's when
  // those were held or carry the retired drop, and STOCK_RAW when the BASE's were too. Never 'drop':
  // that patch is retired, so no build writes it, whatever a stored record says.
  patcher.setRfKorrGateFloor(toggles.applyRfKorrHold ? 'hold' : 'stock');

  // The back-calculated EGT correction. Threaded in explicitly rather than read off hook state
  // for the same reason the toggles are: a caller that rebuilds inside one handler would otherwise
  // hash a value the render has not caught up with.
  //
  // Never together with a derived VE map: page.tsx arms one or the other (see rfKorrArmed), because
  // the table is anchored on the VE the drive ran on and one drive's VE error would land in both.
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
    // The BASE, not the patcher clone and not the car image: the composer needs the table the
    // proposals were derived against to tell which cells IDLE actually moved, and nothing earlier
    // in this function touches KF_LLS_TV.
    const tables = readIdleTables(base);
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
}

/** Byte-for-byte equality of two images — the write gate's whole comparison. */
export function sameBytes(a: ArrayBuffer | null | undefined, b: ArrayBuffer | null | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
