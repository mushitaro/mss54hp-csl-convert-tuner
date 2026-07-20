import { useEffect, useState } from 'react';
import { VECalculator } from '@/lib/ve-calculator/calculator';
import { VEMap, LogDataPoint } from '@/lib/types';
import { MAP_DIMENSIONS, CSL_STOCK_WOT_RPM, CSL_STOCK_WOT_LOAD } from '@/config/constants';

export function useVeCalculation() {
  const [newMap, setNewMap] = useState<VEMap | null>(null);
  const [mapData, setMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
  const [hitMap, setHitMap] = useState<number[][] | null>(null);
  const [correctionMap, setCorrectionMap] = useState<number[][] | null>(null);
  const [weightMap, setWeightMap] = useState<number[][] | null>(null);

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

  const runCalculation = (map: VEMap, data: LogDataPoint[]) => {
    const calc = new VECalculator();
    const result = calc.calculateNewVEMap(map, data);

    setNewMap(result.newMap);
    setMapData(result.diffMap); // Use mapData for diffMap
    setHitMap(result.hitMap);
    setCorrectionMap(result.correctionMap);
    setWeightMap(result.weightMap);

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
  };

  return {
    newMap,
    mapData,
    hitMap,
    correctionMap,
    weightMap,
    warmupMap,
    wotMap,
    runCalculation,
    reset,
  };
}
