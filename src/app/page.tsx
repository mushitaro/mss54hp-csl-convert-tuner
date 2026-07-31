'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic'; // Added dynamic import
import { DropZone } from '@/components/DropZone';
import { MapEditor } from '@/components/MapEditor';
// Dynamic imports for heavy components
const MapVisualizer = dynamic(() => import('@/components/MapVisualizer').then(mod => mod.MapVisualizer), { ssr: false });
const LogTimeSeriesChart = dynamic(() => import('@/components/LogTimeSeriesChart').then(mod => mod.LogTimeSeriesChart), { ssr: false });
import { FilterConfigPanel } from '@/components/FilterConfigPanel';
import { InterpolationTableEditor } from '@/components/InterpolationTableEditor';
import { LogDataTable } from '@/components/LogDataTable';
import { SessionList, OriginBadge, NewFromWhich } from '@/components/SessionList';
import { FieldVisibilityPanel } from '@/components/FieldVisibilityPanel';
import { AdaptationResetDialog } from '@/components/AdaptationResetDialog';
import { FlashCounterResetDialog } from '@/components/FlashCounterResetDialog';
import { DisclaimerDialog } from '@/components/DisclaimerDialog';
import { DmeIdentityDialog } from '@/components/DmeIdentityDialog';
import { AlertCircle, CheckCircle, Download, FileCode, FileSpreadsheet, Settings, Power, Zap, Play, Thermometer, Cpu, Trash2, Github, BookOpen, Square, Loader2, RotateCcw, Eraser, PlugZap, Database, Upload } from 'lucide-react';
import { LogFilterConfig, InterpolationPoint, LogDataPoint } from '@/lib/types';
import { TuningSession, TuneSettings, BaseOrigin } from '@/lib/db/schema';
import { AdaptationSnapshot, FlashCounterInfo, TransferPhase } from '@/lib/dme-link/types';
import { ServiceBlockLayout, LOW_SLOT_WARNING_THRESHOLD } from '@/lib/dme-link/flashCounter';
import { TUNE_ADAPTATION_CLEAR, DS2_SELECTABLE_BAUDS, Ds2SupportedBaud } from '@/lib/dme-link/ds2';
import { saveServiceBackup, listRestorableBackups, loadServiceBackup } from '@/lib/db/serviceBackupRepository';
import { beginLiveRun, appendLiveChunk, endLiveRun, discardLiveRun, findRecoverableRun, loadLiveRunPoints } from '@/lib/db/liveRunRepository';
import { downloadBlob, fileSafe, MIME_BIN, MIME_CSV, MIME_JSON } from '@/lib/download';
import { dialogText } from '@/lib/dialog-text';
import { isAndroidPlatform } from '@/lib/dme-link/byteTransport';
import { serializeLogFile } from '@/lib/log-engine/serializer';
import { sampleRateHzFromTimes } from '@/lib/log-engine/rate';
import { sha256Hex } from '@/lib/db/sessionRepository';
import { useBinaryFile } from '@/hooks/useBinaryFile';
import { useLogFile } from '@/hooks/useLogFile';
import { useVeCalculation } from '@/hooks/useVeCalculation';
import { useComparison } from '@/hooks/useComparison';
import { useSessionDb } from '@/hooks/useSessionDb';
import { useFieldVisibility } from '@/hooks/useFieldVisibility';
import { useDmeLink } from '@/hooks/useDmeLink';
import { useUnloadGuard } from '@/hooks/useUnloadGuard';
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';
import { useHiddenWitness } from '@/hooks/useHiddenWitness';
import { useDisclaimer } from '@/hooks/useDisclaimer';

type TabId = 'startup' | 'current' | 'lambda' | 'new' | 'diff' | 'log' | 'warmup' | 'wot';

/** Live Hz readout tuning. 24 samples is ~3 s of history on the cable (two DS2 exchanges each) and
 *  ~0.5 s under PRACTICE — long enough to ride out one retried exchange either way. Publishing at
 *  4 Hz keeps the digits readable; the value itself is recomputed no faster than that. */
const HZ_WINDOW_SAMPLES = 24;
const HZ_PUBLISH_INTERVAL_S = 0.25;
/** How often a run's samples are appended to the crash-recovery store. Wall clock, not sample time:
 *  this bounds how much of a DRIVE is at risk, and that is measured in seconds of the user's life,
 *  not in samples. At the ~10 Hz this link achieves, 5 s is ~50 points — the most a crash can cost. */
const PERSIST_INTERVAL_MS = 5000;

/** Replaces the tab strip's scrollbar with a fade on whichever edge still has tabs behind it.
 *
 *  The bar had to go: it renders 10px tall inside a 44px row, directly under the active tab's
 *  2px underline, so the row read as two competing rules. A fade costs no height at all.
 *
 *  Only the overflowing side fades. A permanent fade on both edges would say "there is more this
 *  way" while scrolled hard against a stop, which is exactly when there isn't — and an indicator
 *  that is always on communicates nothing. Nothing is lost in exchange: Chromium maps a vertical
 *  wheel onto a container that only scrolls horizontally, and the tabs are real buttons, so Tab-key
 *  focus scrolls them into view on its own. */
function useEdgeFade(fadePx = 24) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      // 1px of slack: fractional layout widths leave scrollLeft a hair short of the true maximum,
      // which would otherwise strand a fade on the right edge at the end of the scroll.
      const max = el.scrollWidth - el.clientWidth;
      setEdges(prev => {
        const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    // Covers the container getting narrower. It does NOT cover the content getting wider: the strip
    // is flex-1, so its own box is unchanged when what is inside it grows.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Which is exactly what a webfont swap does. Tab labels are laid out in the fallback face first,
    // and Inter's metrics can push a strip that fit into one that overflows — with no scroll, no
    // resize and no DOM change to notice it by, leaving the right edge unfaded until the user
    // happens to scroll. `fonts` is undefined in jsdom-style environments, hence the guard.
    document.fonts?.ready.then(update);
    // Insurance for the tab set itself changing. Today every tab is always rendered and only its
    // `disabled` attribute varies, so this never fires — it is here so that making a tab conditional
    // later does not silently strand the fades.
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const mask = `linear-gradient(to right, ${[
    edges.left ? `transparent 0, black ${fadePx}px` : 'black 0',
    edges.right ? `black calc(100% - ${fadePx}px), transparent 100%` : 'black 100%',
  ].join(', ')})`;

  return { ref, style: { maskImage: mask, WebkitMaskImage: mask } as React.CSSProperties };
}

function useFitScale(minScale = 0.5) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [naturalH, setNaturalH] = useState(0);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const compute = () => {
      const naturalW = inner.offsetWidth;
      const naturalH = inner.offsetHeight;
      if (naturalW <= 0 || naturalH <= 0) return;
      // Published even while the box is collapsed — it's what floors the container (minH below), so
      // bailing out first would leave a zero-height box with no way back.
      setNaturalH(naturalH);

      const availW = outer.clientWidth - 12;
      const availH = outer.clientHeight - 12;
      if (availW <= 0 || availH <= 0) return;
      setScale(Math.max(minScale, Math.min(1, availW / naturalW, availH / naturalH)));
    };

    const ro = new ResizeObserver(compute);
    ro.observe(outer);
    ro.observe(inner);
    compute();
    return () => ro.disconnect();
  }, [minScale]);

  // Floor for the container = the smallest the cluster can shrink to. `overflow-hidden` zeroes a flex
  // item's automatic minimum size, so without this `flex-1` collapses the box and clips the main
  // button away entirely on short viewports. Independent of scale, so it can't feed back into it.
  return { outerRef, innerRef, scale, minH: naturalH * minScale };
}

/** One phase, one color. The hub's progress arc, the percentage inside it and the phase label under
 *  it all read this table, so the three can never disagree about what stage the transfer is in.
 *  The two stages that behave unusually get the two colors furthest from the read/write blue: erase
 *  reports nothing and parks the percentage at 0 until it finishes (ERASE_TIMEOUT_MS allows it 65 s),
 *  and verify is a second full-length pass that is reading the ECU back, not writing to it. Since
 *  the palette collapsed to the M tricolor, `amber` is violet and `emerald` is a near-white ice blue
 *  — erase separates by hue, verify by lightness (15.4:1 against blue-400's 8.3:1) plus its label. */
const TRANSFER_PHASE_STYLE: Record<TransferPhase, { label: string; text: string }> = {
  erasing: { label: 'Erasing…', text: 'text-amber-400' },
  reading: { label: 'Reading…', text: 'text-blue-400' },
  writing: { label: 'Writing…', text: 'text-blue-400' },
  verifying: { label: 'Verifying…', text: 'text-emerald-400' },
};

