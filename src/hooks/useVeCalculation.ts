import { useEffect, useState } from 'react';
import { VECalculator, VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { tuneRfKorrTable, RfKorrTuneResult } from '@/lib/ve-calculator/rfKorrTuner';
import { rfKorrRouteAgreement, RfKorrRouteAgreement } from '@/lib/ve-calculator/rfKorrRoutes';
import { VEMap, LogDataPoint, ProcessedLog } from '@/lib/types';
import { MAP_DIMENSIONS, CSL_STOCK_WOT_RPM, CSL_STOCK_WOT_LOAD, APP_CONFIG } from '@/config/constants';

export function useVeCalculation() {
  const [newMap, setNewMap] = useState<VEMap | null>(null);
  const [mapData, setMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
  const [hitMap, setHitMap] = useState<number[][] | null>(null);
  const [correctionMap, setCorrectionMap] = useState<number[][] | null>(null);
  const [weightMap, setWeightMap] = useState<number[][] | null>(null);

  // Measured EGT correction. `rfKorrMap` is the weighted-mean rf_korr each cell's samples were
  // taken under; `rfKorrSpreadMap` is max-min within the cell, which is the number that says
  // whether the cell is trustworthy: a cell built entirely at rf_korr 1.00 is clean, and one that
  // mixes 1.00 with 1.30 is averaging two different operating conditions into a single VE value.
  const [rfKorrMap, setRfKorrMap] = useState<number[][] | null>(null);
  const [rfKorrSpreadMap, setRfKorrSpreadMap] = useState<number[][] | null>(null);
  // The log with `rfKorr` filled in per row — what the table and chart should show, since the
  // measurement needs the Alpha-N map and the log pipeline alone does not have it.
  const [annotatedLog, setAnnotatedLog] = useState<LogDataPoint[] | null>(null);

  // The back-calculated KF_RF_KORR_DRREL. Derived on every run where the binary's tables could be
  // read and the log carries an exhaust temperature, REGARDLESS of what the session asks to be
  // done with it: choosing not to act on the result is not a reason to be unable to look at it.
  const [tunedRfKorr, setTunedRfKorr] = useState<RfKorrTuneResult | null>(null);

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
  const [warmupMap, setWarmupMap] = useState<VEMap | null>(null);
  const [wotMap, setWotMap] = useState<VEMap | null>(null);

  // [EXPERIMENTAL] Auto-gen Warmup Map Effect
  useEffect(() => {
    if (newMap) {
      try {
        const calc = new VECalculator();
        const wMap = calc.generateWarmupMap(newMap);
        setWarmupMap(wMap);

        const wotData = calc.generateWOTMap(newMap);
        setWotMap({
          xAxis: CSL_STOCK_WOT_RPM,
          yAxis: CSL_STOCK_WOT_LOAD,
          data: wotData
        });
      } catch (e) {
        console.error("Failed to gen experimental maps", e);
      }
    } else {
      setWarmupMap(null);
      setWotMap(null);
    }
  }, [newMap]);

  const runCalculation = (map: VEMap, processed: ProcessedLog, options: VeCalcOptions = {}) => {
    const calc = new VECalculator();
    // Measure rf_korr first: the calculation reads point.rfKorr, and the UI shows the same numbers,
    // so both have to come from one pass rather than being derived twice with a chance to diverge.
    const annotated = calc.annotateRfKorr(map, processed.data, options.egt);
    // Between the two: the tuner reads the annotated log and the VE calculation may go on to
    // consume the tuner's output, so this is the only order in which one pass can serve all three.
    //
    // The tuner gets a DIFFERENT set of samples — rfKorrData, which skips the transient test. The
    // correction only runs above 55-80 % filling, which on this engine only happens while the car
    // is accelerating, so the VE map's steady-state requirement removes essentially all of it: on
    // the first real drive, 97 % of the gate-open samples. Annotated separately rather than by
    // re-filtering the annotated log, because `annotated` must stay index-aligned with
    // processed.data for the log table and chart.
    const annotatedForRfKorr = calc.annotateRfKorr(map, processed.rfKorrData, options.egt);
    const rfKorr = options.egt
      ? tuneRfKorrTable(map, annotatedForRfKorr, options.egt,
        { rpm: APP_CONFIG.MSS54HP.AXIS_RPM, load: APP_CONFIG.MSS54HP.AXIS_LOAD })
      : null;
    // The tuned table comes from THIS run, not from the caller. It is derived from the same log
    // the map is about to be built from, so passing it in would mean the caller had to run the
    // tuner first and the two could describe different drives.
    const result = calc.calculateNewVEMap(map, annotated, { ...options, tunedRfKorr: rfKorr });

    setAnnotatedLog(annotated);
    setTunedRfKorr(rfKorr);
    setRouteAgreement(rfKorrRouteAgreement(annotatedForRfKorr, options.egt));
    setNewMap(result.newMap);
    setMapData(result.diffMap); // Use mapData for diffMap
    setHitMap(result.hitMap);
    setCorrectionMap(result.correctionMap);
    setWeightMap(result.weightMap);
    setRfKorrMap(result.rfKorrMap);
    setRfKorrSpreadMap(result.rfKorrSpreadMap);

    // [EXPERIMENTAL] Auto-gen Warmup Map for Visualization
    try {
      const wMap = calc.generateWarmupMap(result.newMap);
      setWarmupMap(wMap);
    } catch (e) {
      console.error("Failed to gen warmup map", e);
    }
  };

  const reset = () => {
    setNewMap(null);
    setWeightMap(null);
    setWarmupMap(null);
    setHitMap(null);
    setCorrectionMap(null);
    setRfKorrMap(null);
    setRfKorrSpreadMap(null);
    setAnnotatedLog(null);
    setTunedRfKorr(null);
    setRouteAgreement(undefined);
  };

  return {
    newMap,
    mapData,
    hitMap,
    correctionMap,
    weightMap,
    rfKorrMap,
    rfKorrSpreadMap,
    annotatedLog,
    tunedRfKorr,
    routeAgreement,
    warmupMap,
    wotMap,
    runCalculation,
    reset,
  };
}
