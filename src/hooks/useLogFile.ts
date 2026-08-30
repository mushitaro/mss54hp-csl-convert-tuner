import { useCallback, useMemo, useRef, useState } from 'react';
import { parseLogFile } from '@/lib/log-engine/parser';
import { processLogData } from '@/lib/log-engine/filter';
import { ProcessedLog, LogDataPoint, LogFilterConfig, InterpolationPoint, TRANSIENT_SETTLE_SEC_DEFAULT } from '@/lib/types';
import { VE_MIN_WEIGHT_DEFAULT } from '@/lib/ve-calculator/calculator';
import type { LambdaLimits } from '@/lib/log-engine/lambdaGates';
import { APP_CONFIG } from '@/config/constants';
import { dialogText } from '@/lib/dialog-text';

const LOG_WINDOW_SIZE = 2000;

const DEFAULT_FILTER_CONFIG: LogFilterConfig = {
  enableCorrection: true,
  enableMinTemp: true,
  minTemp: 65,
  enableTransient: true,
  transientWindow: 4,
  // Stated, and it was not. Without it every NEW session took the legacy sample-count path — which
  // means the wait was 4 samples, i.e. 1.4 s at 2.95 Hz and 0.6 s at 6.6 Hz: a different physical
  // requirement per link speed, on a filter whose whole job is "has the DME finished adjusting".
  // The absence is only meant to describe sessions saved BEFORE the setting existed, and it was
  // describing every session there is.
  transientSettleSec: TRANSIENT_SETTLE_SEC_DEFAULT,
  // Stated, and it was not: absent used to mean 0 and now means 2.5, so a session saved without it
  // re-derives under a bar it was never built with. New sessions carry the value they used.
  minVeCellWeight: VE_MIN_WEIGHT_DEFAULT,
  // OFF by default, and the reason is that the premise did not survive measurement.
  //
  // The wait was justified by rf_korr STEPPING when filling crosses the EGT-correction floor while
  // the trim walks after it. Measured on #928 and #929 with the filling held to 75-85 %RF, rf_korr
  // moves about 3 % across a pull while `trim x rf_korr` moves 7-9 % — so the walk is the lambda
  // integrator settling after a load step, which is the TRANSIENT test's job, and that test is now
  // sized at the loop's own response time.
  //
  // Six seconds of it was also being charged to the wrong stream: `rfKorrData` is collected before
  // this gate runs, so the rf_korr derivation never paid it and the VE map paid all of it. On
  // session #931 it refused 158 samples of a 15-minute drive.
  //
  // Still available, and it belongs to RF KORR work — see LogFilterConfig.highLoadSettleSec.
  highLoadSettleSec: 0,
  rpmStableThreshold: 10,
  tpsStableThreshold: 5,
};