/** Progress arc drawn on the hub button's circumference.
 *
 *  Absolutely positioned, and rendered only while a transfer is in flight: the idle hub is left
 *  exactly as it was, and — the rule the whole cluster follows — nothing here can change the
 *  cluster's natural size and set the auto-fit rescaling the dial mid-read.
 *
 *  The box is -inset-1 (88px around the 80px button) and the viewBox matches it 1:1, so every number
 *  below is in real pixels: the 3px band sits in the gap between the button's own border (r=40) and
 *  the decorative hairline bezel (r≈44). Rotated -90° so 0% starts at 12 o'clock and fills clockwise.
 *  Last child of the wrapper so it paints over the button's outer ring rather than under it.
 *
 *  `stroke-current` + a currentColor drop-shadow means the caller passes a single text-* class and
 *  gets the arc, its glow and the percentage in one color. */
function HubProgressRing({ percent, colorClass, pulse }: { percent: number; colorClass: string; pulse: boolean }) {
  const R = 42;
  const CIRCUMFERENCE = 2 * Math.PI * R;
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 88 88" className="absolute -inset-1 w-[88px] h-[88px] -rotate-90 pointer-events-none" aria-hidden="true">
      {/* Track. Pulses only while erasing — that stage reports no percentage, so the arc alone would
          look like a stalled transfer for the whole erase. */}
      <circle cx="44" cy="44" r={R} fill="none" strokeWidth="3" className={`stroke-slate-800 ${pulse ? 'animate-pulse' : ''}`} />
      {/* Deliberately NOT transitioned. A `transition` on stroke-dashoffset freezes the *rendered*
          value at whatever it was when the first transition started — the inline style keeps
          updating, the computed style never does, and the arc sits at ~4% for the whole read.
          Measured in the browser: with the transition the computed offset never leaves its initial
          value; without it, it tracks exactly. The link already throttles progress to ~10 Hz, so
          stepping straight to each value is smooth on its own. */}
      <circle
        cx="44" cy="44" r={R} fill="none" strokeWidth="3" strokeLinecap="round"
        className={`${colorClass} stroke-current`}
        style={{
          strokeDasharray: CIRCUMFERENCE,
          strokeDashoffset: CIRCUMFERENCE * (1 - clamped / 100),
          filter: 'drop-shadow(0 0 3px currentColor)',
        }}
      />
    </svg>
  );
}

