import { useEffect, useState } from 'react';
import { VECalculator, VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { VEMap, LogDataPoint } from '@/lib/types';
import { MAP_DIMENSIONS, CSL_STOCK_WOT_RPM, CSL_STOCK_WOT_LOAD } from '@/config/constants';

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

  const runCalculation = (map: VEMap, data: LogDataPoint[], options: VeCalcOptions = {}) => {
    const calc = new VECalculator();
    // Measure rf_korr first: the calculation reads point.rfKorr, and the UI shows the same numbers,
    // so both have to come from one pass rather than being derived twice with a chance to diverge.
    const annotated = calc.annotateRfKorr(map, data, options.mapCompensationOff === true);
    const result = calc.calculateNewVEMap(map, annotated, options);

    setAnnotatedLog(annotated);
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
    warmupMap,
    wotMap,
    runCalculation,
    reset,
  };
}
