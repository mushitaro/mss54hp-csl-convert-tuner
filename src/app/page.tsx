'use client';

import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic'; // Added dynamic import
import { ChartLoading } from '@/components/ChartLoading';
import { DropZone, ACCEPT_CSV } from '@/components/DropZone';
import { MapEditor, COVERAGE_OK_DEFAULT } from '@/components/MapEditor';
import { RfKorrTable } from '@/components/RfKorrTable';

// Dynamic imports for heavy components
const MapVisualizer = dynamic(() => import('@/components/MapVisualizer').then(mod => mod.MapVisualizer), { ssr: false, loading: () => <ChartLoading /> });
const LogTimeSeriesChart = dynamic(() => import('@/components/LogTimeSeriesChart').then(mod => mod.LogTimeSeriesChart), { ssr: false, loading: () => <ChartLoading /> });
import { FilterConfigPanel } from '@/components/FilterConfigPanel';
import { diffWindows } from '@/lib/dme-link/spotCheck';
import { DriveSplitChip } from '@/components/DriveSplitNotice';
import { TunedStatusBar } from '@/components/TunedStatusBar';
import { activeExclusion } from '@/lib/log-engine/driveSplit';
import { DropCensusLine } from '@/components/DropCensus';
import {
  type ProcessId, LOG_PROFILES, expectedHz, describeExchanges, missingPatches, deriveRoute,
  productionExchanges,
} from '@/lib/log-engine/logProfile';
import { InertiaWorkflow } from '@/components/InertiaWorkflow';
import { IdleWorkflow } from '@/components/IdleWorkflow';
import { WriteManifest, ManifestCorner, anythingArmed, type ManifestGroup } from '@/components/WriteManifest';
import {
  enabledTabs, featureEnabled, enabledDriveViews, DEV_VARIANT_IS_PREVIEW,
  type TabId, type FeatureName, type DriveView,
} from '@/lib/features';
import { CompareBar, type CompareOption } from '@/components/CompareBar';
import { CalibrationTab } from '@/components/calibration/CalibrationTab';
import { ValuePane } from '@/components/calibration/ValuePane';
import { CalibrationDiffList } from '@/components/calibration/CalibrationDiffList';
import { ParamInfo } from '@/components/calibration/ParamInfo';
import { useCalibrationWorkspace, useCalibrationCompare } from '@/components/calibration/useCalibrationWorkspace';
import { useCalibrationEdits } from '@/hooks/useCalibrationEdits';
import { useCalibrationData, useCalibrationDiff } from '@/hooks/useCalibrationData';
import { useCalVariantBuffers } from '@/hooks/useCalVariantBuffers';
import { armedWriterSpans, changedCellCount, type BulkOp, type CalEdit, type RunSpan } from '@/lib/calibration/edits';
import { readIdleTablesResult } from '@/lib/idle/idleTables';
import { useShapeWorkspace } from '@/components/shape/shapeWorkspace';
import { ShapeGrid } from '@/components/shape/ShapeGrid';
import { ShapeGraph } from '@/components/shape/ShapeGraph';
import { ShapeControls } from '@/components/shape/ShapeControls';
import { readAlphaNTables } from '@/lib/ve-calculator/alphaNTable';
import { composeVeGrid } from '@/lib/ve-calculator/composeVeGrid';
import { buildCoverage, coverageCensus } from '@/lib/ve-calculator/cellCoverage';
import type { ShapeRepairResult } from '@/lib/ve-calculator/lowLoadShape';
import { CoverageDetail } from '@/components/CoverageDetail';
import { trimNeutrality } from '@/lib/log-engine/trimNeutrality';
import { MANIFEST_TEXT, type RfKorrBlock } from '@/lib/manifest-text';
import { writtenVeGrid } from '@/lib/ve-calculator/composeVeGrid';
import { VECalculator, VE_METHOD_DEFAULT, DIRECT_MIN_SAMPLES, DIRECT_AUTHORITY_DEFAULT } from '@/lib/ve-calculator/calculator';
import { useDialogLang } from '@/hooks/useDialogLang';
import { tuneLowLoad } from '@/lib/ve-calculator/lowLoadTuner';
import { InterpolationTableEditor } from '@/components/InterpolationTableEditor';
import { LogDataTable } from '@/components/LogDataTable';
import { SessionList, OriginBadge, NewFromWhich } from '@/components/SessionList';
import { SessionStorePanel } from '@/components/SessionStorePanel';
import { canSync } from '@/lib/session-sync/client';
import type { SaveStatus } from '@/lib/session-sync/status';
import { describeSave, describeSync } from '@/lib/session-sync/status';
import type { WriteVerifyMode } from '@/lib/dme-link/types';
import { initialVerifyMode, recordQuickVerifyProven } from '@/lib/dme-link/verifyPolicy';
import { checkLineage } from '@/lib/lineage/preflight';
import { FieldVisibilityPanel } from '@/components/FieldVisibilityPanel';
import { AdaptationResetDialog } from '@/components/AdaptationResetDialog';
import { FlashCounterResetDialog } from '@/components/FlashCounterResetDialog';
import { DisclaimerDialog } from '@/components/DisclaimerDialog';
import { CreditsDialog } from '@/components/CreditsDialog';
import { MobileMenu, MENU_CELL } from '@/components/MobileMenu';
import { MessageDialog } from '@/components/MessageDialog';
import { MarkIcon } from '@/components/MarkIcon';
import { useAppUpdate, useUpdateRunning, reloadForUpdate } from '@/hooks/useAppUpdate';
import { UpdateOverlay } from '@/components/UpdateOverlay';
import { DownloadToast } from '@/components/DownloadToast';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useOnline } from '@/hooks/useOnline';
import { useWideLayout, useSplitGraph } from '@/hooks/useWideLayout';
import { useMapZoom } from '@/hooks/useMapZoom';
import { useSessionSync } from '@/hooks/useSessionSync';
import { useDiagnosticsPublisher } from '@/hooks/useDiagnosticsPublisher';
import { useAppDialogs } from '@/hooks/useAppDialogs';
import { useEdgeFade } from '@/hooks/useEdgeFade';
import { useFitScale } from '@/hooks/useFitScale';
import { HubProgressRing, TRANSFER_PHASE_STYLE } from '@/components/HubProgressRing';
import { AlertCircle, Download, FileCode, FileSpreadsheet, Zap, Play, Cpu, Trash2, Github, BookOpen, Medal, Shield, Square, Loader2, RotateCcw, RefreshCw, Eraser, PlugZap, Database, Upload, UploadCloud, Gauge } from 'lucide-react';
import { PROJECT_REPO_URL } from '@/config/links';
import { usePrivacyPolicyUrl } from '@/hooks/usePrivacyPolicyUrl';
import { isFieldPresent } from '@/lib/field-registry/registry';
import { LogFilterConfig, InterpolationPoint, LogDataPoint, ProcessedLog, resolveRfKorr } from '@/lib/types';
import type { VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { readEgtTables, type EgtTables } from '@/lib/ve-calculator/egtTables';
import { readRfPtKorrCurves, type RfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { bytesAsRun, patchOnImage, readLogicPatches, type LogicPatches } from '@/lib/binary-engine/patcher';
import { armedPatchesFromHistory, patchOnFlash } from '@/lib/db/flashState';
import {
  RF_KORR_COL_LABEL, RF_KORR_ROW_LABEL, rfKorrViewData, type RfKorrView,
} from '@/lib/ve-calculator/rfKorrView';
import { useBuildVariant, useIsPreviewBuild } from '@/lib/build-variant';
import { TuningSession, TuneSettings, BaseOrigin } from '@/lib/db/schema';
import { AdaptationSnapshot, FlashCounterInfo } from '@/lib/dme-link/types';
import { ServiceBlockLayout, classifyFlashCounter } from '@/lib/dme-link/flashCounter';
import { TUNE_ADAPTATION_CLEAR, Ds2SupportedBaud } from '@/lib/dme-link/ds2';
import { saveServiceBackup, listRestorableBackups, loadServiceBackup } from '@/lib/db/serviceBackupRepository';
import { discardLiveRun, findRecoverableRun, loadLiveRunPoints } from '@/lib/db/liveRunRepository';
import { downloadBlob, fileSafe, MIME_BIN, MIME_CSV, MIME_JSON } from '@/lib/download';
import { dialogText } from '@/lib/dialog-text';
import { isAndroidPlatform } from '@/lib/dme-link/byteTransport';
import { serializeLogFile } from '@/lib/log-engine/serializer';
import { sampleRateHz } from '@/lib/log-engine/rate';
import { sha256Hex } from '@/lib/db/sessionRepository';
import { useBinaryFile, type PatchExtras } from '@/hooks/useBinaryFile';
import { useLogFile } from '@/hooks/useLogFile';
import { useVeCalculation } from '@/hooks/useVeCalculation';
import { useComparison, type MapVariant } from '@/hooks/useComparison';
import { useSessionDb } from '@/hooks/useSessionDb';
import { useFieldVisibility } from '@/hooks/useFieldVisibility';
import { useDmeLink } from '@/hooks/useDmeLink';
import { useUnloadGuard } from '@/hooks/useUnloadGuard';
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';
import { useHiddenWitness } from '@/hooks/useHiddenWitness';
import { useDisclaimer } from '@/hooks/useDisclaimer';
import { useLiveRun } from '@/hooks/useLiveRun';
import { LiveTelemetryStrip } from '@/components/LiveTelemetryStrip';
import { LiveDriveStrip } from '@/components/LiveDriveStrip';
import { MapZoomButtons } from '@/components/MapZoomButtons';

// TabId moved to lib/features.ts, beside the registry that decides which tabs a variant renders.

/** The condition under which GRAPH is a destination of its own, as a Tailwind variant. Must stay
 *  identical to `SPLIT` in useWideLayout.ts — see the reasoning there.
 *
 *  One media query rather than two utilities (`hidden` plus a `min-[900px]:` override), because two
 *  media-query utilities of equal specificity are settled by the order Tailwind happens to emit
 *  them in, and this decides whether a control is reachable. Written out in full at each use so the
 *  scanner sees a literal — an interpolated class name is generated by nobody. */
const SPLIT_ONLY_HIDE = '[@media(max-width:899px)_and_(max-height:560px)]:hidden';
const SPLIT_ONLY_SHOW = 'hidden [@media(max-width:899px)_and_(max-height:560px)]:flex';
/** Let the control panel take the whole pane — only where it is the *only* thing in it.
 *
 *  `flex-initial` is right whenever the panel shares the pane with the 3D view: it takes what its
 *  controls need and never grows, so it cannot donate room to a picture that will stretch to fill
 *  whatever it is given. On a split layout there is nothing to share with — the picture has its own
 *  destination — and the leftover height was simply falling off the bottom, holding the hub 18px
 *  above centre at 683x400 and 43px at 720x450. Growing here hands that slack to the cluster, which
 *  already centres itself in whatever box it gets. */
const SPLIT_ONLY_GROW = '[@media(max-width:899px)_and_(max-height:560px)]:flex-1';

/**
 * What arming PATCH does to the evaporative purge valve, in the reader's terms.
 *
 * RED among the readouts, and that is deliberate: MAP and LTFT are calibration changes you drive
 * away from; this one leaves an emissions device switched off. Measured on this car (Session #902)
 * the valve was open for 82.8 % of a 657 s drive at up to 99.9 % duty; Session #904, with this
 * armed, read TETV = 0 on all 1260 samples.
 * The copy itself is `MANIFEST_TEXT.tankVentNote` — this note is the ARGUMENT for it, which is not
 * a thing to translate.
 */

export default function Home() {
  /** The manifest's explanations follow the reader; its control names never do. See manifest-text. */
  const manifestText = MANIFEST_TEXT[useDialogLang()];
  const binaryFileState = useBinaryFile();
  const logFileState = useLogFile();
  const veCalc = useVeCalculation();
  const sessionDb = useSessionDb();
  const fieldVisibility = useFieldVisibility();
  const dmeLink = useDmeLink();
  /**
   * The low-opening derivation, and THE tuned map both derivations compose into.
   *
   * Up here, ahead of `useComparison`, because of what that fixes: `newMap` used to be the VE
   * calculator's output alone, and the low-opening cells were merged only inside
   * `buildPatchedBuffer` — at download/flash time. So TUNED MAP and DIFFERENCE % rendered a grid
   * that was NOT the grid the WRITE would send. On session #920 the difference is the whole story:
   * VE earns 4 cells and the low-opening band earns 48, so a 52-minute drive looked like it had
   * changed almost nothing while 92 % of its result sat in a table nobody could see. A tab called
   * TUNED MAP has to show the map that gets written.
   *
   * `buildPatchedBuffer` still composes, and that stays correct: it overwrites the owned cells with
   * the same values they already hold here, so composing twice is the same as composing once.
   */
  const alphaNTables = useMemo(
    () => (binaryFileState.binaryBuffer ? readAlphaNTables(binaryFileState.binaryBuffer) : null),
    [binaryFileState.binaryBuffer]);
  const lowLoadResult = useMemo(() => {
    const map = binaryFileState.currentMap;
    const log = logFileState.processedLog;
    if (!alphaNTables || !log?.data?.length || !map) return null;
    return tuneLowLoad(log.data, alphaNTables, map);
  }, [alphaNTables, logFileState.processedLog, binaryFileState.currentMap]);
  /**
   * Composed regardless of whether ALPHA-N is armed, because this answers "what did this log
   * derive", not "what will be flashed" — the manifest answers the second, and with one toggle
   * arming both bands the two can no longer disagree about which half goes.
   */
  const tunedMap = useMemo(() => {
    const ve = veCalc.newMap;
    const arm = lowLoadResult?.acceptable
      ? { grid: lowLoadResult.tuned, owned: lowLoadResult.owned } : null;
    const composed = composeVeGrid(ve?.data ?? null, arm);
    if (!composed) return ve;
    const axes = ve ?? binaryFileState.currentMap;
    return axes ? { xAxis: [...axes.xAxis], yAxis: [...axes.yAxis], data: composed.grid } : ve;
  }, [veCalc.newMap, lowLoadResult, binaryFileState.currentMap]);

  const comparison = useComparison(tunedMap, binaryFileState.initialMapData, sessionDb.sessions);

  /**
   * Make leaving the page deliberate while the DME is being written to, reset, or logged.
   *
   * Derived from the link state, never from a flag — see useUnloadGuard for why that distinction is
   * the whole safety argument. `writing` erases the data area before it writes and `resetting`
   * covers the flash-counter reset, which erases the VIN and AIF records; interrupting either leaves
   * the ECU in a state the app cannot put back. `tuning` is here for a cheaper reason: a reload ends
   * the run, and while the samples now survive it (liveRunRepository) the drive still has to be
   * repeated. Notably an HMR full reload goes through location.reload(), so this catches that too.
   *
   * `reading` is deliberately absent. It is non-destructive — interrupting it costs four minutes and
   * nothing else — and a guard that fires on harmless operations is one the user learns to dismiss
   * without reading, which is exactly what must not happen on the two states above.
   */
  const unloadGuarded =
    dmeLink.state === 'writing' || dmeLink.state === 'resetting' || dmeLink.state === 'tuning';
  // A flash is ~4 minutes and a reset ~2, so ten minutes is a generous ceiling for a bounded
  // operation that has hung. A data log is a drive: capping it at minutes would drop the guard
  // mid-run, so it gets a bound that only a genuinely stuck state could ever reach.
  useUnloadGuard(unloadGuarded, dmeLink.state === 'tuning' ? 6 * 60 * 60_000 : 10 * 60_000);
  /**
   * The two Android-shaped halves of the same problem, deliberately sharing `unloadGuarded` rather
   * than deriving their own condition — one definition of "an operation that must not be
   * interrupted", so a state added there cannot be missed here.
   *
   * The wake lock removes the failure that happens by itself (screen inactivity timeout mid-write).
   * The witness cannot prevent anything; it records whether the page was backgrounded, so a failure
   * can name that instead of looking like a cable fault. Both are no-ops on desktop.
   */
  useScreenWakeLock(unloadGuarded);
  const wasBackgrounded = useHiddenWitness(unloadGuarded);

  const [activeTab, setActiveTab] = useState<TabId>('startup');
  /** Bumped by the chart's FIT button. Folded into the plot's uirevision so Plotly drops the
   *  user's zoom and re-fits — the only way back, since doubleClick is off to keep
   *  click-to-select unambiguous. */
  const [chartFitToken, setChartFitToken] = useState(0);
  /** A tab to move to once it becomes reachable — see the effect that consumes it. */
  const pendingTabRef = useRef<TabId | null>(null);
  /** Every explicit navigation goes through here, so deliberately choosing a tab cancels an armed
   *  auto-move. Without it, a move armed by a run that produced nothing would fire later, on top of
   *  wherever the user had since sent themselves. */
  const goToTab = (id: TabId) => { pendingTabRef.current = null; setActiveTab(id); };

  /**
   * The datalog in progress — its samples, their durability, and the pace of everything downstream.
   *
   * `flush` is handed in on every render rather than captured, because it closes over the map, the
   * filters and the calculator, and all three can change while a run is going. See useLiveRun.
   */
  const liveRun = useLiveRun({ flush: (force, authoritative) => flushRef.current(force, authoritative) });
  const liveSamplesRef = liveRun.samplesRef;
  const liveExchangesRef = liveRun.exchangesRef;
  const hzValueRef = liveRun.hzValueRef;
  // Hub/wing cluster auto-fit: measures real available space vs. the cluster's natural size and
  // returns a transform scale, so it always fits (any viewport) instead of estimating from raw
  // window dimensions.
  // 0.8, not 0.4. The floor is what the cluster is actually rendered at on a short landscape phone —
  // it is not a rare worst case there, it is the normal case — and 0.4 put the 80px dial at 32px, the
  // arming toggles at 14x8 and the label that is the ONLY thing distinguishing READ from WRITE inside
  // that dial at 3.2px. A floor is a promise about the smallest a control may become; 0.4 was not a
  // promise anything could be operated at. The shortfall now falls on the visualizer above, which is
  // the half this panel already declares elastic.
  const { outerRef: clusterOuterRef, innerRef: clusterInnerRef, scale: clusterScale, minH: clusterMinH } = useFitScale(0.8);
  const tabStrip = useEdgeFade();
  const prevCompactRef = useRef(false);
  const compact = prevCompactRef.current ? clusterScale < 0.88 : clusterScale < 0.78;
  prevCompactRef.current = compact;
  // The session everything on screen belongs to. Its status decides whether this is a tuning
  // workspace (draft) or a read-only record you may re-flash (archived).
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);


  /**
   * What a WRITE will prove. Opens on FULL for a DME whose checksum has never been seen to agree
   * with a read-back; see verifyPolicy.ts for why that is the safe direction to be wrong in.
   *
   * Reset from the identity on every connect rather than kept across them: the selector describes
   * the ECU on the other end of the cable, and carrying a QUICK earned on one car over to another
   * is precisely the mistake this exists to prevent.
   */
  const [verifyMode, setVerifyMode] = useState<WriteVerifyMode>('full');
  /**
   * What the run in progress is for — which DS2 blocks a sample is made of, and therefore what the
   * log can answer afterwards.
   *
   * It used to be a RUN selector in the connection cluster, chosen before START TUNE. That selector
   * is gone, and there is nothing left for it to ask: EGT is retired, so VE is the only thing this
   * button can start, and INERTIA has never run from here — it is driven from its own panel, which
   * owns the arming, the gear check and the estimate.
   *
   * So it is set by whoever actually starts a run rather than chosen in advance:
   * `startInertiaRunWithDiagnostics` flips it to INERTIA for the duration and back after. Every
   * branch that reads it still reads a true statement about the run that is happening — including
   * the hub's STOP, which must not run the VE teardown over an inertia run.
   */
  const [logProcess, setLogProcess] = useState<ProcessId>('VE');
  const connectedVin = dmeLink.identity?.vin ?? null;
  useEffect(() => {
    setVerifyMode(initialVerifyMode(connectedVin));
  }, [connectedVin]);
  // Latest raw live-telemetry sample, shown as a live readout during tuning (independent of the VE
  // filters, so the user can confirm data is streaming even when the engine is off / idle-filtered).
  // Every dialog the page can put up — the four named modals and the app's own alert/confirm.
  // See useAppDialogs for why `ask` lives with them and why this is one key rather than four flags.
  const dialogs = useAppDialogs();
  /** Which pane the narrow (stacked) layout shows. Inert above 900px, where both are on screen.
   *  Starts on the map because that is what a stacked layout was failing to show: the two panes
   *  split 38.2/61.8 regardless of how little height there was, so on a 360x800 phone the VE grid
   *  got 217px — six of twenty columns and ten of twenty-four rows — while the dashboard held a
   *  3D chart nobody could read at that size either. One at a time, and each gets all of it. */
  const [narrowPane, setNarrowPane] = useState<'map' | 'graph' | 'dash'>('map');
  const { ask } = dialogs;
  const [menuOpen, setMenuOpen] = useState(false);
  const updateAvailable = useAppUpdate();
  const install = useInstallPrompt();
  const isPreviewBuild = useIsPreviewBuild();
  /** What this build calls itself — '' on production. The badge is on whenever it is not empty. */
  const buildVariant = useBuildVariant();
  /** What the FEATURE gate reads: the deployed variant, with the dev server counting as preview —
   *  the experiments must be visible where they are developed. Sync/store gating stays on the raw
   *  `isPreviewBuild`, because dev has no /api to talk to. */
  const featurePreview = isPreviewBuild || DEV_VARIANT_IS_PREVIEW;
  const online = useOnline();
  // Sending sessions to the store, and what the three controls that do it say. See useSessionSync.
  const sync = useSessionSync({
    sessions: sessionDb.sessions,
    refresh: sessionDb.refresh,
    isPreviewBuild,
    online,
  });
  const uploadSettings = sync.settings;
  const uploadSettingsRef = sync.settingsRef;
  /**
   * The session an operation is running under, readable after the operation ends.
   *
   * An effect is early enough here, unlike the link's own snapshot: the session changes because
   * somebody loaded or created one, which is a committed render minutes before any run finishes.
   * What is NOT early enough is reading `currentSession` as a variable from inside a handler built
   * on the first render — see useDiagnosticsPublisher.
   */
  const currentSessionIdRef = useRef<string | null>(null);
  const diagnostics = useDiagnosticsPublisher({
    readLinkState: dmeLink.readLinkState,
    lastTransferTimingRef: dmeLink.lastTransferTimingRef,
    lastEventLogRef: dmeLink.lastEventLogRef,
    sessionIdRef: currentSessionIdRef,
    settingsRef: uploadSettingsRef,
  });
  /* `diagUpload` is deliberately not destructured any more: nothing on screen reads it. The record
     is still built and still uploaded — see the note where the DIAG marker used to be — it simply
     has no UI, which is what an artifact for the app's own author should have. */
  const { buildLabel, publish: publishDiagnostics } = diagnostics;
  const wideLayout = useWideLayout();
  const splitGraph = useSplitGraph();
  const mapZoom = useMapZoom();
  /** Which of STOCK / TUNED / CHANGE % the RF KORR tab is showing.
   *
   *  Held here rather than inside RfKorrTable because two components render it — the grid and the
   *  3D surface — and they are siblings. With the state inside one of them the other could not
   *  follow, so the surface stayed on TUNED while the grid switched underneath it. */
  const [rfKorrView, setRfKorrView] = useState<RfKorrView>('tuned');
  /** The 3D surface is actually being looked at.
   *
   *  Below 900px the panes share a grid cell and the inactive one is only `invisible` — it stays laid
   *  out, and a surface mounted inside it goes on rebuilding itself where nobody can see it. Measured
   *  at 4x CPU throttle, that cost 3.8-4.3 s per tab change, of which Plotly was over 96%.
   *
   *  Three ways it can be up, and all three have to be here or the surface either never mounts or
   *  mounts where nobody can see it: it is the selected destination on a split layout; the wide
   *  layout has it above the controls; or a narrow-but-tall layout has it stacked in the dash pane,
   *  which is where it lives whenever there is height enough not to split. */
  const graphOnScreen = wideLayout || narrowPane === 'graph' || (!splitGraph && narrowPane === 'dash');
  /** Where the press that opened the menu landed, while it is still down — the sheet follows the
   *  finger from there and commits on release. Cleared on pointerup wherever it lands, so a tap
   *  that merely opens the sheet leaves it in ordinary tap-to-choose mode. */
  const [menuDrag, setMenuDrag] = useState<{ x: number; y: number } | null>(null);
  // アクセス時の免責事項ダイアログ。表示可否と「今後表示しない」の永続化はフックが持つ。
  const disclaimer = useDisclaimer();
  // ポリシーの URL はブラウザ言語で日英を出し分ける。ヘッダーのリンクは静的 HTML に焼き込まれる
  // ため、判定はマウント後 — 理由は hooks/usePrivacyPolicyUrl.ts に書いてある。
  const privacyUrl = usePrivacyPolicyUrl();

  const {
    currentMap, binaryBuffer, patchStatus,
    applyPatch, setApplyPatch, applyWotDisable, setApplyWotDisable,
    applyTankVentDisable, setApplyTankVentDisable,
    writeWarmup, setWriteWarmup, restoreWotFuel, setRestoreWotFuel, writeRfKorr, setWriteRfKorr,
    restoreVe, setRestoreVe, restoreWarmup, setRestoreWarmup,
  } = binaryFileState;

  const {
    logFile, processedLog, filterConfig, interpolationTable,
    logWindowStart, setLogWindowStart, maxWindowStart, panWindow,
    selectedLogIndex, setSelectedLogIndex, windowedLogData, LOG_WINDOW_SIZE,
  } = logFileState;

  /** The rows the table and the chart both render. Normally this is the log-engine's own window,
   *  but once a VE calculation has run there is a better copy of the same rows: the annotated one,
   *  which carries the measured rf_korr. Showing that copy is what makes the RF KORR column agree
   *  with the map that was just built from it.
   *
   *  The length guard is load-bearing. `annotatedLog` is only valid for the log it was computed
   *  from; after a log is reloaded or refiltered without re-running the calculation it is stale,
   *  and slicing a stale array by this window would put the wrong rf_korr next to every row. */
  const displayedLogWindow = useMemo(() => {
    const annotated = veCalc.annotatedLog;
    if (annotated && processedLog && annotated.length === processedLog.data.length) {
      return annotated.slice(logWindowStart, logWindowStart + LOG_WINDOW_SIZE);
    }
    return windowedLogData;
  }, [veCalc.annotatedLog, processedLog, logWindowStart, windowedLogData, LOG_WINDOW_SIZE]);

  /** The selection is stored against the WHOLE log; both log views index their own window. Converting
   *  in one place is what lets a selection survive a scrub instead of being reset by it — outside the
   *  window the relative index simply misses, which both views already render as "nothing selected"
   *  without needing an extra branch. */
  const windowRelativeSelection = selectedLogIndex === null ? null : selectedLogIndex - logWindowStart;
  const selectAbsoluteFromWindow = useCallback(
    (windowIndex: number) => setSelectedLogIndex(logWindowStart + windowIndex),
    [logWindowStart, setSelectedLogIndex],
  );

  const { mapData, hitMap, weightMap, tunedRfKorr } = veCalc;
  /**
   * The two PER-CELL views, composed the same way the grid above is — and for the same reason.
   *
   * `correctionMap` feeds LAMBDA FEEDBACK and `acceptedMap` paints the "rewritten" band on every
   * map view. Both came from the VE calculator alone, which pushes 1.000 and `false` for every cell
   * it did not accept — and it refuses the whole low-opening band by design. So on session #920 the
   * lambda view read a flat 1.000 across rows 0-12 while the low-opening derivation had measured
   * corrections in 48 of them, and the heatmap painted those same 48 cells as never rewritten.
   *
   * calculator.ts already says why that is the worst kind of wrong: "Colour and calculation
   * disagreeing is exactly what tying the band to the gate was meant to end, and the colour is what
   * gets looked at." It tied the colour to VE's gate; there are two gates.
   *
   * `owned` rather than "every cell the low-opening tuner has a number for", so both halves follow
   * the same rule: a cell shows a correction when the correction was ACTED on. The per-cell reasons
   * for the refusals are the LOW LOAD tab's job, and it names all nine of them.
   */
  const { correctionMap, acceptedMap } = useMemo(() => {
    const ve = { correctionMap: veCalc.correctionMap, acceptedMap: veCalc.acceptedMap };
    const ll = lowLoadResult;
    // NOT gated on `acceptable` any more. That flag governs the WRITE, and gating the composition
    // on it meant an unacceptable low-opening run displayed the VE band's flat 1.000 across every
    // cell it had in fact measured. cellCoverage already draws this distinction for the per-cell
    // verdicts — "an unacceptable result still knows, per cell, which bar refused it" — and the
    // corrections deserve the same treatment. `accepted` below still waits for `acceptable`.
    if (!ll || !ve.correctionMap || !ve.acceptedMap) return ve;
    const correction = ve.correctionMap.map(row => [...row]);
    const accepted = ve.acceptedMap.map(row => [...row]);
    for (let r = 0; r < accepted.length; r++) {
      for (let c = 0; c < accepted[r].length; c++) {
        const llCell = ll.cells[r]?.[c];
        // OWNED decides what was WRITTEN; having a measurement decides what is SHOWN. They were
        // one test, so a low-opening cell the tuner measured and then refused displayed the VE
        // band's 1.000 — the reading thrown away on exactly the cells the driver is deciding
        // whether to go back to (operator, 2026-08-28). Same rule as the VE band's own refusals.
        if (ll.acceptable && ll.owned[r]?.[c]) accepted[r][c] = true;
        if (llCell && llCell.samples > 0) correction[r][c] = llCell.correction;
      }
    }
    return { correctionMap: correction, acceptedMap: accepted };
  }, [veCalc.correctionMap, veCalc.acceptedMap, lowLoadResult]);
  /** The composed grid, under the name every consumer below already uses. `veCalc.newMap` is VE's
   *  own half and is read only where that distinction matters — the coverage census, which counts
   *  what VE'S evidence gate accepted. */
  const newMap = tunedMap;
  /** The coverage bands every grid in this page tints with, resolved once from the session's filter
   *  config. Passed explicitly rather than let each MapEditor fall back to its own default, so a
   *  changed setting reaches all four grids or none. */

  /**
   * The heatmap's three levels: refused, rewritten, and driven enough to move on from.
   *
   * The first boundary is not a number at all — it is the gate's own verdict, cell by cell, as the
   * calculation recorded it. Two earlier versions of this tried to reconstruct that verdict from a
   * threshold instead, and both got it wrong: an independent `coverageThin` of 50 painted a cell
   * the gate had ACCEPTED at 20 samples as barely visited, and tying that number to the gate's
   * sample count still ignored the weight half of the gate, so a cell with 10 samples and a weight
   * of 2.5 — refused — was painted as rewritten. The colour is what gets looked at, so it has to be
   * the decision itself rather than a re-derivation of it.
   *
   * `coverageThin` stays on the type for sessions that stored one, and is deliberately ignored: it
   * is display-only, so nothing about a stored tune depends on it.
   */
  /** Memoised, and the reason is the same one already written beside `rfKorrSurface`: MapEditor is
   *  `React.memo`, and an object literal rebuilt every render defeats it. This one is SPREAD into
   *  the props, so two fresh keys landed on every MapEditor on every render of this component — and
   *  this component re-renders for everything, including a narrow-layout pane switch, which then
   *  re-rendered a 480-cell grid it had not changed. */
  /**
   * One verdict per cell, from whichever derivation owns it — the model the TUNED MAP reads.
   *
   * Built once per calculation rather than per cell per render, for the reason written beside
   * `coverageBands` below: this component re-renders for everything, and 480 cells is a grid.
   */
  const coverage = useMemo(() => buildCoverage({
    hitMap, weightMap, correctionMap, rejectMap: veCalc.rejectMap,
    lowLoad: lowLoadResult,
    // Dimensions off whatever exists. No BASE and no grid means no coverage to show,
    // which is the honest empty rather than an invented 24x20 of nothing.
    rows: currentMap?.yAxis.length ?? hitMap?.length ?? 0,
    cols: currentMap?.xAxis.length ?? hitMap?.[0]?.length ?? 0,
  }), [hitMap, weightMap, correctionMap, veCalc.rejectMap, lowLoadResult, currentMap]);
  const coverageCounts = useMemo(() => coverageCensus(coverage), [coverage]);
  /**
   * Which cells this tune MEASURED — the cells a shape repair must never move.
   *
   * Read off the composed coverage rather than from either derivation's own accepted map, so it
   * means exactly what the map paints: `written` is a cell the drive earned, `settled` is one it
   * earned and found correct. Both are measurements and both are frozen; only the cells that carry
   * no measurement are a repair's business.
   */
  const shapeAnchors = useMemo(
    () => coverage.map(row => row.map(c => c.state === 'written' || c.state === 'settled')),
    [coverage]);
  /**
   * The repair the operator confirmed with APPLY, or null.
   *
   * Lifted out of the panel because the WRITE manifest has to count and gate it. A panel that owned
   * this would be a second write path, which is the arrangement composeVeGrid was built to end.
   * Cleared whenever the derivation underneath it changes — a repair is a proposal ABOUT a
   * particular set of anchors, and silently carrying it onto a different one would write cells
   * shaped around measurements that no longer exist.
   */
  const [appliedShape, setAppliedShape] = useState<ShapeRepairResult | null>(null);
  /**
   * APPLY arms the write; REVERT disarms it. One decision, asked once (operator, 2026-08-26).
   *
   * The SHAPE tab already separates the two states this needs: `proposal` moves live with every
   * slider, and `applied` only exists after APPLY. So APPLY is already the moment of commitment —
   * looking at a repair is the proposal, keeping it is the apply — and asking the same question
   * again in a menu two panes away only created a way to answer it inconsistently. The failure was
   * silent in the worst direction: apply the repair, watch the map change, flash, and the repair is
   * not in the bytes.
   *
   * It stays a TOGGLE afterwards. Applying to see it on the grid and then deciding not to write it
   * is a real thing to want, and the manifest is still the place that says what the flash carries —
   * this only changes what it STARTS at.
   */
  const applyShape = useCallback((r: ShapeRepairResult | null) => {
    setAppliedShape(r);
    binaryFileState.setWriteShape(!!r?.shapedCount);
  }, [binaryFileState]);
  /**
   * The SHAPE tab's whole state, in one place because it is read from three.
   *
   * The grid is on the map pane, the profile chart is in the graph pane and the parameters are a
   * popover in the footer — three surfaces that are nowhere near each other in this tree, and one
   * proposal between them. See shapeWorkspace for why they are apart.
   */
  // A re-run replaces the anchors, so the repair built around the old ones is dropped — and the
  // arming goes with it. Left on, it would be a switch pointing at a result that no longer exists.
  useEffect(() => { setAppliedShape(null); binaryFileState.setWriteShape(false); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shapeAnchors]);
  /** Which cell the TUNED MAP has selected. Here rather than in the tab so it survives a tab
   *  switch — you look at DIFFERENCE % to check a neighbour and come back to the same cell. */
  const [coverageCell, setCoverageCell] = useState<{ row: number; col: number } | null>(null);
  /**
   * How much room the cell readout needs under the grid, in pixels.
   *
   * The readout is an overlay on the FOOT of the map, and scrolled to the bottom it covered the
   * last three rows — RO 65, 85 and 100 on AXIS_LOAD, which is the top of the opening axis and the
   * part a CSL conversion is actually tuned in. Reserving this much scroll room below the last row
   * lets them clear it; padding past the end moves nothing that is already on screen, which is
   * what the overlay exists to protect.
   *
   * One value for both tabs because only one of them is mounted at a time, and measured rather
   * than assumed because the box has no fixed height — the remedy sentence wraps, and how far
   * depends on the cell and the language. CoverageDetail reports 0 when it shows nothing.
   */
  const [coverageInset, setCoverageInset] = useState(0);

  const coverageBands = useMemo(() => ({
    acceptedData: acceptedMap ?? undefined,
    coverageOk: filterConfig.coverageOk ?? COVERAGE_OK_DEFAULT,
  }), [acceptedMap, filterConfig.coverageOk]);
  const { diffSubject, setDiffSubject, diffReference, setDiffReference, diffMapForVisualization } = comparison;

  /** What the DIFFERENCE tab's two selectors offer: the three standing maps plus every
   *  session in the store. TUNED is listed even with no map so its absence reads as
   *  "not derived yet" rather than as a missing option. */
  const diffOptions = useMemo<CompareOption[]>(() => [
    { value: 'tuned', label: 'TUNED', disabled: !newMap },
    { value: 'current', label: 'CURRENT' },
    { value: 'stock', label: 'CSL STOCK' },
    ...sessionDb.sessions.map(s => ({ value: `db:${s.id}`, label: s.label })),
  ], [newMap, sessionDb.sessions]);

  // Runs the VE calculation and refreshes the comparison defaults. Does NOT change the active tab —
  // tab navigation is decided by the caller, so re-running the calc (e.g. on a filter tweak) leaves
  // the user where they are.
  /** VE-calculation options derived from the session's settings. One place, because six call sites
   *  reach the calculator and a map built with a different rf_korr treatment than the one the
   *  session records would be unreproducible. Default on — see LogFilterConfig.applyRfKorr.
   *
   *  Takes the config as an ARGUMENT rather than reading the state directly, because two of those
   *  call sites are async handlers that have just asked for a different config to be loaded.
   *  `loadRawLog(…, session.tuneSettings.filterConfig)` schedules a setState; the handler keeps
   *  running in the render scope it was created in, so a memo over `filterConfig` still holds the
   *  PREVIOUS session's value there. Rebuilding an archived session that way silently applies the
   *  wrong rf_korr treatment, and the sha256 reproduction check then fails against bytes that were
   *  built correctly the first time. The `loadFromBuffer` call in the same handler already passes
   *  its stored settings explicitly for exactly this reason. */
  /** Whether a stored session wrote the derived correction table.
   *
   *  Two eras to read. `writeRfKorr` is the field; sessions saved before it existed encoded the
   *  same decision inside `filterConfig.rfKorrMode === 'tuned'`, which `resolveRfKorr` surfaces as
   *  `legacyWrite`. Taking the absent field as plain false would drop the table write from every
   *  archived session of the older kind, and its sha256 reproduction check would then fail against
   *  bytes that were built correctly at the time. */
  const storedWriteRfKorr = (settings?: TuneSettings): boolean =>
    settings?.writeRfKorr ?? (settings ? resolveRfKorr(settings.filterConfig).legacyWrite : false);

  const veCalcOptionsFor = (
    config: LogFilterConfig, egt: EgtTables | null, write: boolean,
    curves: RfPtKorrCurves | null = null,
  ): VeCalcOptions => ({
    // The whole config goes through resolveRfKorr, which is also what reads the two superseded
    // fields — so an archived session saved as 'nominal' / 'as-logged' / 'tuned' re-derives to the
    // same numbers it recorded without this call site knowing those modes ever existed.
    rfKorrSource: config.rfKorrSource,
    rfKorrMode: config.rfKorrMode,
    applyRfKorr: config.applyRfKorr,
    // The hub toggle, not a filter setting — but the derivation needs it, because dividing by the
    // new table and writing it are one decision. `write` is a parameter rather than read from
    // state here for the same reason `config` is: the archived-session handlers run in a render
    // scope whose state is one step behind what they just asked to load.
    writeRfKorr: write,
    // The evidence gate, and the rf_korr tuner's own. Both travel in the filter config so a session
    // replays under the thresholds it was built with rather than under today's defaults.
    //
    // Switched off, the gate becomes 1 sample / 0 weight rather than 0 / 0: a cell nothing landed
    // in still has nothing to say, and writing it would be worse than the no-gate behaviour the
    // switch is offering. Everything else about "off" means off, and the panel says so in red.
    // WHICH METHOD, and how hard it pushes. Both travel in the config so a reopened session
    // re-derives under the method it was built with. See VeMethod in calculator.ts.
    veMethod: config.veMethod,
    directAuthority: config.directAuthority,
    // Switched off, the gate becomes 1 sample / 0 weight rather than 0 / 0: a cell nothing landed
    // in still has nothing to say. Note this only ever moved the two STRUCTURAL bars — under the
    // statistical method the self-share, independence and significance tests are constants and
    // kept refusing regardless, which is why the panel now switches METHOD instead of pretending
    // this switch turns the gate off.
    ...(config.enableVeCellGate === false
      ? { minCellSamples: 1, minCellWeight: 0 }
      : { minCellSamples: config.minVeCellSamples, minCellWeight: config.minVeCellWeight }),
    // `curves`, not the memo. Reopening a session calls this with the curves read from THAT
    // session's BASE while the memo still describes whatever is loaded now — the same trap the
    // note at the reopen call site describes for egtTables and the stored config.
    normaliseTo: config.normaliseChargeTemp ? curves : null,
    // Always passed, unlike the normalisation: measuring rf_korr honestly is not an option the
    // operator turns on. Without it the calculation falls back to the trim alone.
    rfKorrAir: { curves, assumedPressureMbar: config.assumedAmbientPressure },
    rfKorrThresholds: config.enableRfKorrCellGate === false
      ? { minCellSamples: 1, minCellWeight: 0 }
      : { minCellSamples: config.rfKorrMinCellSamples, minCellWeight: config.rfKorrMinCellWeight },
    egt,
  });

  /** The DME's EGT tables, read out of the BASE that is loaded right now.
   *
   *  The BASE is the right source even when a previous session already tuned this table: whatever
   *  KF_RF_KORR_DRREL these bytes hold is what the DME applied while the log was being recorded,
   *  and that is exactly what the measurement is against. Nothing this app patches touches
   *  0xE84A–0xE8FE, so the patch toggles cannot move it either.
   *
   *  `null` when there is no binary, or when the bytes do not match what the catalog describes.
   *  Every consumer treats that as "behave as if these tables were never read". */
  const egtTables = useMemo(
    () => (binaryBuffer ? readEgtTables(binaryBuffer) : null),
    [binaryBuffer]);

  /**
   * `KL_RF_TAN_KORR` and `KL_RF_P_UMG_KORR` out of the same BASE, for the same reason.
   *
   * From the BASE rather than the as-run bytes, unlike lambdaLimits: no patch this app writes
   * touches either curve, and the DME scaled the Alpha-N target through them while the log was
   * being recorded whatever else was armed. Null when there is no binary or the bytes do not match
   * the catalog, and every consumer reads that as "do not normalise" rather than "normalise by 1".
   */
  const rfPtKorrCurves = useMemo(
    () => (binaryBuffer ? readRfPtKorrCurves(binaryBuffer) : null),
    [binaryBuffer]);

  /**
   * The lambda-controller shutdown thresholds of the loaded binary.
   *
   * Beside egtTables because it is the same kind of thing — calibration this app must read rather
   * than assume — and derived from the same dependency for the same reason: these gates have to
   * describe the bytes the DME was running, and one of them is a table this app patches.
   */
  /* Read from the bytes the DME was RUNNING, not from the BASE — see bytesAsRun.
     `KF_BZ_WDK_VL` is one of the tables WRITE PATCH-ON changes, and this is the reader that decides
     which samples were taken at full load. During a live run the workspace already held the patched
     bytes (the post-flash reload puts them there), so the gate was inert as intended; a session
     reopened later held the unpatched BASE and the same drive was suddenly filtered through
     thresholds the DME never ran. The toggles are in the dependency list for that reason: arming
     WOT DISABLE changes what the log MEANS, not just what a later write will contain. */
  const lambdaLimits = useMemo(
    () => (binaryBuffer
      ? new BinaryParser(bytesAsRun(binaryBuffer, { applyPatch, applyWotDisable, applyTankVentDisable }))
        .readLambdaLimits()
      : null),
    [binaryBuffer, applyPatch, applyWotDisable, applyTankVentDisable]);

  // Push it into the log hook so every later re-process (a filter drag, a table edit) uses the same
  // gates that produced the tune. Call sites that load a log in the same tick as a new binary pass
  // it explicitly instead — see handleOpenSession.
  useEffect(() => { logFileState.setLambdaLimits(lambdaLimits); }, [lambdaLimits]);   // eslint-disable-line react-hooks/exhaustive-deps

  const veCalcOptions = useMemo(
    () => veCalcOptionsFor(filterConfig, egtTables, writeRfKorr, rfPtKorrCurves),
    // Hand-listed, and the list is the contract: every input veCalcOptionsFor actually reads has
    // to be here or a toggle change re-renders without re-deriving. `applyRfKorr` alone was enough
    // when it was the only rf_korr input; it is not any more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterConfig.rfKorrSource, filterConfig.rfKorrMode, filterConfig.applyRfKorr,
      filterConfig.veMethod, filterConfig.directAuthority,
      filterConfig.enableVeCellGate, filterConfig.enableRfKorrCellGate, filterConfig.normaliseChargeTemp,
      filterConfig.assumedAmbientPressure,
      filterConfig.minVeCellSamples, filterConfig.minVeCellWeight,
      filterConfig.rfKorrMinCellSamples, filterConfig.rfKorrMinCellWeight,
      egtTables, writeRfKorr, rfPtKorrCurves]);

  /**
   * `options` is a parameter, and that is the fix rather than the tidy-up.
   *
   * `veCalcOptions` is a memo over `filterConfig`. A handler that changes the config and then calls
   * this in the SAME event still holds the previous render's memo — `setFilterConfig` has only been
   * scheduled — so the derivation ran with the gate values the user had just moved away from. The
   * next render rebuilt the memo correctly and nothing re-ran the calculation, so the edit was
   * simply dropped.
   *
   * It only showed after a run. During one, the next flush re-derived everything half a second
   * later and papered over it; when the run ends there is no next flush, and the COVERAGE and
   * RF KORR SOURCE controls go dead — the report that started this. The RAW FILTER sliders above
   * them kept working, because those go through `reprocess`, which reads its own ref.
   */
  const runCalculation = (
    map: NonNullable<typeof currentMap>, processed: ProcessedLog, options = veCalcOptions,
  ) => {
    veCalc.runCalculation(map, processed, options);
    comparison.applyDefaultsAfterCalculation();
  };

  /**
   * Are the loaded bytes a session's stored TUNED, armed for the patch-off flash?
   *
   * A fact that cannot be derived, which is why it is recorded. handleFinalizeSession loads a tune
   * that is already inside the bytes, so it produces no `newMap` — and handleDmeWrite reads the
   * absence of a map as "these bytes carry only patches" and files the flash as PATCH ONLY. That is
   * wrong for the single most important flash a session ever does: the finalize IS the tune reaching
   * the road, and a history that calls it a patch write cannot tell it apart from arming a bare BASE.
   *
   * Cleared by resetDerived, i.e. by every path that swaps the working binary.
   */
  const finalizeArmedRef = useRef(false);

  /**
   * The pending filter intent and the timer that turns it into a derivation — the full design is
   * on handleConfigChange. Declared here, above resetDerived, because resetDerived must be able to
   * kill them: a compute armed in one workspace firing into the next would republish the OLD
   * session's edited config over the one the load adopted, and re-derive Y's log with X's map.
   */
  const [pendingConfig, setPendingConfig] = useState<LogFilterConfig | null>(null);
  const pendingConfigRef = useRef<LogFilterConfig | null>(null);
  const filterComputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingFilterCompute = () => {
    if (filterComputeTimer.current !== null) { clearTimeout(filterComputeTimer.current); filterComputeTimer.current = null; }
    pendingConfigRef.current = null;
    setPendingConfig(null);
  };

  // Wipes everything derived from the previously-loaded binary. Mandatory on every path that swaps
  // the BASE: newMap is otherwise only reset by handleClearLog, so a stale tune from the last
  // session would be grafted onto the new binary by buildPatchedBuffer.
  const resetDerived = () => {
    binaryFileState.clear();
    veCalc.reset();
    logFileState.clear();
    liveRun.reset();
    finalizeArmedRef.current = false;
    // The workspace this move was armed for is going away, so the move has to go with it — otherwise
    // it fires later against whatever gets loaded next.
    pendingTabRef.current = null;
    // Same rule, second currency: a filter compute armed for the old workspace dies with it.
    cancelPendingFilterCompute();
  };

  /** Sets a specific draft's BASE from a file. Called from that draft's own row, so there is no
   *  question which session it lands in. */
  const handleUploadBase = async (session: TuningSession, file: File) => {
    setActiveSessionId(session.id);
    resetDerived();
    const map = await binaryFileState.uploadBinary(file);
    if (!map) return;
    const buffer = await file.arrayBuffer();
    await sessionDb.setBase({
      sessionId: session.id,
      baseOrigin: { kind: 'upload', fileName: file.name },
      baseBinaryBuffer: buffer,
      baseFileName: file.name,
    });
    cancelPendingFilterCompute(); // same as handleOpenSession: no await remains past this line
    // And stay on STARTUP, which is the one path into a session that does NOT move.
    //
    // It used to jump to CURRENT MAP. But picking a BIN off a phone is rarely the last thing you
    // do on this screen: the same row now offers TESTO CSV — and it offers it only while this
    // session is the open one, which is what the upload just made it — and the next move after
    // that is often a drive, which starts at the hub. Jumping to a map the moment a file lands
    // takes the driver away from both, to look at a calibration nothing has been derived from yet
    // (operator, 2026-08-25).
    //
    // A branch (handleNewFrom) does move, to DASH, and the difference is real: it inherits a BASE
    // and a lineage and has nothing left to be given, so its next step is the car.
  };

  /**
   * A CSV picked on a row that is not the open session: open it, then load — in that order, and in
   * SEPARATE RENDERS.
   *
   * The separation is the whole point, and the first draft of this got it wrong. Doing both in one
   * scope hits the hazard `handleOpenSession` documents twice inside itself: `setActiveSessionId`
   * and `loadFromBuffer` only SCHEDULE their state, so this scope still holds the OUTGOING
   * session's `currentMap` and every memo read off the outgoing binary. `handleLogUpload` then
   * saw a null map, skipped `runCalculation`, and the session came up with LAMBDA FEEDBACK greyed
   * out (`enabled: !!correctionMap`) and TUNED MAP empty (`!!newMap`) — the calculation had
   * never run at all. Touching the coverage threshold re-ran it against the by-then-committed map,
   * which is what made it look like a display bug rather than a missing derivation.
   *
   * So the open is awaited to completion, the file is parked, and a counter forces the render on
   * which the effect below loads it — outside handleOpenSession entirely, with every piece of that
   * session's state committed. An already-open row needs none of this and takes the direct path.
   */
  const pendingRowLog = useRef<File | null>(null);
  const [rowLogTick, setRowLogTick] = useState(0);

  const handleRowLogUpload = async (session: TuningSession, file: File) => {
    if (session.id === activeSessionId) { await handleLogUpload(file); return; }
    // AWAIT THE WHOLE OPEN before arming the load. Arming it earlier — on activeSessionId, which
    // commits while handleOpenSession is still inside its awaits — put the import INSIDE that
    // function, and its tail then killed the import's own derivation: `cancelPendingFilterCompute()`
    // is there to kill a compute armed with the OUTGOING session's config and cannot tell that one
    // from this one. Measured: the log landed (CORRECTED LOG enabled) but LAMBDA FEEDBACK stayed
    // grey, because `correctionMap` never arrived.
    await handleOpenSession(session);
    pendingRowLog.current = file;
    // A counter, not the ref, because the effect has to RUN — the open's own state landed renders
    // ago, so nothing else here would change and re-fire it.
    setRowLogTick(t => t + 1);
  };

  const handleLogUpload = async (file: File) => {
    const processed = await logFileState.parseAndSetLog(file);
    if (processed && currentMap) {
      runCalculation(currentMap, processed);
      goToTab('diff'); // jump to the result only on the initial CSV load
    }
  };

  /**
   * The second half of `handleRowLogUpload`, and it must be an effect rather than a continuation.
   *
   * By the time this runs, `setActiveSessionId` and the binary load have both COMMITTED — React
   * batches them into one render — so `handleLogUpload` reads the map and the memos of the session
   * that was just opened rather than the one that was open before. That is the entire difference
   * between a tune that derives and the greyed-out LAMBDA FEEDBACK this replaced.
   *
   * Cleared before the load, not after: `handleLogUpload` awaits, and a second commit landing
   * inside that await would otherwise run the same file twice.
   */
  useEffect(() => {
    const file = pendingRowLog.current;
    if (!file) return;
    pendingRowLog.current = null;
    void handleLogUpload(file);
  }, [rowLogTick]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A filter change paints before it computes — and nothing reads a config the maps do not match.
   *
   * The heavy half of a config change is not the arithmetic — processLogData and the five
   * runCalculation passes measure 1–3 ms each at a 6,000-sample drive — it is the COMMIT those
   * results force: the windowed log table, the map editor's ~480 cells and every Plotly figure.
   * This used to run synchronously inside the click event, so on a phone the checkbox visibly
   * waited for the map, and a slider ran the whole chain once per pointer-move.
   *
   * Three pieces now, with distinct meanings:
   *
   *   filterConfig (committed)  the config of the CURRENT derivation. It moves only inside the
   *                             deferred compute below, in the same transaction as the maps it
   *                             produced — so buildSettings, SAVE and WRITE can never pair new
   *                             settings with bytes built under old ones. (An earlier draft
   *                             published it immediately; review caught SAVE landing inside the
   *                             150 ms gap and recording a config that did not build the bytes.)
   *   pendingConfig (state)     the user's intent, committed cheaply in the frame of the tap.
   *                             Page-owned controls (the LAMBDA CORR toggle) render and build on
   *                             `pendingConfig ?? filterConfig`, so they flip instantly and never
   *                             construct the next config from a base a queued change is about to
   *                             replace. The panel's rows render its own localConfig instead.
   *   the 150 ms timer          one compute per settle, on the newest pending config, inside a
   *                             transition, so even the heavy commit yields to the next tap.
   *
   * Workspace swaps: resetDerived cancels timer and intent (the pendingTabRef rule, second
   * currency), and handleOpenSession cancels again after its awaits, so a send that slipped in
   * mid-load cannot republish the outgoing session's config over the one the load adopted —
   * after loadRawLog there is no await left for a timer to interleave with. A SAVE inside the
   * settle window records the previous derivation, self-consistently; the tweak the hand just
   * made is not yet part of anything and so is not recorded.
   */
  const handleConfigChange = (newConfig: LogFilterConfig) => {
    // The panel is readOnly on an archived session; this closes the same door for every other
    // caller — an archived record must not even transiently re-derive under edited settings.
    if (isArchived) return;
    pendingConfigRef.current = newConfig;
    setPendingConfig(newConfig);
    if (filterComputeTimer.current !== null) clearTimeout(filterComputeTimer.current);
    filterComputeTimer.current = setTimeout(() => {
      filterComputeTimer.current = null;
      const cfg = pendingConfigRef.current;
      if (!cfg) return; // cancelled by a workspace swap between arming and firing
      startTransition(() => {
        const processed = logFileState.reprocess(cfg);
        if (processed && currentMap) {
          // Built from `cfg`, not from the memo — see runCalculation.
          runCalculation(currentMap, processed, veCalcOptionsFor(cfg, egtTables, writeRfKorr, rfPtKorrCurves));
        }
        // Clear only the intent this compute serviced — a newer change may have re-armed.
        if (pendingConfigRef.current === cfg) pendingConfigRef.current = null;
        setPendingConfig(p => (p === cfg ? null : p));
      });
    }, 150);
  };

  /**
   * The DRIVE SPLIT decision — the only writer of `excludeTimeRanges`.
   *
   * Goes through handleConfigChange like every other filter change, so it takes the same deferred
   * recompute, lands in the same session settings and reproduces the same way. The span comes from
   * the detector rather than from a control, because a stretch the operator drew by hand would be
   * a different claim: this one says "the part that disagrees", and that is a measurement.
   */
  const driveSplit = veCalc.driveSplit;
  /**
   * What is currently taken out, from the INTENT rather than the committed config, so the bar
   * flips in the frame of the tap instead of 150 ms later. Read from the config and never from
   * the detector: excluding the odd stretch removes it from the log, so the detector then
   * correctly finds nothing — and driving the notice off that is what made the whole thing, RESTORE
   * included, disappear the moment it was used. See activeExclusion.
   */
  const splitExcludedSpan = activeExclusion(pendingConfig ?? filterConfig);
  const excludeSplit = () => {
    if (!driveSplit) return;
    handleConfigChange({
      ...(pendingConfig ?? filterConfig),
      excludeTimeRanges: [[driveSplit.odd.from, driveSplit.odd.to]],
    });
  };
  const restoreSplit = () => {
    const next = { ...(pendingConfig ?? filterConfig) };
    delete next.excludeTimeRanges;
    handleConfigChange(next);
  };
  /** The log's first sample, so a span can be stated as minutes into the drive. */
  const logOriginSec = logFileState.rawLogData?.[0]?.time ?? 0;
  /**
   * Where the chip goes. The tab alone is not enough on a phone: below 900px the map lives in the
   * `narrowPane === 'map'` pane and everything else is `invisible pointer-events-none`, so setting
   * the tab from the stats row — which is in the OTHER pane — changed something the reader could
   * not see and read as a dead control. Both, always; on a desk the pane state is ignored.
   */
  const openSplitDetail = () => { goToTab('new'); setNarrowPane('map'); };

  const handleTableChange = (newTable: InterpolationPoint[]) => {
    const processed = logFileState.reprocessWithTable(newTable);
    if (processed && currentMap && processed.validCount > 0) {
      runCalculation(currentMap, processed); // stay on the current tab
    }
  };

  const handleClearLog = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering file select
    if (confirm(dialogText().clearLog)) {
      logFileState.clear();
      veCalc.reset();
      if (activeTab === 'log' || activeTab === 'new' || activeTab === 'diff' || activeTab === 'lambda') {
        goToTab('current');
      }
    }
  };

  /**
   * Which channels this log actually carries — the one thing the filter panel cannot see for itself.
   *
   * Read from the RAW log, never from `processedLog`. That is not tidiness, it is the difference
   * between a control that can be turned back off and one that cannot: with the tank-vent exclusion
   * ON, every purging row is dropped, and a stock car purges 94-99.6 % of the time above 2500 rpm.
   * Judging presence on the filtered log would then find no TETV, grey the control out, and leave
   * the user unable to undo the setting that caused it. Nothing here may depend on its own output.
   *
   * `isFieldPresent` rather than four hand-rolled `.some()` calls: it already knows that the derived
   * channels probe their logged precondition instead of themselves, and it already caps the scan.
   */
  const logChannels = useMemo(() => {
    const raw = logFileState.rawLogData ?? [];
    return {
      tabg: isFieldPresent('exhaustTemp', raw),
      rf: isFieldPresent('rf', raw),
    };
  }, [logFileState.rawLogData]);

  /** How far apart the two routes land on this log — the check on DS2 offset 8, which is still
   *  unconfirmed against a real DME. Undefined when they cannot be compared at all, which now
   *  includes the common case of a drive that never took the engine above the correction's filling
   *  floor: there, both routes read 1.000 for reasons that have nothing to do with offset 8.
   *
   *  Comes from useVeCalculation because the comparison needs the annotated log. Computing it here
   *  off `processedLog.data` is what made it silently undefined on every run. */
  const routeGap = veCalc.routeAgreement?.meanAbsGap;
  const routeSamples = veCalc.routeAgreement?.n;

  /** Whether the RF KORR write is a legal answer for this session, and why not when it is not.
   *
   *  Four conditions, all of which have to hold at once, which is why this lives here rather than
   *  in the panel: the panel can see the config and nothing else. */
  const canTuneRfKorr = !!(
    egtTables                                   // the binary's tables decoded
    && tunedRfKorr?.acceptable                  // the back-calculation met its own thresholds
    && !tunedRfKorr.report.sensorMissing        // the log carried an exhaust temperature
    // ...and the log was recorded with MAP compensation off. With it on, rf_korr carries the
    // MAP integrator's +/-2.5 %RF on top — tolerable when tuning VE against it, not when pinning
    // a table whose whole point is a few percent.
    && (applyPatch || patchStatus?.mapOff)
  );

  /** The one value that decides both halves of the RF KORR write.
   *
   *  Deriving the VE map for a corrected table and NOT writing that table leaves the DME applying
   *  the old one, so the difference survives intact: up to -27 % at the stock peak, on the lean
   *  side. Computing this once and threading it into every write path — and into the VE derivation
   *  through `writeRfKorr` — is what makes that state unreachable. The hub toggle is the only
   *  switch; there is no second one to forget.
   *
   *  ANDed with canTuneRfKorr rather than trusting the toggle alone: the toggle can be left armed
   *  from a previous session whose log had an exhaust probe, exactly as writeWarmup/writeWot can be
   *  left armed with no tune. Deriving here shows what WRITE will really do. */
  const rfKorrArmed = writeRfKorr && canTuneRfKorr && featureEnabled('rfKorr', featurePreview);
  const rfKorrWrite = rfKorrArmed ? tunedRfKorr!.tuned : null;


  /**
   * Which of the conditions is missing, in the order they are usually missing.
   *
   * One sentence naming the actual blocker, not a list of everything it could be. A disabled switch
   * that cannot say why is the one that gets reported as broken — the same reasoning as
   * derivedTablesLockReason beside it, which this deliberately reads like.
   *
   * The missing-channel cases are read from the LIVE CENSUS, not from `tunedRfKorr`, and that is the
   * whole point of this rewrite. `tuneRfKorrTable` returns null when either the exhaust temperature
   * or the lambda trim is absent, so `tunedRfKorr` is null in both cases — which meant the branch
   * naming the exhaust temperature could never be reached, and both causes fell through to "record a
   * log". A log had been recorded. What was missing was a channel in it, and the retired EGT profile
   * produces exactly that log.
   */
  const rfKorrCensus = veCalc.rfKorrLive;
  // WHICH condition, not the sentence for it — the sentence is copy and lives in manifest-text.
  // Splitting them is what let this become bilingual without the branch order moving.
  const rfKorrBlock: RfKorrBlock = !egtTables
    ? 'noEgtTables'
    : !(applyPatch || patchStatus?.mapOff)
      ? 'needsPatch'
      : !processedLog?.data.length
        ? 'needsLog'
        // Before the channel tests, because they are decided over the samples that SURVIVED the log
        // filter — and if none did, "this log carries no exhaust temperature" is a claim about the
        // filter dressed up as a claim about the log.
        : rfKorrCensus && rfKorrCensus.samplesTotal === 0
          ? 'allDropped'
          : rfKorrCensus?.sensorMissing
            ? 'noEgt'
            : rfKorrCensus?.trimMissing
              ? 'noTrim'
              : 'tooFewCells';
  const rfKorrLockReason = manifestText.rfKorr[rfKorrBlock];

  /** The TUNED download. The body went missing in a20cfa4 — an edit that was threading
   *  `tunedLowLoad` through the other two artifact builders emptied this one instead, and nothing
   *  complained because a () => void that does nothing is type-correct. It carries the same extras
   *  as the session-save and DME-write paths, because all three must produce identical bytes. */
  const handleDownloadBin = () => {
    binaryFileState.downloadBin(newMap, writeExtras);
  };

  // --- Session artifact downloads ---------------------------------------------------------------
  // These act on what the session has *stored*, which is what makes them unambiguous: DOWNLOAD TUNED
  // above the map builds bytes live from the current toggles, so it can't stand in for these, and
  // they can't stand in for it.

  const handleDownloadSessionBase = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert(dialogText().noStoredBinary); return; }
    downloadBlob(bins.baseBinaryBuffer, session.baseFileName ?? `${fileSafe(session.label)}_BASE.bin`, MIME_BIN);
  };

  /**
   * The PATCH-ON image of a session's stored BASE, rebuilt and handed back.
   *
   * The third artifact: a session keeps its BASE unpatched and its TUNED fully built, and the image
   * in between — the one that goes into the car BEFORE a log run — existed only live, from the open
   * session's toggles. A session that started unpatched and wrote PATCH-ON could not hand back the
   * bytes it had flashed.
   *
   * Built from the patches ON RECORD for this session (`tuneSettings`, else its last real flash),
   * which is the same pair the row's PATCH word is lit from — so the word and the file cannot
   * disagree about what this session put in the car.
   */
  const handleDownloadSessionPatchOn = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert(dialogText().noStoredBinary); return; }
    // The flash history, NOT `tuneSettings`: this file is what went into the CAR, and a session
    // that wrote PATCH-ON and later derived a patch-off tune has all-false settings on the tune.
    const p = patchOnFlash(session);
    if (!p) return;
    const image = patchOnImage(bins.baseBinaryBuffer, {
      applyPatch: !!p.applyPatch,
      applyWotDisable: !!p.applyWotDisable,
      applyTankVentDisable: !!p.applyTankVentDisable,
    });
    downloadBlob(image, `${fileSafe(session.label)}_PatchON.bin`, MIME_BIN);
  };

  /** What the STORED BASE is carrying, read off the bytes rather than off a flag nobody wrote.
   *  Asked by the session list when a row's sheet opens — see `onInspectBase`. */
  const inspectSessionBase = async (session: TuningSession): Promise<LogicPatches | null> => {
    const bins = await sessionDb.loadBinaries(session.id);
    return bins ? readLogicPatches(bins.baseBinaryBuffer) : null;
  };

  const handleDownloadSessionTuned = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins?.tunedBinaryBuffer) { alert(dialogText().noStoredTune); return; }
    downloadBlob(bins.tunedBinaryBuffer, session.binaryFileName ?? `${fileSafe(session.label)}_TUNED.bin`, MIME_BIN);
  };

  const handleDownloadSessionLog = async (session: TuningSession) => {
    const points = await sessionDb.loadLog(session.id);
    if (!points?.length) { alert(dialogText().noStoredLog); return; }
    downloadBlob(serializeLogFile(points), `${fileSafe(session.label)}_log.csv`, MIME_CSV);
  };

  const syncStatus = sync.status;
  const syncLook = syncStatus && describeSync(syncStatus);


  /** The last step of a tune: put the finished map back on the road with the patches off.
   *
   *  Loads the session's STORED TUNED as the working binary and disarms both patch toggles, which
   *  leaves the bytes patched and the toggles saying otherwise — the drift the hub reads to offer
   *  WRITE PATCH-OFF. Everything about the flash itself therefore stays on the one path that has the
   *  confirm gate, the engine-stopped warning, the read-back verify and the key-cycle instructions.
   *
   *  It does NOT re-derive from the log the way opening an archived session does. There is nothing to
   *  re-derive: the tuned map is already inside these bytes, and the only edit is the correction flag.
   *  That also means it still works for a session whose log can no longer be replayed, and it cannot
   *  reach the double-correction trap (V0*C^2) that rebuilding from a tuned map would.
   *
   *  No new session, either. This is the same tune reaching the ECU a second time, so it belongs in
   *  the same row's flashHistory — see handleDmeWrite, which skips saveSessionTune for an archived
   *  session precisely so the earlier flash record keeps pointing at the bytes it actually sent. */
  const handleFinalizeSession = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins?.tunedBinaryBuffer) { alert(dialogText().noTuneToFinalize); return; }
    setActiveSessionId(session.id);
    resetDerived();
    const map = await binaryFileState.loadFromBuffer(
      bins.tunedBinaryBuffer,
      session.binaryFileName ?? 'tuned.bin',
      // Explicit, not detected: detection would read the patch back OFF the bytes and re-arm the very
      // toggles this is here to clear, leaving nothing for the hub to notice.
      //
      // TANK VENT is in the list because finalising is where the promise to put the evaporative
      // system back gets kept. Leaving it out meant a tune logged with the purge valve held shut
      // went to the road that way, and the FINAL badge said road state.
      { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false, writeWarmup: false, restoreWotFuel: false },
    );
    if (!map) return;
    // After loadFromBuffer, and after the resetDerived above that clears it. These bytes are the
    // session's tune, so the flash they are heading for has to be recorded as a tune.
    finalizeArmedRef.current = true;
    // CURRENT MAP, not TUNED MAP: nothing was derived, so `newMap` is null and the TUNED MAP tab is
    // disabled. The map to check before flashing is the one inside the bytes just loaded, and that
    // is what CURRENT MAP shows.
    goToTab('current');
  };

  // --- Session lifecycle -----------------------------------------------------------------------
  // A session is BASE + log + settings -> TUNED. Only a draft may tune; archived sessions are
  // reference + flash. That split is what makes re-applying a log to its own output impossible.

  const currentSession = activeSessionId ? sessionDb.sessions.find(s => s.id === activeSessionId) ?? null : null;
  const isArchived = currentSession?.status === 'archived';

  /**
   * The sample rate, measured against what this profile should manage.
   *
   * Computed once and read by both stats blocks — the wide one and the `min-[900px]:hidden` row —
   * because two copies of "what rate is this" would be two numbers that can disagree, on the one
   * figure every other count in that row depends on. 561 valid samples means one thing at 6.6 Hz
   * and another at 2.9.
   *
   * Live during a run, the log's own average otherwise, so a reopened session reports the rate it
   * was recorded at rather than a dash. The expected figure rides along because logProfile's comment
   * has been promising it ("Shown next to the measured rate during a run precisely so that gap is
   * visible") and nothing ever showed it.
   *
   * Not memoised on purpose: `hzValueRef` is a ref, so a memo would freeze the live value at
   * whatever it held when the deps last changed. This is three arithmetic operations on an array
   * the surrounding block already re-renders for.
   */
  const logRate = (() => {
    if (!processedLog) return null;
    const live = dmeLink.state === 'tuning' ? hzValueRef.current : null;
    // The RAW log, not `processedLog.data`.
    //
    // `data` is what survived the filters, and the gaps between survivors are far larger than the
    // poll interval — so this reported a rate the link never ran at, then compared it against what
    // the wire and the DME's turnaround CAN deliver, which is a comparison about the capture. It
    // also feeds the Settle Time control's "approximately n samples" readout and, when a session
    // carries no `transientSettleSec`, the fallback that positions that slider at all.
    const hz = live ?? sampleRateHz(logFileState.rawLogData ?? processedLog.data) ?? null;
    if (hz === null) return null;
    // The RUN this rate belongs to, which is not always the one the button would start.
    //
    // `logProcess` describes the run in PROGRESS and resets to VE when there is none, so a reopened
    // EGT or INERTIA session had its 6.6 Hz measured against VE's 3.0 expectation and read as though
    // the link had gone twice as fast as it could. The session records what it was recorded as; that
    // is the authority whenever nothing is running.
    const profile = LOG_PROFILES[
      dmeLink.state === 'tuning' ? logProcess : (currentSession?.process ?? logProcess)];
    // The list the link actually settled on, when there is one. A VE run whose RAM lambda-trim check
    // failed is polling the fallback, and comparing its rate against the fast profile's expectation
    // would report a correct run as a slow one.
    // Narrowed when nothing is running, because the expectation has to describe the run this BUILD
    // would start. A production build quoting the preview list's 4.46 Hz would report its own
    // correct 4.56 Hz run as faster than possible. Not applied to the live list: that one is what
    // the link actually settled on, already narrowed at START TUNE.
    const exchanges = (dmeLink.state === 'tuning' ? liveExchangesRef.current : null)
      ?? (featurePreview ? profile.exchanges : productionExchanges(profile.exchanges));
    const want = expectedHz(exchanges);
    return {
      hz, want,
      title: `Measured ${hz.toFixed(2)} Hz against ${want.toFixed(2)} Hz expected for the `
        + `${profile.label} profile (${describeExchanges(exchanges)}).\n\n`
        + 'Expected counts the wire at 9600 8E1 and the DME\'s own turnaround per exchange — 83 ms for '
        + 'a block read, 35 ms for a RAM read — and nothing else. The host is out of it (the datalog '
        + 'instrument measures hostGap at 0.3 ms), so the shortfall is transport latency, most likely '
        + 'the FTDI 16 ms timer.\n\n'
        + 'This is the number every other count here depends on: the same drive at half the rate is '
        + 'half the evidence.',
    };
  })();
  // Published for the handlers that outlive the render that built them — see currentSessionIdRef.
  useEffect(() => { currentSessionIdRef.current = currentSession?.id ?? null; }, [currentSession]);


  // Each tab states the data it needs, rather than a chain of exclusions. CURRENT MAP used to be
  // exempted from every check and so was clickable with nothing loaded, landing on the empty
  // "AWAITING BINARY FILE" placeholder.
  // Memoised on exactly the things the two effects below already list, so it can be a dependency
  // of theirs instead of a lie of omission. As a plain array it changed identity every render, so
  // naming it in either dependency list would have fired that effect on every render — which is why
  // it was left out, and why the React Compiler could not preserve the memo.
  /**
   * The low-opening Alpha-N derivation.
   *
   * Reads the SAME processed log the VE map does, but from `lowLoadData` — validData plus the rows
   * the idle gate dropped, which is the only set containing the samples this needs. Memoised rather
   * than run in the flush loop because it is a whole-log pass and, unlike the VE grid, has no
   * incremental form: a cell's verdict depends on how many distinct VISITS it collected, which is
   * not a quantity that can be accumulated one sample at a time.
   */
  /**
   * Whether the DME's long-term fuel stores were neutral for this run — the precondition EVERY
   * derivation here rests on and none of them could previously check.
   *
   * `New = Old x STFT x ...` assumes STFT carries the whole fuel-path error. Two long-term stores
   * absorb exactly that error, one of them unreadable on this ECU, so the assumption has to be
   * PROVEN per log rather than believed. See trimNeutrality for the inference and its limit.
   *
   * The RAW log, like `logChannels` above and for the same reason: the stores are a property of the
   * ECU during the run, and a sample the filter dropped still reported them truthfully.
   */
  const storeNeutrality = useMemo(() => {
    const raw = logFileState.rawLogData ?? [];
    const window = binaryFileState.binaryBuffer
      ? new BinaryParser(binaryFileState.binaryBuffer).readLtftLearnWindow() : null;
    return trimNeutrality(raw, window);
  }, [logFileState.rawLogData, binaryFileState.binaryBuffer]);
  /** Set only when something is wrong — so `!!storeLockReason` IS the "hold the write" decision,
   *  and the row that explains it and the toggle that obeys it cannot come apart. */
  const storeLockReason = storeNeutrality.verdict === 'learned'
    ? manifestText.trimLearned(storeNeutrality.worst.toFixed(4)) : undefined;
  /**
   * The idle thresholds, decoded from the loaded image.
   *
   * Here rather than only inside IdleWorkflow because the TAB needs the same answer: whether a run
   * can be offered at all depends on whether these decode, and a tab that opened over a binary the
   * tuner will refuse would be a destination that does nothing. Decoded once and passed down.
   */
  const idleTablesResult = useMemo(
    () => (binaryFileState.binaryBuffer ? readIdleTablesResult(binaryFileState.binaryBuffer) : null),
    [binaryFileState.binaryBuffer]);
  const idleTables = idleTablesResult?.ok ? idleTablesResult.tables : null;
  /** Why the loaded image was refused, or null. Only meaningful once a binary IS loaded — before
   *  that there is nothing to refuse. */
  const idleTablesRefusal = idleTablesResult && !idleTablesResult.ok ? idleTablesResult.reason : null;
  /** A run that recorded samples and could not store them. Shown under the hub rather than swallowed:
   *  a save that cannot happen has to say so while the car is still running. */
  const [idleSaveError, setIdleSaveError] = useState<string | null>(null);

  /**
   * IDLE MODE — show only the tabs an idle run needs.
   *
   * The reason the idle tuner was briefly a separate application. Standing beside a running car,
   * the whole job is READ, measure, look at the bytes; the other eight tabs are a VE workflow that
   * cannot be used from the driver's seat and can only be picked by mistake. That is a case for
   * hiding tabs, which is what this does — it was never a case for a second codebase, and being a
   * second codebase is what put the measurement and its lever in different repositories.
   *
   * Persisted, because the device that wants it is a phone that gets opened in a garage, and a
   * setting that resets on every load is one more thing to do with cold hands.
   */
  // The switch is gone from STARTUP at the operator's direction (2026-08-24). It was the only one,
  // so the mode is off and unreachable rather than half-present: a persisted flag with no control
  // is the trap the note above warns about, and someone who had turned it on would have opened the
  // app to three tabs and no way back. `mss54.idleMode` is deliberately not read any more — an old
  // '1' in a phone's localStorage must not decide what this build shows.
  //
  // Nothing else was removed. The IDLE and CALIBRATION tabs are where they were, the filter below
  // still knows which three the mode leaves standing, and putting a control back is one JSX block
  // wherever it belongs — the menu sheet is the obvious home if it comes back at all.
  const idleMode = false;


  /** Same shape for the low-opening block: the toggle ANDed with derivability, so a switch left on
   *  from a session whose log had low-load evidence cannot write into one whose log has none. */
  const lowLoadArmed = binaryFileState.writeLowLoad && !!lowLoadResult?.acceptable
    && featureEnabled('lowLoad', featurePreview);
  /**
   * What the one ALPHA-N row reports, across both bands of the one table it writes.
   *
   * Summed rather than shown as two numbers because the row is one decision: "how much of
   * kf_rf_soll did this drive earn". Which band each cell came from is the coverage map's job and
   * the LOW LOAD tab's, both of which say it per cell rather than as a pair of totals.
   */
  // One count off the COMPOSED acceptance grid. Summing VE's own total and the low-opening tuner's
  // report would double-count now that `acceptedMap` carries both halves, and two ways of counting
  // the same thing is how the hub and the menu come to disagree.
  const alphaNCells = acceptedMap?.flat().filter(Boolean).length ?? 0;
  const shapeCells = appliedShape?.shapedCount ?? 0;
  /** The same shape as every other armed contribution: the toggle ANDed with the thing
   *  existing, so a switch left on cannot write a repair that is no longer there. */
  // Memoised because the WARMUP table is derived from it: a fresh object literal per render would
  // re-interpolate 480 cells on every keystroke anywhere on the page.
  const shapeWrite = useMemo(() => (
    binaryFileState.writeShape && appliedShape && shapeCells > 0
      ? { grid: appliedShape.values, shaped: appliedShape.shaped } : null
  ), [binaryFileState.writeShape, appliedShape, shapeCells]);
  /**
   * The SHAPE tab's whole state, in one place because it is read from three.
   *
   * The grid is on the map pane, the profile chart is in the graph pane and the parameters are a
   * popover in the footer — three surfaces that are nowhere near each other in this tree, with one
   * proposal between them. See shapeWorkspace for why they are apart.
   */
  /**
   * Which drive target the strip is showing. Never two at once — see LiveDriveStrip.
   *
   * Page state rather than the strip's own, so it survives the pane switch that unmounts the map on
   * a phone: swapping to GRAPH and back must not silently put the driver on the other target.
   */
  const [driveView, setDriveView] = React.useState<DriveView>('ve');
  /** What this build may offer. RF KORR is in here only where that feature renders — the strip
   *  sits inside the STABLE lambda tab, so the tab registry alone never gated it. */
  const driveViews = React.useMemo(() => enabledDriveViews(featurePreview), [featurePreview]);
  /**
   * The view actually in force — DERIVED, not stored, so it cannot disagree with what this build
   * has. `useIsPreviewBuild` answers false on the server snapshot and the truth after hydration, so
   * the list legitimately changes once on load; an effect syncing state to it would be a render
   * chain, and a stored value would keep whatever it was set to before the list narrowed.
   *
   * `driveViews` is never empty — `ve` maps to the trunk — so `[0]` needs no guard.
   */
  const activeDriveView = driveViews.includes(driveView) ? driveView : driveViews[0];

  const shape = useShapeWorkspace({
    tuned: newMap, base: currentMap, anchored: shapeAnchors, applied: appliedShape,
    // What this drive still WANTS, which is what says whether the surface has settled. SHAPE is a
    // projection onto a constraint set, so on an unconverged map it makes the measurement error
    // smooth and monotone instead of the engine. See convergence.ts.
    demandMap: veCalc.demandMap, hitMap: veCalc.hitMap,
  });

  /**
   * The surface the SHAPE tab puts in the shared 3-D pane — deferred with the rest of the charts.
   *
   * It reads the workspace's `shownMap` rather than `appliedShape` alone, which is the difference
   * between a surface that moves while a parameter does and one that only moves on APPLY. The
   * whole reason the controls and the picture are both reachable at once is to watch the second
   * while moving the first.
   */
  const shapeSurface = shape.surface;
  const alphaNAvailable = !!newMap || !!lowLoadResult?.acceptable;
  /** True when a log WAS derived and simply earned nothing — a different fact from "no log yet",
   *  and a different next action, so the row must not say the same thing for both. */
  const alphaNEarnedNothing = !!lowLoadResult && !lowLoadResult.acceptable && !newMap;
  /** One decision, two stores. Hoisted out of the manifest rather than written as a closure over
   *  `binaryFileState` there, so the memo can depend on this one stable function instead of on the
   *  whole hook object — which would rebuild every row on any unrelated binary state change. */
  const { setWriteVe, setWriteLowLoad } = binaryFileState;
  const setWriteAlphaN = useCallback((on: boolean) => {
    setWriteVe(on);
    setWriteLowLoad(on);
  }, [setWriteVe, setWriteLowLoad]);
  /** Memoised for the same reason `shapeWrite` is — see the note there. */
  const lowLoadWrite = useMemo(() => (
    lowLoadArmed ? { grid: lowLoadResult!.tuned, owned: lowLoadResult!.owned } : null
  ), [lowLoadArmed, lowLoadResult]);

  // --- CALIBRATION workbench --------------------------------------------------------------------
  /**
   * The byte spans the ARMED table writers own for THIS build. One list, two consumers — the edit
   * rows' locks and the byte arbitration inside applyCalibrationEdits read the same object, so the
   * manifest and the bytes cannot disagree about who owns what.
   */
  const calConflictSpans = useMemo<RunSpan[]>(() => armedWriterSpans({
    veWrite: (binaryFileState.writeVe && !!newMap) || !!lowLoadWrite || !!shapeWrite,
    warmup: !!newMap && writeWarmup,
    restoreVe,
    restoreWarmup,
    restoreWotFuel,
    rfKorr: !!rfKorrWrite,
  }), [binaryFileState.writeVe, newMap, lowLoadWrite, shapeWrite, writeWarmup,
    restoreVe, restoreWarmup, restoreWotFuel, rfKorrWrite]);
  const calEdits = useCalibrationEdits(binaryBuffer, calConflictSpans);
  /** A reopened session's stored edits, staged until the NEW buffer is in state (the hook's
   *  reset-on-identity fires first, then this re-arms against the fresh bytes). */
  const pendingCalEditsRef = useRef<CalEdit[] | null>(null);
  useEffect(() => {
    const pending = pendingCalEditsRef.current;
    if (pending && binaryBuffer) {
      pendingCalEditsRef.current = null;
      calEdits.restoreEdits(pending);
    }
  }, [binaryBuffer, calEdits]);
  /** Which two images the compare bar names, and whether to draw their
   *  difference. Ahead of the catalog, because their BYTES have to be fetched
   *  before anything can decode them. */
  const calCompare = useCalibrationCompare();
  const calWantedVariants = useMemo(
    () => [calCompare.subject, calCompare.reference],
    [calCompare.subject, calCompare.reference]);
  /** The bytes behind those variants — the loaded image, the shipped reference,
   *  or a stored session's own binary. */
  const calVariants = useCalVariantBuffers(
    binaryBuffer, calWantedVariants, sessionDb.loadBinaries);
  const calData = useCalibrationData(
    activeTab === 'calibration', calVariants.bufferOf, calEdits.edits);
  const calWs = useCalibrationWorkspace(calData.catalog?.graph ?? null);
  /** Everything the compare bar's two selectors disagree about. */
  const calDiffEntries = useCalibrationDiff(
    calData, calEdits.edits, calCompare.subject, calCompare.reference);
  /** The adapted def behind the current selection, when it is a parameter. */
  const calSelectedDef = calWs.selected
    ? calData.catalog?.byId.get(calWs.selected) ?? null
    : null;
  // Derivations for the value pane. Memoised — the working overlay builds fresh 480-element
  // arrays, and a fresh identity per page render (this component re-renders on live-run
  // flushes) would defeat any memoisation below it. The decode functions are themselves
  // memos keyed on the buffers, so these recompute exactly when a buffer or the edit
  // set changes. Edits are always made against BASE, whatever is being viewed.
  const { runOf: calRunOf, paramOf: calParamOf } = calData;
  const calSelectedBase = useMemo(
    () => (calSelectedDef ? calParamOf('base', calSelectedDef) : null),
    [calSelectedDef, calParamOf]);
  /** What the pane draws, and what it draws it against. The reference run is
   *  null when both selectors name the same variant — there is no second line
   *  to draw, and a difference of a thing against itself is all zeroes. */
  const calSubjectRun = useMemo(
    () => (calSelectedDef ? calRunOf(calCompare.subject, calSelectedDef) : null),
    [calSelectedDef, calRunOf, calCompare.subject]);
  const calReferenceRun = useMemo(
    () => (calSelectedDef && calCompare.reference !== calCompare.subject
      ? calRunOf(calCompare.reference, calSelectedDef) : null),
    [calSelectedDef, calRunOf, calCompare.reference, calCompare.subject]);
  const calSubjectDecoded = useMemo(
    () => (calSelectedDef ? calParamOf(calCompare.subject, calSelectedDef) : null),
    [calSelectedDef, calParamOf, calCompare.subject]);
  const calReferenceDecoded = useMemo(
    () => (calSelectedDef && calCompare.reference !== calCompare.subject
      ? calParamOf(calCompare.reference, calSelectedDef) : null),
    [calSelectedDef, calParamOf, calCompare.reference, calCompare.subject]);
  const calSelectedEdit = calSelectedDef ? calEdits.edits.get(calSelectedDef.id) : undefined;
  const calEditedMask = useMemo(
    () => (calSelectedEdit
      ? calSelectedEdit.raw.map((r, i) => r !== calSelectedEdit.baseRaw[i])
      : null),
    [calSelectedEdit]);
  const calEditCell = (index: number, physical: number) => {
    if (calSelectedDef && calSelectedBase?.value) calEdits.editCell(calSelectedDef, calSelectedBase.value, index, physical);
  };
  const calBulkOp = (op: BulkOp, indices?: readonly number[]) => {
    if (calSelectedDef && calSelectedBase?.value) {
      calEdits.bulkOp(calSelectedDef, calSelectedBase.value, op, indices);
    }
  };
  /** Take the REFERENCE's whole run for one parameter, addressed by id. The
   *  edit is always recorded against BASE — that is what a revert goes back to
   *  — whatever variant is on screen. */
  const calCopyParam = useCallback((paramId: string) => {
    const def = calData.catalog?.byId.get(paramId);
    if (!def) return;
    const base = calParamOf('base', def)?.value;
    const ref = calRunOf(calCompare.reference, def) ?? null;
    if (base) calEdits.copyFromReference(def, base, ref);
  }, [calData.catalog, calParamOf, calRunOf, calCompare.reference, calEdits]);
  const calCopyRef = () => { if (calSelectedDef) calCopyParam(calSelectedDef.id); };
  const calEditedIds = useMemo(() => new Set(calEdits.edits.keys()), [calEdits.edits]);
  /**
   * What the two selectors offer: this session's bytes, the reference image the
   * app ships, and every stored session.
   *
   * A session is listed by which of ITS binaries would be read — TUNED when it
   * has one, BASE otherwise — because "#3 TUNED" and "#3 BASE" are different
   * claims about a car, and a session with neither has nothing to compare.
   */
  const calCompareOptions = useMemo<CompareOption[]>(() => [
    { value: 'tuned', label: 'TUNED (THIS SESSION)' },
    { value: 'base', label: 'BASE (AS LOADED)' },
    { value: 'stock', label: 'CSL 0401 REF' },
    ...sessionDb.sessions.map(s => ({
      value: `db:${s.id}`,
      label: `${s.label} · ${s.sha256 ? 'TUNED' : 'BASE'}`,
      disabled: !s.baseOrigin,
    })),
  ], [sessionDb.sessions]);
  /** The right pane's bottom tab on CALIBRATION. The auto-rules are derivations, not stored
   *  preferences: a transfer forces DME (that is where its progress lives); a fresh selection
   *  while the link is quiet answers with INFO. */
  const [calBottomTab, setCalBottomTab] = useState<'info' | 'dme' | 'list'>('info');
  useEffect(() => {
    if (dmeLink.state === 'reading' || dmeLink.state === 'writing'
      || dmeLink.state === 'tuning' || dmeLink.state === 'resetting') {
      setCalBottomTab('dme');
    }
  }, [dmeLink.state]);
  // A GENUINE selection change answers with INFO; a link-state change while the selection
  // stands must not yank the reader off the DME tab. Render-time prior-state adjustment —
  // the same pattern as the file's other tab derivations, with no one-frame stale panel.
  const [calPrevSelected, setCalPrevSelected] = useState<string | null>(null);
  if (calWs.selected !== calPrevSelected) {
    setCalPrevSelected(calWs.selected);
    // …and not off LIST either. LIST is itself a selection surface: every row
    // in it changes the selection, so answering that with INFO would close the
    // list on the first thing picked from it.
    if (calWs.selected && calBottomTab !== 'list'
      && (dmeLink.state === 'connected' || dmeLink.state === 'disconnected')) {
      setCalBottomTab('info');
    }
  }

  /**
   * THE extras. One memo, every consumer (download, session save, both DME write paths) — threading
   * a new field through three call sites and forgetting the fourth is the failure this replaces.
   */
  const writeExtras = useMemo<PatchExtras>(() => ({
    tunedRfKorr: rfKorrWrite,
    tunedLowLoad: lowLoadWrite,
    tunedShape: shapeWrite,
    // Feature-gated like rfKorrArmed above it: what the write carries and what the manifest
    // can name must be filtered by the same registry, or one day they diverge.
    calibrationEdits: featureEnabled('calibration', featurePreview) && calEdits.armedEdits.length
      ? { edits: calEdits.armedEdits, conflictSpans: calConflictSpans }
      : null,
  }), [rfKorrWrite, lowLoadWrite, shapeWrite, calEdits.armedEdits, calConflictSpans, featurePreview]);

  /**
   * `kf_rf_soll_kath`, derived from THE SAME grid the flash gets — never from a snapshot.
   *
   * This used to be computed once inside `useVeCalculation`, at the moment the calculation
   * finished, and stored. That was a picture of the tuned map as it stood before SHAPE existed and
   * it never revisited: applying a repair changed what the flash carried and left this tab showing
   * the unrepaired table. Two views of one record, quietly disagreeing.
   *
   * `writtenVeGrid` is the same call `buildPatchedBuffer` makes, with the same three arguments — so
   * the WARMUP tab is a rendering of the bytes rather than a second opinion about them. When
   * nothing is armed for `kf_rf_soll` the grid is null and this falls back to the tuned map, which
   * is also what the flash path does: WARMUP writes its own table at its own address and arming it
   * alone is legitimate.
   *
   * Recomputing is cheap and bounded — one 24x20 compose plus 480 bilinear interpolations — and it
   * runs only when one of these actually changes, which is a toggle or an APPLY.
   */
  const warmupMap = useMemo(() => {
    if (!newMap) return null;
    const written = writtenVeGrid(
      binaryFileState.writeVe ? newMap.data : null, lowLoadWrite, shapeWrite,
    );
    try {
      return new VECalculator().generateWarmupMap(written ? { ...newMap, data: written } : newMap);
    } catch (e) {
      console.error('Failed to generate the derived warmup table', e);
      return null;
    }
  }, [newMap, binaryFileState.writeVe, lowLoadWrite, shapeWrite]);

  const ALL_TABS: { id: TabId; label: string; enabled: boolean }[] = useMemo(() => [
    { id: 'startup', label: 'STARTUP', enabled: true },
    { id: 'current', label: 'CURRENT MAP', enabled: !!currentMap },
    /* `correctionMap` alone. It used to also require `newMap`, which is withheld until a cell
       clears the evidence gate — so the tab that shows the TRIM waited on the map, and the move
       START TUNE arms was released seconds after the button rather than at the first sample. */
    { id: 'lambda', label: 'LAMBDA FEEDBACK', enabled: !!correctionMap },
    { id: 'new', label: 'TUNED MAP', enabled: !!newMap },
    { id: 'diff', label: 'DIFFERENCE %', enabled: !!currentMap },
    { id: 'log', label: 'CORRECTED LOG', enabled: !!processedLog },
    // Straight after the log, and before the derived tables, because it is read in that order: the
    // log says what was measured, SHAPE says what the surface now looks like and what the tune did
    // to it, and only then is there a reason to look at anything derived FROM that surface.
    { id: 'lowload', label: 'SHAPE (EXP.)', enabled: !!newMap },
    // Straight after SHAPE, because it is the same surface seen cold. WARMUP is `kf_rf_soll_kath`
    // — a SECOND Alpha-N table (0xD770) on its own axes, derived from the very grid SHAPE has just
    // finished describing. Reading it two tabs later, after RF KORR's fuel correction, put an
    // unrelated table between two views of one derivation (operator, 2026-08-26).
    { id: 'warmup', label: 'WARMUP (DERIVED / EXP.)', enabled: !!warmupMap },
    // Enabled on the RESULT, not on the binary: the tuner only returns something when the tables
    // decoded AND the log carried an exhaust temperature, which is exactly when there is a table
    // to show. A tab that is reachable and empty says the feature is broken.
    // "/ EXP." carries the same warning as the two around it, and this table has more claim to it
    // than either: it is back-calculated from one log, its inversion is only defined over 45 % of
    // the rpm axis, and nothing here has been checked against a car yet.
    { id: 'rfkorr', label: 'RF KORR (TUNED / EXP.)', enabled: !!tunedRfKorr },
    // Enabled on the LINK plus a loaded image, not on a log or a map. This workflow produces its
    // own samples from a different DS2 block and reads its current values straight out of the
    // binary, so it shares no prerequisite with the VE chain above it — and it is the one tab that
    // is useful before any tuning has happened at all.
    { id: 'inertia', label: 'INERTIA (EXP.)', enabled: !!binaryFileState.binaryBuffer },
    // Enabled on a loaded image, not on a log or a map. This run produces its own samples from its
    // own DS2 exchanges and reads every threshold straight out of the binary, so it is useful the
    // moment there are bytes to read — and its write is SEALED, so it proposes and never patches.
    { id: 'idle', label: 'IDLE (EXP.)', enabled: !!idleTables },
    // Read-only, and the same prerequisite as IDLE. This is where the idle thresholds can be
    // checked against the bytes they were decoded from, cell by cell. It exists as its own tab so
    // that IDLE MODE is self-sufficient: otherwise the only route to the item browser is through
    // RF KORR, which needs a VE drive before it will open.
    { id: 'calibration', label: 'CALIBRATION', enabled: !!binaryFileState.binaryBuffer },
  ], [currentMap, newMap, correctionMap, processedLog, warmupMap, tunedRfKorr, idleTables, binaryFileState.binaryBuffer]);

  /** What IDLE MODE leaves standing. Filtered rather than rebuilt, so a tab cannot end up with two
   *  definitions of when it is enabled. */
  const IDLE_MODE_TABS: readonly TabId[] = ['startup', 'idle', 'calibration'];
  // Order: feature filter first (may this variant render it at all), then IDLE MODE (what the
  // driver wants to see right now). Both filter — neither reorders; layout stays the page's.
  const variantTabs = enabledTabs(featurePreview);
  const TABS = useMemo(
    () => ALL_TABS
      .filter(t => variantTabs.has(t.id))
      .filter(t => !idleMode || IDLE_MODE_TABS.includes(t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ALL_TABS, idleMode, featurePreview]);

  /** A tab move armed before its target exists, released the moment it does.
   *
   *  A log run's two interesting moments both precede their own data. At START TUNE there is no
   *  correctionMap and no newMap, so LAMBDA FEEDBACK is disabled and setting it directly would just be
   *  bounced to startup by the guard below. Arming instead lets the move wait: the first sample runs
   *  an unthrottled flush (handleStartTune zeroes lastFlushRef), correctionMap and newMap appear
   *  together, and this fires — roughly one DS2 round trip after the button.
   *
   *  It never sets a disabled tab, so it cannot fight the guard; the two effects agree by
   *  construction rather than by ordering. */
  useEffect(() => {
    const want = pendingTabRef.current;
    if (!want) return;
    if (!TABS.find(t => t.id === want)?.enabled) return;   // not yet — stay armed
    pendingTabRef.current = null;                          // one-shot
    setActiveTab(want);
    // And go and look at it. Below 900px the tab lives in the other pane, so setting it alone moved
    // the map behind a dashboard nobody had left: START TUNE armed LAMBDA FEEDBACK, the first sample
    // released it, and the screen stayed on DASH with the trim being drawn out of sight. The manual
    // path already pairs these two (onSelectTab does both); this is the same rule for the armed one.
    setNarrowPane('map');
  }, [TABS, currentMap, newMap, correctionMap, processedLog, warmupMap, tunedRfKorr]);

  // Clearing the log or swapping the BASE can disable the tab you're standing on; without this you'd
  // be stranded on a placeholder with its own tab greyed out.
  //
  // Deliberately the one place that still calls setActiveTab raw. A forced bounce is not the user
  // navigating, so it must NOT disarm a pending move — goToTab would, and a run whose result is still
  // being derived would lose its landing.
  useEffect(() => {
    if (!TABS.find(t => t.id === activeTab)?.enabled) setActiveTab('startup');
  }, [TABS, activeTab]);

  /**
   * Everything that goes INTO a save, so the app can tell a saved tune from an unsaved one.
   *
   * Compared by identity, field by field, against what was recorded the last time a save
   * succeeded. Anything that would change the stored bytes changes one of these: the map is a new
   * array every time the derivation re-runs (which is what a filter change does), the two derived
   * tables are new objects when they are re-derived, and the patch toggles are the rest of what
   * `buildPatchedBuffer` reads. `logLen` catches a research run growing.
   *
   * Deliberately NOT a hash of the bytes. Building the patched buffer costs a 64 KB copy and
   * hashing it is async, and neither belongs in a render that runs while a log is flushing. The
   * cost of this being conservative is a SAVE offered over bytes that happen to be identical,
   * which loses nothing; the cost of the opposite would be SAVED over a tune that is not.
   */
  const saveInputs = {
    sessionId: currentSession?.id ?? null,
    map: newMap,
    base: binaryBuffer,
    rfKorr: rfKorrWrite,
    lowLoad: lowLoadWrite,
    logLen: logFileState.rawLogData?.length ?? 0,
    patch: applyPatch,
    wotThreshold: applyWotDisable,
    tankVent: applyTankVentDisable,
    warmup: writeWarmup,
    restoreWot: restoreWotFuel,
    writeVe: binaryFileState.writeVe,
    rfKorrArmed,
    lowLoadArmed,
    // Identity of the armed edit list — a cell commit, revert or hold changes it, so an
    // unsaved calibration change reads as "something to save" like every other input.
    calEditsArmed: calEdits.armedEdits,
  };
  type SaveInputs = typeof saveInputs;
  /** What the last successful save was made of. Null until one happens in this session. */
  const [savedInputs, setSavedInputs] = useState<SaveInputs | null>(null);
  const nothingToSave = !!savedInputs
    && (Object.keys(saveInputs) as (keyof SaveInputs)[]).every(k => savedInputs[k] === saveInputs[k]);

  /**
   * The step before sync: record the tune into THIS DEVICE's database.
   *
   * Computed here, next to `syncStatus`, so the mobile row and the desktop session bar can only
   * have one answer — and so the two halves of the flow (save locally, then send what changed) are
   * described in one place rather than implied by two controls that never mention each other.
   *
   * `saveBusy` is not tracked: handleSaveSession is a single IndexedDB write and resolves in a few
   * ms, so a 'busy' phase would flicker rather than inform. The phase exists in SaveStatus for a
   * caller that needs it; this one honestly does not.
   */
  const saveStatus: SaveStatus = useMemo(() => ({
    phase: dmeLink.state === 'tuning' ? 'logging'
      : !currentSession ? 'nothing'
        // Archived FIRST, before anything about what is loaded.
        //
        // It used to come after the no-VE-map branch, which made an archived session with a log and
        // no map report 'logOnly' — an enabled SAVE, over a record of bytes that are already in an
        // ECU. "Archived" is a fact about the session and the other branches are facts about the
        // workspace; a read-only session cannot become writable because of what is loaded into it.
        : isArchived ? 'archived'
          // A BASE with no tune yet is already on this device — setSessionBase writes it as the READ
          // finishes — so the honest state is "saved", not "nothing to record". SYNC is the control
          // that does something here, and describeSave's copy points at it.
          // A run with no VE map is not automatically nothing. An EGT log cannot move a VE cell — it
          // has no lambda trim to move one with — and it is still the entire product of a drive that
          // exists only in memory until it is written. Before this branch, saving it was impossible
          // and the label said "there is nothing further to save", over exactly the data the run was
          // for.
          // RAW, not filtered — the same correction as in handleSaveSession, and it has to be the
          // same test or the button and the handler disagree about whether there is a drive. A
          // cold-soak log is 100 % filtered out BY DESIGN (minTemp 65 degC) and is still a
          // complete recording.
          : !newMap ? (logFileState.rawLogData?.length
            ? (nothingToSave ? 'saved' : 'logOnly')
            // An idle or inertia run is written to the session as it ends, so by the time this is
            // read the samples are already on the device. Reporting 'baseOnly' here said "BASE
            // saved" over a session that also holds a drive, which reads as the run being lost.
            : currentSession.hasLog ? 'runRecorded'
              : currentSession.baseOrigin ? 'baseOnly' : 'nothing')
            // The state that did not exist: with a tune derived, this was 'ready' for ever. The
            // label never moved, the cell stayed pressable, and there was no way to tell a save
            // that had happened from one that had not.
            : nothingToSave ? 'saved' : 'ready',
  }), [dmeLink.state, currentSession, newMap, isArchived, logFileState.rawLogData, nothingToSave]);
  const saveLook = describeSave(saveStatus);

  const buildSettings = (): TuneSettings => ({
    filterConfig, interpolationTable, applyPatch, applyWotDisable, applyTankVentDisable, writeWarmup, restoreWotFuel,
    restoreVe, restoreWarmup,
    // The armed value, not the raw toggle: `rfKorrArmed` is what actually reached the bytes, and a
    // session must record what it did rather than what was switched on at the time.
    writeRfKorr: rfKorrArmed,
    // Same rule for the two kf_rf_soll contributions: record what the composition actually took.
    writeVe: binaryFileState.writeVe && !!newMap,
    writeLowLoad: lowLoadArmed,
    // The ARMED calibration edits — the exact records the build applied. Recording the raw
    // toggle-side set instead would describe bytes the flash never carried.
    calibrationEdits: calEdits.armedEdits.length ? calEdits.armedEdits : undefined,
  });

  /** Returns the draft to work in, creating one if there is none. */
  const ensureDraft = async (): Promise<TuningSession | null> => {
    if (currentSession && currentSession.status === 'draft') return currentSession;
    // Deliberately does NOT adopt some other draft: several branches can be in progress now, and
    // picking one by list order would silently write this tune into whichever happened to be first.
    return handleNewSession();
  };

  const handleNewSession = async (): Promise<TuningSession | null> => {
    // Drafts with a BASE are left exactly as they are. Archiving them here — the old "at most one
    // draft" rule — meant that branching off an older session silently ended the one you were in
    // the middle of: it came back read-only and could no longer be continued. Tuning is a tree, so
    // several branches may legitimately be in progress at once; only one is *open* at a time.
    // Empty drafts hold nothing at all, so they're still dropped rather than piling up as dead rows.
    for (const s of sessionDb.sessions.filter(s => s.status === 'draft' && !s.baseOrigin)) {
      await sessionDb.remove(s.id);
    }
    // No label: the repository names it "Session #<seq>" from the number it assigns.
    const created = await sessionDb.newDraft();
    setActiveSessionId(created.id);
    resetDerived();
    goToTab('startup');
    return created;
  };

  /** Opens a saved session. Draft -> keep tuning. Archived -> reference + flash only. */
  const handleOpenSession = async (session: TuningSession) => {
    // The base-less branch still swaps the ACTIVE session, so it must drop the outgoing
    // session's derived state like the main path does — without this, a log parked on an
    // empty draft ran the previous session's binary through runCalculation and showed a
    // cross-session tune under the new draft's identity.
    if (!session.baseOrigin) { resetDerived(); setActiveSessionId(session.id); goToTab('startup'); return; }
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert(dialogText().noStoredBinary); return; }

    resetDerived();
    setActiveSessionId(session.id);
    // Stage the stored calibration edits for the effect that re-arms them once the NEW buffer
    // is in state — restoreEdits must rebase against those bytes, and this scope still holds
    // the outgoing session's buffer.
    pendingCalEditsRef.current = session.tuneSettings?.calibrationEdits ?? null;

    // One path for both, which it did not used to be: the draft branch loaded the BASE and stopped,
    // because a draft could not have a stored log — saving archived it. Saving no longer does, so a
    // draft is now the ordinary home of a saved run, and stopping here would hand back a session
    // whose log and filters are in the database and not on the screen.
    //
    // Rebuild the tune FROM THE BASE. Re-running the log against the stored tuned map (what the old
    // code did) would apply the same correction a second time — V0*C^2.
    /**
     * What was armed when these bytes were last in the car, from whichever record can say.
     *
     * `tuneSettings` first: it is the full picture, and it is what the tune was actually derived
     * with. But it has ONE writer, `saveTune`, which only runs once a VE map exists — so a BASE
     * armed with WRITE PATCH-ON before the first log run, and a research run stored by
     * `saveResearchRun`, both reach here with it undefined. The old expression was
     * `session.tuneSettings && { ... }`, which then collapsed the WHOLE bag to undefined and let
     * detection-from-bytes decide. The bytes on offer are `bins.baseBinaryBuffer`, which is the
     * PRE-patch image and always will be — `setBase` is never called again after a flash — so the
     * app concluded the car was stock immediately after patching it, showed the PATCH wings off,
     * withdrew DOWNLOAD PATCH-ON, warned at the next preflight that the patch was missing, locked
     * WRITE RF KORR for want of a patched log, and raised no drift, because the toggle and the
     * detection agreed with each other about the wrong bytes.
     *
     * The flash history is the fallback, and only for the three logic patches — see
     * `armedPatchesFromHistory`.
     */
    const armed = session.tuneSettings
      ? {
        applyPatch: session.tuneSettings.applyPatch,
        applyWotDisable: session.tuneSettings.applyWotDisable,
        applyTankVentDisable: session.tuneSettings.applyTankVentDisable,
        writeWarmup: session.tuneSettings.writeWarmup,
        restoreWotFuel: session.tuneSettings.restoreWotFuel ?? false,
        // Absent reads false, and here that is a fact rather than a default: no session predating
        // these fields could have carried a restore, because neither writer existed.
        restoreVe: session.tuneSettings.restoreVe ?? false,
        restoreWarmup: session.tuneSettings.restoreWarmup ?? false,
        writeRfKorr: storedWriteRfKorr(session.tuneSettings),
        // Absent writeVe reads TRUE: sessions from before the field always wrote the map, and the
        // reopened workspace must rebuild the same bytes. See TuneSettings.writeVe.
        writeVe: session.tuneSettings.writeVe ?? true,
        writeLowLoad: session.tuneSettings.writeLowLoad ?? false,
      }
      : armedPatchesFromHistory(session) ?? undefined;

    const map = await binaryFileState.loadFromBuffer(
      bins.baseBinaryBuffer,
      session.baseFileName ?? 'base.bin',
      armed,
    );
    if (!map) return;

    let rebuilt = false;
    if (session.hasLog) {
      const rawLog = await sessionDb.loadLog(session.id);
      if (rawLog && rawLog.length > 0) {
        const processed = logFileState.loadRawLog(
          rawLog,
          (session.binaryFileName ?? 'session').replace(/\.bin$/i, '.csv'),
          session.tuneSettings?.filterConfig,
          session.tuneSettings?.interpolationTable,
          // Explicit, for the reason the comment below gives about config and table: the effect
          // that pushes `lambdaLimits` into the hook has not run yet in this scope, so the hook
          // still holds the OUTGOING session's binary. Read them from the bytes just loaded —
          // and from those bytes AS THE DME RAN THEM, which is not the same image. This log was
          // captured against a car carrying whatever `armed` says, and the full-load gate reads a
          // table WRITE PATCH-ON rewrites. Replaying it through the raw BASE rejected the very
          // pulls the patch exists to keep.
          new BinaryParser(bytesAsRun(bins.baseBinaryBuffer, {
            applyPatch: !!armed?.applyPatch,
            applyWotDisable: !!armed?.applyWotDisable,
            applyTankVentDisable: !!armed?.applyTankVentDisable,
          })).readLambdaLimits(),
        );
        if (processed) {
          // The STORED config and THESE bytes, not the memos — see veCalcOptionsFor. Both
          // `loadRawLog` and `loadFromBuffer` above only scheduled their state changes; this
          // scope still sees the outgoing session's settings and the previous binary.
          // The stored write flag too. Sessions saved before `writeRfKorr` existed encoded it in
          // filterConfig.rfKorrMode === 'tuned', which resolveRfKorr surfaces as `legacyWrite` —
          // reading the absent field as plain false would drop the table write from every archived
          // 'tuned' session and its sha256 check would fail against bytes that were correct.
          veCalc.runCalculation(map, processed, veCalcOptionsFor(
            session.tuneSettings?.filterConfig ?? filterConfig,
            readEgtTables(bins.baseBinaryBuffer),
            storedWriteRfKorr(session.tuneSettings),
            readRfPtKorrCurves(bins.baseBinaryBuffer)));
          comparison.applyDefaultsAfterCalculation();
          rebuilt = true;
        }
      }
    }

    // WRITE only appears because the rebuild produced a tune; buildPatchedBuffer(null) does not
    // no-op — it returns the BASE — so an unreconstructed session must not offer it.
    //
    // Silent for a draft that has no log yet: that is "continue where I left off", the most ordinary
    // thing in the app, and there is nothing to reconstruct. A session that HAS a log and could not
    // replay it gets the warning whichever status it holds.
    // A send that slipped in during the awaits above armed the compute timer with the OUTGOING
    // session's config. Kill it here, where no await remains for it to interleave with; a fire
    // earlier than this landed before loadRawLog and was overwritten by the config it adopted.
    cancelPendingFilterCompute();
    if (!rebuilt && (session.hasLog || session.status === 'archived')) alert(dialogText().notReconstructed);
    // Land on the map this session is about, and on a phone put that pane in front.
    //
    // CONTINUE used to set the tab and stop, which below 900px changed something in the pane that
    // was not on screen: the map lives in `narrowPane === 'map'` and everything else is
    // `invisible pointer-events-none`, so opening a session left the driver looking at whatever
    // they had been looking at. The pair is what the tab strip and STOP already do.
    //
    // TUNED when the rebuild produced one — that is the answer this session exists for and the
    // reason you opened it — and CURRENT otherwise, which is the map you would start from.
    //
    // The PANE is DASH, not the map: opening a session is the start of a job, and the first thing
    // it needs is the hub — connect, read, start a run. The map is one tap away and is where you
    // go once there is something to look at. (This landed on MAP for a day; the operator asked for
    // DASH, which is the pane the work actually begins in.)
    goToTab(rebuilt ? 'new' : 'current');
    setNarrowPane('dash');
  };

  /**
   * Offers back a data log that a previous page left unsaved, once, after the disclaimer is out of
   * the way and the session list has loaded.
   *
   * Both conditions matter. Firing under the disclaimer would stack a second modal on the one that
   * gates the app, and the restore needs the session list to find the run's BASE — the samples on
   * their own cannot rebuild a tune, because a log only means anything against the bytes it was
   * captured with.
   *
   * Declining discards it. That is the honest reading of "do not restore", and leaving it would make
   * the same prompt reappear on every load until something else cleared it.
   *
   * **Unless the launcher says this is a resume, in which case it restores without asking.** Turning
   * the key off kills the head unit, and the console cold-boots on the way back — Chrome with it, so
   * this app returns to a first-run screen every time. The data is not lost (IndexedDB survives);
   * what is lost is the place. The launcher is the only thing that can put this app back in front,
   * and it knows one fact worth carrying: that the tool was in front when the power went. It says so
   * with `?resume=1`, and nothing else — no state, no session id, because it has neither.
   *
   * The confirmation goes away on that path deliberately. The owner has already watched a three
   * second countdown on the console and not stopped it; asking again would be the second time the
   * same question is put, and would turn a resume into a chore. Nothing is destroyed by restoring —
   * the recovery record is kept until SAVE either way — so there is no decision left to protect.
   *
   * Nothing to resume is the normal case, not an error: the launcher knows the app was in front, not
   * that it had work in progress. Both paths simply fall through to an ordinary start.
   */
  /**
   * `?resume=1`, read once on mount and taken off the URL immediately.
   *
   * Read here rather than inside the effect below, because that one waits for the disclaimer and the
   * session list: the flag has to be captured and cleared before anything else can re-navigate, or a
   * later reload — the update row, a crash, a restore — would read it a second time and resume
   * again. Held in a ref rather than state: nothing renders differently because of it.
   *
   * `history.replaceState` and not a redirect, so no second navigation happens. The query never
   * reaches the cache in the first place — the service worker resolves any navigation to
   * `/index.html` outright rather than by request, which is exactly what lets a resume work in a
   * garage with no signal. That branch must stay as it is.
   */
  const resumeRequestedRef = useRef(false);
  useEffect(() => {
    resumeRequestedRef.current = new URLSearchParams(location.search).get('resume') === '1';
    if (resumeRequestedRef.current) history.replaceState(null, '', location.pathname + location.hash);
  }, []);

  const recoveryOfferedRef = useRef(false);
  useEffect(() => {
    if (disclaimer.open || sessionDb.loading || recoveryOfferedRef.current) return;
    recoveryOfferedRef.current = true;
    void (async () => {
      const resumeRequested = resumeRequestedRef.current;
      const run = await findRecoverableRun().catch(() => null);
      if (!run) return;
      if (!resumeRequested) {
        const t = dialogText();
        const accept = await ask({
          title: t.titleRecoverRun, icon: <Database className="w-3 h-3" />,
          body: t.recoverRun({
            points: run.pointCount, startedAt: run.startedAt, ended: run.endedAt !== undefined, mock: run.mock,
          }),
          confirmLabel: t.btnRestore, cancelLabel: t.btnDiscard,
        });
        if (!accept) { await discardLiveRun(run.runId).catch(() => { }); return; }
      }
      await restoreRun(run.runId, run.sessionId);
    })();
    // One-shot, guarded by the ref: re-running on every sessions refresh would re-offer a run the
    // user has already answered for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disclaimer.open, sessionDb.loading]);

  /**
   * Rebuilds the workspace a lost run was in: its session's BASE, then the recovered samples.
   *
   * Mirrors the archived branch of handleOpenSession rather than reusing it, because that one loads
   * the session's STORED log — and the entire point here is the log that never made it into the
   * store. The recovery record is deliberately NOT cleared on success: the samples are back in
   * memory, which is exactly the fragile place they were lost from, so the net stays up until SAVE.
   */
  const restoreRun = async (runId: string, sessionId: string) => {
    const session = sessionDb.sessions.find(s => s.id === sessionId);
    const bins = session ? await sessionDb.loadBinaries(sessionId) : null;
    if (!session || !bins) { alert(dialogText().recoverFailed); return; }

    const points = await loadLiveRunPoints(runId).catch(() => [] as LogDataPoint[]);
    if (points.length === 0) { alert(dialogText().recoverFailed); return; }

    resetDerived();
    setActiveSessionId(sessionId);
    /* The same bag handleOpenSession resolves, and for the same reason — this used to pass NO third
       argument at all, not even the conditional one, so a crash recovery landed patch-off even for a
       session whose `tuneSettings` could have said otherwise. A recovered run is a run that was in
       progress against a patched car; it must come back describing that car. */
    const armed = session.tuneSettings
      ? {
        applyPatch: session.tuneSettings.applyPatch,
        applyWotDisable: session.tuneSettings.applyWotDisable,
        applyTankVentDisable: session.tuneSettings.applyTankVentDisable,
        writeWarmup: session.tuneSettings.writeWarmup,
        restoreWotFuel: session.tuneSettings.restoreWotFuel ?? false,
        // Absent reads false, and here that is a fact rather than a default: no session predating
        // these fields could have carried a restore, because neither writer existed.
        restoreVe: session.tuneSettings.restoreVe ?? false,
        restoreWarmup: session.tuneSettings.restoreWarmup ?? false,
        writeRfKorr: storedWriteRfKorr(session.tuneSettings),
        // Absent writeVe reads TRUE: sessions from before the field always wrote the map, and the
        // reopened workspace must rebuild the same bytes. See TuneSettings.writeVe.
        writeVe: session.tuneSettings.writeVe ?? true,
        writeLowLoad: session.tuneSettings.writeLowLoad ?? false,
      }
      : armedPatchesFromHistory(session) ?? undefined;
    const map = await binaryFileState.loadFromBuffer(
      bins.baseBinaryBuffer, session.baseFileName ?? 'base.bin', armed);
    if (!map) return;

    // Adopted as the run's buffer, so a later flush appends to this drive rather than starting a
    // second one beside it.
    liveRun.adopt(points);
    /* Gates passed explicitly, same stale-scope reason as the rebuild in handleOpenSession: the
       effect that pushes `lambdaLimits` into the hook has not run in this scope, so without this the
       recovered drive would be filtered through the OUTGOING session's binary. */
    const processed = logFileState.loadRawLog(
      points, 'recovered-log.csv', undefined, undefined,
      new BinaryParser(bytesAsRun(bins.baseBinaryBuffer, {
        applyPatch: !!armed?.applyPatch,
        applyWotDisable: !!armed?.applyWotDisable,
        applyTankVentDisable: !!armed?.applyTankVentDisable,
      })).readLambdaLimits());
    if (processed) {
      // Same stale-scope reason as the archived rebuild: `loadFromBuffer` above only scheduled
      // the binary swap, so the egtTables memo still describes whatever was loaded before. The
      // filter config is NOT reloaded here, so the live one is the right one.
      veCalc.runCalculation(map, processed,
        veCalcOptionsFor(filterConfig, readEgtTables(bins.baseBinaryBuffer), writeRfKorr,
          readRfPtKorrCurves(bins.baseBinaryBuffer)));
      comparison.applyDefaultsAfterCalculation();
      goToTab('new');
    } else {
      goToTab('current');
    }
    // The same trailing cancel handleOpenSession carries: this is the one other loadRawLog path,
    // and a compute armed before the restore must not fire into the restored workspace.
    cancelPendingFilterCompute();
  };

  /** Starts a new session whose BASE is another session's TUNED (continue) or BASE (retry). */
  const handleNewFrom = async (session: TuningSession, which: NewFromWhich) => {
    const bins = await sessionDb.loadBinaries(session.id);
    const buffer = which === 'tuned' ? bins?.tunedBinaryBuffer : bins?.baseBinaryBuffer;
    if (!buffer) { alert(dialogText().noBinaryOfKind(which)); return; }

    const created = await handleNewSession();
    if (!created) return;
    resetDerived();

    const fileName = which === 'tuned'
      ? (session.binaryFileName ?? 'tuned.bin')
      : (session.baseFileName ?? 'base.bin');
    // No toggle overrides: detection off these bytes is correct for a fresh BASE.
    const map = await binaryFileState.loadFromBuffer(buffer, fileName);
    if (!map) return;

    // Taking a session's TUNED makes this its child. Taking its BASE does not: those are the bytes
    // that session itself started from, so this is a sibling retrying from the same point, and it
    // inherits the same origin. Claiming descent from a tune we never used would put it a level too
    // deep in the tree and imply it carries that tune's corrections.
    const baseOrigin: BaseOrigin = which === 'tuned'
      ? { kind: 'session', sessionId: session.id, which: 'tuned' }
      : (session.baseOrigin ?? { kind: 'upload', fileName });

    await sessionDb.setBase({
      sessionId: created.id,
      baseOrigin,
      baseBinaryBuffer: buffer.slice(0),   // copied, so deleting the parent can't strand this one
      baseFileName: fileName,
    });
    // The same landing CONTINUE makes, and for the same reason: a branch is the start of a job,
    // and the first thing it needs is the hub — connect, write the patch, start a run. The map is
    // one tap away and is where you go once there is something to look at.
    //
    // Below 900px the tab alone is not enough. The session list lives in the MAP pane, so setting
    // the tab and stopping left the driver looking at a fresh session's CURRENT MAP with no sign
    // that a job had begun; the pane is the half that moves the screen.
    //
    // Not `handleDmeRead`, which ends with the same two lines minus this one: a READ is pressed AT
    // the hub and the driver is already standing on DASH, so there is nothing to move them to.
    goToTab('current');
    setNarrowPane('dash');
  };

  /** Saves the draft's tune. The only way to persist a session without a cable.
   *
   *  Requires a derived tune, and the button is hidden without one. saveTune means "this session
   *  produced a TUNED": it sets sha256, which is what makes the TUNED download and "Use as base ->
   *  TUNED" offer bytes. This used to fall back to `newMap || currentMap`, so saving a session that
   *  held nothing but a BASE recorded a tune it never derived — and the BASE, dressed as a TUNED,
   *  then became downloadable and branchable. There is nothing else for Save to persist either: the
   *  BASE is already stored by setBase the moment it is chosen.
   *
   *  A flash is the other way to get a TUNED, and it deliberately does NOT require one — writing an
   *  untuned PATCH-ON BIN for the log run is a real step, and those bytes genuinely went to the ECU,
   *  so they have to be kept for flashHistory's hash to point at anything. */
  const handleSaveSession = async () => {
    // No map, but a drive: keep the drive. This is the ONLY way an EGT run's log gets off the heap —
    // its samples carry no lambda trim, so not one VE cell can clear the evidence gate and there is
    // no tune for saveSessionTune to record. Routed to saveResearch for the reason that function
    // exists: it stores BASE + log + process and deliberately sets no sha256, so the session never
    // offers a downloadable TUNED it never derived.
    if (!newMap) {
      // RAW, not filtered. The guard here used to read `processedLog.data.length` while the line
      // below saved `rawLogData` — it refused to save the very array it was about to write. A log
      // taken at ignition-on with the engine cold has every sample dropped by the 65 degC coolant
      // gate, so the filtered set is empty and the recording is complete; the app said "nothing to
      // save" over a whole drive. The question this asks is "did we record anything", and only the
      // raw array can answer it.
      if (!logFileState.rawLogData?.length) return;
      const target = await ensureDraft();
      if (!target) return;
      await sessionDb.saveResearch({
        sessionId: target.id,
        process: logProcess,
        log: logFileState.rawLogData,
      });
      // What makes the cell read SAVED. This path has no dialog of its own — the tune path asks
      // whether to stay in the session, this one has nothing to ask — so before this it was the
      // one press in the app that produced no evidence at all that it had worked.
      setSavedInputs({ ...saveInputs, sessionId: target.id });
      void discardLiveRun().catch(() => { /* a stale record only costs one declined offer */ });
      liveRun.runIdRef.current = null;
      return;
    }
    const target = await ensureDraft();
    if (!target || !binaryBuffer) return;
    if (!target.baseOrigin) { alert(dialogText().setBaseFirst); return; }
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap, undefined, writeExtras);
    if (!patchedBuffer) return;

    await sessionDb.saveSessionTune({
      sessionId: target.id,
      binaryFileName: binaryFileState.buildFileName(newMap, writeExtras),
      tunedBinaryBuffer: patchedBuffer,
      veMapSnapshot: newMap,
      tuneSettings: buildSettings(),
      log: logFileState.rawLogData,
    });

    // `target.id` rather than the render's own: ensureDraft may have just created the session this
    // was written into, and the signature has to name the session it actually landed in or the
    // first save of a new draft reports itself unsaved.
    setSavedInputs({ ...saveInputs, sessionId: target.id });

    // The samples are in the session store now, so the recovery copy has done its job. This is the
    // ONLY success path that clears it: everything before this point — including a run that has
    // stopped and is being read on screen — still has the drive in memory alone.
    void discardLiveRun().catch(() => { /* a stale record only costs one declined offer */ });
    liveRun.runIdRef.current = null;

    // The session stays a DRAFT — saveTune no longer archives, so the log, the filters and the map
    // are all still editable and a re-save just overwrites. Keeping it loaded is therefore the
    // ordinary answer now rather than the risky one: WRITE still refers to a session the DB agrees
    // is open, and adjusting RAW FILTER and saving again is a supported move, not a leak.
    //
    // The question is still asked, because the other answer is also real: a run that is finished
    // with wants to go back to the list, and this is the one moment that is known.
    const keepLoaded = confirm(dialogText().saved);
    if (keepLoaded) return;

    // resetDerived also clears pendingTabRef, which is what stops a run's end-of-log move from firing
    // later on top of the session list.
    resetDerived();
    setActiveSessionId(null);
    goToTab('startup');
  };

  // --- DME connection flow (CONNECTION -> READ -> START TUNE -> STOP -> WRITE / Re-tune) ---

  const handleDmeConnect = async () => {
    await dmeLink.connect(binaryBuffer ?? undefined);
  };

  const handleDmeRead = async () => {
    const outcome = await dmeLink.read();
    // Before the early return, so a read that died part-way — the read worth measuring, and the one
    // a baud experiment produces — is uploaded rather than dropped along with the buffer it failed
    // to return.
    publishDiagnostics('read');
    if (!outcome.ok) return;
    const buffer = outcome.buffer;
    const target = await ensureDraft();
    if (!target) return;
    resetDerived();
    const fileName = `DME_Read_${Date.now()}.bin`;
    await binaryFileState.loadFromBuffer(buffer, fileName);
    await sessionDb.setBase({
      sessionId: target.id,
      baseOrigin: {
        kind: 'dme',
        vin: dmeLink.identity?.vin,
        aif: dmeLink.identity?.aif,
        softwareVersion: dmeLink.identity?.softwareVersion,
        readAt: Date.now(),
      },
      baseBinaryBuffer: buffer.slice(0),
      baseFileName: fileName,
    });
    goToTab('current');
  };

  /**
   * Rebuilds the live view from the samples so far.
   *
   * `authoritative` picks which engine does it, and the distinction is the whole of W4:
   *
   *   false (during the run)  resume the filter, bin only the new samples, finalise the grid.
   *                           Per-sample cost is per-sample and the rest is O(cells), so a flush
   *                           costs the same at minute ten as at minute one. What it leaves out is
   *                           the rf_korr tuner and the route-agreement check, both of which read
   *                           the whole log by nature — so the map on screen is the nominal one.
   *
   *   true (at STOP, and at SAVE)  the full five-pass runCalculation. This is the map that gets
   *                           stored and written, and it is produced by the same code that has
   *                           always produced it. Live is allowed to be an approximation; the
   *                           artefact is not.
   *
   * The two agree wherever they overlap — see verify:incremental, which requires the resumed filter
   * and the drip-fed grid to match a single batch pass cell for cell.
   */
  const flushLiveSamples = (force: boolean, authoritative = false) => {
    const samples = [...liveSamplesRef.current];
    const processed = authoritative
      ? logFileState.loadRawLog(samples, 'live-session.csv')
      : logFileState.appendRawLog(samples, 'live-session.csv');
    if (processed && currentMap) {
      if (authoritative) veCalc.runCalculation(currentMap, processed, veCalcOptions);
      else veCalc.appendCalculation(currentMap, processed, veCalcOptions);
      return processed;
    }
    return null;
  };

  /**
   * The flush, reachable from the poll loop as the CURRENT render's version.
   *
   * `useLiveRun` calls through this rather than closing over `flushLiveSamples`, and the difference
   * is not cosmetic: the function above reads the map, the filters and the calculator, all of which
   * the operator can change while a run is going, and a copy captured at START TUNE would go on
   * deriving against the settings that were on screen when the button was pressed.
   */
  const flushRef = useRef(flushLiveSamples);
  flushRef.current = flushLiveSamples;

  /** One-shot per tuning session — reset in handleStartTune, deliberately NOT per mount. A per-mount
   *  guard would silently skip the teardown for every datalog after the first. */
  const finishedRef = useRef(false);

  /**
   * Ends a datalog — however it ended.
   *
   * Both endings must land here. A log stops either because the user pressed STOP or because the link
   * failed mid-run, and on an unstable cable the second is the common one. Previously only the button
   * ran this: a failed poll tore the loop down inside useDmeLink and quietly returned the link to
   * 'connected', so STOP stopped being offered and this teardown never happened — the user was left
   * connected, with no key-cycle instruction, and (because a partial log still produces a newMap) with
   * the hub silently re-armed to WRITE. That is one click from flashing with the engine running.
   *
   * Order matters: disconnect BEFORE alert, because alert blocks the main thread and would freeze the
   * read pump behind the dialog.
   */
  const finishLog = async (failure: string | null) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // Authoritative: the run is over, and everything downstream of here — the stored TUNED, the
    // bytes a WRITE sends — comes from this pass rather than from the live approximation.
    // The authoritative flush, the durable tail, and the recovery record marked stopped but NOT
    // discarded — see useLiveRun.finish. Awaited so the tail is safe before the blocking alert below.
    const flushed = await liveRun.finish();

    // Land on the tune this run produced — and only if it produced one. A run that captured nothing
    // must arm nothing, or the move would sit waiting and later hijack an unrelated navigation.
    // Armed before the dialog below so React has committed the move by the time it is dismissed,
    // and TUNED MAP is already open behind it.
    pendingTabRef.current = flushed ? 'new' : null;

    // Logging runs with the engine going; writing needs it stopped, and stopping it ends the DME's
    // diagnostic session. So this connection physically cannot survive into the write — keeping it
    // on screen would just mean WRITE times out after the key cycle. Drop it and say what to do.
    //
    // Still before the message, though it no longer has to be: `alert` blocked the main thread and
    // would have frozen the read pump behind the dialog, which is what this ordering was written
    // for. `ask` renders and awaits instead, so nothing is frozen — but disconnecting first is also
    // just the truthful order, since the message it shows describes a link that is already gone.
    await dmeLink.disconnect();
    const t = dialogText();
    await ask({
      title: t.titleLogFinished, icon: <FileSpreadsheet className="w-3 h-3" />,
      body: t.logFinished(failure), confirmLabel: t.btnOk,
    });
  };

  /** startTuning captures onEnd once, when START TUNE is pressed, so it must not close over a stale
   *  finishLog — the final flush has to use the CURRENT map and filters, not the ones frozen at the
   *  start of the run. Routing through a ref refreshed each render avoids re-creating the callback
   *  (adding deps to startTuning would restart the poll loop on every render — far worse on a live
   *  cable). */
  const finishLogRef = useRef(finishLog);
  finishLogRef.current = finishLog;

  const handleStartTune = async () => {
    const profile = LOG_PROFILES[logProcess];
    // INERTIA does not run from here, and must not silently try.
    //
    // This path polls `pollLiveMeasurement`, which reads block 3 unconditionally and consults the
    // selected blocks for exactly one thing — whether to add block 19. Selection 83 in that array
    // is inert: `setLiveBlocks` re-adds block 3 regardless, and nothing ever fetches 83. So an
    // INERTIA run started here does not fail, it QUIETLY DEGRADES to a block-3 log — right sample
    // count, right sample rate, session correctly labelled INERTIA, and not one of the channels the
    // estimator reads. That is exactly how session #903 came to exist: a 2940-sample road log
    // stamped `process: 'INERTIA'` that the estimator could only reject.
    //
    // Routing rather than refusing, because the driver pressing this button wants to measure and
    // the panel is where measuring happens. Placed above every side effect below — `setProcess`,
    // the sample-buffer clear, `beginLiveRun` — so a mis-press costs nothing and destroys no
    // existing recovery record.
    if (logProcess === 'INERTIA') {
      goToTab('inertia');
      setNarrowPane('map');
      return;
    }
    // Preflight, before a drive rather than after one. Overridable — see missingPatches for why —
    // but never silent, because the cost of finding out afterwards is the whole run.
    const missing = missingPatches(profile, { patched: bytesPatched, tankVentShut: bytesTankVentShut });
    if (missing.length) {
      const tPre = dialogText();
      const go = await ask({
        title: tPre.titleRunPreflight, icon: <AlertCircle className="w-3 h-3" />,
        body: tPre.runPreflight(profile.label, missing),
        confirmLabel: tPre.btnRunAnyway, cancelLabel: tPre.btnCancel, danger: true,
      });
      if (!go) return;
    }
    // Settle where this run's lambda trim will come from, before a single sample is recorded.
    //
    // Here rather than inside the poll loop because it is the last moment nothing is at stake: the
    // check costs about a second of standing still, and its alternative is finding out after a drive
    // that four bytes of RAM were not the channel the disassembly said they were. It never fails the
    // run — a car that will not serve the read logs both blocks, the way it always did.
    // Narrow to what this build records, AFTER the truth gate has chosen between the fast list and
    // the fallback. Order matters: the gate is about whether four bytes of RAM are the lambda trim,
    // which is a question about the car, and it must be asked of the profile as written. Narrowing
    // first would hand it a list the disassembly never described.
    //
    // Both lists are annotated, so a production run that falls back is still a production run.
    const exchanges = featurePreview
      ? (await dmeLink.verifyLogProfile(profile)).exchanges
      : productionExchanges((await dmeLink.verifyLogProfile(profile)).exchanges);
    liveExchangesRef.current = exchanges;
    if (currentSession) {
      void sessionDb.setProcess(currentSession.id, logProcess).catch(() => { /* label only */ });
    }
    finishedRef.current = false;
    liveRun.start({ sessionId: currentSession?.id ?? null, mock: dmeLink.mockMode, exchanges });
    // LAMBDA FEEDBACK is where a run is actually read — it is the trim the log is being captured to
    // measure. It is disabled at this instant (no correctionMap, no newMap), which is exactly what
    // arming is for; the first sample's unthrottled flush releases it.
    pendingTabRef.current = 'lambda';
    dmeLink.startTuning(
      (sample) => {
        const point: LogDataPoint = {
          time: sample.time,
          rpm: sample.rpm,
          rawLoad: sample.rawLoad,
          stft1: sample.stft1,
          stft2: sample.stft2,
          coolantTemp: sample.coolantTemp,
          rf: sample.rf,
          exhaustTemp: sample.exhaustTemp,
          wdk1: sample.wdk1,
          // Carried into the log rather than only shown live: whether purge was active is a property
          // of the RUN, and it is the thing you want to check when two logs of the same road
          // disagree. It is worth nothing if it only existed while the numbers were on screen.
          tankVent: sample.tankVent,
          tankVentCheckState: sample.tankVentCheckState,
          tankVentDiag: sample.tankVentDiag,
          lambdaFreeze: sample.lambdaFreeze,
          // THIS LIST IS THE ONLY BRIDGE from LiveMeasurement to the log. A channel the link
          // reads but this literal does not name is decoded on every sample and then thrown
          // away — which is exactly what happened to the long-term trim stores on session #922:
          // `ram8` ran all run, the gate confirmed 3/3, and the log carried none of it.
          ltft1: sample.ltft1,
          ltft2: sample.ltft2,
          llsSt: sample.llsSt,
          intakeTemp: sample.intakeTemp,
          ambientPressure: sample.ambientPressure,
          chargeTemp: sample.chargeTemp,
          altitude: sample.altitude,
          ambientPressureSubstituted: sample.ambientPressureSubstituted,
          ambientTemp: sample.ambientTemp,
          ambientTempFromCan: sample.ambientTempFromCan,
          vehicleSpeed: sample.vehicleSpeed,
          pressureDecodeDisagreesMbar: sample.pressureDecodeDisagreesMbar,
          // The slew limiter. Added on 2026-08-30 and left off this literal for one drive, which
          // is the failure the paragraph above describes happening again: the link read all five
          // on session #930, the registry named them, the profile asked for them, and the log
          // carried none of them.
          mdDynSt: sample.mdDynSt,
          mdFw: sample.mdFw,
          mdFwFilter: sample.mdFwFilter,
          mdLsDelta: sample.mdLsDelta,
          mdDpDelta: sample.mdDpDelta,
        };
        // Record it, price the rate, pace the flush and the recovery write. Nothing in there
        // renders anything — see useLiveRun for why that matters at four samples a second.
        liveRun.addSample(point);
      },
      (failure) => {
        // Publish BEFORE the teardown, not after. `finishLog` disconnects and then blocks on a
        // dialog, and the record is built from live link state; the timing window is already closed
        // and published by this point, so this is both the earliest and the last safe moment.
        //
        // This is the first time a datalog has ever produced a diagnostic record. The rate figures
        // quoted through this whole exercise came from dividing sample count by wall-clock after the
        // fact, which cannot tell the DME's turnaround apart from the app's own cost — the one
        // question the profile work has been guessing at.
        publishDiagnostics('log');
        void finishLogRef.current(failure);
      },
      // What the link and the car between them settled on above — the fast list if the RAM lambda
      // trim checked out, the both-blocks fallback if it did not.
      exchanges,
    );
  };

  /** The inertia run, with the same diagnostic publish the datalog now does. Wrapped here rather
   *  than inside InertiaWorkflow because uploading a record is the page's job — the workflow owns an
   *  EGAS run, not a session. */
  /**
   * The only way an inertia run starts, which is why it is also the only place `logProcess` says so.
   *
   * With the RUN selector gone, nothing declares the process in advance any more — so it is
   * declared by the thing that actually begins the run, and withdrawn when it ends. The branches
   * that depend on it are not cosmetic: the hub's STOP reads it to avoid running the VE teardown
   * over an inertia run, which would flush an empty sample buffer, report a datalog that does not
   * exist and drop the link.
   *
   * Reset in the same callback that publishes the diagnostics, so it happens on a failed run as
   * well as a finished one. Leaving it stuck on INERTIA would make the next START TUNE route to the
   * inertia panel instead of starting a VE log.
   */
  const startInertiaRunWithDiagnostics = useCallback(
    (onSample: Parameters<typeof dmeLink.startInertiaRun>[0], onEnd?: (failure: string | null) => void) => {
      setLogProcess('INERTIA');
      return dmeLink.startInertiaRun(onSample, failure => {
        setLogProcess('VE');
        publishDiagnostics('log');
        onEnd?.(failure);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dmeLink.startInertiaRun],
  );

  const handleStopTune = async () => {
    dmeLink.stopTuning();
    // Run the teardown here rather than waiting for onEnd. On a dying cable the in-flight poll can
    // take a full response timeout to settle, and STOP must not sit there looking dead. onEnd still
    // fires afterwards, finds finishedRef already set, and returns — so this runs exactly once
    // whichever path gets here first.
    await finishLog(null);
  };

  /** Describes toggle drift from what the session was saved with, so the confirm dialog can say so
   *  instead of silently flashing different bytes than the record describes. */
  const settingsDrift = (): string[] => {
    const s = currentSession?.tuneSettings;
    if (!s) return [];
    const rows: string[] = [];
    const cmp = (name: string, was: boolean, now: boolean) => {
      if (was !== now) rows.push(`${name}: ${was ? 'ON' : 'OFF'} → ${now ? 'ON' : 'OFF'}`);
    };
    cmp('PATCH', s.applyPatch, applyPatch);
    cmp('WOT TH', s.applyWotDisable, applyWotDisable);
    // Absent on every session saved before this existed, and `undefined !== false` would report a
    // drift that never happened on all of them. Coerced, not compared loosely.
    cmp('TANK VENT', !!s.applyTankVentDisable, applyTankVentDisable);
    cmp('WRITE WARMUP', s.writeWarmup, writeWarmup);
    cmp('RESTORE WOT FUEL', s.restoreWotFuel ?? false, restoreWotFuel);
    cmp('RESTORE VE', s.restoreVe ?? false, restoreVe);
    cmp('RESTORE WARMUP', s.restoreWarmup ?? false, restoreWarmup);
    cmp('WRITE RF KORR', storedWriteRfKorr(s), rfKorrArmed);
    // Absent writeVe reads TRUE (pre-field sessions always wrote the map); writeLowLoad reads
    // false (the arming was never persisted). Both compare the ARMED value, like RF KORR above.
    cmp('WRITE VE', s.writeVe ?? true, binaryFileState.writeVe && !!newMap);
    cmp('WRITE LOW LOAD', s.writeLowLoad ?? false, lowLoadArmed);
    // Calibration edits: the armed RUNS, not a boolean — a different cell set is drift too.
    const storedCal = s.calibrationEdits ?? [];
    const nowCal = calEdits.armedEdits;
    const calSame = storedCal.length === nowCal.length && storedCal.every(e => {
      const m = nowCal.find(n => n.paramId === e.paramId);
      return !!m && m.raw.length === e.raw.length && m.raw.every((r, i) => r === e.raw[i]);
    });
    if (!calSame) rows.push(`CALIBRATION: ${storedCal.length} edit(s) → ${nowCal.length} edit(s)`);
    return rows;
  };

  const handleDmeWrite = async () => {
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap, undefined, writeExtras);
    if (!patchedBuffer) return;
    // Pin the settings that produced these exact bytes. Reading the toggles again after the write
    // would record whatever they say ~4 minutes later, which is not necessarily what went to the ECU.
    const flashedSettings = buildSettings();

    // Lineage, before anything else and before the erase.
    //
    // A flash rewrites all 65536 bytes — writePartialBin refuses any other length — so a tune built
    // on a BASE the car no longer holds does not merge with what is there, it replaces it. Two
    // sessions branched off one BASE therefore revert each other silently, and they can do it with
    // no overlapping addresses at all: a VE tune and a drivability tune touch entirely different
    // regions and still wipe one another out. Neither session's own diff can show that, which is
    // why the check has to happen against the car rather than against the record.
    //
    // Eight bytes, not a re-read: see lib/lineage/preflight.ts for why, and for what the CRC
    // comparison does and does not prove.
    const lineage = await checkLineage(
      binaryFileState.binaryBuffer,
      () => dmeLink.readDataChecksums(),
    );
    if (lineage.blocking) {
      const tLin = dialogText();
      const proceed = await ask({
        title: tLin.titleLineage, icon: <AlertCircle className="w-3 h-3" />,
        body: tLin.lineageBlocked(lineage.summary, lineage.verdict),
        confirmLabel: tLin.btnFlashAnyway, cancelLabel: tLin.btnCancel, danger: true,
      });
      // Overridable, deliberately. There are legitimate reasons to write over an unknown state —
      // recovering a half-flashed ECU is the obvious one — and a check that cannot be overridden
      // gets worked around instead of heeded. What it must never be is silent.
      if (!proceed) return;
    }

    const drift = settingsDrift();
    // Gate: single safety confirmation before flashing the ECU. The DME itself also rejects the
    // write (0xA2) unless the engine is stopped (RPM/speed = 0), but we warn explicitly.
    const tWrite = dialogText();
    const confirmed = await ask({
      title: tWrite.titleWriteConfirm, icon: <Zap className="w-3 h-3" />,
      body: tWrite.writeConfirm({
        tuned: Boolean(newMap),
        patchOn: applyPatch || applyWotDisable,
        drift,
        // Stated here rather than left to the selector alone. The mode changes what "verified"
        // will mean in the dialog that follows, and the moment to say so is before the erase.
        verifyMode,
        // Same reasoning, higher stakes: this one changes what can go WRONG, and its failure mode
        // lands on an erased ECU. It is never implied.
        boostBaud: dmeLink.writeBaud !== 9600 ? dmeLink.writeBaud : null,
        tankVentOff: applyTankVentDisable,
        // Which campaign shape this write is part of, and — for route B only — that it rests on a
        // division no car has checked. Stated here rather than left to the hub because this is the
        // dialog whose job is the consequence of the thing about to happen.
        route: writeRoute,
        // Android gets extra lines because the guarantees are weaker there: beforeunload is honored
        // inconsistently, so the "you will be asked to confirm" sentence above cannot be relied on,
        // and the screen or an app switch can take the connection down mid-write.
        android: isAndroidPlatform(),
      }),
      confirmLabel: tWrite.btnWrite, cancelLabel: tWrite.btnCancel, danger: true,
    });
    if (!confirmed) return;

    // The windows QUICK verify will read back — bytes that MUST differ once programmed, computed
    // against the image the car held when it was read. Empty means this write changes nothing the
    // spot check could see; FULL ignores it and reads everything.
    const spotCheck = binaryFileState.binaryBuffer
        ? diffWindows(new Uint8Array(binaryFileState.binaryBuffer), new Uint8Array(patchedBuffer))
        : [];
    const outcome = await dmeLink.write(patchedBuffer, verifyMode, spotCheck);
    // Before either branch, and on both of them. A write that failed part-way on an already-erased
    // ECU is the single most valuable record this app can produce, and it is also the one the
    // driver is least able to collect by hand at the time.
    publishDiagnostics('write');
    if (outcome.ok) {
      const verification = outcome.verification;
      // The licence QUICK rests on: on this ECU, a byte-for-byte read-back and the DME's own
      // checksum have now agreed. Recorded only when BOTH actually ran and passed — a FULL write on
      // a DME that would not answer 0x0A proves the bytes and proves nothing about the checksum,
      // which is the thing being licensed.
      // `checksumClean`, not "there was a checksum object". The licence is that a byte-for-byte
      // read-back and the DME's own checksum AGREED on this ECU; a non-null answer that reports a
      // fault is a disagreement, and it used to license the mode that cannot see it.
      if (verification.readBack && verification.checksumClean) {
        recordQuickVerifyProven(dmeLink.readLinkState().identity?.vin);
      }
      const target = currentSession ?? (await ensureDraft());
      // One flash, so one hash and one timestamp, taken here and used by whichever branch runs below.
      const sha256 = await sha256Hex(patchedBuffer);   // the bytes actually sent, not the stored ones
      const flashedAt = Date.now();

      // The key-off power-cycle ends the DME's diagnostic session, so the serial connection goes
      // stale either way. Both branches below say so and then disconnect; they differ in what the
      // session becomes and where you go next. The key-cycle steps themselves live in dialog-text,
      // quoted into both messages there, so the two cannot drift apart or out of language.
      if (!newMap) {
        // No derived map. Two different flashes arrive here and they are NOT the same event:
        //
        //   - arming a bare BASE for the log run (WRITE PATCH-ON), which carries no tune, and
        //   - finalising a session (WRITE PATCH-OFF), where the tune is already inside the bytes.
        //
        // `finalizeArmedRef` separated them — and WRITE CAL is now a third arrival: no derived
        // map, but calibration edits inside the bytes. Those bytes ARE a tune (buildFileName's
        // own claimsTune says so), so the record and the reloaded filename both read the extras
        // that built this exact buffer rather than the absence of a map.
        //
        // Deliberately NOT saveSessionTune and NOT archive either way:
        //  - saveSessionTune would record a TUNED whose map is just the BASE's, which is precisely
        //    the "BASE dressed as a TUNED" that handleSaveSession's doc describes removing.
        //  - archive would end the session before it has tuned anything — !isArchived is what makes
        //    the hub offer START TUNE, so archiving here would strand the whole point of the step.
        //    (A finalize is already archived; archiving again would be a no-op.)
        // Only the flash history grows, which is exactly what happened: bytes went to the ECU.
        if (target) await sessionDb.recordFlash(target.id, {
          at: flashedAt, sha256, settings: flashedSettings,
          tuned: finalizeArmedRef.current || (writeExtras.calibrationEdits?.edits.length ?? 0) > 0,
          verifyMode: verification.mode,
          // Read through the snapshot, not `dmeLink.mockMode`: this handler was built several
          // renders ago and a write takes minutes. See DmeLinkSnapshot.
          practice: dmeLink.readLinkState().mockMode,
        });

        alert(dialogText().patchWriteDone(verification));
        await dmeLink.disconnect();

        // The ECU now holds these bytes, so the workspace has to as well — otherwise patchStatus
        // still describes the pre-patch BASE, the drift never clears, and the hub would keep
        // offering the same write forever. Toggles are passed through rather than re-detected so
        // the reload cannot bounce them.
        await binaryFileState.loadFromBuffer(
          patchedBuffer,
          // WITH the extras that built this buffer: calibration edits make it a Tune_, and a
          // reloaded file whose name denies its own bytes is the lie buildFileName exists to end.
          binaryFileState.buildFileName(null, writeExtras),
          // All six, matching the bag handleOpenSession resolves. `applyTankVentDisable` was
          // missing and got away with it because that patch leaves a trace uploadBinary re-detects
          // — but it is the same omission class the clear() comment in useBinaryFile records as
          // having already shipped once, and a bag that is right by accident is not right.
          { applyPatch, applyWotDisable, applyTankVentDisable, writeWarmup, restoreWotFuel,
            restoreVe, restoreWarmup, writeRfKorr,
            writeVe: binaryFileState.writeVe, writeLowLoad: binaryFileState.writeLowLoad },
        );
        goToTab('current');
        return;
      }

      // saveSessionTune returns the updated record; `target` is a pre-save snapshot whose
      // binaryFileName is still unset for a draft, and re-tuning below needs that name.
      let flashed: TuningSession | null = target;
      if (target) {
        // A draft's tune isn't in the DB yet; an archived session's already is and must not be
        // rewritten — only its flash history grows. That is also what makes FINALIZE safe: it
        // re-flashes an archived session patch-off without touching the TUNED its earlier flash
        // record already points at.
        if (target.status === 'draft' && target.baseOrigin) {
          flashed = await sessionDb.saveSessionTune({
            sessionId: target.id,
            binaryFileName: binaryFileState.buildFileName(newMap, writeExtras),
            tunedBinaryBuffer: patchedBuffer,
            veMapSnapshot: newMap,
            tuneSettings: flashedSettings,
            log: logFileState.rawLogData,
          });
        }
        await sessionDb.recordFlash(target.id, {
          at: flashedAt, sha256, settings: flashedSettings, tuned: true,
          verifyMode: verification.mode, practice: dmeLink.readLinkState().mockMode,
        });
        // These bytes are now in the ECU, so this session is a record of what was flashed, not a
        // workspace: archive it. Leaving it a draft let you keep tuning it afterwards, which would
        // drift its TUNED away from the bytes its own flash history points at — and the list would
        // show DRAFT and "flashed" at the same time. Continue via "Use as base -> TUNED".
        await sessionDb.archive(target.id);
      }

      // Post-write instruction: the DME must be power-cycled to reinitialize with the new data.
      alert(dialogText().writeDone(verification));

      await dmeLink.disconnect();

      // Re-tune: the next session starts from exactly the bytes now in the ECU. Asked here because
      // this is the moment you decide — otherwise you'd have to find the row and open its New From
      // menu. Same code path, so the BASE is still a copy and still provably the parent's TUNED.
      if (flashed?.binaryFileName && confirm(dialogText().retuneConfirm)) {
        await handleNewFrom(flashed, 'tuned');
        return;
      }
      goToTab('startup');
    } else {
      // A failed write used to show nothing at all — no alert, no dialog — leaving only the small red
      // notice line and a WRITE button that still looked ready. That is the most consequential moment
      // in the app to stay silent about: writePartialBin erases the data area BEFORE it writes, so a
      // failure part-way through can leave the ECU partially programmed.
      const tFail = dialogText();
      await ask({
        title: tFail.titleWriteFailed, icon: <AlertCircle className="w-3 h-3" />,
        // From the write's own result, not from `dmeLink.error`. This handler captured the link
        // object before the flash and the error is published during it, so the field here still held
        // whatever was there BEFORE — which on the ordinary path is null, and `writeFailed(null)`
        // says "unknown error". Every real write failure has been reported that way.
        body: tFail.writeFailed(outcome.error, { wasBackgrounded: wasBackgrounded() }),
        confirmLabel: tFail.btnOk,
      });
    }
  };

  /** Records what the DME had learned before this session's log was captured. Best-effort, and
   *  deliberately after the fact: by the time this runs the ECU is already cleared — that is the
   *  real side effect and it succeeded — so a failed bookkeeping write must not present itself as a
   *  failed reset. (The reference takes the same view: PreserveBeforeClearSnapshotAsync warns and
   *  carries on rather than aborting the clear.) */
  const handleAdaptationResetComplete = async (before: AdaptationSnapshot, after: AdaptationSnapshot) => {
    // No session is now a normal outcome, not an unreachable branch: RESET ADAPT is offered on the
    // STARTUP tab whenever the link is connected, including with nothing loaded. Returning early is
    // the correct behaviour and always was — by the time this runs the ECU has already been cleared
    // and verified, so a missing place to file the record must never present itself as a failed
    // reset. Same shape and same reasoning as handleFlashCounterResetComplete.
    if (!currentSession) return;
    try {
      await sessionDb.recordAdaptationReset(currentSession.id, {
        at: Date.now(),
        mask1: TUNE_ADAPTATION_CLEAR.mask1,
        mask2: TUNE_ADAPTATION_CLEAR.mask2,
        before,
        after,
      });
    } catch (e) {
      console.error('Adaptation reset could not be recorded', e);
    }
  };

  /** Key of the pre-erase service block backup, so the session record points at the stored row. */
  const flashBackupRef = useRef<{ at: number; vin?: string } | null>(null);

  /**
   * Saves the 16 KB service block the flash-counter reset is about to erase — to a file AND to the
   * browser — and rejects if either fails.
   *
   * Rejecting is the whole point. resetFlashCounter awaits this before it sends a single erase, so
   * a throw here means the ECU is never touched. That block carries the VIN, AIF and ZIF records,
   * and once it is erased this image is the only way back, so "we couldn't save it, but let's erase
   * anyway" is not a trade worth offering.
   *
   * Saves silently. It deliberately does NOT trigger a file download: in this app writing to the
   * DME and downloading a file are separate, separately-chosen actions — WRITE never produces a
   * file, and every download hangs off a control that names what it exports (DOWNLOAD TUNED, the
   * per-artifact buttons in the session list). Firing a save dialog out of a vehicle write broke
   * that, which is why it is gone.
   */
  const handleFlashCounterBackup = async (pair: ArrayBuffer) => {
    const at = Date.now();
    // Through the snapshot: this is called BY the link, from inside resetFlashCounter, after a
    // reconnect may already have replaced the identity this render captured.
    const link = dmeLink.readLinkState();
    const vin = link.identity?.vin;
    // `mock` is recorded, not inferred later: both modes share this store, and a PRACTICE backup must
    // never be a restore candidate for a real ECU. Recovering the origin afterwards would mean
    // guessing from the VIN string, which is exactly the kind of guess this field removes.
    await saveServiceBackup({ at, vin, mock: link.mockMode, buffer: pair.slice(0) });
    flashBackupRef.current = { at, vin };
  };

  /** Offers the inspected service blocks as a file. Explicit and separately chosen, which is the
   *  app's rule for exports — unlike the pre-erase backup, which is a side effect of a write and so
   *  stays silent. */
  const handleSaveServiceBlocks = () => {
    const bytes = dmeLink.getServiceBlockBytes();
    if (!bytes) return;
    const vin = dmeLink.identity?.vin;
    downloadBlob(bytes, `ServiceBlock_${fileSafe(vin && vin !== 'UNKNOWN' ? vin : 'DME')}_${Date.now()}.bin`, MIME_BIN);
  };

  /** Offers the last operation's per-exchange timing and event log as a file, same explicit-export
   *  rule as the service blocks. The notice line only has room for medians; the sampled
   *  inter-arrival gaps are the part that distinguishes per-byte USB packets from batched ones, and
   *  those need a file. */
  const handleSaveTransferTiming = () => {
    const report = dmeLink.lastTransferTimingRef.current ?? dmeLink.lastTransferTiming;
    const record = report && diagnostics.buildRecord(report.kind);
    if (!record || !report) return;
    // Every knob that was set, in the name. A sweep produces a folder of these, and `baud` alone does
    // not separate a gap-0 run from a gap-20 one at the same rate — it is all inside the JSON, but a
    // directory listing that cannot be read at a glance is how runs get mixed up. The outcome goes in
    // too, so a failure is obvious without opening anything.
    const outcome = report.completed ? 'ok' : `died${report.chunks}`;
    // "asked for X, ran at Y" has to be in the name. A refused switch silently falls back to 9600, so
    // naming the file after the rate it RAN at makes a whole set of attempts look like repeats of the
    // baseline — which is exactly what happened to four candidate rates tested on a car.
    const rate = report.requestedBaud !== null && report.requestedBaud !== report.baud
        ? `${report.requestedBaud}refused-ran${report.baud}`
        : `${report.baud ?? 'unknown'}baud`;
    // The kind leads the name. Read and write reports are the same shape and land in the same
    // folder, and their turnaround medians mean completely different physical things.
    const name = `${report.kind.toUpperCase()}Timing_${rate}_${outcome}_${Date.now()}.json`;
    downloadBlob(JSON.stringify(record, null, 2), name, MIME_JSON);
  };

  /** Restore candidates for the DME actually on the other end of the cable — never anything else. */
  const handleListFlashBackups = () =>
    listRestorableBackups(dmeLink.identity?.vin, dmeLink.mockMode);

  /** Records the reset against the open session, if there is one. Best-effort and deliberately
   *  after the fact, exactly like handleAdaptationResetComplete: by the time this runs the DME has
   *  already been rewritten and verified, so a failed bookkeeping write must not present itself as
   *  a failed reset. There may also be no session at all — the reset is offered whenever the link
   *  is connected, including straight after CONNECTION with nothing loaded. */
  const handleFlashCounterResetComplete = async (before: FlashCounterInfo, after: FlashCounterInfo) => {
    const backup = flashBackupRef.current;
    if (!currentSession || !backup) return;
    try {
      await sessionDb.recordFlashCounterReset(currentSession.id, {
        at: Date.now(),
        beforeMasterUsed: before.master.used,
        beforeSlaveUsed: before.slave.used,
        afterMasterUsed: after.master.used,
        afterSlaveUsed: after.slave.used,
        backupAt: backup.at,
      });
    } catch (e) {
      console.error('Flash counter reset could not be recorded', e);
    }
  };

  /**
   * Writes a saved service block back, recovering a reset that was interrupted mid-rewrite.
   *
   * Marks the backup as consumed so the close handler below does not then tell the user to cycle
   * the ignition: after a recovery the right next step is to check the result, not to power-cycle
   * an ECU that has just been rebuilt.
   */
  const handleFlashCounterRestore = async (at: number): Promise<FlashCounterInfo | null> => {
    const record = await loadServiceBackup(at);
    if (!record) return null;
    // Re-checked here even though the list was already filtered. The list is a UI convenience; this
    // is the last line before 16 KB of identity data goes into an ECU, and the two must not be able
    // to disagree — a stale list, a reconnect to a different car, or a future caller that forgets to
    // filter would otherwise all end the same way.
    const vin = dmeLink.identity?.vin;
    if (!vin || vin === 'UNKNOWN' || record.vin !== vin || Boolean(record.mock) !== dmeLink.mockMode) {
      alert(dialogText().backupMismatch({
        connectedVin: vin ?? null,
        connectedMock: dmeLink.mockMode,
        backupVin: record.vin ?? null,
        backupMock: Boolean(record.mock),
      }));
      return null;
    }
    const info = await dmeLink.restoreServiceBlock(record.buffer);
    if (info) flashBackupRef.current = null;
    return info;
  };

  /**
   * Closes the reset dialog. When the reset actually ran, the connection has to go: the DME needs a
   * power cycle to re-initialise from the rewritten service block, and every DS2 operation after
   * this point would be talking to an ECU in an in-between state. Same shape as the post-write
   * teardown — say what to do, then drop the link.
   *
   * Keyed on whether a backup was taken rather than on the dialog's phase: that ref is set inside
   * onBackup, which is the last thing to happen before the first erase, so it is exactly "the ECU
   * may have been touched".
   */
  const handleFlashDialogClose = async () => {
    dialogs.close();
    if (!flashBackupRef.current) return;
    flashBackupRef.current = null;
    if (dmeLink.state === 'disconnected') return;
    alert(dialogText().flashDialogClosed);
    await dmeLink.disconnect();
  };

  /** Throws away the log just recorded so it can be re-driven, without touching the BASE. */
  const handleDiscardLog = () => {
    if (!confirm(dialogText().discardLog)) return;
    logFileState.clear();
    veCalc.reset();
    liveRun.reset();
    // Throwing the run away is a decision, so the recovery copy goes too — otherwise the next load
    // would offer back the very drive the user just chose to redo.
    void discardLiveRun().catch(() => { });
    goToTab('current');
  };

  /** What the ring offers while the link is connected and idle — derived from the workspace on every
   *  render, never stored.
   *
   *  A tune to flash outranks everything: that's what lets STOP drop the connection for the key cycle
   *  and still come back to WRITE. Then a BASE with no tune yet means record one. Nothing loaded means
   *  fetch a BASE. Because it's read off the data, it cannot disagree with the data — the whole class
   *  of "button says the wrong thing" bugs (a new session keeping WRITE, a reconnect offering READ
   *  over a loaded BASE, READ re-appearing after a read) came from storing this and re-syncing by hand.
   */
  /** Do the loaded bytes already carry the patches the toggles are asking for? Derived, like
   *  everything else here, rather than tracked: patchStatus is read out of the binary itself, so this
   *  compares "what is in the ECU" against "what you have armed" without storing either.
   *
   *  applyPatch is seeded on load from mapOff && tempLimit (uploadBinary), so the comparison has to
   *  use the same pair — testing mapOff alone would call a half-patched BIN patched. */
  const bytesPatched = !!patchStatus && patchStatus.mapOff && patchStatus.tempLimit;
  const bytesWotDisabled = !!patchStatus && patchStatus.wotDisabled;
  const bytesTankVentShut = !!patchStatus && patchStatus.tankVentDisabled;
  // All three, because all three are things that have to come back OFF before the car is handed back
  // to the road. TANK VENT was missing here while being listed in the write confirm and the flash
  // record, so a tune logged with the purge valve shut had no route to a patch-off write at all: no
  // drift, no WRITE PATCH-OFF, nothing to finalize with.
  const patchDrift = !!patchStatus && (bytesPatched !== applyPatch
    || bytesWotDisabled !== applyWotDisable
    || bytesTankVentShut !== applyTankVentDisable);

  /** A draft is a workspace, so drift in either direction there is you arming something. An archived
   *  session is a record, and the only legitimate reason to send it to the ECU again is finalising —
   *  taking the patches off. Without this, reopening an archived session whose log could not be
   *  replayed would raise drift by accident (its stored settings say PATCH ON, its BASE bytes are
   *  unpatched) and the hub would offer a patch write in place of READ, which is the one thing that
   *  state actually needs. */
  const patchWriteAllowed = !isArchived || (!applyPatch && !applyWotDisable && !applyTankVentDisable);

  /** What the ring offers while the link is connected and idle — derived from the workspace on every
   *  render, never stored.
   *
   *  A tune to flash outranks everything: that's what lets STOP drop the connection for the key cycle
   *  and still come back to WRITE. Then a BASE with no tune yet means record one. Nothing loaded means
   *  fetch a BASE. Because it's read off the data, it cannot disagree with the data — the whole class
   *  of "button says the wrong thing" bugs (a new session keeping WRITE, a reconnect offering READ
   *  over a loaded BASE, READ re-appearing after a read) came from storing this and re-syncing by hand.
   *
   *  'writePatch' sits between them and covers the two steps that have no derived map but still have
   *  bytes worth sending: arming the patch before the first log run, and taking a finished tune back
   *  off patch afterwards. It outranks 'tune' on purpose — with the patch not yet in the ECU, START
   *  TUNE would record STFT through the DME's own map correction, which is the wrong next step.
   *  Unlike 'tune' it is NOT gated on !isArchived: finalising is exactly an archived session's job. */
  const idleAction: 'read' | 'tune' | 'write' | 'writePatch' =
    newMap ? 'write'
      // Route A step 1: a correction table with no VE map behind it. An EGT run produces exactly
      // that — its log has no trim, so `newMap` stays null — and without this branch there would be
      // no way to send it. buildPatchedBuffer already writes KF_RF_KORR_DRREL outside its
      // `if (newMap)`, so the bytes have always been reachable; only the offer was missing.
      : (rfKorrArmed && currentMap && currentSession && !isArchived) ? 'writePatch'
        // CALIBRATION edits with no derived map behind them — the same shape as the rfKorr
        // branch above: bytes worth sending, no VE derivation, so without this the ring would
        // offer START TUNE over an armed edit and the only way to flash it would not exist.
        : (calEdits.armedEdits.length > 0 && currentMap && currentSession && !isArchived) ? 'writePatch'
          : (patchDrift && patchWriteAllowed && currentMap && currentSession) ? 'writePatch'
            : (currentMap && currentSession && !isArchived) ? 'tune'
              : 'read';

  /**
   * Which campaign shape the next WRITE belongs to. Derived, never stored — see deriveRoute.
   *
   * The parent's process is what separates "a VE map on BMW's own correction table" from "a VE map
   * on the table this campaign just replaced". Both write the same kind of bytes; only the history
   * says which one you are doing.
   */
  const parentSession = currentSession?.parentSessionId
    ? sessionDb.sessions.find(s => s.id === currentSession.parentSessionId)
    : undefined;
  const writeRoute = deriveRoute({
    process: logProcess,
    writeRfKorr: rfKorrArmed,
    hasVeMap: !!newMap,
    parentProcess: parentSession?.process ?? (parentSession ? 'VE' : undefined),
  });

  // Names the bytes by what they will carry once written, not by what is in the ECU now — the label
  // is a promise about the file being sent, the same rule DOWNLOAD PATCH-ON follows.
  const writePatchLabel = writeRoute === 'A1' ? 'WRITE RF KORR'
    : (applyPatch || applyWotDisable || applyTankVentDisable) ? 'WRITE PATCH-ON'
      // Calibration edits alone: the artifact is the BASE plus those cells, and the label says so.
      : calEdits.armedEdits.length > 0 ? 'WRITE CAL'
        : 'WRITE PATCH-OFF';


  // Which stage the hub's arc, percentage and phase label are all painted for. transferPhase lags
  // transferProgress by a beat — the link publishes 0% the moment the operation starts, and the
  // stage only arrives with the first chunk — so fall back to what the link state already says is
  // happening rather than flashing the read color at the top of a write.
  const transferStyle = TRANSFER_PHASE_STYLE[dmeLink.transferPhase ?? (dmeLink.state === 'writing' ? 'writing' : 'reading')];

  // Four states on a 8px dot, with the accent set down to three hues. Each one carries its own glow
  // rather than the single blue halo this used to wear under every state — a red error dot ringed in
  // M-blue was already wrong, and it gets worse now that the OK state is itself blue-family. Busy
  // additionally pulses, which is the channel that survives when hue does not.
  /** The header's FLASH field: how much programming life the DME has left.
   *
   *  ONE number, because a flash consumes a slot on both processors together — they track each
   *  other. The pair is still read and compared rather than assumed: the erase is a single command
   *  but the two writes are separate, so a write that succeeds on master and fails on slave leaves
   *  them permanently apart. That is rare and it is exactly the case worth seeing, so the display
   *  falls back to `master · slave` only when they actually disagree.
   *
   *  Colour comes from the status layer, not a new hue: violet ("amber") once either side is inside
   *  the reference's 5-slot warning band, red once a boot field is not closed — that one is not a
   *  headroom warning at all but "a programming session is still open", which blocks the reset. */
  const flashCounter = dmeLink.identity?.flashCounter ?? null;
  const flashSplit = !!flashCounter && flashCounter.master.used !== flashCounter.slave.used;
  const flashText = !flashCounter ? '-'
    : flashSplit
      ? `${flashCounter.master.used} · ${flashCounter.slave.used}/${ServiceBlockLayout.limitPerProcessor}`
      : `${flashCounter.master.used}/${ServiceBlockLayout.limitPerProcessor}`;
  const flashRegions = flashCounter ? [flashCounter.master, flashCounter.slave] : [];
  // The classification comes from flashCounter.ts rather than being worked out here, so the header
  // and anything else that has to judge the same numbers cannot come to different conclusions.
  const flashLevel = classifyFlashCounter(flashRegions);
  const flashColor = flashLevel === 'blocked' ? 'text-red-400'
    : flashLevel === 'low' ? 'text-amber-400'
      : 'text-slate-300';
  /** The per-processor detail the single number above folds away, kept on hover. Also where the
   *  click affordance is spelled out, since a bare number gives no hint that it is a control. */
  const flashTitle = flashCounter
    ? flashRegions.map(r => `${r.name}: ${r.used}/${ServiceBlockLayout.limitPerProcessor} used, ${r.remaining} left, marker 0x${r.firstOpenMarker.toString(16).toUpperCase().padStart(4, '0')} @ 0x${r.address.toString(16).padStart(6, '0')}`).join('\n')
      + '\n\nClick to read the flash counter and reset it.'
    : 'Flash counter not read';

  const dmeStatusColor = dmeLink.state === 'disconnected' ? 'bg-slate-600'
    : dmeLink.state === 'connecting' || dmeLink.state === 'reading' || dmeLink.state === 'writing' || dmeLink.state === 'resetting' ? 'bg-amber-500 shadow-[0_0_8px_rgba(155,132,232,0.6)] animate-pulse'
      : dmeLink.error ? 'bg-red-500 shadow-[0_0_8px_rgba(241,26,34,0.6)]'
        : 'bg-emerald-500 shadow-[0_0_8px_rgba(143,216,242,0.6)]';

  // WRITE WARMUP / WRITE WOT build their tables FROM the tuned map, so they have nothing to derive
  // until a log has produced one — buildPatchedBuffer generates both inside `if (newMap)` and ignores
  // the flags entirely otherwise. Same condition, expressed once, for the disabled state and the
  // effective value. PATCH and WOT TH are not in here: those patch the DME's logic directly and are
  // meaningful on a bare BASE, which is exactly what DOWNLOAD PATCH-ON exports.
  /** The two views whose map is assembled rather than stored: a base map wearing another map's
   *  numbers. Built here so their identity is stable — spread inline at the call site they were a
   *  new object on every render, which is exactly what a memo compares. */
  const diffVisualMap = useMemo(
    () => (diffMapForVisualization && (newMap || currentMap))
      ? { ...(newMap || currentMap)!, data: diffMapForVisualization }
      : null,
    [newMap, currentMap, diffMapForVisualization]);
  const lambdaVisualMap = useMemo(
    /* Axes from `currentMap`, NOT from `newMap`, and that is the whole of why this view used to
       arrive several seconds after START TUNE.
       The data here is `correctionMap`, which every flush produces from the first sample. `newMap`
       was only ever read for `xAxis`/`yAxis` — and the calculator builds those as literal copies of
       `currentMap`'s (calculator.ts:426), which have been in hand since the BASE was read. But
       `newMap` is deliberately withheld until at least one cell clears the evidence gate (10 samples
       and weight 5 by default), so borrowing its axes made this tab inherit a wait that belongs to
       a different question. That withholding is a safety property — a log with no qualifying cell
       produces a map identical to the BASE, and returning it once let a flash slot write the BASE
       back to a car under a TUNED name — so it stays exactly as it is. This view simply stops
       asking it. */
    () => (correctionMap && currentMap)
      ? { xAxis: currentMap.xAxis, yAxis: currentMap.yAxis, data: correctionMap }
      : null,
    [correctionMap, currentMap]);
  /** The RF KORR grid and surface, from the one selection they share. Memoised for the same reason
   *  as the two above — MapVisualizer is memoised, and a fresh object each render defeats it. */
  const rfKorrSurface = useMemo(
    () => tunedRfKorr ? rfKorrViewData(tunedRfKorr, rfKorrView) : null,
    [tunedRfKorr, rfKorrView]);

  /**
   * The chart pane and the log table run one beat behind the data, on purpose.
   *
   * Plotly applies its update synchronously inside React's commit, and the log table is up to
   * 2,000 DOM rows — ~440 ms to build on a desktop by its own header's measurement, several times
   * that on the phone. With every consumer in one pass, the deferred filter compute landed as one
   * long uninterruptible commit — and the SECOND tap of a filter session froze under it: the
   * paint-first handler had only moved the freeze 150 ms later, onto the next finger.
   *
   * useDeferredValue splits the heavy consumers into their own low-priority render. The grid and
   * readouts still update in the fast pass; an urgent tap between the data commit and the chart
   * commit jumps the queue; the plot follows when the finger goes quiet. Gates and data BOTH read
   * this bundle — gating on fresh state while rendering deferred data is how a `!` assertion
   * meets a null.
   */
  const chartFeed = useMemo(() => ({
    currentMap, newMap, diffVisualMap, lambdaVisualMap, rfKorrSurface, warmupMap, shapeSurface,
    logWindow: displayedLogWindow,
  }), [currentMap, newMap, diffVisualMap, lambdaVisualMap, rfKorrSurface, warmupMap, shapeSurface, displayedLogWindow]);
  const deferredCharts = useDeferredValue(chartFeed);

  /** Whether the visualisation box has anything in it for the current view. GRAPH is a destination,
   *  and a destination that lands on an empty box is worse than one that is greyed out. STARTUP is
   *  the only view that never has one; the log tab does, it is just 2D. */
  const graphHasContent = !!(
    (activeTab === 'current' && currentMap) ||
    (activeTab === 'new' && newMap) ||
    (activeTab === 'diff' && diffMapForVisualization && (newMap || currentMap)) ||
    (activeTab === 'lambda' && lambdaVisualMap) ||
    (activeTab === 'warmup' && warmupMap) ||
    (activeTab === 'rfkorr' && tunedRfKorr) ||
    // SHAPE draws here now, so the narrow layout's GRAPH tab is a destination on it.
    (activeTab === 'lowload' && newMap) ||
    (activeTab === 'log' && processedLog) ||
    // CALIBRATION: the selected parameter's chart/table, once it has decodable values.
    (activeTab === 'calibration' && calSelectedDef?.run && binaryBuffer)
  );

  /**
   * Is a ZOOMABLE GRID the thing on screen?
   *
   * The six views that render a `MapEditor`, each with the data that view needs — the same
   * conditions the panes below are gated on, and they have to stay the same: this decides whether
   * the zoom control is offered, and a zoom offered over the session list adjusts nothing.
   *
   * `graphHasContent` is NOT this. It includes the log tab, whose picture is a 2D chart with its
   * own scrub and no zoom, and it is asking about the other pane.
   */
  const gridOnScreen = !!(
    (activeTab === 'current' && currentMap) ||
    (activeTab === 'new' && newMap) ||
    (activeTab === 'diff' && mapData) ||
    (activeTab === 'lambda' && lambdaVisualMap) ||
    (activeTab === 'rfkorr' && tunedRfKorr) ||
    (activeTab === 'warmup' && warmupMap)
  );

  /** Standing on a destination that has stopped existing. Two ways to get there: the view changed
   *  under you and has no picture, or the phone was rotated back to portrait and the graph went home
   *  to the dash pane. Both land on DASH, which is where the graph now is in the second case. */
  useEffect(() => {
    if (narrowPane === 'graph' && (!splitGraph || !graphHasContent)) setNarrowPane('dash');
  }, [narrowPane, splitGraph, graphHasContent]);

/**
 * The WOT derivation is gone, and this is what replaced the reasoning that used to live here.
 *
 * It computed `NewWOT(rpm) = NewVE(rpm, 100 % RO) x (StockWOT(rpm) / StockVE(rpm, 100 % RO))` and
 * argued that it preserved BMW's enrichment ratio. It did not. Fuel at full load is proportional
 * to `rf_soll x rf_korr x KF_TI_N_RF_VL`, so correcting the VE table already corrects the fuel;
 * multiplying this table by the same ratio applies it a second time and the mixture goes lean by
 * c^2. Found on a real car holding a full-load lambda of 1.23 at 2100 rpm, saved only by the
 * WOT-threshold patch keeping the table out of reach. See COMMUNITY_WOT_FUEL_RAW.
 *
 * What is left is a restore to a known reference, armed by hand and shown when the bytes drift.
 */

  const derivedTablesLocked = !newMap;

  /**
   * Has the loaded binary's full-load fuel multiplier drifted from the community reference?
   *
   * `null` when there are no bytes to ask. Derived from the BYTES, never from a toggle: the table
   * is written by flashing and a session's settings cannot say what a previous campaign left
   * behind — which is exactly how a car ended up holding `KF_TI_N_RF_VL` scaled by its VE ratio,
   * with a full-load lambda of 1.23 at 2100 rpm, and nobody knowing. See COMMUNITY_WOT_FUEL_RAW.
   *
   * The lambda figures below are `1 / value`, which is what the multiplier means once the VE table
   * is right (see the same doc). They are the reason this is stated in the title rather than left
   * as "drifted": a number nobody can interpret is not a warning.
   */
  const wotFuel = useMemo(() => {
    if (!binaryFileState.binaryBuffer) return null;
    try {
      const p = new BinaryParser(binaryFileState.binaryBuffer);
      return { stock: p.wotFuelIsStock(), values: p.readWotFuel() };
    } catch { return null; }
  }, [binaryFileState.binaryBuffer]);
  const wotFuelDrift = wotFuel === null ? null : !wotFuel.stock;

  /**
   * How far the two Alpha-N tables in THESE bytes have moved from the CSL 0401 reference.
   *
   * Read from the binary, never from the session's toggles, for the reason `wotFuel` above states
   * and this pair states more sharply: `kf_rf_soll` is the table every campaign writes, so what a
   * loaded image holds is the sum of every flash that came before — including ones made in other
   * sessions, on other days, by other tools. A toggle can only speak for this session.
   *
   * A count, not a flag. 6 is a tune in progress; 363 is session #920's car against stock. The
   * RESTORE row shows it so that arming a restore is a decision with a size attached to it.
   */
  const stockDrift = useMemo(() => {
    if (!binaryFileState.binaryBuffer) return null;
    try {
      const p = new BinaryParser(binaryFileState.binaryBuffer);
      return { ve: p.veCellsOffStock(), warmup: p.warmupCellsOffStock() };
    } catch { return null; }
  }, [binaryFileState.binaryBuffer]);
  const wotFuelTitle = wotFuel === null ? manifestText.wotNeedsBinary
    : wotFuel.stock ? manifestText.wotStock
      // The implied lambda per rpm point, which is what makes 'drift!' mean something. Computed
      // here and passed in: it is DATA, and the only translated part is the sentence around it.
      : manifestText.wotDrift(wotFuel.values.map(v => (128 / v).toFixed(2)).join(' / '));

  /**
   * The hub's WRITE / RESTORE / PATCH groups.
   *
   * Computed HERE because every input — armed values, lock reasons, cell counts — already lives
   * here, and the menu must never disagree with what buildPatchedBuffer actually does. `checked`
   * is the ARMED value (toggle ANDed with derivability and with the feature gate), for the reason
   * rfKorrArmed exists: a switch reading ON while the write would contribute nothing is the lie
   * the manifest replaces.
   */
  const manifestGroups: ManifestGroup[] = useMemo(() => {
    // Which feature each row belongs to. WARMUP and the WOT FUEL restore ride with 've': warmup is
    // generated from the VE result, and the restore repairs a table the stable workflow's own
    // history damaged. The PATCH rows are logic switches the stable workflow has always had.
    const rowFeature: Record<string, FeatureName> = {
      alphan: 've', shape: 'lowLoad', warmup: 've', rfkorr: 'rfKorr',
      idle: 'idle', inertia: 'inertia', wotfuel: 've',
      // The two Alpha-N restores ride with 've' like the WOT FUEL one above: they repair tables the
      // VE workflow's own history moved. `restorewarmup` is 've' and not 'lowLoad' because
      // kf_rf_soll_kath is written by the WARMUP derivation, which is inside the VE trunk.
      restoreve: 've', restorewarmup: 've',
      patch: 've', map: 've', ltft: 've', tankvent: 've', wotth: 've',
    };
    /**
     * Is anything armed that writes DERIVED cells into `kf_rf_soll`?
     *
     * The three contributions the composition can take — VE's band, LOW LOAD's band, and SHAPE's
     * interpolated cells — against the one row that puts the whole table back. They are locked
     * against each other because they are the same 960 bytes: whichever ran last would win, and a
     * restore that a tune can overwrite is not a restore. `buildPatchedBuffer` enforces the same
     * order independently, so this lock is the explanation rather than the mechanism.
     */
    const veTuneArmed = binaryFileState.writeVe || lowLoadArmed
      || (binaryFileState.writeShape && shapeCells > 0);

    /**
     * Is the one write to `kf_rf_soll` armed? SHAPE hangs off this and is not a peer of it.
     *
     * SHAPE chooses WHICH SHAPE of the same grid goes into the table — the tuned map as measured,
     * or the tuned map with the low-opening repair applied. It is not a second table and not a
     * second set of cells: `buildPatchedBuffer` overlays the repaired cells onto the composed grid
     * and writes that ONE grid, so with ALPHA-N off there is no grid to overlay onto and the
     * repair was being dropped in silence while the row read as armed. A switch reading ON while
     * the write would contribute nothing is the lie this manifest exists to end.
     */
    const alphaNArmed = binaryFileState.writeVe || lowLoadArmed;

    /** CALIBRATION tab edits, one WRITE row per symbol. Held-back and conflicted edits stay
     *  listed — a row that vanishes when locked reads as data loss, and the count on it is the
     *  count the tab's COMPARE view reports. */
    const calManifestRows = [...calEdits.edits.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => {
        const owner = calEdits.conflicts.get(e.paramId);
        return {
          id: `cal:${e.paramId}`,
          label: e.name.toUpperCase(),
          kind: 'toggle' as const,
          symbol: `${e.name} · 0x${e.address.toString(16).toUpperCase().padStart(4, '0')} · ${e.dims ? `${e.dims.rows}x${e.dims.cols}` : e.count}`,
          checked: !calEdits.heldBack.has(e.paramId) && !owner,
          disabled: !!owner,
          lockReason: owner ? manifestText.calLockedByWriter(owner) : manifestText.calEditNote,
          status: `${changedCellCount(e)} cells`,
          onToggle: (on: boolean) => calEdits.setHeld(e.paramId, !on),
        };
      });

    const groups: ManifestGroup[] = [
      {
        id: 'write', title: 'WRITE', caption: manifestText.captionWrite,
        rows: [
          {
            // ONE ROW FOR ONE TABLE. `kf_rf_soll` is a single 24x20 map, and VE and LOW LOAD are
            // two derivations over different bands of it — since TI_F_STAT came out of the
            // correction and `ltft` went into both, they are now the SAME expression,
            // `Old x stft x ltft x rf_korr`, differing only in the evidence each band demands.
            // Two toggles over one table asked the reader to make a decision the arithmetic no
            // longer offers, and let one be armed while the other was not — which is a table
            // written half from a drive and half from BASE, with nothing on screen saying so.
            //
            // The split stays INSIDE, and deliberately: a stationary idle can park on a cell for
            // minutes while a sweep crosses it in a second, so the two bands need different bars;
            // and the additive trim store this ECU cannot read is the one an idle learns into, so
            // the risk carried by the neutrality inference is concentrated below the seam. That is
            // a reason to keep reporting the bands apart, not to keep asking about them apart.
            //
            // Same shape as the PATCH row below, which arms TANK VENT with it for the same reason.
            id: 'alphan', label: 'ALPHA-N', kind: 'toggle',
            checked: binaryFileState.writeVe || lowLoadArmed,
            disabled: !alphaNAvailable || !!storeLockReason || restoreVe,
            // RESTORE VE first, because it is the thing the operator just switched and the only one
            // of the three they can undo in one tap. Then the store gate: a map derived through a
            // learned store is wrong by an amount nothing on this ECU can measure, and saying "no
            // map yet" over that would name the smaller problem.
            lockReason: restoreVe
              ? manifestText.restoreVeLocksAlphaN
              : storeLockReason ?? (alphaNAvailable ? undefined
                : alphaNEarnedNothing ? manifestText.alphaNEarnedNothing
                  : manifestText.derivedTablesLocked),
            status: alphaNAvailable ? `${alphaNCells} cells` : undefined,
            onToggle: setWriteAlphaN,
          },
          {
            // Its own row and its own toggle, because these cells carry NO direct measurement.
            // They are interpolated between cells that do, which is a defensible thing to write and
            // a different thing from what ALPHA-N writes — so it is a separate decision, off until
            // taken, and counted separately wherever it appears.
            id: 'shape', label: 'SHAPE', kind: 'toggle',
            checked: binaryFileState.writeShape && shapeCells > 0 && alphaNArmed,
            disabled: shapeCells === 0 || !alphaNArmed || !!storeLockReason || restoreVe,
            // ALPHA-N before the other locks: it is the row this one is a MODE of, and the rest
            // are about the table rather than about the choice.
            lockReason: restoreVe
              ? manifestText.restoreVeLocksShape
              : !alphaNArmed ? manifestText.shapeNeedsAlphaN
                : storeLockReason ?? (shapeCells === 0
                  ? manifestText.shapeNothingApplied
                  : manifestText.shapeReady),
            status: shapeCells > 0 ? `${shapeCells} cells` : undefined,
            onToggle: binaryFileState.setWriteShape,
          },
          {
            id: 'warmup', label: 'WARMUP', kind: 'toggle',
            checked: writeWarmup, disabled: derivedTablesLocked || restoreWarmup,
            lockReason: restoreWarmup
              ? manifestText.restoreWarmupLocksWarmup
              : derivedTablesLocked ? manifestText.derivedTablesLocked : undefined,
            status: newMap ? 'derived' : undefined,
            onToggle: setWriteWarmup,
          },
          {
            id: 'rfkorr', label: 'RF KORR', kind: 'toggle',
            checked: rfKorrArmed, disabled: !canTuneRfKorr,
            lockReason: !canTuneRfKorr ? rfKorrLockReason : undefined,
            onToggle: setWriteRfKorr,
          },
          // TRIM STORE used to sit here: a readout of the neutrality verdict, on the argument that
          // the licence the two derivations above are written on should be checkable and not only
          // audible when it refuses. Taken out on request (operator, 2026-08-31) — four rows of the
          // menu were spent stating a fact in its good case, which is its usual case.
          //
          // THE GATE ITSELF IS UNTOUCHED. `storeLockReason` still disables ALPHA-N and SHAPE on a
          // learned store, and `manifestText.trimLearned` is still what their info reads out, so
          // the refusal is said in full where the refusal happens. What is gone is the row that
          // said NEUTRAL when there was nothing to refuse.
          {
            id: 'idle', label: 'IDLE', kind: 'sealed',
            lockReason: manifestText.idleSealed,
          },
          {
            id: 'inertia', label: 'INERTIA', kind: 'info', status: 'proposal only',
            lockReason: manifestText.inertiaProposal,
          },
        ],
      },
      {
        id: 'restore', title: 'RESTORE', caption: manifestText.captionRestore,
        rows: [
          // ONE ROW PER TABLE, each carrying the ECU's own name for it. A restore's subject is the
          // TABLE — "which bytes go back to what" — where a WRITE row's subject is the derivation,
          // so these are the rows that name a definition and the WRITE rows are not (operator,
          // 2026-08-26).
          //
          // The two Alpha-N tables are separate rows for a reason that is not symmetry: they are
          // separate addresses on separate axes, and a campaign routinely moves the warm one and
          // leaves the cold one alone. Folding them together would make going back to a known warm
          // table cost the cold one too.
          {
            id: 'restoreve', label: 'VE', kind: 'toggle',
            symbol: 'kf_rf_soll · 0xD356 · 24x20',
            checked: restoreVe, disabled: !binaryFileState.binaryBuffer || veTuneArmed,
            lockReason: !binaryFileState.binaryBuffer ? manifestText.restoreNeedsBinary
              : veTuneArmed ? manifestText.restoreVeLockedByTune
                : stockDrift === null ? undefined
                  : stockDrift.ve === 0 ? manifestText.restoreAlreadyStock
                    : manifestText.restoreVeDrift(stockDrift.ve),
            status: stockDrift === null ? undefined
              : stockDrift.ve === 0 ? 'stock' : `${stockDrift.ve} cells`,
            statusTone: stockDrift?.ve === 0 ? 'ok' : 'warn',
            onToggle: setRestoreVe,
          },
          {
            id: 'restorewarmup', label: 'WARMUP', kind: 'toggle',
            symbol: 'kf_rf_soll_kath · 0xD770 · 24x20',
            checked: restoreWarmup, disabled: !binaryFileState.binaryBuffer || writeWarmup,
            lockReason: !binaryFileState.binaryBuffer ? manifestText.restoreNeedsBinary
              : writeWarmup ? manifestText.restoreWarmupLockedByWrite
                : stockDrift === null ? undefined
                  : stockDrift.warmup === 0 ? manifestText.restoreAlreadyStock
                    : manifestText.restoreWarmupDrift(stockDrift.warmup),
            status: stockDrift === null ? undefined
              : stockDrift.warmup === 0 ? 'stock' : `${stockDrift.warmup} cells`,
            statusTone: stockDrift?.warmup === 0 ? 'ok' : 'warn',
            onToggle: setRestoreWarmup,
          },
          {
            id: 'wotfuel', label: 'WOT FUEL', kind: 'toggle',
            symbol: 'KF_TI_N_RF_VL · 0x0B5A · 3x18',
            checked: restoreWotFuel, disabled: wotFuelDrift === null,
            // The full comparison, lambda figures and all — it is what makes 'drift!' mean
            // something. Rendered when locked, on hover otherwise.
            lockReason: wotFuelTitle,
            status: wotFuelDrift ? 'drift!' : undefined, statusTone: 'warn',
            onToggle: setRestoreWotFuel,
          },
          ...calManifestRows,
        ],
      },
      {
        id: 'patch', title: 'PATCH', caption: manifestText.captionPatch,
        rows: [
          {
            id: 'patch', label: 'PATCH', kind: 'toggle',
            checked: applyPatch, disabled: !patchStatus,
            lockReason: !patchStatus ? manifestText.needBinary : undefined,
            // One switch, two patches — it arms TANK VENT with it. The two rows below are what
            // that decision does, stated as readouts rather than as second decisions.
            onToggle: (on) => { setApplyPatch(on); setApplyTankVentDisable(on); },
          },
          { id: 'map', label: 'MAP', kind: 'readout', status: applyPatch ? 'OFF' : 'ON', statusTone: applyPatch ? 'warn' : 'muted' },
          { id: 'ltft', label: 'LTFT MIN', kind: 'readout', status: applyPatch ? '100' : 'OEM', statusTone: applyPatch ? 'warn' : 'muted' },
          {
            id: 'tankvent', label: 'TANK VENT', kind: 'readout',
            status: applyTankVentDisable ? 'SHUT' : 'OEM',
            statusTone: applyTankVentDisable ? 'danger' : 'muted',
            lockReason: manifestText.tankVentNote,
          },
          {
            id: 'wotth', label: 'WOT TH', kind: 'toggle',
            checked: applyWotDisable, disabled: !patchStatus,
            lockReason: !patchStatus ? manifestText.needBinary : undefined,
            status: applyWotDisable ? '102.3' : 'OEM', statusTone: applyWotDisable ? 'warn' : 'muted',
            onToggle: setApplyWotDisable,
          },
        ],
      },
    ];
    // `infoLabel` set here rather than on every row above: it is the same word on all of them, and
    // twenty copies of one string is twenty places for it to fall out of step.
    return groups
      .map(g => ({
        ...g,
        rows: g.rows
          .filter(r => featureEnabled(
            r.id.startsWith('cal:') ? 'calibration' : rowFeature[r.id], featurePreview))
          .map(r => ({ ...r, infoLabel: manifestText.info })),
      }))
      .filter(g => g.rows.length > 0);
  }, [storeLockReason, alphaNCells, alphaNAvailable, alphaNEarnedNothing,
    shapeCells, binaryFileState.writeShape, binaryFileState.setWriteShape,
    setWriteAlphaN, binaryFileState.writeVe, lowLoadArmed, newMap,
    writeWarmup, setWriteWarmup, derivedTablesLocked, manifestText,
    rfKorrArmed, canTuneRfKorr, rfKorrLockReason, setWriteRfKorr,
    restoreWotFuel, setRestoreWotFuel, wotFuelDrift, wotFuelTitle, applyPatch, setApplyPatch,
    restoreVe, setRestoreVe, restoreWarmup, setRestoreWarmup, stockDrift, binaryFileState.binaryBuffer,
    applyTankVentDisable, setApplyTankVentDisable, applyWotDisable, setApplyWotDisable,
    patchStatus, featurePreview, calEdits]);

  /** Whether the next write would carry anything at all. The ring's WRITE gates on it: an empty
   *  write is not an action, and offering it is how a flash comes back byte-identical. */
  const writeCarriesSomething = anythingArmed(manifestGroups);

  /** How the three groups are hung around the dial. PATCH left, WRITE right, level with each other
   *  so the ring is flanked by the two decisions taken on every campaign; RESTORE sits under WRITE
   *  because it is used a handful of times a year, not every flash. */
  const groupById = (id: string) => manifestGroups.filter(g => g.id === id);
  const leftWingGroups = groupById('patch');
  const rightWingGroups = groupById('write');
  /** RESTORE is NOT a wing. The wings are what the dial is flanked by — the decisions taken on
   *  every campaign — and this one is taken a few times a year. It sits in the panel's bottom
   *  corner instead, reachable and out of the way. */
  const [restoreGroup] = groupById('restore');

  const dmeButtonConfig = (() => {
    switch (dmeLink.state) {
      case 'disconnected': return { label: 'CONNECTION', Icon: PlugZap, onClick: handleDmeConnect, disabled: false, spin: false };
      case 'connecting': return { label: 'CONNECTING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      case 'reading': return { label: 'READING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      // An inertia run reaches 'tuning' through startInertiaRun, not through handleStartTune, so
      // the ordinary STOP would run the VE teardown over it: finishLog flushes an empty sample
      // buffer, reports a datalog that does not exist, and disconnects the link. Stopping the poll
      // is all that is wanted — InertiaWorkflow's own onEnd then computes and stores the estimate.
      case 'tuning': return logProcess === 'INERTIA'
        ? { label: 'STOP', Icon: Square, onClick: () => { dmeLink.stopTuning(); goToTab('inertia'); setNarrowPane('map'); }, disabled: false, spin: false }
        : { label: 'STOP', Icon: Square, onClick: handleStopTune, disabled: false, spin: false };
      case 'writing': return { label: 'WRITING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      // The reset dialog owns the screen while this runs; the hub is disabled rather than hidden so
      // it's visible that the link is busy and START TUNE cannot be raced against the DS2 traffic.
      case 'resetting': return { label: 'RESET', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      case 'connected':
        switch (idleAction) {
          // Gated on the manifest, not on having a derivation. Every table is behind a toggle
          // now, so a map can exist with nothing armed — and offering WRITE there produces a flash
          // that comes back byte-identical to the BASE, which reads as a failed write rather than
          // as an empty one. The reason is rendered under the ring, since a disabled ring that
          // cannot say why is the control that gets reported as broken.
          case 'write': return {
            label: 'WRITE', Icon: Zap, onClick: handleDmeWrite,
            disabled: !writeCarriesSomething, spin: false,
          };
          case 'writePatch': return {
            label: writePatchLabel, Icon: Zap, onClick: handleDmeWrite,
            disabled: !writeCarriesSomething, spin: false,
          };
          // Tuning is a draft-only act: an archived session must never re-derive its own map.
          // Labelled for where it goes. handleStartTune refuses INERTIA and routes to the panel, but
          // a button that says START TUNE and then navigates is a surprise — and the surprise is the
          // whole failure mode being fixed here.
          case 'tune': return logProcess === 'INERTIA'
            ? { label: 'INERTIA PANEL', Icon: Gauge, onClick: handleStartTune, disabled: false, spin: false }
            : { label: 'START TUNE', Icon: Play, onClick: handleStartTune, disabled: false, spin: false };
          case 'read': return { label: 'READ', Icon: Zap, onClick: handleDmeRead, disabled: false, spin: false };
        }
    }
  })();


  /** Which destination the narrow layout is showing, wearing the tab row's own clothes: same height,
   *  same 10px letterspaced label, same 2px underline under the active one. It stands where the
   *  tabs stood and looks like what stood there, so it reads as navigation rather than as a new
   *  kind of control. Above 900px both panes are on screen and this is not rendered at all.
   *
   *  Rendered in BOTH 44px rows, because each pane owns its own and the pane you are not looking
   *  at is `hidden` — put it in one and the way back out of the other goes with it.
   *
   *  GRAPH is here only where the pane actually splits. Given the height to stack, the 3D view is
   *  already on screen in the dash pane above the controls, and a third destination would be a tap
   *  charged for something you can see anyway. */
  /** A reload has been asked for and the new build is being fetched. Ends with the document being
   *  replaced, so nothing ever clears it — the only way out of this state is the new build.
   *
   *  Read from the update store rather than held here, because the store is what knows: the phases
   *  are set inside `reloadForUpdate` and the byte counts arrive from the installing worker. A copy
   *  in this component could only ever be a second answer to a question that already has one.
   *  Deliberately the boolean hook and not `useUpdateProgress` — this file is 3800 lines and the
   *  worker reports at 10 Hz, so subscribing to the whole record here would re-render the app a few
   *  hundred times per update to move a bar that lives in one small panel. */
  const reloading = useUpdateRunning();

  /** Asks first only when there is something to lose. Disconnected with no log and no unsaved tune,
   *  a reload costs nothing and a confirmation would just be a step.
   *
   *  Shared by the menu row and the header control, which are the same action reached from the two
   *  layouts. Not `location.reload()` — with the offline cache in front of it that reloads the build
   *  already on disk, which is the one being offered as a replacement. */
  const handleReload = useCallback(() => {
    if (reloading) return;
    const busy = dmeLink.state !== 'disconnected' || !!processedLog || !!newMap;
    if (busy && !confirm(dialogText().reloadBusy)) return;
    void reloadForUpdate();
  }, [reloading, dmeLink.state, processedLog, newMap]);

  const narrowPaneTabs = (
    <div className="flex min-[900px]:hidden space-x-6 h-full shrink-0">
      {([['map', 'MAP', true, ''], ['graph', 'GRAPH', graphHasContent, SPLIT_ONLY_SHOW], ['dash', 'DASH', true, '']] as const).map(([id, label, enabled, shown]) => (
        <button
          key={id}
          type="button"
          disabled={!enabled}
          onClick={() => setNarrowPane(id)}
          className={`relative h-full ${shown || 'flex'} items-center shrink-0 whitespace-nowrap text-[10px] font-bold tracking-widest transition ${narrowPane === id
            ? 'text-blue-400 border-t-2 border-blue-400'
            : enabled ? 'text-slate-500 hover:text-slate-300 border-t-2 border-transparent'
              : 'text-slate-700 border-t-2 border-transparent cursor-default'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  /** The connect/write hub — status row, notice line, ring, wings, RESTORE corner. Hoisted so
   *  the CALIBRATION tab can mount it inside its bottom [INFO|DME] tabs while every other tab
   *  renders it in place. One instance either way — the state machine never doubles. */
  const dmeInputsPanel = (
    <>
              {/* Minimal File Inputs - No Icons, Just Text, Hover for action */}
              <div className="space-y-1 mb-4">
                {/* DME (LIVE) — connection status + settings; the CONNECTION action itself lives on the main ring below */}
                {/* Wraps rather than overflows, and `min-h` rather than `h`.
                    ────────────────────────────────────────────────────────────────────────────────
                    What this row carries depends on the cable. Over the mock link it is
                    "practice · connected", QUICK VERIFY and DISCONNECT — 247px, which fits. On a
                    WebUSB FTDI it also gets FAST ON/OFF and the BOOST selector, and measured at 375
                    that is 383px of content in a 335px row.

                    A fixed-height flex row with nothing to give does not clip: it overflows. And the
                    section around it is `overflow-y-auto`, which CSS resolves to `overflow-x: auto`
                    as well — so the pane's scrollWidth went to 403 against a 375 viewport and the
                    whole status area could be dragged sideways, but ONLY with a real cable attached
                    (operator, 2026-08-25; the mock never renders those two).

                    So the row is allowed a second line. The 32px is a floor now, which keeps the
                    stability the fixed height was for — nothing moves while the row fits — and lets
                    it grow the moment it cannot. */}
                <div className="rounded flex flex-wrap items-center justify-between gap-x-2 gap-y-1 min-h-[32px] px-2">
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-1.5">
                    <Cpu className="w-3 h-3" /> DME (LIVE)
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 min-w-0">
                    {/* OUTSIDE the connected/disconnected split on purpose. This belongs to the last
                        READ, not to the link — and the whole point of the measurement is a sweep where
                        you read, DISCONNECT to change the driver's latency timer, reconnect and read
                        again. Inside the connected branch it vanished at exactly the moment you needed
                        it, taking an un-saved run with it. */}
                    {/* There is no DIAG marker here any more, and none on the notice line either.
                        It reported whether the diagnostic record reached the store — an upload the
                        user never asked for, about a file that exists for whoever is debugging this
                        app. Four states rendered in four tones for it, next to a link that has its
                        own four states, on the row where the operator is looking for the state of a
                        CAR. Nothing about it changed what to do next.

                        The record itself is untouched: `publishDiagnostics` still runs on every read,
                        write and log, and TIMING beside this still saves the same thing as JSON. If
                        an upload fails, the place that says so is the store panel, which is where
                        someone who cares about uploads already is. */}
                    {dmeLink.lastTransferTiming && (
                      <button
                        onClick={handleSaveTransferTiming}
                        className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-blue-400 transition-colors"
                        title={'Save the last operation\'s per-exchange timing and event log as JSON.\n\n'
                          + 'One operation = one report, and the next one overwrites it. Save before running another.\n\n'
                          + 'The same record is uploaded to the store automatically when a sync token is configured — this is the offline copy.'}
                      >
                        Timing
                      </button>
                    )}
                    {dmeLink.state === 'disconnected' ? (
                      <>
                        <label className="py-3 -my-3 flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer" title="Simulate a DME offline — no cable required">
                          <input
                            type="checkbox"
                            checked={dmeLink.mockMode}
                            onChange={(e) => dmeLink.setMockMode(e.target.checked)}
                            className="w-3 h-3 accent-amber-500 rounded bg-slate-700 border-none"
                          />
                          PRACTICE
                        </label>
                        {/* The READ baud selector stood here. It is gone, and with it the `invisible`
                            box that had to be kept mounted so hiding it under PRACTICE would not
                            shove this checkbox sideways as you clicked it — a whole layout hazard
                            that existed only to hold a control with one usable setting.

                            9600 was the default and the only rate that finishes a read: 38400 is
                            closed negative over eleven attempts and 125000 cannot be reached from a
                            read at all. Every path picks its own rate from what it is doing — the
                            read, the datalog, the full write, and FAST READ's 125000 through a
                            programming session — so there was never a decision here to make. The
                            evidence lives in Ds2SupportedBaud, where it belongs. */}
                      </>
                    ) : (
                      <>
                        <span className="text-[9px] text-slate-600 font-mono uppercase">{dmeLink.mockMode ? 'practice' : 'live'} · {dmeLink.state}</span>
                        {/* What a WRITE will prove. Here rather than inside the confirm dialog because
                            the dialog's job is to state the consequence of the thing about to happen —
                            it names this mode in its text — and a control that changes the consequence
                            while the warning is on screen is the wrong shape for a destructive gate.
                            Opens on FULL for a DME that has never had the two checks agree; see
                            verifyPolicy.ts. */}
                        {/* A checkbox, not a two-option list. FULL is the state of not having asked
                            for QUICK — which is the shape of the decision, and the same shape as
                            PRACTICE two elements away, so the row reads as one kind of control
                            rather than three.

                            Amber for the same reason PRACTICE is amber: ticking it opts out of the
                            conservative default. Unticked means every one of the 65536 bytes is read
                            back and compared, and that is what a blank box should mean. */}
                        <label
                          className="py-3 -my-3 flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer"
                          title={'How the flash proves it landed. Every chunk\'s verify byte is checked either way — this chooses what happens after the last one.\n\n'
                            + 'TICKED (QUICK) — ask the DME for its own encoding checksum (DS2 0x0A). One exchange, ~50ms. Its authority is the CRC-16/ARC values the ECU stores in its own flash, covering 65528 of the pair\'s 65536 bytes. It cannot say WHERE a mismatch is, and it cannot catch a corruption that preserves CRC-16.\n\n'
                            + 'CLEAR (FULL) — everything QUICK does, and read all 65536 bytes back and compare them byte for byte. Adds ~123s. The only check that can name an offset.\n\n'
                            + 'This opens CLEAR until QUICK and FULL have agreed once on this VIN.'}
                        >
                          <input
                            type="checkbox"
                            checked={verifyMode === 'quick'}
                            disabled={dmeLink.state !== 'connected'}
                            onChange={(e) => setVerifyMode(e.target.checked ? 'quick' : 'full')}
                            className="w-3 h-3 accent-amber-500 rounded bg-slate-700 border-none disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          {/* "QUICK" alone would sit two controls from FAST READ and mean something
                              different; the second word is what keeps them apart. */}
                          QUICK VERIFY
                        </label>
                        {/* FAST READ. A readout, not a control — it is armed by whether a service-block
                            backup exists for this VIN, which is a fact about the DME rather than a
                            preference. Shown even when off, because "why was my read still 2 minutes"
                            is exactly the question this answers. */}
                        {dmeLink.state === 'connected' && !dmeLink.mockMode && (
                          <span
                            className={`text-[9px] font-mono ${dmeLink.fastReadArmed ? 'text-emerald-400' : 'text-slate-600'}`}
                            title={dmeLink.fastReadArmed
                              ? 'FAST READ armed. The bulk read will erase and immediately restore the Free Identifiers sector to reach a programming session, where the DME accepts 125000 baud — about 123s down to 15-30s.\n\n'
                                + 'Every byte put back is read live seconds before the erase; the stored backup supplies addresses only. The restore is verified byte for byte BEFORE the baud switch is attempted, so a refused switch costs the speed and nothing else.\n\n'
                                + 'Afterwards the DME is rebooted and reconnected automatically, because at 125000 it will not serve live values or adaptations.'
                              : 'FAST READ not armed — this DME has no stored service-block backup yet, so there is no map of what the Free Identifiers sector must keep. Take one from the FLASH dialog (inspect / backup) and it arms itself on the next connect. Reads run at 9600 until then.'}
                          >
                            FAST {dmeLink.fastReadArmed ? 'ON' : 'OFF'}
                          </span>
                        )}
                        {/* The write-path baud boost. Rendered ONLY on the transport that can change
                            rate on the open handle, because this switch can only be sent after the
                            erase — the one moment a port close/reopen could desync the link is the
                            moment the ECU has nothing to fall back on. It is not a preference: it
                            resets to 9600 on every connect and has to be armed deliberately. */}
                        {dmeLink.transportKind === 'web-usb-ftdi' && !dmeLink.mockMode && (
                          <label
                            className="flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer"
                            title={'EXPERIMENT. Boost the flash write to 125000 baud, which the DME accepts only from inside a programming session — the erase is what creates one.\n\n'
                              + 'Measured on this car: a write telegram is 150ms of request, 32ms of DME programming and 11ms of response, so it is 78% wire. At 125000 that is ~44ms instead of ~193ms, and a QUICK write should fall from about 68s to roughly 17s.\n\n'
                              + 'Bounded three ways: the switch is answered before anything moves; a refused switch just writes at 9600; and if it is accepted but the DME then goes silent, the link drops back to 9600 BEFORE a single write telegram is sent.\n\n'
                              + 'If the ECU answers at neither rate the write stops with the data area erased. Recovery is ignition off, 10 seconds, back on, reconnect, WRITE again — it always restarts from the erase. Resets to 9600 on every connect.'}
                          >
                            BOOST
                            <select
                              value={dmeLink.writeBaud}
                              disabled={dmeLink.state !== 'connected'}
                              onChange={(e) => dmeLink.setWriteBaud(Number(e.target.value) as Ds2SupportedBaud)}
                              className="bg-slate-800 text-[9px] font-mono text-slate-300 rounded px-1 py-0.5 outline-none cursor-pointer border border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value={9600}>OFF</option>
                              <option value={125000}>125000</option>
                            </select>
                          </label>
                        )}
                        <button
                          onClick={dmeLink.disconnect}
                          className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 transition-colors"
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {/* Notice line: fixed height whether or not it says anything. Errors and warnings come
                    and go with DME state, and letting them grow this panel grew it into the
                    visualizer above (250 -> 285px), resizing the 3D map every time one appeared.
                    The full text is on hover, and on the header status dot.

                    TWO lines below 900px, one above it, and both are reserved rather than grown.
                    The intent here has always been "one line, truncated" — but the paragraph inside
                    had picked up `whitespace-pre-line max-h-[56px] overflow-y-auto`, which wraps.
                    At 375 the message this line exists to carry — "Nothing armed — open WRITE on
                    the hub and switch on what this flash should carry." — is 28px of text in a 14px
                    box whose child scrolls, so on connect the hub grew a 14px sliver you could drag
                    up and down (operator, 2026-08-25). One line is not a width this message fits in
                    on a phone, and `title` is a hover tooltip on a device with no hover, so
                    truncating it would hide the instruction rather than shorten it.

                    A desk keeps 14px: at that width the same message is one line, and the growth
                    this slot was introduced to stop was measured there. */}
                <div className="h-[28px] min-[900px]:h-[14px] px-2 flex items-center overflow-hidden">
                  {(() => {
                    // dmeLink.warning first: it describes the operation that just ran, and the
                    // transport notice only applies while disconnected, so the two never compete.
                    //
                    // `transportKind === 'none'` rather than a negated "supported" flag, because
                    // null (not yet determined, i.e. the static prerender) must render nothing.
                    // The old test was a bare boolean that read false during prerender, which put
                    // an "unsupported browser" line into the exported HTML for every visitor.
                    // `warningKind === 'info'` is NOT rendered, and that is the whole of the change.
                    //
                    // That kind carries one message: the read reporting its own measured baud and
                    // throughput. It was instrumentation for the period when the transport was being
                    // characterised, and it has been noise on every successful read since — a line of
                    // white numbers on the one surface reserved for "something needs your attention".
                    // Nothing is lost by dropping it: the per-exchange record still goes to the
                    // diagnostics store on every operation, and the TIMING button still saves the
                    // whole thing as JSON. Measurements belong in a record, not on the dashboard.
                    //
                    // Errors and real warnings are untouched — those are the reason this line exists.
                    const warning = (dmeLink.warning && dmeLink.warningKind !== 'info' ? dmeLink.warning : null)
                      ?? (!dmeLink.mockMode && dmeLink.state === 'disconnected' && dmeLink.transportKind === 'none'
                        ? dialogText().noTransport({ android: isAndroidPlatform() })
                        : null);
                    // Ranked by CONSEQUENCE, not by source. A run that recorded samples and could
                    // not store them is the most expensive thing this line can say, and it used to be
                    // displaced by a caution about the cable. A refused calibration comes next: it is
                    // why the IDLE tab is dark, and without it that reads as a broken build.
                    // Last, below the faults: a ring that will not move because nothing is armed
                    // is not an error, it is an instruction. Without it the disabled WRITE is the
                    // control that gets reported as broken.
                    const nothingArmed = dmeLink.state === 'connected'
                      && (idleAction === 'write' || idleAction === 'writePatch')
                      && !writeCarriesSomething
                      ? 'Nothing armed — open WRITE on the hub and switch on what this flash should carry.'
                      : null;
                    const notice = dmeLink.error
                      ?? idleSaveError
                      ?? (idleTablesRefusal ? `IDLE UNAVAILABLE: ${idleTablesRefusal}` : null)
                      ?? warning
                      ?? nothingArmed;
                    if (!notice) return null;
                    // Two levels now, not three. The third was the near-white `info` tone, which
                    // existed only for the measurement line dropped above — with nothing quiet left
                    // to say, every message that reaches here is either a fault or a caution.
                    // Leading is pinned to the row height so the font cannot grow the panel into the
                    // visualizer.
                    const tone = dmeLink.error ? 'text-red-400' : 'text-amber-500/80';
                    return (
                      <p className={`text-[11px] leading-[14px] font-mono whitespace-pre-line line-clamp-2 min-[900px]:line-clamp-1 ${tone}`} title={notice}>
                        {notice}
                      </p>
                    );
                  })()}
                </div>
              </div>

              {/* DASHBOARD CLUSTER — outer div measures real available space; inner div renders the
                  hub/wings at natural size and gets a computed transform:scale to fit exactly. */}
              {
                <div ref={clusterOuterRef} style={{ minHeight: clusterMinH }} className="relative flex-1 min-w-0 flex justify-center items-center overflow-hidden py-1.5">
                {/* 3-column grid, NOT a flex row: the two outer columns are equal-width (1fr each), so
                    the hub sits at the exact horizontal centre no matter how wide the wings are. A flex
                    row centres the cluster as a whole, which lets the hub drift sideways whenever a wing
                    label changes width (e.g. WRITE WARMUP -> WARMUP). Empty placeholder columns keep the
                    hub in column 2 even before a BIN is loaded. */}
                <div ref={clusterInnerRef} className="fade-in-up select-none flex-none grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center" style={{ transform: `scale(${clusterScale})`, transformOrigin: 'center center' }}>

                  {/* --- LEFT WING: PATCH ---
                      Mirrored with the right, as the layout reference requires: the wings face
                      inward and the dial sits between them. PATCH is here because it always was,
                      and because it is the other decision taken on every campaign — what logic the
                      ECU is left holding, against what tables the artifact carries.

                      The trailing spacer keeps this column the same height as the right one, so
                      PATCH and WRITE land on the same line rather than half a row apart. */}
                  <div className={`justify-self-end mr-6 shrink-0 ${patchStatus ? '' : 'invisible'}`}>
                    <WriteManifest groups={leftWingGroups} align="left" busy={dmeLink.state === 'writing'} />
                  </div>

                  {/* --- CENTRAL HUB: DME STATE-MACHINE RING (falls back to file download when no DME session is active) --- */}
                  <div className="relative group mx-2 z-10 flex flex-col items-center shrink-0">
                    <div className="relative">
                      {/* Outer Glow/Border Ring */}
                      {/* `transition`, never `transition-all` — see the note on the hub button below.
                          This bezel was the worst offender at duration-500. */}
                      <div className={`absolute -inset-1 rounded-full border border-slate-800 opacity-100 transition duration-500 ${dmeLink.state !== 'disconnected' ? 'border-blue-500/30' : ''} ${dmeLink.state === 'tuning' ? 'animate-pulse border-amber-500/50' : ''}`}></div>

                      {/* `transition`, NOT `transition-all`, and the difference is not cosmetic.
                          `transition-all` includes `visibility`, and a visibility transition is
                          special: the element stays VISIBLE for the whole duration and flips only at
                          the end. So when a pane switch set the parent to `visibility: hidden`, this
                          button kept painting for its full 300 ms and the bezel above for 500 ms —
                          while the pane's own background, which has no transition, went at once.
                          That is exactly what "the block goes but the buttons linger" was.
                          Tailwind's plain `transition` is a curated property list — colour, shadow,
                          opacity, transform/translate/scale, filter — with no `visibility` in it, so
                          `active:scale-95` and every hover tint below behave exactly as before. */}
                      <button
                        onClick={dmeButtonConfig.onClick}
                        disabled={dmeButtonConfig.disabled}
                        className={`
                              relative w-20 h-20 rounded-full flex flex-col items-center justify-center gap-1 transition duration-300 active:scale-95
                              ${!dmeButtonConfig.disabled
                            ? 'bg-slate-900 hover:bg-slate-800 text-blue-500 hover:text-blue-400 border border-slate-700 shadow-2xl cursor-pointer ring-1 ring-slate-800'
                            : 'bg-slate-900/50 border border-slate-800/50 text-slate-700 cursor-not-allowed'}
                              ${dmeLink.state === 'tuning' ? 'text-amber-500 border-amber-700' : ''}
                          `}
                      >
                        {/* Mid-transfer the percentage IS the button: the arc around it carries the
                            same number, so a spinner would only say "busy" a second time, and the
                            8px label the percentage used to share space with was too small to read
                            across a garage at arm's length. Idle, nothing about the hub changes. */}
                        {dmeLink.transferProgress !== null ? (
                          <span className={`flex items-baseline font-mono font-bold leading-none tabular-nums ${transferStyle.text}`}>
                            <span className="text-[22px] tracking-tight">{dmeLink.transferProgress}</span>
                            <span className="text-[10px] ml-0.5">%</span>
                          </span>
                        ) : (
                          <>
                            <dmeButtonConfig.Icon className={`w-5 h-5 transition-transform duration-300 stroke-[1.5] ${dmeButtonConfig.spin ? 'animate-spin' : 'group-hover:scale-110'}`} />
                            <span className="text-[8px] font-bold tracking-widest uppercase leading-none text-center px-1">
                              {dmeButtonConfig.label}
                            </span>
                          </>
                        )}
                      </button>

                      {dmeLink.transferProgress !== null && (
                        <HubProgressRing
                          percent={dmeLink.transferProgress}
                          colorClass={transferStyle.text}
                          pulse={dmeLink.transferPhase === 'erasing'}
                        />
                      )}
                    </div>

                  </div>


                  {/* --- RIGHT WING: WRITE, and RESTORE beneath it ---
                      Collapsed by default. Each row is a word and, beneath it, the names of
                      whatever that group currently contributes — so "what will the next write
                      contain" is answerable without opening anything, and openable when it is not.
                      The summary line has a reserved height, so arming a table cannot reflow the
                      cluster the dial is centred in. */}
                  <div className={`justify-self-start ml-6 shrink-0 ${patchStatus ? '' : 'invisible'}`}>
                    <WriteManifest groups={rightWingGroups} align="right" busy={dmeLink.state === 'writing'} />
                  </div>


                </div>
                </div>
              }

              {/* Hub sub-actions. Deliberately OUTSIDE the cluster above, and a fixed height in every
                  state — including when empty. Two reasons:
                  1. Reserving the height means showing/hiding these can never resize the cluster, so
                     the hub stays put. (Hanging them under the hub — in flow OR absolutely — is what
                     made it jump: in flow they changed the cluster's height, absolutely they fell
                     outside its overflow-hidden box and got clipped away.)
                  2. Outside the cluster's transform, so the labels stay legible instead of being
                     scaled down along with the dial.

                  A ROW, not a column. Stacked, this overflowed its own reserved height: 46px minus
                  the 10px top padding left 36px, each button is 15px tall (line-height 1.5 on
                  text-[10px], taller than the 12px icon) and the gap was 8, so two of them wanted
                  48px — measured, not estimated. Two is reachable today, whenever a log produced no
                  valid points (Discard log needs a processedLog, Reset Adapt needs no newMap), and
                  the overflow scrolled the whole inputs panel since this sits in an overflow-y-auto
                  box. Laid out horizontally the content is 31px tall whatever it holds, and the
                  reserved height is untouched so the hub still cannot move. No flex-wrap: a second
                  line would put the height back over budget, which is the bug this fixes. */}
              {/* The buttons below carry `py-3 -my-3`: the padding grows the touch target to ~40px
                  while the negative margin cancels its contribution to layout, so the 31px content
                  height and the 46px budget above are both exactly as measured. Finger-sized targets
                  matter here more than anywhere else in the app — Discard log throws away a drive
                  and Reset Adapt writes to the ECU — and on a phone a 15px-tall button between two
                  siblings 16px away is a coin toss. Do not "simplify" this to plain padding. */}
              {/* Three cells rather than one centred row, for the reason the hub cluster itself
                  is a 3-column grid: the sub-actions have to stay on the screen's centre line
                  whatever hangs off the end. RESTORE is that end — the panel's bottom-right
                  corner, deliberately away from the dial. */}
              <div className="h-[46px] flex-none flex flex-row items-center">
                <div className="flex-1" />
                <div className="flex flex-row items-center justify-center gap-x-4">
                {dmeLink.transferPhase && (
                  <span className={`whitespace-nowrap text-[9px] font-bold tracking-[0.2em] uppercase animate-pulse ${transferStyle.text}`}>
                    {transferStyle.label}
                  </span>
                )}

                {/* Downloading is not here. DOWNLOAD TUNED on the session bar covers the live bytes
                    once the run is over, and the session list downloads each stored artifact from the
                    row that names it. Two buttons calling the same handler is what made the old
                    "Download BIN" / "Download BIN File" pair confusing.
                    Re-tuning isn't here either — it means "start the next session from this tune",
                    and by then the DME is disconnected for the key cycle. What is genuinely local to
                    this moment is throwing away a bad log.
                    Keyed on having a log rather than on state === 'stopped': STOP now drops the
                    connection for the key cycle, and this has to survive that. */}
                {processedLog && !isArchived && dmeLink.state !== 'tuning' && dmeLink.state !== 'writing' && (
                  <button
                    onClick={handleDiscardLog}
                    className="whitespace-nowrap flex items-center gap-1.5 py-3 -my-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" /> Discard log
                  </button>
                )}

                {/* Clearing the DME's learned values before START TUNE, so the next log is captured
                    from a known base — that is the moment it was built for, and on any tab it still
                    appears exactly when the hub says START TUNE.
                    PLUS the whole STARTUP tab while connected, which is a separate, real need: after a
                    WRITE finishes, after cancelling out of something, or when clearing adaptations is
                    the only reason the cable is plugged in at all. None of those leave a loaded map
                    and a live session, so `idleAction === 'tune'` hid the button in precisely the
                    cases where the user came to press it. Scoped to STARTUP on purpose — that tab is
                    where sessions and the ECU are managed, and the map/tuning tabs stay uncluttered.
                    `state === 'connected'` is what keeps it safe: it already excludes reading,
                    tuning, writing and resetting, so this can never fire during an operation.
                    Amber rather than the siblings' red: those two discard local work, this one writes
                    to the ECU. */}
                {dmeLink.state === 'connected' && (idleAction === 'tune' || activeTab === 'startup') && (
                  <button
                    onClick={() => dialogs.open('adaptation')}
                    className="whitespace-nowrap flex items-center gap-1.5 py-3 -my-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-amber-400 transition-colors"
                  >
                    <Eraser className="w-3 h-3" /> Reset Adapt
                  </button>
                )}

                {/* No flash-counter action here. It lives on the header's FLASH field instead: this
                    row is for the workspace and the current run (throw away this log, clear what the
                    DME learned before recording), while the flash counter is a property of the ECU
                    that the header already states. Putting the reset on the number it changes also
                    means there is exactly one place to look for it. */}

                {/* Cancel sub-button, shown while a partial-BIN read is in progress */}
                {dmeLink.state === 'reading' && (
                  <button
                    onClick={dmeLink.cancelRead}
                    className="whitespace-nowrap flex items-center gap-1.5 py-3 -my-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 transition-colors"
                  >
                    <Square className="w-3 h-3" /> Cancel Read
                  </button>
                )}

                </div>
                <div className="flex-1" />
              </div>

              {/* RESTORE, in the panel's own bottom-right corner — below the sub-actions rather
                  than beside them, so it is not read as one of the hub's controls. Its own row
                  because the row above is a reserved 46px budget that two-line content would
                  overflow, and because "further down and to the right" is the point: this is a
                  handful of uses a year, kept reachable and out of the way. */}
              {restoreGroup && (
                <div className="flex-none flex justify-end">
                  <ManifestCorner group={restoreGroup} busy={dmeLink.state === 'writing'} />
                </div>
              )}
    </>
  );

  /** The INFO side of the same slot: what the selected calibration item IS. */
  const calInfoPanel = calData.catalog ? (
    <div className="flex-1 min-h-0">
      <ParamInfo
        graph={calData.catalog.graph}
        node={calWs.selected ? calData.catalog.graph.byId.get(calWs.selected) ?? null : null}
        def={calWs.selected ? calData.catalog.byId.get(calWs.selected) ?? null : null}
        onSelect={calWs.select}
      />
    </div>
  ) : <div className="flex-1 min-h-0" />;

  /**
   * The third side of the same slot: WHICH parameters differ.
   *
   * A jump list, so its rows use `jump` rather than `select` — the tree's
   * select leaves the diagram on the block you are reading, which is right
   * there and wrong here.
   */
  const calListPanel = (
    <CalibrationDiffList
      entries={calDiffEntries}
      editedIds={calEditedIds}
      selectedId={calWs.selected}
      canCopyReference={calCompare.subject === 'tuned'}
      onSelect={calWs.jump}
      onCopyRef={calCopyParam}
      onRevert={calEdits.revertParam}
    />
  );

  return (
    // 100svh, not h-screen and not dvh. This page deliberately never scrolls — everything is sized to fit the
    // viewport — and on Android `100vh` resolves to the LARGEST viewport, the one with the browser
    // chrome retracted. With no scrolling to recover it, the bottom of the layout (the action row
    // that carries WRITE) sits under the URL bar and cannot be reached. `dvh` tracks the viewport
    // that is actually visible.
    <main className="h-[100svh] flex flex-col bg-slate-950 font-sans text-slate-300 overflow-hidden selection:bg-blue-500/30">
      {/* App Header - Ultra Minimal */}
      <header className="relative px-6 py-3 flex justify-between items-center bg-slate-950/80 backdrop-blur-md z-10 shrink-0 h-[48px]">
        {/* The ///M stripe as the header's bottom rule, replacing a slate-900 border-b. Absolutely
            positioned inside the 48px rather than added below it, so the pane split underneath keeps
            its measured 61.8/38.2 and nothing reflows. Hard color stops — a gradient would blend the
            three into muddy intermediates at 2px. Middle stripe is the legible violet for the same
            reason as the wordmark: #2B115A at 1.33:1 would read as a gap between blue and red. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 pointer-events-none"
          style={{ background: 'linear-gradient(to right, #0A9BDB 0 33.333%, #9B84E8 33.333% 66.667%, #F11A22 66.667% 100%)' }}
        />
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* An LED, and only that. It used to be the way in to VIN / AIF / SW as well, on the
              argument that an 8px dot needs a real hit box anyway so it may as well have a
              destination. What that produced is a control nobody can see is a control: 8px of
              colour with a 40px tap target around it, in the corner a thumb rests on, opening a
              dialog over whatever was being read (operator, 2026-08-31).

              So it states machine state and nothing else, and the identity dialog goes with it —
              see the note where it used to render. The state is still readable on hover, where a
              readout of this size belongs. */}
          <span
            title={`DME: ${dmeLink.state}${dmeLink.error ? ' — ' + dmeLink.error : ''}`}
            className={`shrink-0 block w-2 h-2 rounded-full ${dmeStatusColor}`}
          />
          {/* Capped on a narrow header. Dropping `shrink-0` let the ellipsis work, but flexbox still
              hands this the larger share — its content is ~300px against the identity strip's ~60 —
              so the strip was resolving to zero width and FLASH went with it. A ceiling, not a
              hidden: the wordmark is how you know which tool has the cable. */}
          <h1 className="min-w-0 max-w-[60%] min-[900px]:max-w-none text-sm font-bold tracking-widest text-slate-200 uppercase whitespace-nowrap overflow-hidden text-ellipsis">
            {/* The ///M mark, not punctuation. It is the one place red can live permanently without
                costing it any alarm value: a wordmark states no machine state, so it does not
                compete with the error LED two elements to the left.
                The middle stripe is the legible violet, not the logo navy #2B115A — at 1.33:1 on
                black that glyph would read as missing rather than dark.

                Coloured HERE and monochrome in the app icon, which is not an inconsistency to fix:
                the icon is the supplied logo and is read at 48dp against an unknown wallpaper, where
                three thin coloured stripes lose their separation. This renders at 14px on a surface
                whose colour we control. (This comment used to say icon.svg "has carried the tricolor
                in the browser tab all along" — true until the logo landed, and no longer.) */}
            MSS54HP CSL CONVERT{' '}
            <span className="tracking-tight" aria-hidden="true">
              <span className="text-blue-500">/</span>
              <span className="text-indigo-400">/</span>
              <span className="text-red-500">/</span>
            </span>{' '}
            TUNER
          </h1>
          {/* Which build this is, once you are already inside it. The manifest name only shows on
              the way in — on the home screen and in the task switcher — and with production and a
              preview installed side by side, "which one am I looking at" is a question you ask
              after opening one, not before.

              Read from a meta tag injected by scripts/brand-preview.mjs rather than compiled in,
              so the variant has exactly one definition and production's build is untouched. */}
          {/* ANY non-production build says so, not just the preview one.
              STAGING is the build that needed this most and had it least: it is main, unmodified,
              so it carries none of the code that would mark it — and it looks identical to
              production once it is open, on a phone where the URL is not on screen. The badge is
              the only thing that can tell the two apart there.

              Violet rather than amber for staging, because they mean different things: amber is
              "this is not the release", violet is "this IS the release, one step early". */}
          {buildVariant && (
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold whitespace-nowrap
              ${isPreviewBuild ? 'text-amber-300 bg-amber-500/15' : 'text-violet-300 bg-violet-500/15'}`}>
              {buildVariant.toUpperCase()}
            </span>
          )}
          {/* Identity, and nothing else. It used to open CREDITS as well, on the argument that a
              version number is a label carrying no state and so costs nothing to make a control.
              What that missed is that CREDITS already has a sign in both layouts — the medal above
              900px, the menu sheet's own row below it — so this was a third, unlabelled way in, and
              a version number that swallows a tap is a version number that cannot be read on a
              phone without opening a dialog (operator, 2026-08-31). */}
          <span className="shrink-0 text-[9px] font-mono text-slate-500 whitespace-nowrap">
            V2.2.0 β
          </span>

          <div className="hidden min-[900px]:flex flex-1 min-w-0 items-center gap-4 text-[9px] font-mono text-slate-500 whitespace-nowrap overflow-hidden ml-8 pl-8 border-l border-slate-800">
            {/* The only one of the four that is a control: clicking it opens the reset dialog. The
                reset has no button of its own anywhere else — it belongs on the number it changes,
                and the hub's sub-action row is for actions on the workspace and the current run.
                Disabled rather than hidden while disconnected, so the field never moves.

                `shrink-0` so the readouts after it absorb the shortfall instead of this button. */}
            <button
              type="button"
              title={flashTitle}
              disabled={dmeLink.state !== 'connected'}
              onClick={() => dialogs.open('flash')}
              className="shrink-0 whitespace-nowrap enabled:cursor-pointer enabled:hover:text-slate-300 disabled:cursor-default transition-colors"
            >
              FLASH <span className={flashColor}>{flashText}</span>
            </button>
            {/* 1160, not the 900 the strip itself appears at, and the three of them together are
                why. Disconnected they read "VIN -  AIF -  SW -" and cost nothing; the moment the
                link comes up they fill with real strings and the row stops fitting.

                Measured at 920 with the DME connected: FLASH 12/30 is 59px, VIN 113, AIF 97, SW 81,
                plus 48px of gaps — 398px of content in a box that is 192px wide. The strip is
                `overflow-hidden`, so the shortfall is not a wrap or a scrollbar: VIN and everything
                after it is simply cut, mid-string, at the moment the identity finally exists.
                398 + 64px of rule and margin needs about 1126px of viewport, so the three appear at
                1160 with a little room to spare.

                Nothing is lost between 900 and 1160: the status dot to the left of the wordmark
                opens the identity dialog, and its own tooltip has said "Click for VIN / AIF / SW"
                all along. FLASH stays down at 900 — it is 59px and it is the one of the four that
                can turn amber. */}
            <span className="hidden min-[1160px]:inline">VIN <span className="text-slate-300">{dmeLink.identity?.vin ?? '-'}</span></span>
            <span className="hidden min-[1160px]:inline">AIF <span className="text-slate-300">{dmeLink.identity?.aif ?? '-'}</span></span>
            <span className="hidden min-[1160px]:inline">SW <span className="text-slate-300">{dmeLink.identity?.softwareVersion ?? '-'}</span></span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* The grid's zoom used to stand here, at the empty right end of a phone's header. It
              is on the grid now — see `ZOOM PILL` in the map pane. The header is identity and
              machine state, and the one control in it that was meant to be used while moving was
              also the one furthest from a thumb. */}

          {/* Privacy policy, on the sibling site. First in the cluster because it is the least of
              the three, and because putting it here leaves the one labelled link anchored to the
              right edge where it already sits.

              Hover goes to neutral slate, NOT to an accent like the Tuning Source link below. This
              states no machine state, so it has no business borrowing a semantic colour — the same
              reason the GitHub link beside it is neutral.

              `_blank` is not decoration: a same-tab navigation would drop the serial link and take
              an unsaved run with it. */}
          <a
            href={privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors"
            title="Privacy Policy"
          >
            <Shield className="w-5 h-5" />
          </a>

          {/* GitHub Link */}
          <a
            href={PROJECT_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors"
            title="View on GitHub"
          >
            <Github className="w-5 h-5" />
          </a>

          {/* CREDITS, which the wide layout did not have — the version string used to be the
              desk's only way in, and it is a span now.

              THIRD, not fourth, because the menu sheet reads PRIVACY GITHUB MEDAL GUIDE RELOAD and
              the two layouts are the same five controls. Two orders for one row is a thing the
              reader has to learn twice, and this is the layout that had it wrong: the sheet puts
              the medal in the middle deliberately, on its own grid column, because it is the one
              item here that is an acknowledgement rather than a tool (operator, 2026-08-31).

              Same size and the same neutral tone as its neighbours: this states no machine state. */}
          <button
            onClick={() => dialogs.open('credits')}
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            title="Credits & attribution"
          >
            <Medal className="w-5 h-5" />
          </button>

          {/* The guide. Icon only, at the same w-5 h-5 as everything else in the row — it was the
              one member wearing a label ("TUNING SOURCE") and a smaller glyph, which made a row of
              equals read as icons and a link. The destination is in the tooltip, where the rest of
              the row puts theirs. */}
          <a
            href="https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors"
            title="Tuning guide — methodology source: NA M3 Forum"
          >
            <BookOpen className="w-5 h-5" />
          </a>

          {/* The wide layout's only reload, and until it existed there was none at all.
              Pull-to-refresh is off on purpose, the row that replaced it lives in the menu sheet,
              and the sheet is `min-[900px]:hidden` — so above the breakpoint nothing rendered it.
              That is not "harder to reach": on the 1024x600 head unit this is installed on, running
              as a TWA with no browser chrome, there was no way to take an update or to recover from
              a bad state short of killing the app.

              Last in the row, hard against the corner, for the same reason RELOAD sits at the far
              end of the menu sheet: it drops the link, the log being recorded and any unsaved tune.
              `confirm` guards exactly those cases and nothing else.

              Sized by its content, like the four icons before it. A stated width was tried, so
              that announcing an update could not move the header, and it cost more than it bought:
              the slot had to be as wide as the WORD, so the idle glyph sat 52px from the medal
              beside it while its four neighbours sat 16px apart, and the row read as four icons and
              a straggler (operator, 2026-08-31). The trade is that when an update does arrive the
              four icons shift left by the difference — once per released build, on the one control
              whose job that moment is to be noticed. */}
          {/* There is no SYNC here any more, and this note is why.
              This was a third one: a cloud with a pending count that called `sync.syncAll()` — the
              SAME action, on the same status object, as the labelled SYNC on the session bar over
              the table. Above 900px both were on screen at once, and the store panel's trigger
              made a third cloud beside them. Three clouds, two of which did the identical thing.
              The send is one control now and it lives with SAVE, which is the other half of the
              same two-step flow and the only place the pair can be read together.
              Below 900px nothing changed: this was `min-[900px]:flex`, and the phone's SYNC has
              always been the menu sheet's own row, which still carries the count and the sentence. */}

          <button
            type="button"
            onClick={handleReload}
            title={reloading
              ? 'Downloading the new build — the app reloads into it when it is ready'
              : updateAvailable
                ? 'A newer build is on the server — reload to take it'
                : 'Reload the app'}
            /* `py-3 -my-3` for the hit box: the head unit this runs on is a touchscreen, and the
               header's own convention renders these at 16px tall. The padding is cancelled by the
               margin so the row still lays out at 16 and nothing moves. Vertical only — the gap to
               the link beside it is 16px, and horizontal padding would consume all of it. */
            /* Hidden below 900px only while there is NOTHING to take.
               A plain Reload is a convenience the mobile menu already carries; an available update
               is not, and burying it behind a menu nobody opens is why three deploys in a row were
               read as "you did not commit it". On a phone the whole point of this control is to be
               seen without being looked for. */
            /* Three states in one slot, none of which resize it: idle grey, an available update
               pulsing blue, and that same blue holding still while the icon spins on the download.
               The pulse and the spin are deliberately not both on — pulsing means "there is
               something here to take", and once it is being taken that is no longer the message. */
            className={`${updateAvailable ? 'flex' : 'hidden min-[900px]:flex'} items-center shrink-0 py-3 -my-3 transition-colors ${reloading ? 'text-blue-400 cursor-default' : `cursor-pointer ${updateAvailable ? 'text-blue-400 hover:text-blue-300 animate-pulse' : 'text-slate-500 hover:text-slate-300'}`}`}
          >
            {/* ONE of the two, never both. Idle, this is a convenience nobody is being told about,
                and a glyph is the whole message — the word RELOAD beside it said the same thing a
                second time, in the strip's largest type. With an update waiting the message is not
                "reload" at all: it is that there IS one, so the word carries it and the glyph goes,
                because a refresh arrow is exactly what this is not asking for.

                Mid-download the glyph comes back, spinning. That is the one state where the arrow
                is literal, and the pulse stops for the same reason it always did. */}
            {updateAvailable && !reloading ? (
              <span className="text-[10px] uppercase font-bold tracking-wider whitespace-nowrap">Update</span>
            ) : (
              /* w-5, the size of the four glyphs before it, for the reason the guide link
                 records: a row of equals with one smaller member reads as a group and a
                 straggler. */
              <RefreshCw className={`w-5 h-5 shrink-0 ${reloading ? 'animate-spin' : ''}`} />
            )}
          </button>
        </div>
      </header>

      <div className="grid flex-1 min-h-0 min-[900px]:flex min-[900px]:flex-row overflow-hidden">

        {/* === LEFT COLUMN (70% desktop / 40% stacked) === */}
        <div className={`[grid-area:1/1] flex min-[900px]:[grid-area:auto] ${narrowPane === 'map' ? '' : 'invisible pointer-events-none min-[900px]:visible min-[900px]:pointer-events-auto'} min-[900px]:flex-none min-[900px]:h-full min-[900px]:w-[61.8%] flex-col border-b min-[900px]:border-b-0 border-r-0 min-[900px]:border-r border-slate-900 relative bg-slate-950/40 min-h-0`}>

          {/* Header Frame (Tabs) - Matches Right Column Header Height */}
          {/* z-30, not z-50. The row has to outrank the right pane (z-20) so the config popovers
              anchored in it can hang over the map below — but it was sharing z-50 with the modal
              panels, which put it ABOVE every dialog's backdrop (z-40) and left the tab bar sitting
              crisp on top of a blurred page. Modals now live in their own tier (z-100/110), and the
              layers here read: 10 chrome / 20 panes / 30 this row / 40 popover scrims / 50 popovers. */}
          <div className="h-[44px] hidden min-[900px]:flex items-center px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none z-30">
            <div
              ref={tabStrip.ref}
              style={tabStrip.style}
              className="no-scrollbar hidden min-[900px]:flex space-x-6 h-full mr-auto flex-1 min-w-0 overflow-x-auto overflow-y-hidden"
            >
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => goToTab(tab.id)}
                  disabled={!tab.enabled}
                  className={`relative h-full flex items-center shrink-0 whitespace-nowrap text-[10px] font-bold tracking-widest transition ${activeTab === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-slate-500 hover:text-slate-300 border-b-2 border-transparent disabled:opacity-20'
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Log Stats & Filter */}
            <div className="h-full hidden min-[900px]:flex items-center ml-auto border-l border-slate-800 pl-4 ml-4 gap-4">
              {processedLog && (
                /* ONE line: the rate and the two counts it governs. Nothing else.
                   This bar is 44px tall and it belongs to the TABS. What was here — the drop census
                   and the live rf_korr census, each on its own row, with a two-line advisory that
                   replaced them when it fired — is real information that had been put in the one
                   place with no room for it, and it took the room from the tab strip beside it
                   (measured: the strip squeezed to 229px of a 1280px window).
                   None of it is lost. The census is itemised under RAW FILTER, which is where its
                   thresholds are set; the rf_korr advisory and its counts are on the RF KORR tab,
                   which is the thing they are about. Both are one click from here, and both have
                   the width to be read. */
                <div className="flex items-center h-full shrink-0 gap-2 text-[9px] font-mono leading-none whitespace-nowrap" title={logRate?.title}>
                  {/* RATE ahead of the counts it governs — a 561-sample drive means one thing at
                      6.6 Hz and another at 2.9. Live value during a run, the log's own average
                      otherwise; the expected figure stays in the title. */}
                  {logRate && (
                    <>
                      <span className="text-slate-600">RATE</span>
                      <span className="text-slate-300 font-bold">{logRate.hz.toFixed(2)}</span>
                    </>
                  )}
                  <span className="text-slate-500">VALID</span>
                  <span className="text-blue-400 font-bold">{processedLog.validCount.toLocaleString()}</span>
                  <span className="text-slate-600">TOTAL</span>
                  <span className="text-slate-500">{(processedLog.validCount + processedLog.droppedCount).toLocaleString()}</span>
                  {/* Last, and last on the phone's band too — one slot for this readout at both
                      widths. It stood between VALID and TOTAL, where its two states are two
                      different widths (⚠ −6.0 % against ✂ 5m): excluding the stretch moved TOTAL
                      sideways, so the number you were reading changed place at the moment you
                      acted, and the same readout sat in two positions depending on the screen.
                      At the end it cannot push anything, which is the whole of the fix. */}
                  <DriveSplitChip
                    split={driveSplit} excludedSpan={splitExcludedSpan} onOpen={openSplitDetail} />
                </div>
              )}
              <div className="flex items-center gap-2">
                {/* The store's door is NOT here any more. It was a cloud among three chart controls,
                    in a bar whose subject is the log — findable only by hovering everything, and
                    about none of the things beside it. It now sits next to NEW SESSION on the
                    STARTUP tab, which is where the rows it lists and pulls back actually are, and
                    that one placement serves both widths. */}
                <InterpolationTableEditor
                  config={interpolationTable}
                  onSave={handleTableChange}
                  enabled={(pendingConfig ?? filterConfig).enableCorrection}
                  onToggle={(enabled) => handleConfigChange({ ...(pendingConfig ?? filterConfig), enableCorrection: enabled })}
                  readOnly={isArchived}
                />
                <FilterConfigPanel config={filterConfig} onConfigChange={handleConfigChange} readOnly={isArchived}
                  /* Which stream the tab behind this panel is reading — see its `scope` prop.
                     One expression, both call sites, so the two cannot answer differently. */
                  scope={activeTab === 'rfkorr' ? 'rfkorr' : 've'}
                  channels={logChannels} measuredHz={logRate?.hz} routeGap={routeGap} routeSamples={routeSamples} />
                {/* One slot, two occupants. LOG FIELDS chooses the log table's columns, which
                    is nothing to do with the SHAPE tab — and the parameters that ARE its business
                    have to be reachable from both panes, which is what this cluster is. So they
                    take turns rather than sitting side by side: a fourth button would widen the
                    cluster on the width that has the least to spare. */}
                {activeTab === 'lowload' ? (
                  <ShapeControls shape={shape} onApply={applyShape} />
                ) : (
                  <FieldVisibilityPanel
                    visibleFields={fieldVisibility.visibleFields}
                    onToggle={fieldVisibility.toggleField}
                    onShowCoreOnly={fieldVisibility.showCoreOnly}
                    onShowDefaults={fieldVisibility.showDefaults}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Session bar. A tune only means something relative to what it started from, so which
              session is open and where its BASE came from stay on screen the whole time you are
              looking at maps — otherwise you'd have to go back to STARTUP to find out. */}
          {currentSession && activeTab !== 'startup' && (
            <div className="h-[26px] flex-none hidden min-[900px]:flex items-center gap-3 px-4 border-b border-slate-900 bg-slate-950/60 text-[10px] min-w-0">
              <span className="font-bold tracking-widest uppercase text-slate-300 truncate max-w-[220px]" title={currentSession.label}>
                {currentSession.label}
              </span>
              <span className={`shrink-0 font-bold tracking-widest uppercase px-1.5 py-0.5 rounded text-[8px] ${isArchived
                ? 'bg-slate-800 text-slate-400'
                : 'bg-blue-500/15 text-blue-400'}`}>
                {isArchived ? 'Archived · read-only' : 'Draft'}
              </span>
              <span className="shrink-0 text-slate-600 font-bold tracking-widest uppercase text-[8px]">Base</span>
              <div className="min-w-0 flex items-center">
                <OriginBadge
                  session={currentSession}
                  parent={currentSession.parentSessionId
                    ? sessionDb.sessions.find(s => s.id === currentSession.parentSessionId)
                    : undefined}
                />
              </div>

              {/* The session's other input and its outputs. Here rather than floating above the list,
                  because every one of them acts on this session and nothing else. */}
              <span className="shrink-0 text-slate-700">·</span>
              <span className="shrink-0 text-slate-600 font-bold tracking-widest uppercase text-[8px]">Log</span>
              {logFile ? (
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <span className="text-[9px] font-mono text-slate-400 truncate max-w-[200px]" title={logFile.name}>{logFile.name}</span>
                  {processedLog && <span className="text-[9px] font-mono text-slate-600 shrink-0">{processedLog.validCount}pts</span>}
                  {!isArchived && (
                    <button onClick={handleClearLog} className="p-0.5 text-slate-600 hover:text-red-400 transition-colors shrink-0" title="Remove this log">
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  )}
                </span>
              ) : isArchived ? (
                <span className="text-[9px] font-mono text-slate-700">—</span>
              ) : (
                <span className="group relative inline-flex items-center gap-1 cursor-pointer text-[9px] font-bold uppercase tracking-widest text-green-500/80 hover:text-green-400 shrink-0">
                  <Upload className="w-2.5 h-2.5" /> Testo CSV
                  <DropZone label="" accept={ACCEPT_CSV} onFileSelect={handleLogUpload} className="!absolute !inset-0 !opacity-0 !border-0 cursor-pointer" />
                </span>
              )}

              <div className="ml-auto flex items-center gap-4 shrink-0">
                {/* Two exports of the same builder, split on whether a tune exists, so exactly one of
                    them is ever on screen. Both stand down while the DME is recording: 'tuning' is
                    the live log run, the map moves with every sample, and a file or session record
                    written mid-run would claim to be the result of a run that had not finished. STOP
                    is what makes the numbers final; both come back the moment it does.
                    Neither offers the raw BASE — the session tree already downloads each session's
                    stored BASE and LOG from the row that names them, and these bytes are not that:
                    buildPatchedBuffer runs the patches and recalculates the checksum, so even with no
                    tune the result differs from the BASE that went in. That is the whole reason this
                    one is named for the PATCH and not for the base it was built from. */}

                {/* The PATCH-ON BIN: no tune yet, but a patch is armed, which is the state you flash
                    from before a log run.
                    "Patch" here means PATCH or WOT TH — both rewrite DME logic in place, and either
                    one alone already makes these bytes something other than the BASE. WRITE WARMUP and
                    WRITE WOT are deliberately not in that set: they inject derived TABLES built from a
                    tune, so they cannot apply in this no-tune state anyway.
                    The same expression drives the _PatchON suffix in buildFileName, so the button and
                    the file it produces cannot disagree about whether this BIN is patched. */}
                {binaryBuffer && !newMap && (applyPatch || applyWotDisable) && dmeLink.state !== 'tuning' && (
                  <button
                    onClick={handleDownloadBin}
                    className="group inline-flex items-center gap-1.5"
                    title="Download the BASE with the PATCH applied and the checksum corrected — the exact bytes WRITE would send right now. This is the PATCH-ON BIN to flash before a log run."
                  >
                    <Download className="w-3 h-3 text-slate-600 group-hover:text-blue-400 transition-colors" />
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-blue-400 transition-colors">Download Patch-On</span>
                  </button>
                )}
                {binaryBuffer && newMap && dmeLink.state !== 'tuning' && (
                  <button
                    onClick={handleDownloadBin}
                    className="group inline-flex items-center gap-1.5"
                    title="Download the TUNED bytes WRITE would send right now — built live from the current map and toggles, saved or not. To get a session's stored TUNED instead, use its row in the session list."
                  >
                    <Download className="w-3 h-3 text-slate-600 group-hover:text-blue-400 transition-colors" />
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-blue-400 transition-colors">Download Tuned</span>
                  </button>
                )}
                {/* Keyed on there being a tune, not just bytes: Save records a TUNED, and with only a
                    BASE loaded there is no TUNED to record — the BASE was already stored when it was
                    chosen. Offering it anyway is what let a base-only session claim a tune. */}
                {/* Wording and enabled-ness from describeSave, so this and the menu sheet's row
                    cannot drift apart — the same rule the sync control already follows. Rendered in
                    every state rather than hidden when it cannot be pressed: "Save — after the run"
                    is an answer, a missing button is not. */}
                <button
                  onClick={saveLook.disabled ? undefined : handleSaveSession}
                  disabled={saveLook.disabled}
                  className="group inline-flex items-center gap-1.5 disabled:cursor-default"
                  title={saveLook.title}
                >
                  <Database className={`w-3 h-3 transition-colors ${saveLook.tone === 'done' ? 'text-emerald-400/80'
                    : saveLook.disabled ? 'text-slate-700' : 'text-slate-600 group-hover:text-amber-400'}`} />
                  {/* describeSave's label, which this used to discard for a fixed "Save". The
                      objection was width — this bar is a fixed 26px row that already carries the
                      session name, the badge and the BASE origin, and "Save — nothing to record"
                      squeezed the badge out of a narrow window. The labels are one or two words
                      now, so the objection is gone and the state is on screen in both layouts:
                      SAVE while there is something to write, SAVED once it is written. */}
                  <span className={`text-[9px] font-bold uppercase tracking-widest transition-colors ${saveLook.tone === 'done' ? 'text-emerald-400/80'
                    : saveLook.disabled ? 'text-slate-700' : 'text-slate-500 group-hover:text-amber-400'}`}>
                    {saveLook.label}
                  </span>
                </button>
                {/* SYNC, immediately after SAVE, because they are one flow and were previously
                    impossible to see together at this width: SAVE lives in this bar, which renders
                    on every tab EXCEPT startup, and the only labelled SYNC lived in the SESSIONS
                    header, which renders on startup and nowhere else. The header's icon-only cloud
                    was on screen the whole time and was not read as the other half of saving —
                    reported as "SAVE never appears anywhere near SYNC", which was exactly right.
                    Same status object as the header twin and the menu row, so all three agree. */}
                {syncLook && (
                  <button
                    onClick={syncLook.disabled ? undefined : () => { void sync.syncAll(); }}
                    disabled={syncLook.disabled}
                    className="group inline-flex items-center gap-1.5 disabled:cursor-default"
                    title={syncLook.title}
                  >
                    <UploadCloud className={`w-3 h-3 transition-colors ${syncLook.tone === 'ready' ? 'text-blue-400'
                      : syncLook.tone === 'error' ? 'text-red-400'
                        : syncLook.tone === 'busy' ? 'text-slate-500 animate-pulse' : 'text-slate-700'}`} />
                    <span className={`text-[9px] font-bold uppercase tracking-widest transition-colors ${syncLook.tone === 'ready' ? 'text-blue-400 group-hover:text-blue-300'
                      : syncLook.tone === 'error' ? 'text-red-400 group-hover:text-red-300'
                        : 'text-slate-700'}`}>
                      {/* The count, not the sentence — this bar is 26px and already crowded. The
                          full wording is in the tooltip and in the menu sheet. */}
                      Sync{(syncStatus?.pending ?? 0) > 0 ? ` ${syncStatus?.pending}` : ''}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* The instrument band — a phone only, and directly under the header.
              ────────────────────────────────────────────────────────────────────────────────
              These readouts used to sit in a 52px band at the BOTTOM, above the control row, where
              they were the last thing between the map and the screen edge. They are about the drive
              on screen, so they belong at the top of it — and below 900px there was nothing between
              the header and the grid at all, because the 44px tab bar and the 26px session bar are
              both `min-[900px]` and up.

              Two lines, because at 375 they do not fit on one: the content box is 343px and the
              RATE/VALID/TOTAL trio plus the split chip is 327px of it, which leaves 8px for a
              census that needs 189. Stacked, the band is 34px against the old 52 — and the header
              keeps its wordmark, which is what tells you which tool has the cable.

              Line 2 is the drive's own numbers: RATE, VALID, TOTAL and the split, read against
              each other — a 1,260-sample drive means one thing at 6.6 Hz and another at 2.9, and
              a 6 % split says which half of it you are looking at. They are a unit and never clip;
              measured, the four are 327px of the 343. Line 1 is then only the census, which has
              the whole width to clip in, biggest reason first and all of it one tap away.

              The split chip sat on line 1 while that line was "what is wrong with this drive". It
              is a measurement of the drive, not a reason samples were dropped — the census counts
              what the filter removed, and the split is about the ones it kept. */}
          {/* THE ZOOM LIVES ON THIS LINE, and the line now outlives the log.
              It used to be gated on `processedLog`, because everything on it was about a drive.
              The zoom is not — it is about the map, which is on screen whether or not a log has
              been read — and putting it on a band that comes and goes would move the control out
              from under the thumb the moment a session was cleared. So the band renders for any
              grid, and the drive's numbers are what is conditional inside it.

              Here rather than floating over the grid, and rather than on the census strip below:
              this is the topmost line of the map pane, it is already only 20px tall, and a control
              that shares it costs the map no height at all. The census strip is one line further
              down and belongs to the TUNED tab alone; this band is every grid tab's. */}
          {(processedLog || gridOnScreen) && (
            /* `max-w-[100vw] overflow-hidden`, and both halves are load bearing.
               The pane this sits in is a grid item whose column is `auto`, so the column takes the
               MAX-content width of its contents — and the census line is as wide as its text. The
               map grid beside it never did this because it lives in an `overflow-auto` box, which
               is a scroll container and contributes nothing. Without the cap the pane measured
               423px inside a 375px viewport and everything in it, the map included, sat 48px wide
               of the screen. A percentage max-width would not have helped: percentages resolve to
               auto during intrinsic sizing, which is exactly the pass that was going wrong.

               `pt-4 pb-2`, and the asymmetry is what makes it look symmetric.
               What sits under this bar is not the grid — it is the grid's own `pt-2` and the 1px
               rule, so the gap a reader sees below the text is 8 + 1 + 8 = 17px. Matching that
               with 16 above centres the band between the header line and the first row. Even
               padding here would centre it inside its own box and leave it visibly hugging the
               header, which is what it did.

               Opened upward rather than closing the grid's padding: the scale says take the
               space, and the room comes off a header edge that had none rather than off the
               content area, which has a stated value. */
            <div className="min-[900px]:hidden flex-none px-4 pt-4 pb-2 flex items-center gap-2 border-b border-slate-900 bg-slate-900/40 min-w-0 max-w-[100vw] overflow-hidden">
              <span className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden whitespace-nowrap">
                {processedLog && logRate && (
                  <span className="flex items-center gap-1.5 text-[9px] font-mono leading-none" title={logRate.title}>
                    <span className="text-slate-600">RATE</span>
                    <span className="text-slate-300 font-bold">{logRate.hz.toFixed(2)}</span>
                  </span>
                )}
                {processedLog && (
                  <span className="flex items-center gap-1.5 text-[9px] font-mono leading-none">
                    <span className="text-slate-500">VALID</span>
                    <span className="text-blue-400 font-bold">{processedLog.validCount.toLocaleString()}</span>
                  </span>
                )}
                {/* TOTAL, and it is still the door. DROP stood here for a while because it was the
                    half you can act on, but VALID is beside it and the drop count is their
                    difference — so TOTAL is the number the row could not otherwise give you, and
                    the one that says whether the drive was long enough to argue about at all.
                    Tapping still opens the census that says why the difference exists. */}
                {processedLog && (
                  <DropCensusLine
                    census={processedLog.dropCensus} chip className="leading-none"
                    total={processedLog.validCount + processedLog.droppedCount} />
                )}
                {/* Last, after the counts it qualifies: VALID is one number for a drive that this
                    says was two. */}
                {processedLog && (
                  <DriveSplitChip
                    split={driveSplit} excludedSpan={splitExcludedSpan} onOpen={openSplitDetail} />
                )}
              </span>
              {gridOnScreen && (
                <MapZoomButtons
                  atMin={mapZoom.atMin} atMax={mapZoom.atMax} onNudge={mapZoom.nudge} />
              )}
            </div>
          )}

          {/* Grid Container */}
          <div className="flex-1 overflow-auto relative">
            {/* Content */}
            {/* `pt-2 pb-2 px-4` is the scroll content area's padding in the spacing scale, and it
                stays that. An earlier attempt at evening up the band above zeroed the top of this
                box instead — closing whitespace to solve a whitespace problem, which is backwards
                in a system whose rule is to take the space. The band opens its own instead. */}
            <div className="absolute inset-0 pt-2 pb-2 px-4">
              {(activeTab === 'current' && currentMap) && <MapEditor mapData={currentMap} hitData={hitMap ?? undefined} {...coverageBands} weightData={weightMap ?? undefined} zoom={mapZoom.zoom} />}
              {(activeTab === 'new' && newMap) && (
                <div className="h-full w-full flex flex-col">
                  {/* One strip where there were two rows and a paragraph. The drive split, the
                      evidence gate, the air model and the cell census are all things you check
                      when a number surprises you — they were all on screen at once, above the map,
                      on the tab that is read on a phone. See TunedStatusBar. */}
                  <TunedStatusBar
                    coverage={veCalc.coverage}
                    census={coverageCounts}
                    chargeTempInfo={veCalc.chargeTempInfo}
                    // The METHOD and the two numbers that belong to it. `weight` is gone: it was
                    // reported here as `?? 5` while the calculator had already retired it to a
                    // default of 0, so the strip was quoting a bar the derivation was not applying.
                    gate={{
                      method: filterConfig.veMethod ?? VE_METHOD_DEFAULT,
                      samples: filterConfig.minVeCellSamples
                        ?? ((filterConfig.veMethod ?? VE_METHOD_DEFAULT) === 'statistical'
                          ? 10 : DIRECT_MIN_SAMPLES),
                      authority: filterConfig.directAuthority ?? DIRECT_AUTHORITY_DEFAULT,
                    }}
                    split={driveSplit} excludedSpan={splitExcludedSpan} originSec={logOriginSec}
                    readOnly={isArchived} onExclude={excludeSplit} onRestore={restoreSplit}
                  />
                  {/* `relative`, because the cell readout is an overlay on the foot of this box
                      rather than a row under it: it appears only when a cell is selected, and a
                      row that appeared would push the grid up and take the cell out from under
                      the finger that just tapped it. */}
                  <div className="flex-1 min-h-0 relative">
                    <MapEditor
                      mapData={newMap}
                      hitData={hitMap || undefined} {...coverageBands}
                      weightData={weightMap || undefined}
                      zoom={mapZoom.zoom}
                      onCellSelect={(row, col) => setCoverageCell(
                        c => (c && c.row === row && c.col === col ? null : { row, col }))}
                      selected={coverageCell}
                      bottomInset={coverageInset}
                      // NO cellTint. The background band already says all three states — no fill
                      // means nothing landed here, a faint fill means driven and refused, a strong
                      // one means written — and MapEditor keeps every band dark enough for ONE text
                      // colour precisely so the numbers do not change as coverage builds. Colouring
                      // them as well said the same thing twice and read as noise (operator,
                      // 2026-08-28). Which action a cell needs is the detail strip's job, and it
                      // names the reason rather than implying it with a hue.
                    />
                    <CoverageDetail
                      cell={coverageCell ? coverage[coverageCell.row]?.[coverageCell.col] : null}
                      map={newMap}
                      demand={coverageCell ? veCalc.demandMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      rfKorr={coverageCell ? veCalc.rfKorrMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      rfKorrSpread={coverageCell ? veCalc.rfKorrSpreadMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      onHeightChange={setCoverageInset}
                    />
                  </div>
                </div>
              )}
              {(activeTab === 'diff' && mapData) && ( // Changed from diffMap
                <div className="h-full w-full flex flex-col">
                  {/* SUBJECT vs REFERENCE. The measured width rules that keep two selects
                      full of session names inside a 343px pane live with the component — see
                      components/CompareBar.tsx. The CALIBRATION tab asks the same question
                      through the same control. */}
                  <CompareBar
                    options={diffOptions}
                    subject={diffSubject}
                    onSubject={v => setDiffSubject(v as MapVariant)}
                    reference={diffReference}
                    onReference={v => setDiffReference(v as MapVariant)}
                  />

                  <div className="flex-1 overflow-hidden relative">
                    <MapEditor
                      mapData={diffVisualMap!}
                      diffData={diffMapForVisualization || undefined}
                      hitData={hitMap || undefined} {...coverageBands}
                      weightData={weightMap || undefined}
                      zoom={mapZoom.zoom}
                    />
                  </div>
                </div>
              )}
              {(activeTab === 'lambda' && lambdaVisualMap) && (
                /* A column, like every other map tab: the strip takes the top and the grid
                   takes the rest. A fragment left the grid unsized once the readout below
                   it needed flex-1.

                   The strip is a ROW here, not an overlay — see LiveDriveStrip. An absolute
                   one contributed no height, so the grid started at the top of this same box
                   and the strip sat on `MapEditor`'s sticky `thead`: the RPM axis, hidden for
                   the whole of every run. */
                <div className="h-full w-full flex flex-col relative">
                  {/* The drive readout, over the map you are driving to fill.

                      Here rather than only on the graph pane, because on a phone those are two
                      panes and the one you watch while driving to a cell is this one. Session #924
                      spent forty minutes and put no samples at all into the band it was driven for:
                      nothing on screen said which cell the car was in or whether the pull had been
                      held long enough to count. See LiveDriveStrip.

                      `interpolationTable` and `highLoadSettleSec` come from the SESSION's own
                      settings, not from defaults — a session stores what it was built with, and a
                      readout aimed at a different number than the derivation uses is worse than
                      no readout. */}
                  {dmeLink.state === 'tuning' && (
                    <LiveDriveStrip
                      feed={liveRun.readout}
                      interpolationTable={interpolationTable}
                      settleSec={filterConfig.highLoadSettleSec}
                      view={activeDriveView}
                      views={driveViews}
                      onViewChange={setDriveView}
                      hitMap={hitMap}
                      rpmAxis={currentMap?.xAxis}
                      loadAxis={currentMap?.yAxis}
                      coverageOk={filterConfig.coverageOk ?? COVERAGE_OK_DEFAULT}
                    />
                  )}
                  {/* `relative` for the same reason the TUNED tab needs it: the readout is an
                      overlay on the foot of the box, not a row under it, so selecting a cell in the
                      bottom row does not push the grid out from under the finger. */}
                  <div className="flex-1 min-h-0 relative">
                    <MapEditor
                      mapData={lambdaVisualMap!}
                      hitData={hitMap || undefined} {...coverageBands}
                      weightData={weightMap || undefined}
                      zoom={mapZoom.zoom}
                      onCellSelect={(row, col) => setCoverageCell(
                        c => (c && c.row === row && c.col === col ? null : { row, col }))}
                      selected={coverageCell}
                      bottomInset={coverageInset}
                    />
                    {/* The same readout as TUNED MAP, and deliberately the same component: this is
                        the tab a cell's trustworthiness is judged on while driving, and two
                        readouts of one cell would be two places for the numbers to drift apart. */}
                    <CoverageDetail
                      cell={coverageCell ? coverage[coverageCell.row]?.[coverageCell.col] : null}
                      map={lambdaVisualMap}
                      demand={coverageCell ? veCalc.demandMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      rfKorr={coverageCell ? veCalc.rfKorrMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      rfKorrSpread={coverageCell ? veCalc.rfKorrSpreadMap?.[coverageCell.row]?.[coverageCell.col] : undefined}
                      onHeightChange={setCoverageInset}
                    />
                  </div>
                </div>
              )}

              {(activeTab === 'rfkorr' && tunedRfKorr) && (
                <RfKorrTable
                  result={tunedRfKorr}
                  zoom={mapZoom.zoom}
                  view={rfKorrView}
                  onViewChange={setRfKorrView}
                  buffer={binaryBuffer}
                />
              )}

              {(activeTab === 'warmup' && warmupMap) && (
                <MapEditor mapData={warmupMap} zoom={mapZoom.zoom} />
              )}


              {activeTab === 'lowload' && (
                <ShapeGrid shape={shape} zoom={mapZoom.zoom} />
              )}

              {/* Mounted always, hidden by class rather than by `&&`: the run's samples live in a
                  ref inside IdleWorkflow, so unmounting it on a tab change threw away a run in
                  progress — silently, because the tab still came back looking ready. */}
              <div className={`h-full w-full overflow-y-auto p-3 ${activeTab === 'idle' ? '' : 'hidden'}`}>
                <IdleWorkflow
                  startRun={dmeLink.startIdleRun}
                  stopRun={dmeLink.stopTuning}
                  tables={idleTables}
                  onArm={binaryFileState.setTunedIdleQvs}
                  armed={!!binaryFileState.tunedIdleQvs}
                  onSaveRun={(samples) => {
                    // BOTH failure paths below used to be silent, which is why a run that plainly
                    // happened could show no log and leave the driver nothing to act on. A save that
                    // cannot happen has to say so while the car is still running; afterwards it is
                    // one more drive that cannot be reproduced.
                    if (!currentSession) {
                      setIdleSaveError(`${samples.length} samples recorded and NOT saved — this run `
                        + 'had no open session. Open or create one, then run again.');
                      return;
                    }
                    setIdleSaveError(null);
                    void sessionDb.saveResearch({
                      sessionId: currentSession.id,
                      process: 'IDLE',
                      // The projection the log table and CSV read. Same rule the inertia run learned
                      // the hard way: it must never be the only copy, because it drops md_llri — the
                      // one quantity the whole estimate is made of.
                      log: samples.map(sample => ({
                        time: sample.time,
                        rpm: sample.rpm ?? 0,
                        rawLoad: 0,
                        coolantTemp: sample.coolantTemp ?? undefined,
                        wdk1: sample.wdk1 ?? undefined,
                      })),
                      idle: samples,
                    }).catch((e: unknown) => {
                      setIdleSaveError(`${samples.length} samples recorded and NOT saved: `
                        + (e instanceof Error ? e.message : String(e)));
                    });
                  }}
                />
              </div>

              {activeTab === 'calibration' && (
                <CalibrationTab
                  catalog={calData.catalog}
                  catalogError={calData.catalogError}
                  data={calData}
                  edits={calEdits}
                  ws={calWs}
                />
              )}

              {activeTab === 'inertia' && (
                <div className="h-full w-full overflow-y-auto p-3">
                  <InertiaWorkflow
                    startRun={startInertiaRunWithDiagnostics}
                    stopRun={dmeLink.stopTuning}
                    probeRam={dmeLink.probeRam}
                    baseImage={binaryFileState.binaryBuffer}
                    /**
                     * An inertia run is research in its own session — the samples used to live in a
                     * ref and nothing else, so navigating away lost the drive.
                     *
                     * Stored through saveResearch rather than saveSessionTune because there are no
                     * TUNED bytes: this run proposes calibration changes and writes nothing. No
                     * sha256 means the list never offers FINAL, Finalize or From TUNED for it, which
                     * is right and needs no special case anywhere.
                     *
                     * Inertia samples are not LogDataPoints and deliberately cannot be — see
                     * InertiaSample. They are mapped onto the log record's shape here, at the one
                     * boundary that knows both, keeping `time` and the channels the estimator reads.
                     */
                    onSaveRun={(samples) => {
                      if (!currentSession) return;
                      void sessionDb.saveResearch({
                        sessionId: currentSession.id,
                        process: 'INERTIA',
                        // The projection stays, because the log table and the CSV export read it.
                        // What it must never be is the ONLY copy: it keeps `time` and engine speed
                        // and drops the torque — one of the two quantities the whole estimate is a
                        // regression between. A run stored only like this cannot be re-analysed,
                        // which cost a real drive.
                        log: samples.map(s => ({
                          time: s.time,
                          rpm: s.rpm ?? 0,
                          rawLoad: s.rf ?? 0,
                          coolantTemp: s.coolantTemp ?? undefined,
                          wdk1: s.wdk1 ?? undefined,
                          rf: s.rf ?? undefined,
                        })),
                        // The samples as the DME sent them. Nulls preserved: `mdIndNe: null` is "the
                        // RAM read came back short" and `mdIndNe: 0` is "overrun, no combustion
                        // torque", and the first must never become the second — zero torque is the
                        // anchor point of every regression line in the run.
                        inertia: samples,
                      }).catch(() => { /* the estimate is on screen either way */ });
                    }}
                  />
                </div>
              )}

              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0">
                  {/* The same deferred window the chart reads — the one-window-two-views rule
                      survives the deferral because both defer TOGETHER. */}
                  <LogDataTable
                    data={deferredCharts.logWindow}
                    selectedIndex={windowRelativeSelection}
                    onRowClick={selectAbsoluteFromWindow}
                    totalCount={processedLog.data.length}
                    visibleFields={fieldVisibility.visibleFields}
                    presenceData={logFileState.rawLogData ?? undefined}
                    /* On screen only when this pane is. A point clicked on the chart is clicked
                       from the OTHER narrow pane, and the scroll to its row cannot happen until
                       this one is showing — see the effect this feeds. */
                    active={wideLayout || narrowPane === 'map'}
                  />
                </div>
              )}

              {activeTab === 'startup' && (
                // No file row above the list any more: a floating BIN/CSV input never said which
                // session it fed. Picking a BASE now happens on the draft's own row, and its log and
                // outputs on the session bar once it's open.
                <div className="h-full w-full flex flex-col">
                  <SessionList
                    sessions={sessionDb.sessions}
                    loading={sessionDb.loading}
                    error={sessionDb.error}
                    onOpen={handleOpenSession}
                    onNewSession={handleNewSession}
                    /* The door to the store, beside the action it belongs with — and the WIDE
                       layout's only one. The narrow layout already puts SYNC next to NEW and SAVE
                       in the menu sheet's SESSION band, which is the arrangement this copies; two
                       doors on a phone would be the duplication that took the header's SYNC away.
                       `hidden min-[900px]:block` and not a second render path, so the two layouts
                       cannot drift apart.

                       Preview only — see `storePanel` on the menu sheet for why — and unstyled, so
                       it takes the component's default shape: the same 10px uppercase label and 3px
                       icon NEW SESSION uses, one control's width to its left. */
                    beforeNew={isPreviewBuild ? (
                      <div className="hidden min-[900px]:block">
                        <SessionStorePanel
                          settings={sync.settings}
                          onRestored={() => void sessionDb.refresh()}
                        />
                      </div>
                    ) : undefined}
                    onNewFrom={handleNewFrom}
                    onRename={sessionDb.rename}
                    onDelete={sessionDb.remove}
                    onUploadBase={handleUploadBase}
                    onDownloadBase={handleDownloadSessionBase}
                    onDownloadTuned={handleDownloadSessionTuned}
                    onDownloadPatchOn={handleDownloadSessionPatchOn}
                    onInspectBase={inspectSessionBase}
                    onDownloadLog={handleDownloadSessionLog}
                    /* The workspace's own input, offered on the open row. `logFile` rather than
                       `session.hasLog`: the question is whether THIS workspace already holds one. */
                    onLoadLogFile={handleRowLogUpload}
                    canLoadLogFile={!logFile && !isArchived}
                    /* The other half of the same control. `logFile` decides both, so exactly one
                       of the two renders — see loadedLogName in SessionList's props. */
                    loadedLogName={logFile?.name}
                    loadedLogPoints={processedLog?.validCount}
                    onClearLog={!isArchived ? handleClearLog : undefined}
                    onUploadLog={canSync(uploadSettings) ? sync.syncSessionRow : undefined}
                    uploadState={sync.uploadState}
                    onFinalize={handleFinalizeSession}
                    activeSessionId={currentSession?.id}
                  />
                </div>
              )}

              {!currentMap && activeTab !== 'log' && activeTab !== 'startup' && (
                <div className="h-full flex flex-col items-center justify-center text-slate-700">
                  <div className="w-16 h-16 border-2 border-dashed border-slate-800 rounded-full flex items-center justify-center mb-4 opacity-50">
                    <FileCode className="w-6 h-6 opacity-50" />
                  </div>
                  <p className="text-xs font-mono opacity-50">AWAITING BINARY FILE...</p>
                </div>
              )}
            </div>
          </div>

          {/* ZOOM PILL — on the grid, because that is what it adjusts.
              ────────────────────────────────────────────────────────────────────────────────
              It was at the right end of the header: the far top corner of a phone, on the one
              control here meant to be used while the car is moving. The footer was the obvious
              new home and it does not fit — measured at 375, the row is MAP/DASH at 16-98, MENU
              at 162-214 and the three config panels at 247-359, which leaves 64px to the left of
              MENU and 33px to its right. A 44px target does not go in 33, and anything narrower
              that did would sit against the app's primary navigation control, which is the
              mis-tap this is trying not to invent.

              So it floats over the bottom-right of the grid instead — in the thumb's arc, on the
              thing it acts on, and clear of every other control by the height of the footer. The
              map scrolls underneath, so no cell is permanently behind it.

              Inside the map PANE, so DASH takes it away without a condition of its own — that
              pane is `invisible pointer-events-none` while the dash is up. `gridOnScreen` is the
              other half: the session list lives in this pane too, and a zoom over a list of
              sessions adjusts nothing.

              44px targets, disabled at the ends of the range rather than hidden — a control that
              vanishes at the limit takes the way back with it. Background step and a shadow, no
              border: one separator per edge, and this one is genuinely floating. */}
          {/* THE FLOATING PAIR IS GONE. It sat at `bottom-3 right-3` over the grid, which was
              right while there was nothing at the top of the pane to sit beside. There is now —
              the drive band above renders for any grid — and the map is worth more than the
              corner: a floating control covers cells, and the one it covered was in the bottom
              right, which on this table is high rpm at high opening. */}
        </div>

        {/* === RIGHT COLUMN (30% desktop / 60% stacked) === */}
        {/* NO `backdrop-blur-sm` here, and its removal is the fix for "the buttons disappear late"
            when switching DASH/MAP on a phone.

            It made this pane a backdrop-filter layer the size of the viewport — measured 375x711,
            266,625 px², at z-20 — and a pane switch toggles its visibility. Tearing that layer down
            and rebuilding it is compositor work, which happens AFTER the JavaScript: the commit can
            be as fast as you like and the old pane still sits on screen until the GPU has
            re-rasterized the full-screen region. That is why making the commit 4x faster
            (47 ms -> 12 ms, the coverageBands memo) changed nothing anyone could see.

            And it was blurring nothing. Measured in both layouts: on a phone the two panes are
            never painted at the same time — while DASH is up the MAP pane computes to
            `visibility: hidden` — and above 900px they are side-by-side flex columns with no
            overlap at all (map 0-791, dash 791-1280 at 1280 wide). So the only thing ever beneath
            this filter is the app's own flat background, and a blur of a flat colour is that colour.
            `bg-slate-900/20` still paints exactly as it did.

            The header's and the footer's blurs are kept: those DO sit over pane content, so theirs
            is an effect rather than a cost. They are also 18,000 and 19,875 px² — together under a
            seventh of what this one was. */}
        <div className={`[grid-area:1/1] flex min-[900px]:[grid-area:auto] ${narrowPane !== 'map' ? '' : 'invisible pointer-events-none min-[900px]:visible min-[900px]:pointer-events-auto'} min-h-0 min-[900px]:flex-none min-[900px]:h-full min-[900px]:w-[38.2%] flex-col bg-slate-900/20 relative z-20 overflow-hidden`}>

          {/* Header Frame - Matches Left Column Height */}
          <div className="h-[44px] hidden min-[900px]:flex items-center justify-between px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Visualization & Inputs</span>
          </div>

          {/* CONTENT FLEX CONTAINER (6:4 Split) */}
          <div className="flex-1 flex flex-col min-h-0">

            {/* 3D Graph (Flex 7) */}
            {/* The visualizer is the elastic half. A 3D map reads fine at any size; the dial and its
                toggles do not. A fixed 7:3 split had it backwards — it pinned the picture and made
                the controls absorb every shortfall, squeezing the 80px dial down to 52px.

                The 140px floor kept doing that job for it on a short viewport. Measured on the
                phone this is actually used on — 915x412 landscape — the pane had 320px to spend:
                the visualizer took its 140 and the cluster was left holding 48px against a natural
                120, so it sat pinned at the 0.4 scale floor and the arming toggles that decide what
                goes into the ECU rendered at 14x8 px. The floor only lowers where the viewport is
                genuinely short; a laptop still gets the full 140. It still earns its keep in a
                short *wide* window, which stacks these two and cannot split them.

                This and the panel below take turns only where the pane splits. Everywhere else —
                any wide layout, and any narrow one with the height for it — they stack, which is
                what this box has always done and what the floor above is written for. */}
            <div className={`${narrowPane === 'graph' ? '' : SPLIT_ONLY_HIDE} flex-1 min-h-[48px] [@media(min-height:560px)]:min-h-[140px] relative overflow-hidden bg-gradient-to-b from-slate-900/10 to-transparent`}>
              {/* Live raw telemetry readout — floats over the visualization during logging so it shows
                  the latest DME sample (independent of the VE filters) WITHOUT shifting the inputs /
                  dashboard layout: the panel below is identical whether logging or stopped. */}
              {dmeLink.state === 'tuning' && <LiveTelemetryStrip feed={liveRun.readout} />}
              {graphOnScreen && (activeTab === 'current' && deferredCharts.currentMap) && <MapVisualizer mapData={deferredCharts.currentMap} title="" zAxisLabel="RF %" />}
              {graphOnScreen && (activeTab === 'new' && deferredCharts.newMap) && <MapVisualizer mapData={deferredCharts.newMap} title="" zAxisLabel="RF %" />}
              {/* SHAPE shows the surface it would leave behind — the applied repair if there is one,
                  the composed tune if not. The whole tab is about what the table LOOKS like, and
                  that is the one question a grid of numbers answers worst. */}
              {/* The two signed maps. Their neutral value differs — useComparison emits a percentage
                  difference (no change = 0), the VE calculator emits an STFT multiplier (no change =
                  1.0) — so each states its own midpoint rather than letting the scale guess. */}
              {/* diffVisualMap already carries the "is there anything to show" decision — it is null
                  unless diffMapForVisualization and a base to wear it exist — so the gate and the
                  data come from the one deferred object and cannot disagree. */}
              {graphOnScreen && (activeTab === 'diff' && deferredCharts.diffVisualMap) && (
                <MapVisualizer mapData={deferredCharts.diffVisualMap} title="" zAxisLabel="Diff %" scale="deviation" deviationMidpoint={0} />
              )}
              {graphOnScreen && (activeTab === 'lambda' && deferredCharts.lambdaVisualMap) && (
                <MapVisualizer mapData={deferredCharts.lambdaVisualMap} title="" zAxisLabel="Lambda" scale="deviation" deviationMidpoint={1} />
              )}
              {/* The correction is a multiplier centred on 1.0, and only the departure from it
                  means anything, so it takes the deviation scale like the two signed maps above
                  rather than the absolute one the filling maps use. CHANGE % is centred on 0
                  instead, which is why the midpoint comes from the view rather than being stated
                  here — see rfKorrView.ts.

                  It also follows the table's STOCK / TUNED / CHANGE % selection. It did not, and
                  that was the worst kind of wrong: a surface that kept drawing TUNED while the grid
                  beside it showed STOCK, with nothing on screen saying so. Y is the exhaust
                  temperature delta, NOT the VE map's load axis, which is the other half of the same
                  bug — the scene had `RO %` hardcoded. */}
              {graphOnScreen && (activeTab === 'rfkorr' && deferredCharts.rfKorrSurface) && (
                <MapVisualizer
                  mapData={deferredCharts.rfKorrSurface.map}
                  title=""
                  xAxisLabel={RF_KORR_COL_LABEL}
                  yAxisLabel={RF_KORR_ROW_LABEL}
                  zAxisLabel={deferredCharts.rfKorrSurface.zAxisLabel}
                  scale="deviation"
                  deviationMidpoint={deferredCharts.rfKorrSurface.deviationMidpoint}
                />
              )}
              {graphOnScreen && (activeTab === 'warmup' && deferredCharts.warmupMap) && <MapVisualizer mapData={deferredCharts.warmupMap} title="" zAxisLabel="RF %" />}
              {/* CALIBRATION: the ported SVG chart + editable grid, not Plotly — it fits this
                  pane via viewBox and the diagram next door is the main view anyway. */}
              {graphOnScreen && activeTab === 'calibration' && (
                <ValuePane
                  def={calSelectedDef}
                  subjectRun={calSubjectRun}
                  referenceRun={calReferenceRun}
                  subjectDecoded={calSubjectDecoded}
                  referenceDecoded={calReferenceDecoded}
                  editedMask={calEditedMask}
                  hasEdit={!!calSelectedEdit}
                  graphMode={calWs.graphMode}
                  onGraphMode={calWs.setGraphMode}
                  sectionAxis={calWs.sectionAxis}
                  onSectionAxis={calWs.setSectionAxis}
                  subject={calCompare.subject}
                  onSubject={calCompare.setSubject}
                  reference={calCompare.reference}
                  onReference={calCompare.setReference}
                  compareOptions={calCompareOptions}
                  diffMode={calCompare.diffMode}
                  onDiffMode={calCompare.setDiffMode}
                  diffCount={calDiffEntries?.length ?? null}
                  onShowList={() => setCalBottomTab('list')}
                  onEditCell={calEditCell}
                  onBulkOp={calBulkOp}
                  onCopyRef={calCopyRef}
                  onRevert={() => { if (calSelectedDef) calEdits.revertParam(calSelectedDef.id); }}
                />
              )}
              {/* Two views in the slot the other tabs give to one: the tuned surface, or a cut
                  through it. This column was empty on SHAPE while the cut was wedged under the
                  grid in the other pane — see ShapeGraph. */}
              {graphOnScreen && activeTab === 'lowload' && shape.ready && (
                <ShapeGraph shape={shape} surface={deferredCharts.shapeSurface} />
              )}
              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0 relative">
                  {/* Chart Container - Absolute fill; chart flexes, window-scrub slider docked below it
                      (moved off the tab bar so tab scrolling isn't squeezed by it). */}
                  <div className="absolute inset-0 flex flex-col">
                    <div className="flex-1 min-h-0">
                      <LogTimeSeriesChart
                        data={deferredCharts.logWindow}
                        selectedIndex={windowRelativeSelection}
                        onPointClick={selectAbsoluteFromWindow}
                        visibleFields={fieldVisibility.visibleFields}
                        presenceData={logFileState.rawLogData ?? undefined}
                        live={dmeLink.state === 'tuning'}
                        fitToken={chartFitToken}
                        onPanWindow={panWindow}
                        canPanWindow={maxWindowStart > 0}
                        logKey={logFileState.logFile?.name ?? 'none'}
                      />
                    </div>
                    {/* The window scrub. It drives what BOTH this chart and the row table are looking
                        at, which is what keeps a clicked point and its row the same index. A two-finger
                        horizontal swipe on the chart calls the same panWindow, so the slider and the
                        trackpad are one control with two grips.

                        step is clamped to the range: it used to be a flat 100 while max could be as
                        little as 1, so a log that HAD outgrown the window still could not be scrubbed. */}
                    {(() => {
                      const canScrub = maxWindowStart > 0;
                      const step = Math.max(1, Math.min(100, maxWindowStart));
                      const windowEnd = Math.min(processedLog.data.length, logWindowStart + LOG_WINDOW_SIZE);
                      return (
                        <div className="flex-none flex items-center gap-3 px-2.5 pt-2 pb-0.5">
                          <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap">
                            WIN: {logWindowStart.toLocaleString()} - {windowEnd.toLocaleString()}
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={maxWindowStart}
                            step={step}
                            value={logWindowStart}
                            disabled={!canScrub}
                            onChange={(e) => setLogWindowStart(Number(e.target.value))}
                            title={canScrub
                              ? 'Scroll the window through the log — the chart and the rows move together'
                              : 'The whole log fits in one window'}
                            className={`flex-1 min-w-[60px] h-1 bg-slate-700 rounded-lg appearance-none transition-colors ${canScrub
                              ? 'cursor-pointer accent-blue-500 hover:accent-blue-400'
                              : 'cursor-not-allowed accent-slate-600 opacity-50'}`}
                          />
                          <span className="text-[9px] text-slate-600 font-mono whitespace-nowrap">/ {processedLog.validCount.toLocaleString()}</span>
                          {/* doubleClick is off so click-to-select stays unambiguous, which leaves no
                              built-in way out of a zoom. This is it. */}
                          <button
                            onClick={() => setChartFitToken(t => t + 1)}
                            className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-blue-400 transition-colors whitespace-nowrap"
                            title="Undo the chart zoom and fit the window"
                          >
                            Fit
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Inputs & Controls (Flex 3) */}
            {/* flex-initial (0 1 auto): takes the height its controls actually need and never grows.
                It can still shrink on a genuinely short viewport — that's what useFitScale's floor
                and overflow-y-auto are for — but it no longer donates room to an empty 3D pane. */}
            {/* On CALIBRATION the region's height is the layout's (φ of the column), not the
                content's: INFO and DME alternate inside it, and a height that followed the content
                would resize the value pane above on every tab switch. Other tabs keep flex-initial —
                the hub's natural height — exactly as before. */}
            <div className={`flex ${narrowPane === 'graph' ? SPLIT_ONLY_HIDE : SPLIT_ONLY_GROW} ${activeTab === 'calibration' ? 'basis-[38.2%] grow-0 shrink-0' : 'flex-initial'} min-h-0 overflow-y-auto px-5 pt-2 pb-2 [@media(min-height:560px)]:pt-4 [@media(min-height:560px)]:pb-5 flex-col`}>

              {/* On the CALIBRATION tab this pane's bottom region is tabbed: DIFF for what
                  differs between the two BINs, INFO for the selected parameter, FLASH for the
                  connect/write hub. ONE branch mounts at a time — the hub is one state machine and
                  must never exist twice in the DOM. Every other tab renders the hub exactly where
                  it always was. */}
              {activeTab === 'calibration' && (
                <div className="h-[26px] flex-none flex items-center gap-4 px-1 mb-1 border-b border-slate-900">
                  {/* Reading order, left to right: which ones differ, what this
                      one is, and what to do with the result.

                      The LABELS are not the ids. `dme` reads FLASH because the
                      tab is named for the job — writing the binary — while the
                      id stays with the device the rest of the file is named
                      after (dmeLink, dmeInputsPanel, dmeStatusColor). Renaming
                      the id would rename a state machine to match a word on a
                      tab. */}
                  {(['list', 'info', 'dme'] as const).map(id => (
                    <button
                      key={id}
                      onClick={() => setCalBottomTab(id)}
                      className={`h-full flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest border-b-2 transition ${calBottomTab === id
                        ? 'text-blue-400 border-blue-400'
                        : 'text-slate-600 border-transparent hover:text-slate-300'}`}
                    >
                      {id === 'list' ? 'DIFF' : id === 'info' ? 'INFO' : 'FLASH'}
                      {id === 'dme' && <span className={`block w-1.5 h-1.5 rounded-full ${dmeStatusColor}`} />}
                      {id === 'list' && calDiffEntries !== null && (
                        <span className="font-mono text-slate-500">{calDiffEntries.length}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {activeTab !== 'calibration' || calBottomTab === 'dme'
                ? dmeInputsPanel
                : calBottomTab === 'list' ? calListPanel : calInfoPanel}
            </div >
          </div >
        </div >
      </div >

      {/* MOBILE FOOTER — the app's controls for a window that cannot spare a row at the top.
          Outside both panes on purpose: each pane hides the other below 900px, so anything living
          inside one of them takes the way back out of the other with it.

          MENU is centred absolutely rather than by flex order, so it stays on the screen's centre
          line whatever the groups either side of it happen to weigh — the pane labels are two short
          words today and the config cluster is three icons, and neither is a promise.

          The record counts sit ABOVE the control row rather than below it: below is the screen
          edge, where Android's gesture bar is, and a 9px readout is not something to put there. */}
      <div className="min-[900px]:hidden flex-none z-30 border-t border-slate-900 bg-slate-900/50 backdrop-blur-sm">
        {/* The record counts used to sit here, above the control row, and they cost 52px of a
            phone's screen for a readout that never changes shape. They are in the header now, whose
            middle was empty below 900px — see the block beside the wordmark. The map got the 52px. */}
        {/* One row again.

            This wrapped to two rows below 520px, and it had to: the cluster is `ml-auto` so it
            grows leftward from the right edge while MENU is absolutely centred, and at five panels
            it was 192px wide — left edge at x=152 on a 360px screen, against MENU's 154-206. The
            cluster sat on top of the app's primary navigation control.

            It is back to three, which is what this row was sized for: the session store moved to
            the SESSIONS header and the ECU parameters into the RF KORR tab, beside the table they
            are the provenance of. Measured at 360x800 after the move — MENU ends at x=206, the
            cluster starts at x=232, and `elementFromPoint` at MENU's centre returns MENU.

            `top-0` and `z-10` on MENU are kept rather than reverted with the rest. Neither depends
            on the wrap: the first says which row MENU belongs to if this ever grows again, and the
            second means that if it does, the navigation control is the one that stays pressable. */}
        <div className="relative h-[52px] flex items-center px-4">
          {narrowPaneTabs}
          {/* Opens on pointerdown, not click, so the same press can carry on into the sheet and
              pick a row on the way back up. `touch-none` stops the browser claiming the gesture as a
              scroll before the menu ever sees it.

              The release is NOT handled here. The sheet's scrim goes up on this very pointerdown and
              covers this button, so its own pointerup never arrives — the drag would stay armed
              after the finger had gone and the next release anywhere would read as a selection.
              That is what made the button feel unreliable. The sheet ends the drag instead, from a
              window-level listener that always fires. */}
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); setMenuOpen(true); setMenuDrag({ x: e.clientX, y: e.clientY }); }}
            aria-label="Open menu"
            className="absolute left-1/2 -translate-x-1/2 top-0 h-[52px] w-[52px] flex items-center justify-center touch-none text-slate-400 hover:text-slate-200 cursor-pointer z-10"
          >
            <MarkIcon className="w-8 h-7" />
          </button>
          {/* `openUp` because these hang off the bottom edge here; the same three render `top-10`
              in the desktop tab row, which is the other instance of them. */}
          <div className="ml-auto flex items-center gap-2">
            <InterpolationTableEditor
              config={interpolationTable}
              onSave={handleTableChange}
              enabled={(pendingConfig ?? filterConfig).enableCorrection}
              onToggle={(enabled) => handleConfigChange({ ...(pendingConfig ?? filterConfig), enableCorrection: enabled })}
              readOnly={isArchived}
              openUp
            />
            <FilterConfigPanel config={filterConfig} onConfigChange={handleConfigChange} readOnly={isArchived}
                scope={activeTab === 'rfkorr' ? 'rfkorr' : 've'}
                channels={logChannels} measuredHz={logRate?.hz} routeGap={routeGap} routeSamples={routeSamples} openUp />
            {/* Same swap as the wide cluster above — see the note there. */}
            {activeTab === 'lowload' ? (
              <ShapeControls shape={shape} onApply={applyShape} openUp />
            ) : (
              <FieldVisibilityPanel
                visibleFields={fieldVisibility.visibleFields}
                onToggle={fieldVisibility.toggleField}
                onShowCoreOnly={fieldVisibility.showCoreOnly}
                onShowDefaults={fieldVisibility.showDefaults}
                openUp
              />
            )}
          </div>
        </div>
      </div>

      {/* Mounted at <main> level, not inside the hub cluster: that cluster is overflow-hidden and
          sits under useFitScale's transform, so a modal rendered within it would be clipped and
          scaled down along with the dial. */}
      {dialogs.isOpen('adaptation') && (
        <AdaptationResetDialog
          onRead={dmeLink.readAdaptations}
          onReset={dmeLink.resetAdaptations}
          onClose={() => dialogs.close()}
          onResetComplete={handleAdaptationResetComplete}
          error={dmeLink.error}
          errorKind={dmeLink.errorKind}
        />
      )}

      {/* Above every other dialog in the app (DialogFrame is z-100/110), which is right: the
          messages routed here are the ones that stop a sequence — a run has ended, a write is about
          to go out, a write did not. Nothing should be able to paint over them. */}
      {dialogs.message && <MessageDialog message={dialogs.message} closeLabel={dialogText().btnClose} />}

      {/* Every download in the app announces itself here. Installed, there is no browser chrome to
          do it — see the component, and downloadBlob's own note. Mounted at <main> level for the
          same reason the dialogs are: the hub cluster is overflow-hidden and scaled by useFitScale,
          so anything inside it would be clipped along with the dial. */}
      <DownloadToast />

      {/* Last, so it paints over everything including those. It shares their z tier rather than
          claiming a new one: nothing else needs to be above a panel whose next act is to replace the
          document, and DOM order settles it. It holds off 400 ms of its own accord, so a swap that
          is already downloaded does not flash it.

          Mounted behind `reloading` rather than rendering itself away, so that it exists only on the
          client: it reads this document's build stamp out of the DOM, and a component that touches
          `document` during render must not be reachable from the prerender. It was, once, and the
          export failed with `ReferenceError: document is not defined` and a minified stack. */}
      {reloading && <UpdateOverlay />}

      {menuOpen && (
        <MobileMenu
          onClose={() => setMenuOpen(false)}
          dragFrom={menuDrag}
          onDragEnd={() => setMenuDrag(null)}
          updateAvailable={updateAvailable}
          reloading={reloading}
          onReload={handleReload}
          installState={install.state}
          onInstall={() => { void install.promptInstall(); }}
          sync={syncStatus}
          save={saveStatus}
          onSave={() => { void handleSaveSession(); }}
          onNewSession={() => { void handleNewSession(); setNarrowPane('map'); }}
          onOpenCredits={() => { dialogs.open('credits'); setMenuOpen(false); }}
          /* The SYNC cell of the sheet's grid, and the panel behind it — one control, not two.
             SEND and "where does it send" were a cell each, which is one cell too many on a
             three-across grid and a distinction nobody was making — the destination is this
             deployment and there is nothing to choose. The panel is titled SESSION SYNC, explains
             the two-step flow, and carries the send itself as `topAction`.

             Preview only, for the same reason `sync` is: production has no `/api` for this to talk
             to, so it could only ever report failures. Assembled here rather than imported inside
             the sheet so that one gate stays in one place, and so the trigger's tone comes from the
             same describeSync the header's twin reads. */
          storePanel={isPreviewBuild && syncLook ? (
            <SessionStorePanel
              openUp
              label={`Sync${(syncStatus?.pending ?? 0) > 0 ? ` ${syncStatus?.pending}` : ''}`}
              triggerIcon={<UploadCloud className="w-4 h-4 shrink-0" />}
              triggerClassName={MENU_CELL}
              triggerToneClassName={syncLook.tone === 'ready' ? 'text-blue-400 hover:bg-slate-800 cursor-pointer'
                : syncLook.tone === 'error' ? 'text-red-400 hover:bg-slate-800 cursor-pointer'
                  : syncLook.tone === 'busy' ? 'text-slate-500 animate-pulse'
                    : 'text-slate-600 hover:bg-slate-800 cursor-pointer'}
              topAction={
                <button
                  type="button"
                  onClick={syncLook.disabled ? undefined : () => { void sync.syncAll(); }}
                  disabled={syncLook.disabled}
                  title={syncLook.title}
                  className={`w-full flex items-center justify-center gap-2 min-h-[44px] rounded border transition-colors ${syncLook.tone === 'ready' ? 'border-blue-500/40 text-blue-400 hover:bg-blue-500/10 cursor-pointer'
                    : syncLook.tone === 'error' ? 'border-red-500/40 text-red-400 hover:bg-red-500/10 cursor-pointer'
                      : syncLook.tone === 'busy' ? 'border-slate-800 text-slate-500 animate-pulse cursor-wait'
                        : 'border-slate-800 text-slate-700 cursor-default'}`}
                >
                  <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[10px] font-bold uppercase tracking-widest">{syncLook.label}</span>
                </button>
              }
              settings={sync.settings}
              onRestored={() => void sessionDb.refresh()}
            />
          ) : undefined}
          buildLabel={buildLabel}
          tabs={TABS}
          activeTab={activeTab}
          /* Picking a view is also asking to look at it. Without the second call the tab changed
             behind whichever pane was already showing, so choosing CURRENT MAP from the dashboard
             left you on the dashboard with the map loaded out of sight. */
          onSelectTab={(id) => { goToTab(id as TabId); setNarrowPane('map'); }}
          identity={dmeLink.identity}
          linkState={dmeLink.state}
          flashText={flashText}
          flashColor={flashColor}
          flashEnabled={dmeLink.state === 'connected'}
          onOpenFlash={() => dialogs.open('flash')}
          session={currentSession ? { label: currentSession.label, archived: isArchived } : null}
          baseOrigin={currentSession ? (
            <OriginBadge
              session={currentSession}
              parent={currentSession.parentSessionId
                ? sessionDb.sessions.find(s => s.id === currentSession.parentSessionId)
                : undefined}
            />
          ) : undefined}
          logName={logFile?.name}
          logPoints={processedLog?.validCount}
        />
      )}

      {dialogs.isOpen('credits') && (
        <CreditsDialog
          onClose={() => dialogs.close()}
          buildLabel={buildLabel ?? null}
        />
      )}

      {/* The DME IDENTITY dialog stood here. Its only trigger was the status dot in the header,
          and with that back to being an LED nothing could open it — a dialog reachable from nowhere
          is not a feature, it is a branch that never runs. `components/DmeIdentityDialog.tsx` is
          still on disk and still compiles; giving it an entry point again is one line. The identity
          itself is not lost either: `useDiagnosticsPublisher` still sends VIN and software version
          with every diagnostics record. */}

      {dialogs.isOpen('flash') && (
        <FlashCounterResetDialog
          onRead={dmeLink.readFlashCounter}
          onReadRpm={dmeLink.readEngineRpm}
          onReset={dmeLink.resetFlashCounter}
          onBackup={handleFlashCounterBackup}
          onInspect={dmeLink.readServiceBlocks}
          onSaveInspection={handleSaveServiceBlocks}
          onListBackups={handleListFlashBackups}
          onRestore={handleFlashCounterRestore}
          onClose={() => void handleFlashDialogClose()}
          onResetComplete={handleFlashCounterResetComplete}
          transferProgress={dmeLink.transferProgress}
          transferPhase={dmeLink.transferPhase}
          error={dmeLink.error}
          errorKind={dmeLink.errorKind}
        />
      )}

      {disclaimer.open && <DisclaimerDialog onAccept={disclaimer.accept} />}
    </main >
  );
}