export default function Home() {
  const binaryFileState = useBinaryFile();
  const logFileState = useLogFile();
  const veCalc = useVeCalculation();
  const sessionDb = useSessionDb();
  const fieldVisibility = useFieldVisibility();
  const dmeLink = useDmeLink();
  const comparison = useComparison(veCalc.newMap, binaryFileState.initialMapData, sessionDb.sessions);

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

  const liveSamplesRef = useRef<LogDataPoint[]>([]);
  const lastFlushRef = useRef<number>(0);
  /** Crash-recovery persistence for the run in progress — see lib/db/liveRunRepository.
   *
   *  `liveSamplesRef` is memory only, so until this existed any reload during a run took the whole
   *  drive with it. Samples accumulate in `persistQueueRef` and are appended to IndexedDB every
   *  PERSIST_INTERVAL_MS as a new chunk, so the write cost per flush does not grow with the run. */
  const liveRunIdRef = useRef<string | null>(null);
  const persistQueueRef = useRef<LogDataPoint[]>([]);
  const persistSeqRef = useRef<number>(0);
  const persistAtRef = useRef<number>(0);
  /** True while an append is in flight, so a slow write cannot have a second one stacked on top of
   *  it — the queue simply keeps filling and the next tick takes everything at once. */
  const persistBusyRef = useRef(false);
  /** Live sample-rate readout. Refs, not state, on purpose: setLiveSample below already re-renders on
   *  every sample, so a ref read during render is always current — the same trick the SAMP cell uses
   *  — and adding state here would double the per-sample render cost for a value that changes at 4 Hz.
   *
   *  Two smoothings, both needed. The window averages out a single retried DS2 exchange, which would
   *  otherwise read as a momentary 0.5 Hz; the publish gate stops the digits churning every sample.
   *  Both are clocked off `sample.time` rather than Date.now(), so they stay honest if the tab is
   *  backgrounded and the poll loop keeps running. */
  const hzWindowRef = useRef<number[]>([]);
  const hzValueRef = useRef<number | null>(null);
  const hzPublishedAtRef = useRef<number>(0);
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
  // Latest raw live-telemetry sample, shown as a live readout during tuning (independent of the VE
  // filters, so the user can confirm data is streaming even when the engine is off / idle-filtered).
  const [liveSample, setLiveSample] = useState<LogDataPoint | null>(null);
  const [adaptDialogOpen, setAdaptDialogOpen] = useState(false);
  const [flashDialogOpen, setFlashDialogOpen] = useState(false);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);
  // アクセス時の免責事項ダイアログ。表示可否と「今後表示しない」の永続化はフックが持つ。
  const disclaimer = useDisclaimer();

  const {
    binaryFile, currentMap, binaryBuffer, patchStatus,
    applyPatch, setApplyPatch, applyWotDisable, setApplyWotDisable,
    writeWarmup, setWriteWarmup, writeWot, setWriteWot,
  } = binaryFileState;

  const {
    logFile, processedLog, filterConfig, interpolationTable,
    logWindowStart, setLogWindowStart, maxWindowStart, panWindow,
    selectedLogIndex, setSelectedLogIndex, windowedLogData, LOG_WINDOW_SIZE,
  } = logFileState;

  /** The selection is stored against the WHOLE log; both log views index their own window. Converting
   *  in one place is what lets a selection survive a scrub instead of being reset by it — outside the
   *  window the relative index simply misses, which both views already render as "nothing selected"
   *  without needing an extra branch. */
  const windowRelativeSelection = selectedLogIndex === null ? null : selectedLogIndex - logWindowStart;
  const selectAbsoluteFromWindow = useCallback(
    (windowIndex: number) => setSelectedLogIndex(logWindowStart + windowIndex),
    [logWindowStart, setSelectedLogIndex],
  );

  const { newMap, mapData, hitMap, correctionMap, weightMap, warmupMap, wotMap } = veCalc;
  const { diffSubject, setDiffSubject, diffReference, setDiffReference, diffMapForVisualization } = comparison;

  // Runs the VE calculation and refreshes the comparison defaults. Does NOT change the active tab —
  // tab navigation is decided by the caller, so re-running the calc (e.g. on a filter tweak) leaves
  // the user where they are.
  const runCalculation = (map: NonNullable<typeof currentMap>, data: any[]) => {
    veCalc.runCalculation(map, data);
    comparison.applyDefaultsAfterCalculation();
  };

  // Wipes everything derived from the previously-loaded binary. Mandatory on every path that swaps
  // the BASE: newMap is otherwise only reset by handleClearLog, so a stale tune from the last
  // session would be grafted onto the new binary by buildPatchedBuffer.
  const resetDerived = () => {
    binaryFileState.clear();
    veCalc.reset();
    logFileState.clear();
    liveSamplesRef.current = [];
    // The workspace this move was armed for is going away, so the move has to go with it — otherwise
    // it fires later against whatever gets loaded next.
    pendingTabRef.current = null;
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
    goToTab('current');
  };

  const handleLogUpload = async (file: File) => {
    const processed = await logFileState.parseAndSetLog(file);
    if (processed && currentMap) {
      runCalculation(currentMap, processed.data);
      goToTab('diff'); // jump to the result only on the initial CSV load
    }
  };

  const handleConfigChange = (newConfig: LogFilterConfig) => {
    const processed = logFileState.reprocess(newConfig);
    if (processed && currentMap) {
      runCalculation(currentMap, processed.data); // stay on the current tab
    }
  };

  const handleTableChange = (newTable: InterpolationPoint[]) => {
    const processed = logFileState.reprocessWithTable(newTable);
    if (processed && currentMap && processed.validCount > 0) {
      runCalculation(currentMap, processed.data); // stay on the current tab
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

  const handleDownloadBin = () => {
    binaryFileState.downloadBin(newMap);
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
      { applyPatch: false, applyWotDisable: false, writeWarmup: false, writeWot: false },
    );
    if (!map) return;
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

  // Each tab states the data it needs, rather than a chain of exclusions. CURRENT MAP used to be
  // exempted from every check and so was clickable with nothing loaded, landing on the empty
  // "AWAITING BINARY FILE" placeholder.
  const TABS: { id: TabId; label: string; enabled: boolean }[] = [
    { id: 'startup', label: 'STARTUP', enabled: true },
    { id: 'current', label: 'CURRENT MAP', enabled: !!currentMap },
    { id: 'lambda', label: 'LAMBDA FEEDBACK', enabled: !!correctionMap && !!newMap },
    { id: 'new', label: 'TUNED MAP', enabled: !!newMap },
    { id: 'diff', label: 'DIFFERENCE %', enabled: !!currentMap },
    { id: 'log', label: 'CORRECTED ROG', enabled: !!processedLog },
    { id: 'warmup', label: 'WARMUP (DERIVED / EXP.)', enabled: !!warmupMap },
    { id: 'wot', label: 'WOT (DERIVED / EXP.)', enabled: !!wotMap },
  ];

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
  }, [currentMap, newMap, correctionMap, processedLog, warmupMap, wotMap]);

  // Clearing the log or swapping the BASE can disable the tab you're standing on; without this you'd
  // be stranded on a placeholder with its own tab greyed out.
  //
  // Deliberately the one place that still calls setActiveTab raw. A forced bounce is not the user
  // navigating, so it must NOT disarm a pending move — goToTab would, and a run whose result is still
  // being derived would lose its landing.
  useEffect(() => {
    if (!TABS.find(t => t.id === activeTab)?.enabled) setActiveTab('startup');
  }, [currentMap, newMap, correctionMap, processedLog, warmupMap, wotMap, activeTab]);

  const buildSettings = (): TuneSettings => ({
    filterConfig, interpolationTable, applyPatch, applyWotDisable, writeWarmup, writeWot,
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
    if (!session.baseOrigin) { setActiveSessionId(session.id); goToTab('startup'); return; }
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert(dialogText().noStoredBinary); return; }

    resetDerived();
    setActiveSessionId(session.id);

    if (session.status === 'draft') {
      // Continue where it left off: the BASE is the working map.
      const map = await binaryFileState.loadFromBuffer(bins.baseBinaryBuffer, session.baseFileName ?? 'base.bin');
      if (!map) return;
      goToTab('current');
      return;
    }

    // Archived: rebuild the tune FROM THE BASE. Re-running the log against the stored tuned map
    // (what the old code did) would apply the same correction a second time — V0*C^2.
    const map = await binaryFileState.loadFromBuffer(
      bins.baseBinaryBuffer,
      session.baseFileName ?? 'base.bin',
      session.tuneSettings && {
        applyPatch: session.tuneSettings.applyPatch,
        applyWotDisable: session.tuneSettings.applyWotDisable,
        writeWarmup: session.tuneSettings.writeWarmup,
        writeWot: session.tuneSettings.writeWot,
      },
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
        );
        if (processed) {
          veCalc.runCalculation(map, processed.data);
          comparison.applyDefaultsAfterCalculation();
          rebuilt = true;
        }
      }
    }

    // WRITE only appears because the rebuild produced a tune; buildPatchedBuffer(null) does not
    // no-op — it returns the BASE — so an unreconstructed session must not offer it.
    if (!rebuilt) alert(dialogText().notReconstructed);
    goToTab('current');
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
   */
  const recoveryOfferedRef = useRef(false);
  useEffect(() => {
    if (disclaimer.open || sessionDb.loading || recoveryOfferedRef.current) return;
    recoveryOfferedRef.current = true;
    void (async () => {
      const run = await findRecoverableRun().catch(() => null);
      if (!run) return;
      const accept = confirm(dialogText().recoverRun({
        points: run.pointCount, startedAt: run.startedAt, ended: run.endedAt !== undefined, mock: run.mock,
      }));
      if (!accept) { await discardLiveRun(run.runId).catch(() => { }); return; }
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
    const map = await binaryFileState.loadFromBuffer(bins.baseBinaryBuffer, session.baseFileName ?? 'base.bin');
    if (!map) return;

    liveSamplesRef.current = points;
    const processed = logFileState.loadRawLog(points, 'recovered-log.csv');
    if (processed) {
      runCalculation(map, processed.data);
      goToTab('new');
    } else {
      goToTab('current');
    }
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
    goToTab('current');
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
    if (!newMap) return;
    const target = await ensureDraft();
    if (!target || !binaryBuffer) return;
    if (!target.baseOrigin) { alert(dialogText().setBaseFirst); return; }
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap);
    if (!patchedBuffer) return;

    await sessionDb.saveSessionTune({
      sessionId: target.id,
      binaryFileName: binaryFileState.buildFileName(newMap),
      tunedBinaryBuffer: patchedBuffer,
      veMapSnapshot: newMap,
      tuneSettings: buildSettings(),
      log: logFileState.rawLogData,
    });

    // The samples are in the session store now, so the recovery copy has done its job. This is the
    // ONLY success path that clears it: everything before this point — including a run that has
    // stopped and is being read on screen — still has the drive in memory alone.
    void discardLiveRun().catch(() => { /* a stale record only costs one declined offer */ });
    liveRunIdRef.current = null;

    // saveTune archives the session — the record now describes a specific set of bytes. But the
    // workspace does not know that: newMap is still loaded, so idleAction stays 'write' and the hub
    // keeps offering WRITE against a session the DB considers closed. That is the "button says the
    // wrong thing" class idleAction was written to eliminate, arriving through the one door it did
    // not cover, and it is the state the user described as frightening.
    //
    // Ask rather than decide, at the one moment the answer is known — the same idiom handleDmeWrite
    // already uses for the re-tune question. Keeping it loaded is a legitimate answer: save-then-flash
    // is a real sequence, and forcing a reopen would tax it for no safety gain while the user is
    // standing right there.
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
    const buffer = await dmeLink.read();
    if (!buffer) return;
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
   * Writes whatever has queued up since the last append to the crash-recovery store.
   *
   * Best effort in the strongest sense: this must never throw into the poll loop, never block a
   * sample, and never fail a run. A drive that is being recorded is worth more than the safety net,
   * so if the net cannot be written the run carries on without it. On failure the batch is put back
   * at the front of the queue and retried on the next tick, so a transient error costs nothing.
   */
  const persistLiveSamples = async (force: boolean) => {
    const runId = liveRunIdRef.current;
    if (!runId || persistBusyRef.current) return;
    const now = Date.now();
    if (!force && now - persistAtRef.current < PERSIST_INTERVAL_MS) return;
    if (persistQueueRef.current.length === 0) return;

    const batch = persistQueueRef.current;
    persistQueueRef.current = [];
    persistAtRef.current = now;
    persistBusyRef.current = true;
    try {
      await appendLiveChunk(runId, persistSeqRef.current++, batch);
    } catch {
      // Re-queue ahead of anything that arrived meanwhile, so capture order survives the retry.
      persistQueueRef.current = [...batch, ...persistQueueRef.current];
      persistSeqRef.current--;
    } finally {
      persistBusyRef.current = false;
    }
  };

  /** Returns whether this call actually derived anything, so the end-of-run tab move can be armed only
   *  when there is a result to move to. The throttled early return reports null, which matters solely
   *  to force=true callers — and finishLog is the only one. */
  const flushLiveSamples = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastFlushRef.current < 500) return null;
    lastFlushRef.current = now;
    const processed = logFileState.loadRawLog([...liveSamplesRef.current], 'live-session.csv');
    if (processed && currentMap) {
      veCalc.runCalculation(currentMap, processed.data);
      return processed;
    }
    return null;
  };

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
    const flushed = flushLiveSamples(true);

    // Flush the tail into the recovery store and mark the run stopped — but do NOT discard it. The
    // samples are still only in memory until SAVE, so a stopped-and-unsaved run is exactly as
    // fragile as a running one, and this is the window in which the user reads the result and
    // decides. Awaited so the tail is durable before the blocking alert below.
    await persistLiveSamples(true);
    if (liveRunIdRef.current) {
      try { await endLiveRun(liveRunIdRef.current); } catch { /* the samples are already stored */ }
    }

    // Land on the tune this run produced — and only if it produced one. A run that captured nothing
    // must arm nothing, or the move would sit waiting and later hijack an unrelated navigation.
    // Armed before the disconnect/alert below on purpose: alert blocks, so React commits the move
    // behind the dialog and dismissing it reveals TUNED MAP already open.
    pendingTabRef.current = flushed ? 'new' : null;

    // Logging runs with the engine going; writing needs it stopped, and stopping it ends the DME's
    // diagnostic session. So this connection physically cannot survive into the write — keeping it
    // on screen would just mean WRITE times out after the key cycle. Drop it and say what to do.
    await dmeLink.disconnect();
    alert(dialogText().logFinished(failure));
  };

  /** startTuning captures onEnd once, when START TUNE is pressed, so it must not close over a stale
   *  finishLog — the final flush has to use the CURRENT map and filters, not the ones frozen at the
   *  start of the run. Routing through a ref refreshed each render avoids re-creating the callback
   *  (adding deps to startTuning would restart the poll loop on every render — far worse on a live
   *  cable). */
  const finishLogRef = useRef(finishLog);
  finishLogRef.current = finishLog;

  const handleStartTune = () => {
    liveSamplesRef.current = [];
    lastFlushRef.current = 0;
    finishedRef.current = false;
    // Open the recovery record. Not awaited: the poll loop starts below and the first samples must
    // not wait on IndexedDB. They queue up regardless — persistLiveSamples no-ops until the id
    // lands, and nothing is dropped because the queue is what it reads from.
    liveRunIdRef.current = null;
    persistQueueRef.current = [];
    persistSeqRef.current = 0;
    persistAtRef.current = Date.now();
    persistBusyRef.current = false;
    if (currentSession) {
      void beginLiveRun({ sessionId: currentSession.id, mock: dmeLink.mockMode })
        .then(id => { liveRunIdRef.current = id; })
        .catch(() => { /* no net; the run itself is unaffected */ });
    }
    hzWindowRef.current = [];
    hzValueRef.current = null;
    hzPublishedAtRef.current = 0;
    // LAMBDA FEEDBACK is where a run is actually read — it is the trim the log is being captured to
    // measure. It is disabled at this instant (no correctionMap, no newMap), which is exactly what
    // arming is for; the first sample's unthrottled flush releases it.
    pendingTabRef.current = 'lambda';
    setLiveSample(null);
    dmeLink.startTuning(
      (sample) => {
        const point: LogDataPoint = {
          time: sample.time,
          rpm: sample.rpm,
          rawLoad: sample.rawLoad,
          stft1: sample.stft1,
          stft2: sample.stft2,
          lambda1: sample.stft1,
          lambda2: sample.stft2,
          coolantTemp: sample.coolantTemp,
        };
        liveSamplesRef.current.push(point);
        persistQueueRef.current.push(point);

        // Trailing window of sample times. There is no poll interval to read — the loop in
        // startTuning awaits pollLiveMeasurement back to back, so the rate IS the DS2 round trip and
        // the only way to know it is to measure it.
        const w = hzWindowRef.current;
        w.push(point.time);
        if (w.length > HZ_WINDOW_SAMPLES) w.splice(0, w.length - HZ_WINDOW_SAMPLES);
        if (point.time - hzPublishedAtRef.current >= HZ_PUBLISH_INTERVAL_S) {
          const hz = sampleRateHzFromTimes(w);
          // Leave the last good value standing on a degenerate window rather than blanking the cell
          // mid-run: the rate did not become unknown, we just could not measure it this tick.
          if (hz !== undefined) hzValueRef.current = hz;
          hzPublishedAtRef.current = point.time;
        }

        setLiveSample(point); // live raw readout, independent of the VE filters
        flushLiveSamples(false);
        void persistLiveSamples(false); // own throttle, far slower than the 500 ms UI flush
      },
      (failure) => { void finishLogRef.current(failure); },
    );
  };

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
    cmp('WRITE WARMUP', s.writeWarmup, writeWarmup);
    cmp('WRITE WOT', s.writeWot, writeWot);
    return rows;
  };

  const handleDmeWrite = async () => {
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap);
    if (!patchedBuffer) return;
    // Pin the settings that produced these exact bytes. Reading the toggles again after the write
    // would record whatever they say ~4 minutes later, which is not necessarily what went to the ECU.
    const flashedSettings = buildSettings();

    const drift = settingsDrift();
    // Gate: single safety confirmation before flashing the ECU. The DME itself also rejects the
    // write (0xA2) unless the engine is stopped (RPM/speed = 0), but we warn explicitly.
    const confirmed = confirm(dialogText().writeConfirm({
      tuned: Boolean(newMap),
      patchOn: applyPatch || applyWotDisable,
      drift,
      // Android gets extra lines because the guarantees are weaker there: beforeunload is honored
      // inconsistently, so the "you will be asked to confirm" sentence above cannot be relied on,
      // and the screen or an app switch can take the connection down mid-write.
      android: isAndroidPlatform(),
    }));
    if (!confirmed) return;

    const ok = await dmeLink.write(patchedBuffer);
    if (ok) {
      const target = currentSession ?? (await ensureDraft());
      // One flash, so one hash and one timestamp, taken here and used by whichever branch runs below.
      const sha256 = await sha256Hex(patchedBuffer);   // the bytes actually sent, not the stored ones
      const flashedAt = Date.now();

      // The key-off power-cycle ends the DME's diagnostic session, so the serial connection goes
      // stale either way. Both branches below say so and then disconnect; they differ in what the
      // session becomes and where you go next. The key-cycle steps themselves live in dialog-text,
      // quoted into both messages there, so the two cannot drift apart or out of language.
      if (!newMap) {
        // Patch-only flash. Deliberately NOT saveSessionTune and NOT archive:
        //  - saveSessionTune would record a TUNED whose map is just the BASE's, which is precisely
        //    the "BASE dressed as a TUNED" that handleSaveSession's doc describes removing.
        //  - archive would end the session before it has tuned anything — !isArchived is what makes
        //    the hub offer START TUNE, so archiving here would strand the whole point of the step.
        // Only the flash history grows, which is exactly what happened: bytes went to the ECU.
        if (target) await sessionDb.recordFlash(target.id, { at: flashedAt, sha256, settings: flashedSettings, tuned: false });

        alert(dialogText().patchWriteDone);
        await dmeLink.disconnect();

        // The ECU now holds these bytes, so the workspace has to as well — otherwise patchStatus
        // still describes the pre-patch BASE, the drift never clears, and the hub would keep
        // offering the same write forever. Toggles are passed through rather than re-detected so
        // the reload cannot bounce them.
        await binaryFileState.loadFromBuffer(
          patchedBuffer,
          binaryFileState.buildFileName(null),
          { applyPatch, applyWotDisable, writeWarmup, writeWot },
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
            binaryFileName: binaryFileState.buildFileName(newMap),
            tunedBinaryBuffer: patchedBuffer,
            veMapSnapshot: newMap,
            tuneSettings: flashedSettings,
            log: logFileState.rawLogData,
          });
        }
        await sessionDb.recordFlash(target.id, { at: flashedAt, sha256, settings: flashedSettings, tuned: true });
        // These bytes are now in the ECU, so this session is a record of what was flashed, not a
        // workspace: archive it. Leaving it a draft let you keep tuning it afterwards, which would
        // drift its TUNED away from the bytes its own flash history points at — and the list would
        // show DRAFT and "flashed" at the same time. Continue via "Use as base -> TUNED".
        await sessionDb.archive(target.id);
      }

      // Post-write instruction: the DME must be power-cycled to reinitialize with the new data.
      alert(dialogText().writeDone);

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
      alert(dialogText().writeFailed(dmeLink.error, { wasBackgrounded: wasBackgrounded() }));
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
    const vin = dmeLink.identity?.vin;
    // `mock` is recorded, not inferred later: both modes share this store, and a PRACTICE backup must
    // never be a restore candidate for a real ECU. Recovering the origin afterwards would mean
    // guessing from the VIN string, which is exactly the kind of guess this field removes.
    await saveServiceBackup({ at, vin, mock: dmeLink.mockMode, buffer: pair.slice(0) });
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

  /** Offers the last read's per-chunk timing as a file, same explicit-export rule as the service
   *  blocks. The notice line only has room for medians; the sampled inter-arrival gaps are the part
   *  that distinguishes per-byte USB packets from batched ones, and those need a file. */
  const handleSaveReadTiming = () => {
    const report = dmeLink.lastReadTiming;
    if (!report) return;
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
    const name = `ReadTiming_${rate}_${outcome}_${Date.now()}.json`;
    downloadBlob(JSON.stringify(report, null, 2), name, MIME_JSON);
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
    setFlashDialogOpen(false);
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
    liveSamplesRef.current = [];
    // Throwing the run away is a decision, so the recovery copy goes too — otherwise the next load
    // would offer back the very drive the user just chose to redo.
    void discardLiveRun().catch(() => { });
    liveRunIdRef.current = null;
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
  const patchDrift = !!patchStatus && (bytesPatched !== applyPatch || bytesWotDisabled !== applyWotDisable);

  /** A draft is a workspace, so drift in either direction there is you arming something. An archived
   *  session is a record, and the only legitimate reason to send it to the ECU again is finalising —
   *  taking the patches off. Without this, reopening an archived session whose log could not be
   *  replayed would raise drift by accident (its stored settings say PATCH ON, its BASE bytes are
   *  unpatched) and the hub would offer a patch write in place of READ, which is the one thing that
   *  state actually needs. */
  const patchWriteAllowed = !isArchived || (!applyPatch && !applyWotDisable);

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
      : (patchDrift && patchWriteAllowed && currentMap && currentSession) ? 'writePatch'
        : (currentMap && currentSession && !isArchived) ? 'tune'
          : 'read';

  // Names the bytes by what they will carry once written, not by what is in the ECU now — the label
  // is a promise about the file being sent, the same rule DOWNLOAD PATCH-ON follows.
  const writePatchLabel = (applyPatch || applyWotDisable) ? 'WRITE PATCH-ON' : 'WRITE PATCH-OFF';

  const dmeButtonConfig = (() => {
    switch (dmeLink.state) {
      case 'disconnected': return { label: 'CONNECTION', Icon: PlugZap, onClick: handleDmeConnect, disabled: false, spin: false };
      case 'connecting': return { label: 'CONNECTING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      case 'reading': return { label: 'READING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      case 'tuning': return { label: 'STOP', Icon: Square, onClick: handleStopTune, disabled: false, spin: false };
      case 'writing': return { label: 'WRITING', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      // The reset dialog owns the screen while this runs; the hub is disabled rather than hidden so
      // it's visible that the link is busy and START TUNE cannot be raced against the DS2 traffic.
      case 'resetting': return { label: 'RESET', Icon: Loader2, onClick: () => { }, disabled: true, spin: true };
      case 'connected':
        switch (idleAction) {
          case 'write': return { label: 'WRITE', Icon: Zap, onClick: handleDmeWrite, disabled: false, spin: false };
          case 'writePatch': return { label: writePatchLabel, Icon: Zap, onClick: handleDmeWrite, disabled: false, spin: false };
          // Tuning is a draft-only act: an archived session must never re-derive its own map.
          case 'tune': return { label: 'START TUNE', Icon: Play, onClick: handleStartTune, disabled: false, spin: false };
          case 'read': return { label: 'READ', Icon: Zap, onClick: handleDmeRead, disabled: false, spin: false };
        }
    }
  })();

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
  const flashColor = flashRegions.some(r => r.state !== 'available') ? 'text-red-400'
    : flashRegions.some(r => r.remaining < LOW_SLOT_WARNING_THRESHOLD) ? 'text-amber-400'
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
  const derivedTablesLocked = !newMap;
  const derivedTablesLockReason = 'Needs a tune first — these tables are derived from the tuned map. Record a log (START TUNE) or load one, then they unlock.';

  return (
    // 100dvh, not h-screen. This page deliberately never scrolls — everything is sized to fit the
    // viewport — and on Android `100vh` resolves to the LARGEST viewport, the one with the browser
    // chrome retracted. With no scrolling to recover it, the bottom of the layout (the action row
    // that carries WRITE) sits under the URL bar and cannot be reached. `dvh` tracks the viewport
    // that is actually visible.
    <main className="h-[100dvh] flex flex-col bg-slate-950 font-sans text-slate-300 overflow-hidden selection:bg-blue-500/30">
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
          {/* The dot is the identity's entry point, not just an LED. `p-4 -m-4` grows the hit box to
              40px without moving anything: the padding is cancelled by the margin, so the dot still
              occupies its 8px in the row. It needed a real target anyway — an 8px control is
              unhittable on a phone — and it needed a destination, because the readouts beside it are
              hidden below 900px and had nowhere else to be reached from. */}
          <button
            type="button"
            onClick={() => setIdentityDialogOpen(true)}
            title={`DME: ${dmeLink.state}${dmeLink.error ? ' — ' + dmeLink.error : ''}\n\nClick for VIN / AIF / SW.`}
            className="shrink-0 p-4 -m-4 cursor-pointer"
          >
            <span className={`block w-2 h-2 rounded-full ${dmeStatusColor}`} />
          </button>
          <h1 className="min-w-0 text-sm font-bold tracking-widest text-slate-200 uppercase whitespace-nowrap overflow-hidden text-ellipsis">
            {/* The ///M mark, not punctuation — icon.svg has carried the tricolor in the browser tab
                all along while this rendered slate-600. It is also the one place red can live
                permanently without costing it any alarm value: a wordmark states no machine state,
                so it does not compete with the error LED two elements to the left.
                The middle stripe is the legible violet, not the logo navy #2B115A — at 1.33:1 on
                black that glyph would read as missing rather than dark. */}
            MSS54HP CSL CONVERT{' '}
            <span className="tracking-tight" aria-hidden="true">
              <span className="text-blue-500">/</span>
              <span className="text-indigo-400">/</span>
              <span className="text-red-500">/</span>
            </span>{' '}
            TUNER
          </h1>
          <span className="shrink-0 text-[9px] font-mono text-slate-500 whitespace-nowrap">V2 β</span>
          {/* VIN/AIF/SW are readouts and may clip; FLASH is a control and may not — it is the only
              entry to the flash-counter dialog, so clipping it removes a feature rather than a
              label. This strip is overflow-hidden, so what clips is whatever sits at its END:
              FLASH therefore goes FIRST and the three readouts trail it.

              It used to go last, with a comment claiming that was "on purpose" and a second comment
              a few lines up asserting the opposite — that FLASH was the one thing that would not
              clip. Both could not be true, and the one that held was the geometry: on a narrow
              window FLASH was the first thing to disappear, which is the outcome the ordering was
              supposed to prevent.

              Below 900px the three readouts are hidden outright rather than squeezed. They are
              reachable the whole time from the status dot, which now opens DmeIdentityDialog — the
              earlier claim that they were "still on the status dot's tooltip" was false; that title
              carries link state and error and has never carried identity. */}
          <div className="flex-1 min-w-0 flex items-center gap-4 text-[9px] font-mono text-slate-500 whitespace-nowrap overflow-hidden ml-2 min-[900px]:ml-8 pl-2 min-[900px]:pl-8 border-l border-slate-800">
            {/* The only one of the four that is a control: clicking it opens the reset dialog. The
                reset has no button of its own anywhere else — it belongs on the number it changes,
                and the hub's sub-action row is for actions on the workspace and the current run.
                Disabled rather than hidden while disconnected, so the field never moves.

                `shrink-0` so the readouts after it absorb the shortfall instead of this button. */}
            <button
              type="button"
              title={flashTitle}
              disabled={dmeLink.state !== 'connected'}
              onClick={() => setFlashDialogOpen(true)}
              className="shrink-0 whitespace-nowrap enabled:cursor-pointer enabled:hover:text-slate-300 disabled:cursor-default transition-colors"
            >
              FLASH <span className={flashColor}>{flashText}</span>
            </button>
            <span className="hidden min-[900px]:inline">VIN <span className="text-slate-300">{dmeLink.identity?.vin ?? '-'}</span></span>
            <span className="hidden min-[900px]:inline">AIF <span className="text-slate-300">{dmeLink.identity?.aif ?? '-'}</span></span>
            <span className="hidden min-[900px]:inline">SW <span className="text-slate-300">{dmeLink.identity?.softwareVersion ?? '-'}</span></span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* GitHub Link */}
          <a
            href="https://github.com/mushitaro/mss54hp-csl-convert-tuner"
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-500 hover:text-slate-300 transition-colors"
            title="View on GitHub"
          >
            <Github className="w-5 h-5" />
          </a>

          {/* Forum Link */}
          <a
            href="https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability"
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-500 hover:text-amber-400 transition-colors flex items-center gap-2 group"
            title="Methodology Source: NA M3 Forum"
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-[10px] uppercase font-bold tracking-wider whitespace-nowrap">Tuning Source</span>
          </a>
        </div>
      </header>

      <div className="flex flex-1 flex-col min-[900px]:flex-row overflow-hidden">

        {/* === LEFT COLUMN (70% desktop / 40% stacked) === */}
        <div className="h-[38.2%] min-[900px]:h-full min-[900px]:w-[61.8%] flex flex-col border-b min-[900px]:border-b-0 border-r-0 min-[900px]:border-r border-slate-900 relative bg-slate-950/40 min-h-0">

          {/* Header Frame (Tabs) - Matches Right Column Header Height */}
          {/* z-30, not z-50. The row has to outrank the right pane (z-20) so the config popovers
              anchored in it can hang over the map below — but it was sharing z-50 with the modal
              panels, which put it ABOVE every dialog's backdrop (z-40) and left the tab bar sitting
              crisp on top of a blurred page. Modals now live in their own tier (z-100/110), and the
              layers here read: 10 chrome / 20 panes / 30 this row / 40 popover scrims / 50 popovers. */}
          <div className="h-[44px] flex items-center px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none z-30">
            <div
              ref={tabStrip.ref}
              style={tabStrip.style}
              className="no-scrollbar flex space-x-6 h-full mr-auto flex-1 min-w-0 overflow-x-auto overflow-y-hidden"
            >
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => goToTab(tab.id)}
                  disabled={!tab.enabled}
                  className={`relative h-full flex items-center shrink-0 whitespace-nowrap text-[10px] font-bold tracking-widest transition-all ${activeTab === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-slate-500 hover:text-slate-300 border-b-2 border-transparent disabled:opacity-20'
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Log Stats & Filter */}
            <div className="h-full flex items-center border-l border-slate-800 pl-4 ml-4 gap-4">
              {processedLog && (
                <div className="flex flex-col items-end justify-center h-full">
                  <div className="flex items-center gap-2 text-[9px] font-mono leading-none mb-1">
                    <span className="text-slate-500">VALID</span>
                    <span className="text-blue-400 font-bold">{processedLog.validCount.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] font-mono leading-none">
                    <span className="text-slate-600">TOTAL</span>
                    <span className="text-slate-500">{(processedLog.validCount + processedLog.droppedCount).toLocaleString()}</span>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <InterpolationTableEditor
                  config={interpolationTable}
                  onSave={handleTableChange}
                  enabled={filterConfig.enableCorrection}
                  onToggle={(enabled) => handleConfigChange({ ...filterConfig, enableCorrection: enabled })}
                  readOnly={isArchived}
                />
                <FilterConfigPanel config={filterConfig} onConfigChange={handleConfigChange} readOnly={isArchived} />
                <FieldVisibilityPanel
                  visibleFields={fieldVisibility.visibleFields}
                  onToggle={fieldVisibility.toggleField}
                  onShowCoreOnly={fieldVisibility.showCoreOnly}
                  onShowAll={fieldVisibility.showAll}
                />
              </div>
            </div>
          </div>

          {/* Session bar. A tune only means something relative to what it started from, so which
              session is open and where its BASE came from stay on screen the whole time you are
              looking at maps — otherwise you'd have to go back to STARTUP to find out. */}
          {currentSession && activeTab !== 'startup' && (
            <div className="h-[26px] flex-none flex items-center gap-3 px-4 border-b border-slate-900 bg-slate-950/60 text-[10px] min-w-0">
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
                  <DropZone label="" accept=".csv" onFileSelect={handleLogUpload} className="!absolute !inset-0 !opacity-0 !border-0 cursor-pointer" />
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
                {newMap && !isArchived && dmeLink.state !== 'tuning' && (
                  <button onClick={handleSaveSession} className="group inline-flex items-center gap-1.5" title="Save this tune to the session — no cable needed">
                    <Database className="w-3 h-3 text-slate-600 group-hover:text-amber-400 transition-colors" />
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-amber-400 transition-colors">Save</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Grid Container */}
          <div className="flex-1 overflow-auto relative">
            {/* Content */}
            <div className="absolute inset-0 pt-2 pb-2 px-4">
              {(activeTab === 'current' && currentMap) && <MapEditor mapData={currentMap} />}
              {(activeTab === 'new' && newMap) && (
                <MapEditor
                  mapData={newMap}
                  hitData={hitMap || undefined}
                  weightData={weightMap || undefined}
                />
              )}
              {(activeTab === 'diff' && mapData) && ( // Changed from diffMap
                <div className="h-full w-full flex flex-col">
                  {/* Diff Section Header with Selectors */}
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border-b border-slate-800">
                    <span className="text-xs font-bold text-slate-400 mr-2">COMPARE</span>

                    <div className="flex items-center gap-2 flex-1">
                      {/* Subject Selector */}
                      <div className="flex items-center gap-1 bg-slate-800 rounded px-2 py-0.5">
                        <span className="text-[9px] text-slate-500 uppercase">Subject</span>
                        <select
                          value={diffSubject}
                          onChange={(e) => setDiffSubject(e.target.value as any)}
                          className="bg-transparent text-[10px] font-bold text-white outline-none cursor-pointer"
                        >
                          <option value="tuned" disabled={!newMap} className="bg-slate-900 text-slate-300">TUNED</option>
                          <option value="current" className="bg-slate-900 text-slate-300">CURRENT</option>
                          <option value="stock" className="bg-slate-900 text-slate-300">CSL STOCK</option>
                          {sessionDb.sessions.map(s => (
                            <option key={s.id} value={`db:${s.id}`} className="bg-slate-900 text-slate-300">{s.label}</option>
                          ))}
                        </select>
                      </div>

                      <span className="text-xs text-slate-600 font-bold">vs</span>

                      {/* Reference Selector */}
                      <div className="flex items-center gap-1 bg-slate-800 rounded px-2 py-0.5">
                        <span className="text-[9px] text-slate-500 uppercase">Reference</span>
                        <select
                          value={diffReference}
                          onChange={(e) => setDiffReference(e.target.value as any)}
                          className="bg-transparent text-[10px] font-bold text-indigo-400 outline-none cursor-pointer"
                        >
                          <option value="tuned" disabled={!newMap} className="bg-slate-900 text-slate-300">TUNED</option>
                          <option value="current" className="bg-slate-900 text-slate-300">CURRENT</option>
                          <option value="stock" className="bg-slate-900 text-slate-300">CSL STOCK</option>
                          {sessionDb.sessions.map(s => (
                            <option key={s.id} value={`db:${s.id}`} className="bg-slate-900 text-slate-300">{s.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 overflow-hidden relative">
                    <MapEditor
                      mapData={{ ...(newMap || currentMap!), data: diffMapForVisualization || [] }} // Fallback to currentMap if newMap null
                      diffData={diffMapForVisualization || undefined}
                      hitData={hitMap || undefined}
                      weightData={weightMap || undefined}
                    />
                  </div>
                </div>
              )}
              {(activeTab === 'lambda' && correctionMap && newMap) && (
                <MapEditor
                  mapData={{ ...newMap, data: correctionMap }}
                  hitData={hitMap || undefined}
                  weightData={weightMap || undefined}
                />
              )}

              {(activeTab === 'warmup' && warmupMap) && (
                <MapEditor mapData={warmupMap} />
              )}

              {(activeTab === 'wot' && wotMap) && (
                <MapEditor mapData={wotMap} />
              )}

              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0">
                  <LogDataTable
                    data={windowedLogData}
                    selectedIndex={windowRelativeSelection}
                    onRowClick={selectAbsoluteFromWindow}
                    totalCount={processedLog.data.length}
                    visibleFields={fieldVisibility.visibleFields}
                    presenceData={logFileState.rawLogData ?? undefined}
                  />
                </div>
              )}

              {activeTab === 'startup' && (
                // No file row above the list any more: a floating BIN/CSV input never said which
                // session it fed. Picking a BASE now happens on the draft's own row, and its log and
                // outputs on the session bar once it's open.
                <div className="h-full w-full">
                  <SessionList
                    sessions={sessionDb.sessions}
                    loading={sessionDb.loading}
                    error={sessionDb.error}
                    onOpen={handleOpenSession}
                    onNewSession={handleNewSession}
                    onNewFrom={handleNewFrom}
                    onRename={sessionDb.rename}
                    onDelete={sessionDb.remove}
                    onUploadBase={handleUploadBase}
                    onDownloadBase={handleDownloadSessionBase}
                    onDownloadTuned={handleDownloadSessionTuned}
                    onDownloadLog={handleDownloadSessionLog}
                    onFinalize={handleFinalizeSession}
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
        </div>

        {/* === RIGHT COLUMN (30% desktop / 60% stacked) === */}
        <div className="flex-1 min-h-0 min-[900px]:flex-none min-[900px]:h-full min-[900px]:w-[38.2%] flex flex-col bg-slate-900/20 backdrop-blur-sm relative z-20 overflow-hidden">

          {/* Header Frame - Matches Left Column Height */}
          <div className="h-[44px] flex items-center justify-between px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none">
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
                genuinely short; a laptop still gets the full 140. */}
            <div className="flex-1 min-h-[76px] [@media(min-height:560px)]:min-h-[140px] relative overflow-hidden bg-gradient-to-b from-slate-900/10 to-transparent">
              {/* Live raw telemetry readout — floats over the visualization during logging so it shows
                  the latest DME sample (independent of the VE filters) WITHOUT shifting the inputs /
                  dashboard layout: the panel below is identical whether logging or stopped. */}
              {dmeLink.state === 'tuning' && (
                <div className="absolute top-2 left-2 right-2 z-20 px-2 py-1.5 rounded bg-slate-950/85 border border-slate-800 backdrop-blur-sm grid grid-cols-7 gap-x-2 font-mono pointer-events-none">
                  {([
                    { label: 'RPM', value: liveSample ? liveSample.rpm.toFixed(0) : '—', color: 'text-slate-200' },
                    { label: 'RO %', value: liveSample ? liveSample.rawLoad.toFixed(1) : '—', color: 'text-blue-400' },
                    // Warm end of the M-red ramp, matching LOG_FIELD_REGISTRY.coolantTemp. Not the
                    // amber (now violet) status ramp: violet reads as "armed / busy" everywhere
                    // else in this panel, and coolant temp is a readout, not a machine state.
                    { label: 'TEMP', value: liveSample?.coolantTemp !== undefined ? `${liveSample.coolantTemp.toFixed(0)}°` : '—', color: 'text-red-300' },
                    { label: 'SAMP', value: String(liveSamplesRef.current.length), color: 'text-slate-500' },
                    // Grey, deliberately. A sample rate is a readout, not machine state — violet
                    // means "armed / busy" and the red ramp is coolant temp, so borrowing either
                    // would report a condition this cell does not describe.
                    {
                      label: 'HZ',
                      value: hzValueRef.current === null ? '—'
                        : hzValueRef.current >= 100 ? hzValueRef.current.toFixed(0)
                          : hzValueRef.current.toFixed(1),
                      color: 'text-slate-400',
                    },
                    { label: 'STFT1', value: liveSample ? liveSample.stft1.toFixed(3) : '—', color: 'text-green-400' },
                    { label: 'STFT2', value: liveSample ? liveSample.stft2.toFixed(3) : '—', color: 'text-green-400' },
                  ]).map(cell => (
                    <div key={cell.label} className="flex flex-col leading-none">
                      <span className="text-[8px] text-slate-600 uppercase tracking-wider">{cell.label}</span>
                      <span className={`text-[11px] font-bold ${cell.color}`}>{cell.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {(activeTab === 'current' && currentMap) && <MapVisualizer mapData={currentMap} title="" zAxisLabel="RF %" />}
              {(activeTab === 'new' && newMap) && <MapVisualizer mapData={newMap} title="" zAxisLabel="RF %" />}
              {/* The two signed maps. Their neutral value differs — useComparison emits a percentage
                  difference (no change = 0), the VE calculator emits an STFT multiplier (no change =
                  1.0) — so each states its own midpoint rather than letting the scale guess. */}
              {(activeTab === 'diff' && diffMapForVisualization && (newMap || currentMap)) && (
                <MapVisualizer mapData={{ ...(newMap || currentMap!), data: diffMapForVisualization }} title="" zAxisLabel="Diff %" scale="deviation" deviationMidpoint={0} />
              )}
              {(activeTab === 'lambda' && correctionMap && newMap) && (
                <MapVisualizer mapData={{ ...newMap, data: correctionMap }} title="" zAxisLabel="Lambda" scale="deviation" deviationMidpoint={1} />
              )}
              {(activeTab === 'warmup' && warmupMap) && <MapVisualizer mapData={warmupMap} title="" zAxisLabel="RF %" />}
              {(activeTab === 'wot' && wotMap) && <MapVisualizer mapData={wotMap} title="" zAxisLabel="RF %" />}
              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0 relative">
                  {/* Chart Container - Absolute fill; chart flexes, window-scrub slider docked below it
                      (moved off the tab bar so tab scrolling isn't squeezed by it). */}
                  <div className="absolute inset-0 flex flex-col">
                    <div className="flex-1 min-h-0">
                      <LogTimeSeriesChart
                        data={windowedLogData}
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
            <div className="flex-initial min-h-0 overflow-y-auto px-5 pt-4 pb-5 flex flex-col">

              {/* Minimal File Inputs - No Icons, Just Text, Hover for action */}
              <div className="space-y-1 mb-4">
                {/* DME (LIVE) — connection status + settings; the CONNECTION action itself lives on the main ring below */}
                <div className="rounded flex items-center justify-between h-[32px] px-2">
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-1.5">
                    <Cpu className="w-3 h-3" /> DME (LIVE)
                  </span>
                  <div className="flex items-center gap-2">
                    {/* OUTSIDE the connected/disconnected split on purpose. This belongs to the last
                        READ, not to the link — and the whole point of the measurement is a sweep where
                        you read, DISCONNECT to change the driver's latency timer, reconnect and read
                        again. Inside the connected branch it vanished at exactly the moment you needed
                        it, taking an un-saved run with it. */}
                    {dmeLink.lastReadTiming && (
                      <button
                        onClick={handleSaveReadTiming}
                        className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-blue-400 transition-colors"
                        title={'Save the last read\'s per-chunk timing as JSON.\n\n'
                          + 'One read = one report, and the next read overwrites it. Save before reading again.'}
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
                        {/* Baud only applies to a real DME, so it's hidden under PRACTICE — but it stays
                            mounted and keeps its box. Unmounting it shrank this row, which shoved the
                            PRACTICE checkbox sideways out from under the pointer as you clicked it. */}
                        <label
                          className={`flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer ${dmeLink.mockMode ? 'invisible pointer-events-none' : ''}`}
                          aria-hidden={dmeLink.mockMode}
                          title={'Bulk-read baud rate. These are the only three the DME implements — asked for anything else it answers 0xB0 PARAMETER_ERROR and the read silently falls back to 9600.\n\n'
                            + '9600 — the default. Sends no switch at all. Measured 122.9s for the 64KB read, reproducibly. This is the floor.\n\n'
                            + '38400 — the switch is accepted and the wire really does run at 38400, but every attempt died inside the first 17 of 538 chunks with the ECU silent. An inter-telegram gap up to 40ms did not help.\n\n'
                            + '125000 — the DME ACKs, then every exchange times out. The reference only reaches it after a flash-erasing "fast entry" procedure.\n\n'
                            + 'A rate the DME rejects is harmless (it stays at the current one). A rate it accepts but cannot run needs an ignition cycle to recover.'}
                        >
                          READ
                          {/* Options come from DS2_SELECTABLE_BAUDS rather than being listed here, so a
                              rate cannot exist in the switch table but be unreachable from the UI —
                              or, worse, be offered here without a payload behind it. */}
                          <select
                            value={dmeLink.readBaud}
                            disabled={dmeLink.mockMode}
                            onChange={(e) => dmeLink.setReadBaud(Number(e.target.value) as Ds2SupportedBaud)}
                            className="bg-slate-800 text-[9px] font-mono text-slate-300 rounded px-1 py-0.5 outline-none cursor-pointer border border-slate-700"
                          >
                            {DS2_SELECTABLE_BAUDS.map(baud => (
                              <option key={baud} value={baud}>{baud}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : (
                      <>
                        <span className="text-[9px] text-slate-600 font-mono uppercase">{dmeLink.mockMode ? 'practice' : 'live'} · {dmeLink.state}</span>
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
                    Kept to one line and truncated — long DS2 errors would otherwise wrap and reintroduce
                    the same shift. The full text is on hover, and on the header status dot. */}
                <div className="h-[14px] px-2 flex items-center overflow-hidden">
                  {(() => {
                    // dmeLink.warning first: it describes the operation that just ran, and the
                    // transport notice only applies while disconnected, so the two never compete.
                    //
                    // `transportKind === 'none'` rather than a negated "supported" flag, because
                    // null (not yet determined, i.e. the static prerender) must render nothing.
                    // The old test was a bare boolean that read false during prerender, which put
                    // an "unsupported browser" line into the exported HTML for every visitor.
                    const warning = dmeLink.warning
                      ?? (!dmeLink.mockMode && dmeLink.state === 'disconnected' && dmeLink.transportKind === 'none'
                        ? dialogText().noTransport({ android: isAndroidPlatform() })
                        : null);
                    const notice = dmeLink.error ?? warning;
                    if (!notice) return null;
                    // Three levels, because a read reporting its own speed is not a warning and
                    // should not wear the warning colour on every successful transfer. But "quieter"
                    // must not mean "unreadable": at 9px/slate-500 the read's own measured baud and
                    // throughput were invisible from the driver's seat and got reported as "nothing
                    // appeared" — and a baud rate cannot be judged by feel, which is the whole reason
                    // this line reports numbers. Leading is pinned to the row height so the larger
                    // font still cannot grow the panel into the visualizer.
                    const tone = dmeLink.error ? 'text-red-400'
                      : dmeLink.warning && dmeLink.warningKind === 'info' ? 'text-slate-300'
                        : 'text-amber-500/80';
                    return (
                      <p className={`text-[11px] leading-[14px] font-mono truncate ${tone}`} title={notice}>
                        {notice}
                      </p>
                    );
                  })()}
                </div>
              </div>

              {/* DASHBOARD CLUSTER — outer div measures real available space; inner div renders the
                  hub/wings at natural size and gets a computed transform:scale to fit exactly. */}
              {
                <div ref={clusterOuterRef} style={{ minHeight: clusterMinH }} className="relative flex-1 min-w-0 flex justify-center items-center overflow-hidden">
                {/* 3-column grid, NOT a flex row: the two outer columns are equal-width (1fr each), so
                    the hub sits at the exact horizontal centre no matter how wide the wings are. A flex
                    row centres the cluster as a whole, which lets the hub drift sideways whenever a wing
                    label changes width (e.g. WRITE WARMUP -> WARMUP). Empty placeholder columns keep the
                    hub in column 2 even before a BIN is loaded. */}
                <div ref={clusterInnerRef} className="fade-in-up select-none flex-none grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center" style={{ transform: `scale(${clusterScale})`, transformOrigin: 'center center' }}>

                  {/* --- LEFT WING (Convex Arc) --- */}
                  {/* --- LEFT WING --- always rendered, inert until a BIN gives it meaning.
                      Mounting the wings only once patchStatus existed changed the cluster's natural
                      size on READ (80->120 tall, 96->414 wide), so the auto-fit rescaled the whole
                      dial underneath you: the ring jumped 78px -> 52px. Reserving their footprint
                      from the first frame is the same rule the sub-action row already follows. */}
                  <div className={`justify-self-end flex flex-col items-end gap-[18px] mr-3 shrink-0 ${patchStatus ? '' : 'invisible'}`}>

                    {/* ROW 1: PATCH TOGGLE (Close to Ring) */}
                    <div className="h-7 flex items-center gap-3 mr-1 opacity-90 hover:opacity-100 transition-opacity shrink-0">
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${applyPatch ? 'text-blue-400' : 'text-slate-500'}`}>
                        PATCH
                      </span>
                      <label className="py-3 -my-3 px-2 -mx-2 relative inline-flex items-center cursor-pointer group">
                        <input type="checkbox" className="sr-only peer" checked={applyPatch} disabled={dmeLink.state === 'writing'} onChange={(e) => setApplyPatch(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                    </div>

                    {/* ROW 2: MAP STATUS (Pushed Away/Far) */}
                    <div className="h-7 flex items-center gap-4 mr-8 pr-1 shrink-0">
                      <span className="text-[10px] font-bold text-slate-600 tracking-widest uppercase whitespace-nowrap">MAP</span>
                      <div className="flex items-center justify-end w-8">
                        <span className={`text-[11px] font-mono font-bold tracking-wider ${applyPatch ? 'text-amber-500' : 'text-slate-500'}`}>
                          {applyPatch ? 'OFF' : 'ON'}
                        </span>
                      </div>
                    </div>

                    {/* ROW 3: LTFT STATUS (Close to Ring) */}
                    <div className="h-7 flex items-center gap-3 mr-1 opacity-90 transition-opacity shrink-0">
                      <span className="text-[10px] font-bold text-slate-600 tracking-widest uppercase whitespace-nowrap">LTFT MIN</span>
                      <div className="flex items-center justify-end w-8">
                        <span className={`text-[11px] font-mono font-bold tracking-wider ${applyPatch ? 'text-amber-500' : 'text-slate-500'}`}>
                          {applyPatch ? '100' : 'OEM'}
                        </span>
                      </div>
                    </div>

                  </div>


                  {/* --- CENTRAL HUB: DME STATE-MACHINE RING (falls back to file download when no DME session is active) --- */}
                  <div className="relative group mx-2 z-10 flex flex-col items-center shrink-0">
                    <div className="relative">
                      {/* Outer Glow/Border Ring */}
                      <div className={`absolute -inset-1 rounded-full border border-slate-800 opacity-100 transition-all duration-500 ${dmeLink.state !== 'disconnected' ? 'border-blue-500/30' : ''} ${dmeLink.state === 'tuning' ? 'animate-pulse border-amber-500/50' : ''}`}></div>

                      <button
                        onClick={dmeButtonConfig.onClick}
                        disabled={dmeButtonConfig.disabled}
                        className={`
                              relative w-20 h-20 rounded-full flex flex-col items-center justify-center gap-1 transition-all duration-300 active:scale-95
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


                  {/* --- RIGHT WING (Convex Arc) --- */}
                  <div className={`justify-self-start flex flex-col items-start gap-[18px] ml-3 shrink-0 ${patchStatus ? '' : 'invisible'}`}>

                    {/* ROW 1: WOT TH 100 (Close to Ring) */}
                    <div className="h-7 flex items-center gap-3 ml-1 opacity-90 hover:opacity-100 transition-opacity shrink-0">
                      <label className="py-3 -my-3 px-2 -mx-2 relative inline-flex items-center cursor-pointer group">
                        <input type="checkbox" className="sr-only peer" checked={applyWotDisable} disabled={dmeLink.state === 'writing'} onChange={(e) => setApplyWotDisable(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${applyWotDisable ? 'text-blue-400' : 'text-slate-500'}`}>
                        WOT TH
                      </span>
                      <span className={`text-[11px] font-mono font-bold tracking-wider ml-1 whitespace-nowrap ${applyWotDisable ? 'text-amber-500' : 'text-slate-500'}`}>
                        {applyWotDisable ? '102.3' : 'OEM'}
                      </span>
                    </div>

                    {/* ROWS 2-3 inject TABLES derived from a tune, so they do nothing without one:
                        buildPatchedBuffer generates both inside `if (newMap)`. That made them the only
                        switches on the hub that could be armed and silently ignored.

                        `checked` is ANDed with the tune rather than the stored flag being cleared. A
                        disabled control still reading ON would be the worse half of the same problem —
                        stuck armed with no way to turn it off — and clearing would throw away a
                        preference the user set, or one restored from a saved session whose tune has not
                        been rebuilt yet ([page.tsx] loadSession passes tuneSettings.writeWarmup/Wot
                        straight back in). Deriving instead shows exactly what WRITE will do in every
                        path, and hands the preference back untouched the moment a tune exists. */}

                    {/* ROW 2: WRITE WARMUP (Pushed Away/Far) */}
                    <div className={`h-7 flex items-center gap-4 ml-8 pl-1 shrink-0 transition-opacity ${derivedTablesLocked ? 'opacity-40' : ''}`}>
                      <label
                        className={`py-3 -my-3 px-2 -mx-2 relative inline-flex items-center group ${derivedTablesLocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={derivedTablesLocked ? derivedTablesLockReason : undefined}
                      >
                        <input type="checkbox" className="sr-only peer" checked={!derivedTablesLocked && writeWarmup} disabled={derivedTablesLocked || dmeLink.state === 'writing'} onChange={(e) => setWriteWarmup(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span
                        className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${!derivedTablesLocked && writeWarmup ? 'text-blue-400' : 'text-slate-500'}`}
                        title={derivedTablesLocked ? derivedTablesLockReason : undefined}
                      >
                        {compact ? 'WARMUP' : 'WRITE WARMUP'}
                      </span>
                    </div>

                    {/* ROW 3: WRITE WOT (Close to Ring) */}
                    <div className={`h-7 flex items-center gap-3 ml-1 transition-opacity shrink-0 ${derivedTablesLocked ? 'opacity-40' : 'opacity-90'}`}>
                      <label
                        className={`py-3 -my-3 px-2 -mx-2 relative inline-flex items-center group ${derivedTablesLocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={derivedTablesLocked ? derivedTablesLockReason : undefined}
                      >
                        <input type="checkbox" className="sr-only peer" checked={!derivedTablesLocked && writeWot} disabled={derivedTablesLocked || dmeLink.state === 'writing'} onChange={(e) => setWriteWot(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span
                        className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${!derivedTablesLocked && writeWot ? 'text-blue-400' : 'text-slate-500'}`}
                        title={derivedTablesLocked ? derivedTablesLockReason : undefined}
                      >
                        {compact ? 'WOT' : 'WRITE WOT'}
                      </span>
                    </div>

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
              <div className="h-[46px] flex-none flex flex-row items-center justify-center gap-x-4">
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
                    onClick={() => setAdaptDialogOpen(true)}
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
            </div >
          </div >
        </div >
      </div >

      {/* Mounted at <main> level, not inside the hub cluster: that cluster is overflow-hidden and
          sits under useFitScale's transform, so a modal rendered within it would be clipped and
          scaled down along with the dial. */}
      {adaptDialogOpen && (
        <AdaptationResetDialog
          onRead={dmeLink.readAdaptations}
          onReset={dmeLink.resetAdaptations}
          onClose={() => setAdaptDialogOpen(false)}
          onResetComplete={handleAdaptationResetComplete}
          error={dmeLink.error}
          errorKind={dmeLink.errorKind}
        />
      )}

      {identityDialogOpen && (
        <DmeIdentityDialog
          identity={dmeLink.identity}
          state={dmeLink.state}
          onClose={() => setIdentityDialogOpen(false)}
        />
      )}

      {flashDialogOpen && (
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
