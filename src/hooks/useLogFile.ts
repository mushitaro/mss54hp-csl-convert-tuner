import { useEffect, useMemo, useState } from 'react';
import { parseLogFile } from '@/lib/log-engine/parser';
import { processLogData } from '@/lib/log-engine/filter';
import { ProcessedLog, LogDataPoint, LogFilterConfig, InterpolationPoint } from '@/lib/types';
import { APP_CONFIG } from '@/config/constants';

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

  const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);

  // A new log invalidates any row that was selected in the previous one.
  useEffect(() => {
    setSelectedLogIndex(null);
  }, [processedLog]);

  /**
   * The whole log. There used to be a 2000-point window with a scrub slider in front of it, and it
   * was wrong twice over.
   *
   * It never worked: Plotly keeps a user's zoom until the layout it is handed offers something to
   * revert to, and the layout supplied no xaxis range or autorange. So after any trackpad zoom the
   * axis stayed pinned while the window slid underneath it — the data changed and the picture did
   * not. Below 2000 points (most runs) the slider could not move at all, which hid the rest.
   *
   * And it bought nothing: a line trace collapses to one SVG path however many points it holds.
   * Measured at 20,000 points across five traces, a full Plotly.react is ~32 ms and a pan ~9 ms.
   * Navigation is the trackpad's job — dragmode 'pan' and scrollZoom are already on.
   */
  const displayedLogData = useMemo(() => processedLog?.data ?? [], [processedLog]);

  // Parses a new CSV file, sets raw+processed state, and returns the processed result
  const parseAndSetLog = async (file: File): Promise<ProcessedLog | null> => {
    const text = await file.text();
    const rawData = parseLogFile(text);

    if (rawData.length === 0) {
      alert('No valid data found in CSV.');
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
    setSelectedLogIndex(null);
  };

  return {
    logFile,
    rawLogData,
    processedLog,
    filterConfig,
    interpolationTable,
    selectedLogIndex,
    setSelectedLogIndex,
    displayedLogData,
    parseAndSetLog,
    loadRawLog,
    reprocess,
    reprocessWithTable,
    clear,
  };
}