export function useLogFile() {
  const [logFile, setLogFile] = useState<File | null>(null);
  const [rawLogData, setRawLogData] = useState<LogDataPoint[] | null>(null);
  const [processedLog, setProcessedLog] = useState<ProcessedLog | null>(null);
  const [filterConfig, setFilterConfig] = useState<LogFilterConfig>(DEFAULT_FILTER_CONFIG);
  const [interpolationTable, setInterpolationTable] = useState<InterpolationPoint[]>(APP_CONFIG.MSS54HP.INTERPOLATION_TABLE);
  /**
   * The lambda-shutdown thresholds of the binary this log belongs to.
   *
   * Held here for the same reason `filterConfig` is: every later re-process has to use the same
   * ones, or dragging a filter would silently re-derive the tune against a different set of gates
   * than produced it. Null until a binary is loaded, and null means those gates do not run.
   */
  const [lambdaLimits, setLambdaLimits] = useState<LambdaLimits | null>(null);

  const [logWindowStart, setLogWindowStart] = useState<number>(0);
  const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);

  /**
   * The same values again, readable from a closure that was built several renders ago.
   *
   * This is not caching — it is the difference between the live path working and silently not
   * working. `appendRawLog` is reached from the poll loop's sample callback, which `startTuning`
   * captured once when START TUNE was pressed. Everything it read as a variable was therefore
   * frozen at that instant: `processedLog` was null, so the resume it looked for was never there,
   * and every flush of the run re-filtered the whole drive — the exact O(n)-per-flush cost the
   * resume exists to remove. `filterConfig` and `interpolationTable` were frozen too, so a filter
   * dragged mid-run was ignored by every append that followed.
   *
   * Written where the state is written, not from an effect. The flush interval is 500 ms so a
   * commit would in fact land in time, but "in time" is a scheduling assumption and this is a
   * correctness property; assigning both in one place makes it one.
   */
  const latest = useRef({
    processedLog, rawLogData, logFile, filterConfig, interpolationTable, lambdaLimits,
  });
  const publishProcessed = (log: ProcessedLog | null) => {
    latest.current.processedLog = log;
    setProcessedLog(log);
  };
  const publishRaw = (data: LogDataPoint[] | null) => {
    latest.current.rawLogData = data;
    setRawLogData(data);
  };
  const publishFile = (file: File | null) => {
    latest.current.logFile = file;
    setLogFile(file);
  };
  const publishConfig = (config: LogFilterConfig) => {
    latest.current.filterConfig = config;
    setFilterConfig(config);
  };
  const publishTable = (table: InterpolationPoint[]) => {
    latest.current.interpolationTable = table;
    setInterpolationTable(table);
  };
  const publishLimits = useCallback((limits: LambdaLimits | null) => {
    latest.current.lambdaLimits = limits;
    setLambdaLimits(limits);
  }, []);

  /**
   * Puts the scrub position and the selected row back to the start of a NEW log.
   *
   * Called from the four places that replace the log, rather than from an effect on `processedLog`.
   * The effect fired on every result — and a live run produces a new result twice a second, so the
   * window snapped back to zero and the selected row was cleared on every flush, for the whole
   * drive. An append is the same log a little longer; only a replacement is a new log.
   */
  const resetView = () => {
    setLogWindowStart(0);
    setSelectedLogIndex(null);
  };

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

    publishRaw(rawData);
    const processed = processLogData(rawData, file.name, filterConfig, interpolationTable, lambdaLimits);
    publishFile(file);
    publishProcessed(processed);
    resetView();
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
    /** Same override-and-adopt rule as `config` and `table` above, and needed for the same reason:
     *  a caller that has just swapped the binary is still in a scope where `lambdaLimits` holds the
     *  PREVIOUS one, because setState only scheduled the change. */
    limits?: LambdaLimits | null,
  ): ProcessedLog | null => {
    if (rawData.length === 0) return null;
    const cfg = config ?? latest.current.filterConfig;
    const tbl = table ?? latest.current.interpolationTable;
    const lim = limits !== undefined ? limits : latest.current.lambdaLimits;
    if (config) publishConfig(config);
    if (table) publishTable(table);
    if (limits !== undefined) publishLimits(limits);

    const file = new File([], fileName);
    publishRaw(rawData);
    const processed = processLogData(rawData, fileName, cfg, tbl, lim);
    publishFile(file);
    publishProcessed(processed);
    resetView();
    return processed;
  };

  /**
   * The live path: the same log, a few samples longer.
   *
   * Resumes from the previous result instead of re-filtering the drive, which is what stops the
   * sample rate falling as the run goes on. Everything else — a CSV import, reopening a session,
   * dragging a filter — starts fresh, because those are the cases where the whole log genuinely has
   * to be reconsidered.
   *
   * Correctness comes from the resume being a continuation of the SAME loop rather than a second
   * implementation of it (see FilterResume), and the resume is taken from whatever produced the
   * current result — so a mid-run filter change reprocesses in full and the next append simply
   * carries on from that.
   */
  const appendRawLog = (rawData: LogDataPoint[], fileName: string): ProcessedLog | null => {
    if (rawData.length === 0) return null;
    const state = latest.current;
    const prior = state.processedLog?.resume;
    // A resume is only valid against the log it was taken from, and BOTH halves of that are needed.
    // The length test catches an array that got shorter; the identity test catches a DIFFERENT log
    // that happens to be longer than the prefix — which passes the length test, starts the loop past
    // the end of the new drive, and keeps the old drive's filtered samples. See FilterResume.
    const usable = prior && prior.logId === fileName && rawData.length >= prior.consumed ? prior : undefined;
    publishRaw(rawData);
    const processed = processLogData(
      rawData, fileName, state.filterConfig, state.interpolationTable, state.lambdaLimits, usable);
    publishProcessed(processed);
    return processed;
  };

  // Re-processes the currently-loaded raw data with a new filter config
  const reprocess = (newConfig: LogFilterConfig): ProcessedLog | null => {
    publishConfig(newConfig);
    const { rawLogData: raw, logFile: file, interpolationTable: tbl, lambdaLimits: lim } = latest.current;
    if (raw && file) {
      const processed = processLogData(raw, file.name, newConfig, tbl, lim);
      publishProcessed(processed);
      return processed;
    }
    return null;
  };

  // Re-processes the currently-loaded raw data with a new interpolation table
  const reprocessWithTable = (newTable: InterpolationPoint[]): ProcessedLog | null => {
    publishTable(newTable);
    const { rawLogData: raw, logFile: file, filterConfig: cfg, lambdaLimits: lim } = latest.current;
    if (raw && file) {
      const processed = processLogData(raw, file.name, cfg, newTable, lim);
      publishProcessed(processed);
      return processed;
    }
    return null;
  };

  const clear = () => {
    publishFile(null);
    publishRaw(null);
    publishProcessed(null);
    resetView();
  };

  return {
    logFile,
    rawLogData,
    processedLog,
    filterConfig,
    interpolationTable,
    lambdaLimits,
    setLambdaLimits: publishLimits,
    logWindowStart,
    setLogWindowStart,
    maxWindowStart,
    panWindow,
    selectedLogIndex,
    setSelectedLogIndex,
    windowedLogData,
    LOG_WINDOW_SIZE,
    parseAndSetLog,
    appendRawLog,
    loadRawLog,
    reprocess,
    reprocessWithTable,
    clear,
  };
}
