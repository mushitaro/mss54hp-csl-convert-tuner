import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseLogFile } from '@/lib/log-engine/parser';
import { processLogData } from '@/lib/log-engine/filter';
import { ProcessedLog, LogDataPoint, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { APP_CONFIG } from '@/config/constants';
import { dialogText } from '@/lib/dialog-text';

const LOG_WINDOW_SIZE = 2000;

const DEFAULT_FILTER_CONFIG: LogFilterConfig = {
  enableCorrection: true,
  enableMinTemp: true,
  minTemp: 65,
  enableIdle: true,
  idleRpm: 1000,
  enableTransient: true,
  transientWindow: 4,
  rpmStableThreshold: 10,
  tpsStableThreshold: 5,
};

export function useLogFile() {
  const [logFile, setLogFile] = useState<File | null>(null);
  const [rawLogData, setRawLogData] = useState<LogDataPoint[] | null>(null);
  const [processedLog, setProcessedLog] = useState<ProcessedLog | null>(null);
  const [filterConfig, setFilterConfig] = useState<LogFilterConfig>(DEFAULT_FILTER_CONFIG);
  const [interpolationTable, setInterpolationTable] = useState<InterpolationPoint[]>(APP_CONFIG.MSS54HP.INTERPOLATION_TABLE);

  const [logWindowStart, setLogWindowStart] = useState<number>(0);
  const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);

  // Reset window when file changes
  useEffect(() => {
    setLogWindowStart(0);
    setSelectedLogIndex(null);
  }, [processedLog]);

  /**
   * `selectedLogIndex` is an index into the WHOLE log, not into the window.
   *
   * It used to be window-relative, which forced a reset on every scrub: the same number meant a
   * different row once the window moved, so keeping it would have silently mis-marked the data. That
   * reset is why the reference line vanished the moment you slid — the selection was being thrown
   * away, not just scrolled off.
   *
   * Absolute, it simply survives. The two views convert to their own local index where they render,
   * and a selection outside the current window is a selection you cannot see yet rather than one
   * that has been lost.
   */

  /**
   * The shared data window — the one thing the chart and the row table are both looking at.
   *
   * This is the load-bearing idea of the log view, and removing it broke the pairing outright: the
   * chart was given the whole log while the table kept its own 2,000-row cap, so the two stopped
   * indexing the same array and clicking a point past row 2,000 addressed a row that was never
   * rendered. One window, two views, one index space — anything that moves the view has to move THIS,
   * not a per-view range.
   */
  const windowedLogData = useMemo(() => {
    if (!processedLog) return [];
    return processedLog.data.slice(logWindowStart, logWindowStart + LOG_WINDOW_SIZE);
  }, [processedLog, logWindowStart]);

  /** Furthest the window can start and still be full — the slider's max, and the clamp every other
   *  input (trackpad pan) has to respect so the two can never disagree about the limits. */
  const maxWindowStart = Math.max(0, (processedLog?.data.length ?? 0) - LOG_WINDOW_SIZE);

  /** Moves the window by a signed number of points, clamped. The single entry point for "scroll the
   *  view", so the slider and the trackpad are the same operation with different hardware.
   *
   *  useCallback is not decoration here: this is passed to the chart, which is React.memo'd so the
   *  per-sample re-render during a live log stops at its boundary. A fresh function identity every
   *  render would defeat that memo and drag a full Plotly pass along with every sample. */
  const panWindow = useCallback((deltaPoints: number) => {
    setLogWindowStart(prev => Math.max(0, Math.min(maxWindowStart, Math.round(prev + deltaPoints))));
  }, [maxWindowStart]);

  // Parses a new CSV file, sets raw+processed state, and returns the processed result
  const parseAndSetLog = async (file: File): Promise<ProcessedLog | null> => {
    const text = await file.text();
    const rawData = parseLogFile(text);

    if (rawData.length === 0) {
      alert(dialogText().noValidCsvData);
      return null;
    }

    setRawLogData(rawData);
    const processed = processLogData(rawData, file.name, filterConfig, interpolationTable);
    setLogFile(file);
    setProcessedLog(processed);
    return processed;
  };

  // Loads previously-saved raw log data (e.g. from the session DB) as if it had just been parsed
  // from a CSV.
  //
  // When restoring a saved session, pass its stored config/table: they are adopted as hook state,
  // not just handed to this one call. processLogData is pure, but every later re-process reads the
  // state — so without adopting them the panels would still show the defaults and the first filter
  // touch would silently re-derive the tune with settings that never produced it.
  const loadRawLog = (
    rawData: LogDataPoint[],
    fileName: string,
    config?: LogFilterConfig,
    table?: InterpolationPoint[],
  ): ProcessedLog | null => {
    if (rawData.length === 0) return null;
    const cfg = config ?? filterConfig;
    const tbl = table ?? interpolationTable;
    if (config) setFilterConfig(config);
    if (table) setInterpolationTable(table);

    const file = new File([], fileName);
    setRawLogData(rawData);
    const processed = processLogData(rawData, fileName, cfg, tbl);
    setLogFile(file);
    setProcessedLog(processed);
    return processed;
  };

  // Re-processes the currently-loaded raw data with a new filter config
  const reprocess = (newConfig: LogFilterConfig): ProcessedLog | null => {
    setFilterConfig(newConfig);
    if (rawLogData && logFile) {
      const processed = processLogData(rawLogData, logFile.name, newConfig, interpolationTable);
      setProcessedLog(processed);
      return processed;
    }
    return null;
  };

  // Re-processes the currently-loaded raw data with a new interpolation table
  const reprocessWithTable = (newTable: InterpolationPoint[]): ProcessedLog | null => {
    setInterpolationTable(newTable);
    if (rawLogData && logFile) {
      const processed = processLogData(rawLogData, logFile.name, filterConfig, newTable);
      setProcessedLog(processed);
      return processed;
    }
    return null;
  };

  const clear = () => {
    setLogFile(null);
    setRawLogData(null);
    setProcessedLog(null);
    setLogWindowStart(0);
    setSelectedLogIndex(null);
  };

  return {
    logFile,
    rawLogData,
    processedLog,
    filterConfig,
    interpolationTable,
    logWindowStart,
    setLogWindowStart,
    maxWindowStart,
    panWindow,
    selectedLogIndex,
    setSelectedLogIndex,
    windowedLogData,
    LOG_WINDOW_SIZE,
    parseAndSetLog,
    loadRawLog,
    reprocess,
    reprocessWithTable,
    clear,
  };
}
