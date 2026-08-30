import { useRef, useState } from 'react';
import { VECalculator, VeCalcOptions, type VeReject } from '@/lib/ve-calculator/calculator';
import { tuneRfKorrTable, rfKorrCensus, RfKorrTuneResult, RfKorrTuneReport } from '@/lib/ve-calculator/rfKorrTuner';
import { rfKorrRouteAgreement, RfKorrRouteAgreement } from '@/lib/ve-calculator/rfKorrRoutes';
import { summariseChargeTemp, type ChargeTempInfo } from '@/lib/ve-calculator/chargeTemp';
import { VEMap, LogDataPoint, ProcessedLog, resolveRfKorr } from '@/lib/types';
import { MAP_DIMENSIONS, APP_CONFIG } from '@/config/constants';
import { timeScaleSeconds } from '@/lib/log-engine/filter';
import { detectDriveSplit, type DriveSplit } from '@/lib/log-engine/driveSplit';

export function useVeCalculation() {
  /**
   * The live accumulator: the grid so far, the annotated samples so far, and how many of the
   * filtered log they account for.
   *
   * A ref, not state, for the same reason liveSamplesRef is one — it is written on every sample and
   * nothing renders from it directly. Keyed on the map object so a different BASE cannot inherit a
   * grid built against the previous one.
   */
  const liveRef = useRef<{ map: VEMap; grid: ReturnType<VECalculator['createGrid']>; consumed: number; annotated: LogDataPoint[] } | null>(null);
  const [newMap, setNewMap] = useState<VEMap | null>(null);
  const [mapData, setMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
  const [hitMap, setHitMap] = useState<number[][] | null>(null);
  const [correctionMap, setCorrectionMap] = useState<number[][] | null>(null);
  const [weightMap, setWeightMap] = useState<number[][] | null>(null);
  /** Which cells the evidence gate accepted — i.e. which ones the map was actually rewritten in.
   *  The heatmap paints from this rather than re-testing a threshold of its own, so the colour
   *  cannot say something different from the calculation. */
  const [acceptedMap, setAcceptedMap] = useState<boolean[][] | null>(null);
  /** Which gate refused each cell, null where it was written. The map reads it to say WHY a
   *  cell is unwritten — a refusal a reader cannot act on is indistinguishable from a bug. */
  const [rejectMap, setRejectMap] = useState<(VeReject | null)[][] | null>(null);
  /** What each cell ASKED for, before the gate and before the gain — defined for refused cells too.
   *  This is what convergence is measured on: a map is converged when no cell still wants to move,
   *  which is a different question from how many cells were written this pass. */
  const [demandMap, setDemandMap] = useState<number[][] | null>(null);

  // Measured EGT correction. `rfKorrMap` is the weighted-mean rf_korr each cell's samples were
  // taken under; `rfKorrSpreadMap` is max-min within the cell, which is the number that says
  // whether the cell is trustworthy: a cell built entirely at rf_korr 1.00 is clean, and one that
  // mixes 1.00 with 1.30 is averaging two different operating conditions into a single VE value.
  const [rfKorrMap, setRfKorrMap] = useState<number[][] | null>(null);
  const [rfKorrSpreadMap, setRfKorrSpreadMap] = useState<number[][] | null>(null);
  // The log with `rfKorr` filled in per row — what the table and chart should show, since the
  // measurement needs the Alpha-N map and the log pipeline alone does not have it.
  const [annotatedLog, setAnnotatedLog] = useState<LogDataPoint[] | null>(null);

  /**
   * Whether this drive holds more than one population -- see driveSplit.ts.
   *
   * Computed on the FULL pass only, never per live flush: it is a statement about a finished
   * drive, and a verdict that flickered while the numbers were still arriving would be read as
   * noise and then ignored when it mattered. A run gets it at STOP, which is when there is a map
   * to decide about. The cost is one O(n) pass plus a coarse sweep -- 7 ms on 13,608 samples.
   */
  const [driveSplit, setDriveSplit] = useState<DriveSplit | null>(null);

  // The back-calculated KF_RF_KORR_DRREL. Derived on every run where the binary's tables could be
  // read and the log carries an exhaust temperature, REGARDLESS of what the session asks to be
  // done with it: choosing not to act on the result is not a reason to be unable to look at it.
  const [tunedRfKorr, setTunedRfKorr] = useState<RfKorrTuneResult | null>(null);

  /**
   * The correction-table census DURING a run — why samples are being kept or thrown away, live.
   *
   * The table itself is deliberately not built live (see appendCalculation), but the CENSUS is the
   * part that has to be visible while there is still time to act on it. Two complete drives have now
   * been lost to the same thing: the gate opened, nothing was held steady long enough, no anchor was
   * ever recorded, and nobody could know until the drive was over and the tab was opened.
   */
  const [rfKorrLive, setRfKorrLive] = useState<RfKorrTuneReport | null>(null);

  // How far the two routes to rf_korr land apart — the standing check on DS2 offset 8.
  //
  // Computed here rather than by the page, because it needs the ANNOTATED log and the page only has
  // the processed one. It used to be a useMemo over `processedLog.data`, whose points never carry
  // `rfKorr` (annotateRfKorr returns copies), so every sample failed the first guard, the function
  // returned undefined for want of anything to compare, and the panel showed its "not compared"
  // state for the entire life of the feature. The check reads the same array the tuner does now.
  const [routeAgreement, setRouteAgreement] =
    useState<RfKorrRouteAgreement | undefined>(undefined);

  // [EXPERIMENTAL]
  /** How many VE cells cleared the evidence gate. Null until a calculation has run — distinct from
   *  a run that cleared zero, which is a result and needs saying out loud. */
  /**
   * What the level normalisation did, or would do. Measured always, applied only when asked.
   *
   * A READOUT before it is a transform: "every sample in this drive wants 11 % more air than the
   * table is written for" is worth knowing whether or not the normalisation is switched on, and it
   * is measured either way. See chargeTemp.ts.
   */
  const [chargeTempInfo, setChargeTempInfo] = useState<ChargeTempInfo | null>(null);

  const [coverage, setCoverage] = useState<{ withEvidence: number; withAnyData: number; total: number } | null>(null);

  const runCalculation = (map: VEMap, processed: ProcessedLog, options: VeCalcOptions = {}) => {
    const calc = new VECalculator();
    // Measure rf_korr first: the calculation reads point.rfKorr, and the UI shows the same numbers,
    // so both have to come from one pass rather than being derived twice with a chance to diverge.
    const annotated = calc.annotateRfKorr(map, processed.data, options.egt, options.rfKorrAir);
    // Between the two: the tuner reads the annotated log and the VE calculation may go on to
    // consume the tuner's output, so this is the only order in which one pass can serve all three.
    //
    // The tuner gets a DIFFERENT set of samples — rfKorrData, which skips the transient test. The
    // correction only runs above 55-80 % filling, which on this engine only happens while the car
    // is accelerating, so the VE map's steady-state requirement removes essentially all of it: on
    // the first real drive, 97 % of the gate-open samples. Annotated separately rather than by
    // re-filtering the annotated log, because `annotated` must stay index-aligned with
    // processed.data for the log table and chart.
    const annotatedForRfKorr = calc.annotateRfKorr(map, processed.rfKorrData, options.egt, options.rfKorrAir);
    const rfKorr = options.egt
      ? tuneRfKorrTable(map, annotatedForRfKorr, options.egt,
        { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD },
        // The tuner has always had proper thresholds and no way to reach them — this was the only
        // production call site and it passed nothing. Only the two the panel exposes are forwarded;
        // the other seventeen keep their defaults, which is the point of having defaults.
        options.rfKorrThresholds ?? {})
      : null;
    // The tuned table comes from THIS run, not from the caller. It is derived from the same log
    // the map is about to be built from, so passing it in would mean the caller had to run the
    // tuner first and the two could describe different drives.
    const result = calc.calculateNewVEMap(map, annotated, { ...options, tunedRfKorr: rfKorr });

    /*
     * What restating this log would do to it: measured always, applied inside the calculator.
     *
     * Measured over the SAME points the calculator binned, so `usable/total` is the honest count of
     * how much of the drive could answer — the first samples of every run cannot, because the slow
     * lane has not read the cluster yet, and they are dropped rather than binned un-normalised.
     *
     * Nothing is rebuilt here. The factor is per sample and load-dependent, so it cannot be applied
     * to a finished cell after the fact the way a single scalar level could; `accumulatePoint` is
     * the only place it can go in.
     */
    // Counted off the ANNOTATED log, because that is where the refusal happens: a sample with no
    // air data comes back without an rfKorr and the calculation falls back to the trim alone.
    const candidates = annotated.filter(p => p.rf !== undefined).length;
    setChargeTempInfo({
      ...summariseChargeTemp(processed.data, options.normaliseTo ?? null, !!options.normaliseTo),
      rfKorrMeasured: annotated.filter(p => p.rfKorr !== undefined).length,
      rfKorrCandidates: candidates,
    });
    const out = result;

    setAnnotatedLog(annotated);
    // The axes the calculator just binned on, so a stretch is judged in the cells it will be
    // written into. Seconds-per-unit from the same helper the filters use, because a Testo CSV
    // counts in milliseconds and "a 2-minute stretch" has to mean two minutes there too.
    setDriveSplit(detectDriveSplit(annotated,
      { rpm: map.xAxis, load: map.yAxis },
      { secondsPerUnit: timeScaleSeconds(processed.data) }));
    setTunedRfKorr(rfKorr);
    // The census, from the batch path too.
    //
    // It used to be set only by `appendCalculation`, so the panel that says WHY the correction table
    // is locked went blank the moment a run stopped, a CSV was imported, or a saved session was
    // reopened — exactly the three moments somebody sits and reads it. The tuner already computes
    // this census internally; recomputing it here costs one more O(n) pass over a few thousand rows
    // and removes the case where the numbers exist and are not shown.
    setRfKorrLive(options.egt
      ? rfKorrCensus(annotatedForRfKorr, options.egt,
        { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD },
        options.rfKorrThresholds ?? {}).report
      : null);
    setRouteAgreement(rfKorrRouteAgreement(annotatedForRfKorr, options.egt));
    setNewMap(out.newMap);
    setMapData(out.diffMap); // Use mapData for diffMap
    setHitMap(out.hitMap);
    setCorrectionMap(out.correctionMap);
    setWeightMap(out.weightMap);
    setAcceptedMap(result.acceptedMap);
    setRejectMap(result.rejectMap);
    setDemandMap(result.demandMap);
    setRfKorrMap(out.rfKorrMap);
    setRfKorrSpreadMap(out.rfKorrSpreadMap);
    setCoverage(out.coverage);

    // [EXPERIMENTAL] The two derived tables, here and nowhere else.
    //
    // They used to be derived TWICE: once below and once again by an effect on `newMap`. That effect
    // is what made them a live cost — `appendCalculation` sets `newMap` on every flush, so both
    // tables were regenerated twice a second, all run long, for tabs nobody can be looking at
    // mid-drive. And the two derivations disagreed: this one guarded on a null map and the effect
    // did not.
    //
    // WARMUP IS NOT DERIVED HERE ANY MORE. It used to be: `generateWarmupMap(out.newMap)`, once,
    // into state, at the moment the calculation finished. That made it a snapshot of the tuned map
    // as it stood before SHAPE existed, and it never revisited — so applying a repair changed the
    // bytes the flash carried and left the WARMUP TAB rendering the unrepaired table.
    //
    // It is a `useMemo` in page.tsx now, over `writtenVeGrid` — the same call the flash path makes.
    // One derivation, one answer, recomputed whenever the grid under it moves.
  };

  /**
   * The live counterpart to runCalculation: annotate and bin only the samples that arrived.
   *
   * runCalculation makes five passes over the whole log — two annotations, the rf_korr tuner, the
   * binning, and the route-agreement check — and at two flushes a second on a growing drive that is
   * what made the DS2 loop slow down as the run went on. Here the per-sample work is per-sample and
   * the rest is O(cells), so a flush costs the same at minute ten as at minute one.
   *
   * TWO things are deliberately NOT done here, and both are done at STOP instead:
   *
   *  - **The rf_korr tuner.** It reads the whole log by nature, and its output feeds back into the
   *    binning per sample — so a table that changed mid-run would make the grid a mixture of two
   *    calibrations with no way to unpick it. Live binning therefore uses the nominal correction.
   *  - **Route agreement.** A whole-log statistic; nothing reads it during a run.
   *
   * So the map on screen during a run is the nominal one. The map that gets SAVED or WRITTEN is not
   * this one: finishLog runs the full runCalculation once, and that is the pass whose output leaves
   * the app. Live is allowed to be an approximation; the artefact is not.
   */
  const appendCalculation = (map: VEMap, processed: ProcessedLog, options: VeCalcOptions = {}) => {
    const calc = new VECalculator();
    const st = liveRef.current;
    // A new log, a new map, or a reprocess that shortened the valid set: start over. Cheap to
    // detect and the only way a stale grid could survive into a different drive.
    if (!st || st.map !== map || processed.data.length < st.consumed) {
      liveRef.current = { map, grid: calc.createGrid(), consumed: 0, annotated: [] };
    }
    const live = liveRef.current!;
    const plan = resolveRfKorr(options);
    for (let i = live.consumed; i < processed.data.length; i++) {
      const point = calc.annotateRfKorrPoint(map, processed.data[i], options.egt, options.rfKorrAir);
      live.annotated.push(point);
      // `null`, not options.tunedRfKorr — see the note above about mixing two calibrations.
      // Same reference as the batch path, or a live flush and the STOP pass would build
      // different maps from one drive. verify:incremental asserts they agree.
      calc.accumulatePoint(live.grid, point, plan, null, options.normaliseTo);
    }
    live.consumed = processed.data.length;

    // Measured over the whole run so far, not the increment: the panel says what this DRIVE would
    // be restated by, and a per-flush figure would jitter with whatever the last half second held.
    setChargeTempInfo({
      ...summariseChargeTemp(processed.data, options.normaliseTo ?? null, !!options.normaliseTo),
      rfKorrMeasured: live.annotated.filter(p => p.rfKorr !== undefined).length,
      rfKorrCandidates: live.annotated.filter(p => p.rf !== undefined).length,
    });

    const result = calc.finalizeGrid(map, live.grid, { ...options, tunedRfKorr: null });
    // A fresh array, not the accumulator itself. Handing back the same object every flush would
    // make React see no change, and any memoised child keyed on it would stop updating mid-run.
    // It is a copy of references, not of samples — cheap next to the work it protects.
    setAnnotatedLog([...live.annotated]);
    setNewMap(result.newMap);
    setMapData(result.diffMap);
    setHitMap(result.hitMap);
    setCorrectionMap(result.correctionMap);
    setWeightMap(result.weightMap);
    setAcceptedMap(result.acceptedMap);
    setRejectMap(result.rejectMap);
    setDemandMap(result.demandMap);
    setRfKorrMap(result.rfKorrMap);
    setRfKorrSpreadMap(result.rfKorrSpreadMap);
    setCoverage(result.coverage);

    // The census, not the table. `rfKorrData` is the tuner's own sample set (it skips the transient
    // test the VE map needs), so it has to be annotated separately — and re-annotated whole, which
    // is O(n) of plain arithmetic on a few thousand rows a couple of times a second. That is nothing
    // beside what it prevents: driving for seven minutes to be told afterwards that none of it
    // counted. The same argument the inertia side already made for recomputing rather than
    // accumulating, and the same conclusion.
    if (options.egt) {
      const annR = calc.annotateRfKorr(map, processed.rfKorrData, options.egt);
      setRfKorrLive(rfKorrCensus(annR, options.egt,
        { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD },
        options.rfKorrThresholds ?? {}).report);
    }
  };

  const reset = () => {
    liveRef.current = null;
    // With the log, so a new workspace cannot inherit the last drive's verdict.
    setDriveSplit(null);
    setNewMap(null);
    setWeightMap(null);
    setAcceptedMap(null);
    // Both were missing here. A stale rejectMap only mislabels a cleared map; a stale demandMap
    // would let the SHAPE tab call a map converged on numbers from a drive that is no longer loaded.
    setRejectMap(null);
    setDemandMap(null);
    setHitMap(null);
    setCorrectionMap(null);
    setRfKorrMap(null);
    setRfKorrSpreadMap(null);
    setAnnotatedLog(null);
    setTunedRfKorr(null);
    setRouteAgreement(undefined);
    setCoverage(null);
    setRfKorrLive(null);
  };

  return {
    newMap,
    mapData,
    hitMap,
    correctionMap,
    weightMap,
    acceptedMap,
    rejectMap,
    demandMap,
    rfKorrMap,
    rfKorrSpreadMap,
    coverage,
    rfKorrLive,
    chargeTempInfo,
    annotatedLog,
    driveSplit,
    tunedRfKorr,
    routeAgreement,
    runCalculation,
    appendCalculation,
    reset,
  };
}
