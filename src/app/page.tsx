'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic'; // Added dynamic import
import { ChartLoading } from '@/components/ChartLoading';
import { DropZone } from '@/components/DropZone';
import { MapEditor, COVERAGE_THIN_DEFAULT, COVERAGE_OK_DEFAULT } from '@/components/MapEditor';
import { RfKorrTable } from '@/components/RfKorrTable';

// Dynamic imports for heavy components
const MapVisualizer = dynamic(() => import('@/components/MapVisualizer').then(mod => mod.MapVisualizer), { ssr: false, loading: () => <ChartLoading /> });
const LogTimeSeriesChart = dynamic(() => import('@/components/LogTimeSeriesChart').then(mod => mod.LogTimeSeriesChart), { ssr: false, loading: () => <ChartLoading /> });
import { FilterConfigPanel } from '@/components/FilterConfigPanel';
import { InertiaWorkflow } from '@/components/InertiaWorkflow';
import { InterpolationTableEditor } from '@/components/InterpolationTableEditor';
import { LogDataTable } from '@/components/LogDataTable';
import { SessionList, OriginBadge, NewFromWhich, UploadState } from '@/components/SessionList';
import { SessionStorePanel } from '@/components/SessionStorePanel';
import {
  EMPTY_SETTINGS, SyncSettings, buildIdentity, canSync, syncSession, loadSyncSettings, needsSync,
  sessionFingerprint,
} from '@/lib/session-sync/client';
import type { SaveStatus, SyncStatus } from '@/lib/session-sync/status';
import { describeSave, describeSync } from '@/lib/session-sync/status';
import { DiagnosticRecord, uploadDiagnostic } from '@/lib/session-sync/diagnostics';
import type { WriteVerifyMode } from '@/lib/dme-link/types';
import { initialVerifyMode, recordQuickVerifyProven } from '@/lib/dme-link/verifyPolicy';
import { checkLineage } from '@/lib/lineage/preflight';
import { FieldVisibilityPanel } from '@/components/FieldVisibilityPanel';
import { AdaptationResetDialog } from '@/components/AdaptationResetDialog';
import { FlashCounterResetDialog } from '@/components/FlashCounterResetDialog';
import { DisclaimerDialog } from '@/components/DisclaimerDialog';
import { DmeIdentityDialog } from '@/components/DmeIdentityDialog';
import { CreditsDialog } from '@/components/CreditsDialog';
import { MobileMenu } from '@/components/MobileMenu';
import { MessageDialog, Message } from '@/components/MessageDialog';
import { MarkIcon } from '@/components/MarkIcon';
import { useAppUpdate, reloadForUpdate } from '@/hooks/useAppUpdate';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useOnline } from '@/hooks/useOnline';
import { useWideLayout, useSplitGraph } from '@/hooks/useWideLayout';
import { useMapZoom } from '@/hooks/useMapZoom';
import { AlertCircle, CheckCircle, Download, FileCode, FileSpreadsheet, Settings, Power, Zap, Play, Thermometer, Cpu, Trash2, Github, BookOpen, Shield, Square, Loader2, RotateCcw, RefreshCw, Eraser, PlugZap, Database, Upload, UploadCloud } from 'lucide-react';
import { PRIVACY_POLICY_URL } from '@/config/links';
import { LogFilterConfig, InterpolationPoint, LogDataPoint, ProcessedLog, RfKorrSource, resolveRfKorr } from '@/lib/types';
import type { VeCalcOptions } from '@/lib/ve-calculator/calculator';
import { readEgtTables, type EgtTables } from '@/lib/ve-calculator/egtTables';
import {
  RF_KORR_COL_LABEL, RF_KORR_ROW_LABEL, rfKorrViewData, type RfKorrView,
} from '@/lib/ve-calculator/rfKorrView';
import { useIsPreviewBuild, usePreviewTitle } from '@/lib/build-variant';
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
import { sha256Hex, markSessionSynced } from '@/lib/db/sessionRepository';
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

type TabId = 'startup' | 'current' | 'lambda' | 'new' | 'diff' | 'log' | 'rfkorr' | 'warmup' | 'wot' | 'inertia';

/** Live Hz readout tuning. 24 samples is ~3 s of history on the cable (two DS2 exchanges each) and
 *  ~0.5 s under PRACTICE — long enough to ride out one retried exchange either way. Publishing at
 *  4 Hz keeps the digits readable; the value itself is recomputed no faster than that. */
const HZ_WINDOW_SAMPLES = 24;
const HZ_PUBLISH_INTERVAL_S = 0.25;
/** How often a run's samples are appended to the crash-recovery store. Wall clock, not sample time:
 *  this bounds how much of a DRIVE is at risk, and that is measured in seconds of the user's life,
 *  not in samples. At the ~10 Hz this link achieves, 5 s is ~50 points — the most a crash can cost. */
const PERSIST_INTERVAL_MS = 5000;

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

  // Session store. `uploadState` is per session id because "did that land?" is a question about one
  // row, not about the app; `syncBusy`/`syncError` are the app-level half, for the one control that
  // acts on all of them at once.
  const [uploadSettings, setUploadSettings] = useState<SyncSettings>(EMPTY_SETTINGS);
  const [uploadState, setUploadState] = useState<Record<string, UploadState>>({});
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Loaded here rather than only in the store panel. The panel lives on the SESSIONS tab now, so
  // waiting for it to mount would leave the menu's sync row reading "not set up" until somebody
  // happened to open that tab — a control lying about the app's state because of where a different
  // component is. An effect, not lazy state: localStorage does not exist during the static
  // prerender, and seeding from it would bake an empty token into the export.
  useEffect(() => { setUploadSettings(loadSyncSettings()); }, []);
  // Kept in a ref as well as in state, because the diagnostics uploader runs from inside async
  // handlers that were created several renders ago and would otherwise close over an empty token —
  // which is the failure that looks exactly like "the store is not configured".
  const uploadSettingsRef = useRef(uploadSettings);
  uploadSettingsRef.current = uploadSettings;

  /**
   * What a WRITE will prove. Opens on FULL for a DME whose checksum has never been seen to agree
   * with a read-back; see verifyPolicy.ts for why that is the safe direction to be wrong in.
   *
   * Reset from the identity on every connect rather than kept across them: the selector describes
   * the ECU on the other end of the cable, and carrying a QUICK earned on one car over to another
   * is precisely the mistake this exists to prevent.
   */
  const [verifyMode, setVerifyMode] = useState<WriteVerifyMode>('full');
  const connectedVin = dmeLink.identity?.vin ?? null;
  useEffect(() => {
    setVerifyMode(initialVerifyMode(connectedVin));
  }, [connectedVin]);
  // Latest raw live-telemetry sample, shown as a live readout during tuning (independent of the VE
  // filters, so the user can confirm data is streaming even when the engine is off / idle-filtered).
  const [liveSample, setLiveSample] = useState<LogDataPoint | null>(null);
  const [adaptDialogOpen, setAdaptDialogOpen] = useState(false);
  const [flashDialogOpen, setFlashDialogOpen] = useState(false);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);
  const [creditsDialogOpen, setCreditsDialogOpen] = useState(false);
  /** Which pane the narrow (stacked) layout shows. Inert above 900px, where both are on screen.
   *  Starts on the map because that is what a stacked layout was failing to show: the two panes
   *  split 38.2/61.8 regardless of how little height there was, so on a 360x800 phone the VE grid
   *  got 217px — six of twenty columns and ten of twenty-four rows — while the dashboard held a
   *  3D chart nobody could read at that size either. One at a time, and each gets all of it. */
  const [narrowPane, setNarrowPane] = useState<'map' | 'graph' | 'dash'>('map');
  /**
   * The app's own alert/confirm, for the four messages the browser's cannot show whole.
   *
   * A native dialog grows with its text. On the head unit — about 683x400 — the post-log
   * instructions and the write confirmation are long enough that the buttons land under the fold,
   * so the one dialog standing between a tap and an ECU write was answered without being read.
   * `MessageDialog` puts the scroll in the body and keeps the buttons in the frame.
   *
   * Promise-shaped because every call site is mid-sequence and the ordering there is deliberate —
   * `finishLog` disconnects *before* it speaks so a blocking dialog cannot freeze the read pump
   * behind it. `await ask(...)` reads the same as `confirm(...)` did and preserves that.
   */
  const [message, setMessage] = useState<Message | null>(null);
  const ask = useCallback((m: Omit<Message, 'resolve'>) => new Promise<boolean>(resolve => {
    setMessage({ ...m, resolve: ok => { setMessage(null); resolve(ok); } });
  }), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const updateAvailable = useAppUpdate();
  const install = useInstallPrompt();
  const isPreviewBuild = useIsPreviewBuild();
  usePreviewTitle();
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

  const {
    binaryFile, currentMap, binaryBuffer, patchStatus,
    applyPatch, setApplyPatch, applyWotDisable, setApplyWotDisable,
    applyTankVentDisable, setApplyTankVentDisable,
    writeWarmup, setWriteWarmup, writeWot, setWriteWot, writeRfKorr, setWriteRfKorr,
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

  const { newMap, mapData, hitMap, correctionMap, weightMap, warmupMap, wotMap, tunedRfKorr } = veCalc;
  /** The coverage bands every grid in this page tints with, resolved once from the session's filter
   *  config. Passed explicitly rather than let each MapEditor fall back to its own default, so a
   *  changed setting reaches all four grids or none. */
  const coverageBands = {
    coverageThin: filterConfig.coverageThin ?? COVERAGE_THIN_DEFAULT,
    coverageOk: filterConfig.coverageOk ?? COVERAGE_OK_DEFAULT,
  };
  const { diffSubject, setDiffSubject, diffReference, setDiffReference, diffMapForVisualization } = comparison;

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
    minCellSamples: config.minVeCellSamples,
    minCellWeight: config.minVeCellWeight,
    rfKorrThresholds: {
      minCellSamples: config.rfKorrMinCellSamples,
      minCellWeight: config.rfKorrMinCellWeight,
    },
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

  const veCalcOptions = useMemo(
    () => veCalcOptionsFor(filterConfig, egtTables, writeRfKorr),
    // Hand-listed, and the list is the contract: every input veCalcOptionsFor actually reads has
    // to be here or a toggle change re-renders without re-deriving. `applyRfKorr` alone was enough
    // when it was the only rf_korr input; it is not any more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterConfig.rfKorrSource, filterConfig.rfKorrMode, filterConfig.applyRfKorr,
      filterConfig.minVeCellSamples, filterConfig.minVeCellWeight,
      filterConfig.rfKorrMinCellSamples, filterConfig.rfKorrMinCellWeight,
      egtTables, writeRfKorr]);

  const runCalculation = (map: NonNullable<typeof currentMap>, processed: ProcessedLog) => {
    veCalc.runCalculation(map, processed, veCalcOptions);
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

  // Wipes everything derived from the previously-loaded binary. Mandatory on every path that swaps
  // the BASE: newMap is otherwise only reset by handleClearLog, so a stale tune from the last
  // session would be grafted onto the new binary by buildPatchedBuffer.
  const resetDerived = () => {
    binaryFileState.clear();
    veCalc.reset();
    logFileState.clear();
    liveSamplesRef.current = [];
    finalizeArmedRef.current = false;
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
      runCalculation(currentMap, processed);
      goToTab('diff'); // jump to the result only on the initial CSV load
    }
  };

  const handleConfigChange = (newConfig: LogFilterConfig) => {
    const processed = logFileState.reprocess(newConfig);
    if (processed && currentMap) {
      runCalculation(currentMap, processed); // stay on the current tab
    }
  };

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

  /** Does this log carry an exhaust temperature at all? The DME-table route needs a Δ, and Δ has
   *  exactly one non-circular source: kf_rf_tabg_modell(rpm, RF) − TABG. Without TABG there is no
   *  row to read the table at, so the route is not a choice. */
  const logHasTabg = useMemo(
    () => !!processedLog?.data.some(p => p.exhaustTemp !== undefined),
    [processedLog]);

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
  const rfKorrArmed = writeRfKorr && canTuneRfKorr;
  const rfKorrWrite = rfKorrArmed ? tunedRfKorr!.tuned : null;

  /** Which of the four conditions is missing, in the order they are usually missing.
   *
   *  One sentence naming the actual blocker, not a list of everything it could be. A disabled
   *  switch that cannot say why is the one that gets reported as broken — the same reasoning as
   *  derivedTablesLockReason beside it, which this deliberately reads like. */
  const rfKorrLockReason = !egtTables
    ? 'Needs the binary\'s EGT tables — they did not decode from these bytes, so there is nothing to derive against.'
    : !(applyPatch || patchStatus?.mapOff)
      ? 'Needs a log recorded with the PATCH on (k_rf_cfg = 0x02). With MAP compensation live, RF carries the integrator on top and rf_korr cannot be pinned to a few percent.'
      : !tunedRfKorr
        ? 'Needs a log first — the table is back-calculated from one. Record a run (START TUNE) or load one.'
        : tunedRfKorr.report.sensorMissing
          ? 'Needs an exhaust temperature (TABG) in the log. Δ has no other non-circular source, and Δ is what picks the row of the table.'
          : 'Too few cells cleared their evidence thresholds to be worth writing — see the RF KORR tab for the per-cell reasons.';

  const handleDownloadBin = () => {
    binaryFileState.downloadBin(newMap, { tunedRfKorr: rfKorrWrite });
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

  /** Sends a whole session to the store, and says on the row whether it landed.
   *
   *  The session goes as the local database holds it — the record, its log and its binaries — so
   *  it can come back the same way. It syncs under its own id, which is what makes a retry after a
   *  dropped connection replace rather than duplicate; a phone in a garage drops uploads often
   *  enough that this is the normal path, not the exceptional one. Nothing local is touched. */
  const syncOne = async (session: TuningSession): Promise<string | null> => {
    // Taken BEFORE the upload, not after. A run that finishes recording while a slow upload is in
    // flight must leave the session outstanding — see markSessionSynced.
    const fingerprint = sessionFingerprint(session);
    setUploadState(prev => ({ ...prev, [session.id]: 'busy' }));
    try {
      await syncSession(session, uploadSettings);
      await markSessionSynced(session.id, fingerprint);
      setUploadState(prev => ({ ...prev, [session.id]: 'done' }));
      return null;
    } catch (e) {
      // Kept on the row rather than raised in an alert: an alert has to be dismissed before the
      // driver can retry, and the message is most useful next to the thing that failed.
      const error = (e as Error).message;
      setUploadState(prev => ({ ...prev, [session.id]: { error } }));
      return error;
    }
  };

  const handleUploadSessionLog = async (session: TuningSession) => {
    await syncOne(session);
    await sessionDb.refresh();   // the row's synced state is now on the record
  };

  /** Sessions worth sending that are not up there as they now stand. Also what the menu's sync row
   *  counts, so the number on the button and the rows it would act on are the same list. */
  const pendingSync = useMemo(
    () => sessionDb.sessions.filter(needsSync),
    [sessionDb.sessions],
  );

  /**
   * Sends everything outstanding, one at a time.
   *
   * Sequential rather than `Promise.all`. Each session carries its BASE and TUNED images — around
   * 128 KB before gzip, and the API caps a part at 900 KB — so this is a handful of large uploads
   * over whatever signal a garage has, not a fan-out that finishes sooner for being parallel. It
   * also means a failure is attributable: the row that failed is the one that stopped, and the rest
   * still went.
   *
   * Nothing is skipped on failure. A phone that loses signal for one session usually has it back
   * for the next, and stopping the loop would strand later sessions behind an earlier one's bad
   * luck. The count of failures is what the button reports.
   */
  const handleSyncAll = async () => {
    const outstanding = pendingSync;
    if (!outstanding.length) return;
    setSyncBusy(true);
    setSyncError(null);
    const failures: string[] = [];
    for (const session of outstanding) {
      const error = await syncOne(session);
      if (error) failures.push(error);
    }
    await sessionDb.refresh();
    setSyncBusy(false);
    // The first message, with a count — not all of them concatenated. A dropped connection produces
    // N copies of one sentence, and the button has one line to say it in.
    setSyncError(failures.length
      ? `${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''}`
      : null);
  };

  const online = useOnline();
  /**
   * What the sync controls say, or null when this build has no store behind them.
   *
   * Null on production, and that is not a styling choice. Production is served statically from
   * GitHub Pages: there are no Pages Functions, no D1 and no `/api` at any path. A permanently
   * greyed "Sync — not set up" row there would describe a feature that build does not contain, and
   * the honest rendering of a feature that does not exist is nothing at all.
   *
   * Keyed on the preview marker rather than on having a token, because those come from the same
   * build step and the marker is the one that means "this deployment has functions". A preview
   * whose token failed to embed still shows the row, saying `unavailable` — which is exactly the
   * case somebody needs to be told about rather than shielded from.
   */
  const syncStatus: SyncStatus | null = useMemo(() => !isPreviewBuild ? null : ({
    phase: !canSync(uploadSettings) ? 'unavailable'
      : syncBusy ? 'busy'
        // Offline outranks the error: "no network" is the actionable half of a failure that
        // happened because there was no network, and it is the one that says what to do about it.
        : !online ? 'offline'
          : syncError ? 'error'
            : pendingSync.length > 0 ? 'ready'
              : 'clean',
    pending: pendingSync.length,
    error: syncError ?? undefined,
  }), [isPreviewBuild, uploadSettings, syncBusy, online, syncError, pendingSync.length]);
  const syncLook = syncStatus && describeSync(syncStatus);


  /** Which build this is, for the menu and for every uploaded record. Resolved after mount: the
   *  meta tag exists in the export but `document` does not during the static prerender. */
  const [buildLabel, setBuildLabel] = useState<string | undefined>(undefined);
  /**
   * Whether the last operation's diagnostic record reached the store.
   *
   * Shown next to TIMING. The upload has always been best-effort and silent, which is right for not
   * disturbing a flash — and wrong for ever finding out it is not working. Two vehicle sessions were
   * spent believing records were being sent; they were, but for the previous run each time, and the
   * only way to discover either fact was to query D1 from a laptop.
   */
  type DiagUploadState =
    | { state: 'idle' } | { state: 'none' } | { state: 'sending' }
    | { state: 'stored'; bytes: number }
    | { state: 'failed'; reason: string };
  const [diagUpload, setDiagUpload] = useState<DiagUploadState>({ state: 'idle' });
  useEffect(() => { void buildIdentity().then(setBuildLabel); }, []);

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
      { applyPatch: false, applyWotDisable: false, applyTankVentDisable: false, writeWarmup: false, writeWot: false },
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
        // A BASE with no tune yet is already on this device — setSessionBase writes it as the READ
        // finishes — so the honest state is "saved", not "nothing to record". SYNC is the control
        // that does something here, and describeSave's copy points at it.
        : !newMap ? (currentSession.baseOrigin ? 'baseOnly' : 'nothing')
          : isArchived ? 'archived'
            : 'ready',
  }), [dmeLink.state, currentSession, newMap, isArchived]);
  const saveLook = describeSave(saveStatus);

  // Each tab states the data it needs, rather than a chain of exclusions. CURRENT MAP used to be
  // exempted from every check and so was clickable with nothing loaded, landing on the empty
  // "AWAITING BINARY FILE" placeholder.
  const TABS: { id: TabId; label: string; enabled: boolean }[] = [
    { id: 'startup', label: 'STARTUP', enabled: true },
    { id: 'current', label: 'CURRENT MAP', enabled: !!currentMap },
    { id: 'lambda', label: 'LAMBDA FEEDBACK', enabled: !!correctionMap && !!newMap },
    { id: 'new', label: 'TUNED MAP', enabled: !!newMap },
    { id: 'diff', label: 'DIFFERENCE %', enabled: !!currentMap },
    { id: 'log', label: 'CORRECTED LOG', enabled: !!processedLog },
    // Enabled on the RESULT, not on the binary: the tuner only returns something when the tables
    // decoded AND the log carried an exhaust temperature, which is exactly when there is a table
    // to show. A tab that is reachable and empty says the feature is broken.
    // "/ EXP." carries the same warning as the two below it, and this table has more claim to it
    // than either: it is back-calculated from one log, its inversion is only defined over 45 % of
    // the rpm axis, and nothing here has been checked against a car yet.
    { id: 'rfkorr', label: 'RF KORR (TUNED / EXP.)', enabled: !!tunedRfKorr },
    { id: 'warmup', label: 'WARMUP (DERIVED / EXP.)', enabled: !!warmupMap },
    { id: 'wot', label: 'WOT (DERIVED / EXP.)', enabled: !!wotMap },
    // Enabled on the LINK plus a loaded image, not on a log or a map. This workflow produces its
    // own samples from a different DS2 block and reads its current values straight out of the
    // binary, so it shares no prerequisite with the VE chain above it — and it is the one tab that
    // is useful before any tuning has happened at all.
    { id: 'inertia', label: 'INERTIA (EXP.)', enabled: !!binaryFileState.binaryBuffer },
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
    // And go and look at it. Below 900px the tab lives in the other pane, so setting it alone moved
    // the map behind a dashboard nobody had left: START TUNE armed LAMBDA FEEDBACK, the first sample
    // released it, and the screen stayed on DASH with the trim being drawn out of sight. The manual
    // path already pairs these two (onSelectTab does both); this is the same rule for the armed one.
    setNarrowPane('map');
  }, [currentMap, newMap, correctionMap, processedLog, warmupMap, wotMap, tunedRfKorr]);

  // Clearing the log or swapping the BASE can disable the tab you're standing on; without this you'd
  // be stranded on a placeholder with its own tab greyed out.
  //
  // Deliberately the one place that still calls setActiveTab raw. A forced bounce is not the user
  // navigating, so it must NOT disarm a pending move — goToTab would, and a run whose result is still
  // being derived would lose its landing.
  useEffect(() => {
    if (!TABS.find(t => t.id === activeTab)?.enabled) setActiveTab('startup');
  }, [currentMap, newMap, correctionMap, processedLog, warmupMap, wotMap, tunedRfKorr, activeTab]);

  const buildSettings = (): TuneSettings => ({
    filterConfig, interpolationTable, applyPatch, applyWotDisable, applyTankVentDisable, writeWarmup, writeWot,
    // The armed value, not the raw toggle: `rfKorrArmed` is what actually reached the bytes, and a
    // session must record what it did rather than what was switched on at the time.
    writeRfKorr: rfKorrArmed,
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

    // One path for both, which it did not used to be: the draft branch loaded the BASE and stopped,
    // because a draft could not have a stored log — saving archived it. Saving no longer does, so a
    // draft is now the ordinary home of a saved run, and stopping here would hand back a session
    // whose log and filters are in the database and not on the screen.
    //
    // Rebuild the tune FROM THE BASE. Re-running the log against the stored tuned map (what the old
    // code did) would apply the same correction a second time — V0*C^2.
    const map = await binaryFileState.loadFromBuffer(
      bins.baseBinaryBuffer,
      session.baseFileName ?? 'base.bin',
      session.tuneSettings && {
        applyPatch: session.tuneSettings.applyPatch,
        applyWotDisable: session.tuneSettings.applyWotDisable,
        applyTankVentDisable: session.tuneSettings.applyTankVentDisable,
        writeWarmup: session.tuneSettings.writeWarmup,
        writeWot: session.tuneSettings.writeWot,
        writeRfKorr: storedWriteRfKorr(session.tuneSettings),
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
            storedWriteRfKorr(session.tuneSettings)));
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
    if (!rebuilt && (session.hasLog || session.status === 'archived')) alert(dialogText().notReconstructed);
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
    const map = await binaryFileState.loadFromBuffer(bins.baseBinaryBuffer, session.baseFileName ?? 'base.bin');
    if (!map) return;

    liveSamplesRef.current = points;
    const processed = logFileState.loadRawLog(points, 'recovered-log.csv');
    if (processed) {
      // Same stale-scope reason as the archived rebuild: `loadFromBuffer` above only scheduled
      // the binary swap, so the egtTables memo still describes whatever was loaded before. The
      // filter config is NOT reloaded here, so the live one is the right one.
      veCalc.runCalculation(map, processed,
        veCalcOptionsFor(filterConfig, readEgtTables(bins.baseBinaryBuffer), writeRfKorr));
      comparison.applyDefaultsAfterCalculation();
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
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap, undefined, { tunedRfKorr: rfKorrWrite });
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
    const buffer = await dmeLink.read();
    // Before the early return, so a read that died part-way — the read worth measuring, and the one
    // a baud experiment produces — is uploaded rather than dropped along with the buffer it failed
    // to return.
    publishDiagnostics('read');
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
  /**
   * True while a deferred flush is queued or running, so they cannot pile up.
   *
   * Same shape as `persistBusyRef` next door and for the same reason: the work is O(n) in the log
   * and the log only grows, so on a long run a second flush can be scheduled before the first has
   * finished. Dropping the extra one is right — the next sample schedules another 500 ms later, and
   * a flush that is already in flight is about to show the same answer.
   */
  const flushBusyRef = useRef(false);

  /**
   * Runs the UI flush WITHOUT blocking the DS2 poll loop.
   *
   * `flushLiveSamples` re-processes the whole log and re-runs the VE calculation. Called straight
   * from `onSample` it sits between two DS2 exchanges, so the DME is idle for the whole of it —
   * measured on Session #902, a sample took 411 ms against 244 ms of unavoidable wire and
   * turnaround, and the missing 167 ms is this.
   *
   * Deferring it to a macrotask does not make the work cheaper; it makes it happen at a better
   * time. The poll loop can issue the next request immediately, and the flush then runs during the
   * DME's own ~80 ms of thinking, which is dead CPU time either way. It also stops the rate
   * DEGRADING as the log grows, which is the worse half of the problem: the cost is O(n) and the
   * old arrangement paid all of it on the critical path.
   *
   * requestIdleCallback where it exists, because that is exactly "run when the main thread is
   * otherwise waiting". Safari and older Android have no such thing, hence the timeout fallback.
   */
  const scheduleFlush = () => {
    if (flushBusyRef.current) return;
    const now = Date.now();
    if (now - lastFlushRef.current < 500) return;
    flushBusyRef.current = true;
    const run = () => {
      try { flushLiveSamples(true); } finally { flushBusyRef.current = false; }
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    // A timeout on the idle callback too: idle never arrives on a busy main thread, and a live
    // readout that stops updating during a hard pull is worse than one that costs a few ms there.
    if (ric) ric(run, { timeout: 400 }); else setTimeout(run, 0);
  };

  const flushLiveSamples = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastFlushRef.current < 500) return null;
    lastFlushRef.current = now;
    const processed = logFileState.loadRawLog([...liveSamplesRef.current], 'live-session.csv');
    if (processed && currentMap) {
      veCalc.runCalculation(currentMap, processed, veCalcOptions);
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
        scheduleFlush();
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
    // Absent on every session saved before this existed, and `undefined !== false` would report a
    // drift that never happened on all of them. Coerced, not compared loosely.
    cmp('TANK VENT', !!s.applyTankVentDisable, applyTankVentDisable);
    cmp('WRITE WARMUP', s.writeWarmup, writeWarmup);
    cmp('WRITE WOT', s.writeWot, writeWot);
    cmp('WRITE RF KORR', storedWriteRfKorr(s), rfKorrArmed);
    return rows;
  };

  const handleDmeWrite = async () => {
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap, undefined, { tunedRfKorr: rfKorrWrite });
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
        // Android gets extra lines because the guarantees are weaker there: beforeunload is honored
        // inconsistently, so the "you will be asked to confirm" sentence above cannot be relied on,
        // and the screen or an app switch can take the connection down mid-write.
        android: isAndroidPlatform(),
      }),
      confirmLabel: tWrite.btnWrite, cancelLabel: tWrite.btnCancel, danger: true,
    });
    if (!confirmed) return;

    const verification = await dmeLink.write(patchedBuffer, verifyMode);
    // Before either branch, and on both of them. A write that failed part-way on an already-erased
    // ECU is the single most valuable record this app can produce, and it is also the one the
    // driver is least able to collect by hand at the time.
    publishDiagnostics('write');
    if (verification) {
      // The licence QUICK rests on: on this ECU, a byte-for-byte read-back and the DME's own
      // checksum have now agreed. Recorded only when BOTH actually ran and passed — a FULL write on
      // a DME that would not answer 0x0A proves the bytes and proves nothing about the checksum,
      // which is the thing being licensed.
      if (verification.readBack && verification.encodingChecksum) {
        recordQuickVerifyProven(dmeLink.identity?.vin);
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
        // `finalizeArmedRef` is the only thing that separates them, because the absence of newMap
        // does not. Filing the second as `tuned: false` made the FINAL badge unable to mean what it
        // says, and made a bare-BASE patch-off write claim a tune it never had.
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
          tuned: finalizeArmedRef.current, verifyMode: verification.mode,
        });

        alert(dialogText().patchWriteDone(verification));
        await dmeLink.disconnect();

        // The ECU now holds these bytes, so the workspace has to as well — otherwise patchStatus
        // still describes the pre-patch BASE, the drift never clears, and the hub would keep
        // offering the same write forever. Toggles are passed through rather than re-detected so
        // the reload cannot bounce them.
        await binaryFileState.loadFromBuffer(
          patchedBuffer,
          binaryFileState.buildFileName(null),
          { applyPatch, applyWotDisable, writeWarmup, writeWot, writeRfKorr },
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
        await sessionDb.recordFlash(target.id, { at: flashedAt, sha256, settings: flashedSettings, tuned: true, verifyMode: verification.mode });
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
        body: tFail.writeFailed(dmeLink.error, { wasBackgrounded: wasBackgrounded() }),
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

  /**
   * Builds the diagnostic record for the last instrumented operation: the numbers, the narrative,
   * and enough context to place both.
   *
   * One shape, used by the download button and by the upload — so a record read out of the store at
   * a desk and a file saved on a phone are the same thing, and neither can quietly carry less.
   */
  const buildDiagnosticRecord = (kind: DiagnosticRecord['kind']): DiagnosticRecord | null => {
    // Refs, NOT the rendered state. This function runs from inside the operation's own async
    // handler, which closed over `dmeLink` before the await — reading the state fields there
    // published the previous operation's report and never published the last one at all.
    const report = dmeLink.lastTransferTimingRef.current;
    const events = dmeLink.lastEventLogRef.current;
    // A record with no report is still worth having when something went wrong — the timing window
    // opens after the login and after the baud switch, so a refused login or a switch the DME
    // accepts and then goes silent on produces no report at all. Those are the failures most worth
    // reading, and returning early on a missing report is what made them the ones that left no
    // trace. Nothing at all is published only when there is genuinely nothing: no report, no
    // events, and no error.
    if (!report && !events && !dmeLink.error) return null;
    return {
      id: crypto.randomUUID(),
      // From the caller, not from the report: there may not be one, and a record that cannot say
      // which operation it describes is not a record.
      kind,
      createdAt: Date.now(),
      completed: report?.completed ?? false,
      // `??` chains past null, and `report.error` is null on a SUCCESSFUL run — so the fallback
      // below fired on every clean read and stamped it "failed before the instrument was armed"
      // beside completed=1. Caught in the store, where a 538-exchange 126.7 s success was carrying
      // that sentence. The fallback belongs to the no-report case only.
      error: report ? report.error : (dmeLink.error ?? 'failed before the instrument was armed'),
      // Which car, which bytes, which transport. A timing report without these is a column of
      // numbers that cannot be compared against any other run — and comparing runs is the only
      // thing any of this is for.
      vin: dmeLink.identity?.vin ?? null,
      softwareVersion: dmeLink.identity?.softwareVersion ?? null,
      transport: dmeLink.transportKind,
      mock: dmeLink.mockMode,
      sessionId: currentSession?.id ?? null,
      report,
      events,
    };
  };

  /**
   * Uploads the last operation's diagnostics, best-effort and silent.
   *
   * Fire-and-forget by design: it is called from paths that have just finished a read, a write or a
   * datalog. An upload that could reject there would either surface as an unhandled rejection or
   * replace the operation's own error with a networking one — and the operation's own error is the
   * thing being diagnosed. `uploadDiagnostic` never throws; this `void` is belt and braces.
   */
  const publishDiagnostics = (kind: DiagnosticRecord['kind']) => {
    // Wrapped, because this runs on the line after a read or a flash and NOTHING it does may take
    // that handler down. It threw once in a way that could only present as "the marker never
    // appeared": buildDiagnosticRecord touches half a dozen fields off the link, and an exception
    // here would abort handleDmeRead before any state was set, leaving the UI in exactly the state
    // it was in before the operation. A reporting path that can fail silently is the bug this whole
    // feature exists to stop, so it is not allowed to have one itself.
    try {
      const record = buildDiagnosticRecord(kind);
      if (!record) { setDiagUpload({ state: 'none' }); return; }
      setDiagUpload({ state: 'sending' });
      void uploadDiagnostic(record, uploadSettingsRef.current).then(r => {
        setDiagUpload(r.ok ? { state: 'stored', bytes: r.bytes } : { state: 'failed', reason: r.reason });
      });
    } catch (e) {
      setDiagUpload({ state: 'failed', reason: `could not build the record: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** Offers the last operation's per-exchange timing and event log as a file, same explicit-export
   *  rule as the service blocks. The notice line only has room for medians; the sampled
   *  inter-arrival gaps are the part that distinguishes per-byte USB packets from batched ones, and
   *  those need a file. */
  const handleSaveTransferTiming = () => {
    const report = dmeLink.lastTransferTimingRef.current ?? dmeLink.lastTransferTiming;
    const record = report && buildDiagnosticRecord(report.kind);
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
      : (patchDrift && patchWriteAllowed && currentMap && currentSession) ? 'writePatch'
        : (currentMap && currentSession && !isArchived) ? 'tune'
          : 'read';

  // Names the bytes by what they will carry once written, not by what is in the ECU now — the label
  // is a promise about the file being sent, the same rule DOWNLOAD PATCH-ON follows.
  const writePatchLabel = (applyPatch || applyWotDisable || applyTankVentDisable) ? 'WRITE PATCH-ON' : 'WRITE PATCH-OFF';

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
  /** The two views whose map is assembled rather than stored: a base map wearing another map's
   *  numbers. Built here so their identity is stable — spread inline at the call site they were a
   *  new object on every render, which is exactly what a memo compares. */
  const diffVisualMap = useMemo(
    () => (diffMapForVisualization && (newMap || currentMap))
      ? { ...(newMap || currentMap)!, data: diffMapForVisualization }
      : null,
    [newMap, currentMap, diffMapForVisualization]);
  const lambdaVisualMap = useMemo(
    () => (correctionMap && newMap) ? { ...newMap, data: correctionMap } : null,
    [newMap, correctionMap]);
  /** The RF KORR grid and surface, from the one selection they share. Memoised for the same reason
   *  as the two above — MapVisualizer is memoised, and a fresh object each render defeats it. */
  const rfKorrSurface = useMemo(
    () => tunedRfKorr ? rfKorrViewData(tunedRfKorr, rfKorrView) : null,
    [tunedRfKorr, rfKorrView]);

  /** Whether the visualisation box has anything in it for the current view. GRAPH is a destination,
   *  and a destination that lands on an empty box is worse than one that is greyed out. STARTUP is
   *  the only view that never has one; the log tab does, it is just 2D. */
  const graphHasContent = !!(
    (activeTab === 'current' && currentMap) ||
    (activeTab === 'new' && newMap) ||
    (activeTab === 'diff' && diffMapForVisualization && (newMap || currentMap)) ||
    (activeTab === 'lambda' && correctionMap && newMap) ||
    (activeTab === 'warmup' && warmupMap) ||
    (activeTab === 'wot' && wotMap) ||
    (activeTab === 'rfkorr' && tunedRfKorr) ||
    (activeTab === 'log' && processedLog)
  );

  /** Standing on a destination that has stopped existing. Two ways to get there: the view changed
   *  under you and has no picture, or the phone was rotated back to portrait and the graph went home
   *  to the dash pane. Both land on DASH, which is where the graph now is in the second case. */
  useEffect(() => {
    if (narrowPane === 'graph' && (!splitGraph || !graphHasContent)) setNarrowPane('dash');
  }, [narrowPane, splitGraph, graphHasContent]);

/**
 * What the derived WOT map is actually claiming, said where the switch is.
 *
 * karter16 asked what criteria this uses, noting that at WOT the S54 is not chasing stoich
 * (thread 242281 #161). It is a fair question and the honest answer is short: it does not chase
 * stoich either. It carries BMW's own enrichment ratio forward unchanged and moves the whole
 * curve by however much the airflow estimate turned out to be wrong.
 */
const WOT_CRITERION =
  'EXPERIMENTAL. NewWOT(rpm) = NewVE(rpm, 100 % RO) x ( StockWOT(rpm) / StockVE(rpm, 100 % RO) ).\n\n'
  + 'It does NOT target lambda 1.0 at WOT. The ratio StockWOT/StockVE is the enrichment BMW chose, and it is preserved exactly — the only claim made is that an airflow error measured at the top of the part-throttle map is the same error at full throttle, so the WOT map moves by the same factor.\n\n'
  + 'Two things it cannot promise. The scaling of 0xB5A is still unverified against a known-good binary. And it is only as good as the top load row: that row has to have been driven, with WOT TH on so the lambda integrator was still running up there. Both are gated — the switch stays locked until they hold.';

  const derivedTablesLocked = !newMap;
  const derivedTablesLockReason = 'Needs a tune first — these tables are derived from the tuned map. Record a log (START TUNE) or load one, then they unlock.';
  /**
   * WRITE WOT needs more than a tune, and what it needs is evidence in one specific row.
   *
   * `generateWOTMap` scales BMW's own WOT map by how far the tuned VE map moved at the TOP load
   * row: NewWOT(rpm) = NewVE(rpm, maxLoad) x (StockWOT(rpm) / StockVE(rpm, maxLoad)). That is a
   * defensible criterion — it preserves the enrichment ratio BMW chose and never chases lambda 1.0
   * at WOT, which is what karter16 asked about (thread 242281 #161). But it is only worth anything
   * if the top row actually moved for a measured reason.
   *
   * On a real drive it usually has not. Session #901 held RO >= 20 % for at most 3.5 s and #902 for
   * 2.9 s; neither came close to filling the 100 % row. Multiplying stock by cells that never
   * cleared the evidence gate is extrapolation wearing a measurement's clothes.
   *
   * Three cells, matching the rf_korr tuner's own `gridCellsUpdated >= 3` — the WOT map spans 700
   * to 8000 rpm, and one lucky cell cannot speak for that.
   */
  const wotEvidenceCells = useMemo(() => {
    if (!hitMap?.length) return 0;
    const top = hitMap[hitMap.length - 1];          // maxLoad row: what interpolateMap reads at 100 %
    const min = filterConfig.minVeCellSamples ?? 10;
    return top.reduce((n, hits) => n + (hits >= min ? 1 : 0), 0);
  }, [hitMap, filterConfig.minVeCellSamples]);

  /**
   * And the log has to have been recorded with VL suppressed.
   *
   * Without the WOT-threshold patch the DME declares full load and switches lambda control off, so
   * the integrator freezes — `KF_BZ_WDK_VL` to 102.3 % is what keeps it running up there
   * (docs/ecu-logic/60-tuning-logic.md 3.3). A top row built from a frozen integrator says nothing
   * about mixture, and scaling BMW's WOT map by it would carry that nothing straight into the bytes.
   */
  const wotPatchWasOn = applyWotDisable || !!patchStatus?.wotDisabled;
  const wotLocked = derivedTablesLocked || !wotPatchWasOn || wotEvidenceCells < 3;
  const wotLockReason = derivedTablesLocked
    ? derivedTablesLockReason
    : !wotPatchWasOn
      ? 'Needs a log recorded with WOT TH on (KF_BZ_WDK_VL = 102.3 %). Without it the DME enters full load, lambda control switches off and the integrator freezes — the top load row would be built from a number that stopped measuring.'
      : `Needs evidence at the top load row: ${wotEvidenceCells} of ${hitMap?.[0]?.length ?? 0} cells there cleared the gate, and this needs 3. The WOT map is BMW's own map scaled by how far that row moved, so without it there is nothing to scale by. Hold 100 % RO for longer, or lower the gate in the log filter panel.`;


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
  /** Asks first only when there is something to lose. Disconnected with no log and no unsaved tune,
   *  a reload costs nothing and a confirmation would just be a step.
   *
   *  Shared by the menu row and the header control, which are the same action reached from the two
   *  layouts. Not `location.reload()` — with the offline cache in front of it that reloads the build
   *  already on disk, which is the one being offered as a replacement. */
  const handleReload = useCallback(() => {
    const busy = dmeLink.state !== 'disconnected' || !!processedLog || !!newMap;
    if (busy && !confirm(dialogText().reloadBusy)) return;
    void reloadForUpdate();
  }, [dmeLink.state, processedLog, newMap]);

  const narrowPaneTabs = (
    <div className="flex min-[900px]:hidden space-x-6 h-full shrink-0">
      {([['map', 'MAP', true, ''], ['graph', 'GRAPH', graphHasContent, SPLIT_ONLY_SHOW], ['dash', 'DASH', true, '']] as const).map(([id, label, enabled, shown]) => (
        <button
          key={id}
          type="button"
          disabled={!enabled}
          onClick={() => setNarrowPane(id)}
          className={`relative h-full ${shown || 'flex'} items-center shrink-0 whitespace-nowrap text-[10px] font-bold tracking-widest transition-all ${narrowPane === id
            ? 'text-blue-400 border-t-2 border-blue-400'
            : enabled ? 'text-slate-500 hover:text-slate-300 border-t-2 border-transparent'
              : 'text-slate-700 border-t-2 border-transparent cursor-default'}`}
        >
          {label}
        </button>
      ))}
    </div>
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
          {isPreviewBuild && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold text-amber-300 bg-amber-500/15 whitespace-nowrap">
              PREVIEW
            </span>
          )}
          {/* The version doubles as the way in to CREDITS. It is the one label in this strip that is
              pure identity and carries no state, so nothing is lost by making it a control — and
              attribution has to be reachable from a phone that has only ever seen the installed PWA,
              never the README. Not in the disclaimer: that has a "don't show again" box. */}
          <button
            onClick={() => setCreditsDialogOpen(true)}
            title="CREDITS"
            className="shrink-0 text-[9px] font-mono text-slate-500 hover:text-slate-300 whitespace-nowrap transition-colors cursor-pointer"
          >
            V2.1.1 β
          </button>
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
          {/* Grid size, and the only control in this header that is meant to be used while moving.
              It lives here because below 900px the rest of this cluster does not render at all, so
              the right end of the header is empty — and because the alternative, the footer's icon
              row, is the MAP pane's own controls and already three wide.

              Only while the grid is the thing on screen. It adjusts nothing else, and a control that
              does nothing where it stands is worse than one that is absent.

              `py-3 -my-3` for the hit box: the header renders its contents at ~16px and this is a
              touchscreen at arm's length. The padding is cancelled by the margin, so the row still
              lays out at 16 and nothing in the header moves. Disabled at the ends of the range
              rather than hidden — a control that vanishes at the limit takes the way back with it. */}
          {narrowPane === 'map' && (
            <div className="flex items-center gap-1 min-[900px]:hidden">
              {([['−', -1, mapZoom.atMin], ['＋', 1, mapZoom.atMax]] as const).map(([glyph, dir, at]) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => mapZoom.nudge(dir)}
                  disabled={at}
                  aria-label={dir > 0 ? 'Zoom the grid in' : 'Zoom the grid out'}
                  className={`w-10 py-3 -my-3 flex items-center justify-center text-base leading-none transition-colors ${at ? 'text-slate-700 cursor-default' : 'text-slate-400 hover:text-slate-200 cursor-pointer'}`}
                >
                  {glyph}
                </button>
              ))}
            </div>
          )}

          {/* Privacy policy, on the sibling site. First in the cluster because it is the least of
              the three, and because putting it here leaves the one labelled link anchored to the
              right edge where it already sits.

              Hover goes to neutral slate, NOT to an accent like the Tuning Source link below. This
              states no machine state, so it has no business borrowing a semantic colour — the same
              reason the GitHub link beside it is neutral.

              `_blank` is not decoration: a same-tab navigation would drop the serial link and take
              an unsaved run with it. */}
          <a
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors"
            title="Privacy Policy"
          >
            <Shield className="w-5 h-5" />
          </a>

          {/* GitHub Link */}
          <a
            href="https://github.com/mushitaro/mss54hp-csl-convert-tuner"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:block text-slate-500 hover:text-slate-300 transition-colors"
            title="View on GitHub"
          >
            <Github className="w-5 h-5" />
          </a>

          {/* Forum Link */}
          <a
            href="https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden min-[900px]:flex text-slate-500 hover:text-amber-400 transition-colors items-center gap-2 group"
            title="Methodology Source: NA M3 Forum"
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-[10px] uppercase font-bold tracking-wider whitespace-nowrap">Tuning Source</span>
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

              The label keeps a stated width so announcing an update cannot move the header — the
              house rule that a thing which appears and disappears must not resize anything applies
              to a word changing length just as much as to an element arriving. */}
          {/* Sync, immediately before RELOAD — the same pairing the menu sheet uses, so the two
              viewports are the same two controls in the same order rather than two designs.

              Icon-only here. The header is the one row in the app with a stated budget, and the
              menu's wording ("Sync 3 sessions", "Offline — 3 waiting") is 20-odd characters that
              would have to grow and shrink in place. The count rides on the icon as a superscript
              instead, which is the whole of what a glance needs; `title` carries the sentence.

              Hidden below 900px like RELOAD beside it: that is where the menu sheet takes over, and
              both controls live in it. Absent entirely on production — see syncStatus. */}
          {syncLook && (
            <button
              type="button"
              onClick={syncLook.disabled ? undefined : () => { void handleSyncAll(); }}
              disabled={syncLook.disabled}
              title={syncLook.title}
              className={`hidden min-[900px]:flex items-center gap-1 shrink-0 py-3 -my-3 transition-colors ${syncLook.tone === 'ready' ? 'text-blue-400 hover:text-blue-300 cursor-pointer'
                : syncLook.tone === 'error' ? 'text-red-400 hover:text-red-300 cursor-pointer'
                  : syncLook.tone === 'busy' ? 'text-slate-500 animate-pulse cursor-wait'
                    : 'text-slate-700 cursor-default'}`}
            >
              <UploadCloud className="w-4 h-4 shrink-0" />
              {/* A stated width, so a count arriving or leaving cannot shift RELOAD sideways — the
                  same house rule the label below follows. */}
              <span className="w-[10px] text-left text-[9px] font-bold font-mono leading-none">
                {(syncStatus?.pending ?? 0) > 0 ? syncStatus?.pending : ''}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={handleReload}
            title={updateAvailable
              ? 'A newer build is on the server — reload to take it'
              : 'Reload the app'}
            /* `py-3 -my-3` for the hit box: the head unit this runs on is a touchscreen, and the
               header's own convention renders these at 16px tall. The padding is cancelled by the
               margin so the row still lays out at 16 and nothing moves. Vertical only — the gap to
               the link beside it is 16px, and horizontal padding would consume all of it. */
            className={`hidden min-[900px]:flex items-center gap-2 shrink-0 py-3 -my-3 transition-colors cursor-pointer ${updateAvailable ? 'text-blue-400 hover:text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <RefreshCw className="w-4 h-4 shrink-0" />
            <span className="w-[52px] text-left text-[10px] uppercase font-bold tracking-wider whitespace-nowrap">
              {updateAvailable ? 'Update' : 'Reload'}
            </span>
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
            <div className="h-full hidden min-[900px]:flex items-center ml-auto border-l border-slate-800 pl-4 ml-4 gap-4">
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
                <FilterConfigPanel config={filterConfig} onConfigChange={handleConfigChange} readOnly={isArchived} hasTabg={logHasTabg} routeGap={routeGap} routeSamples={routeSamples} />
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
                  <Database className={`w-3 h-3 transition-colors ${saveLook.disabled ? 'text-slate-700' : 'text-slate-600 group-hover:text-amber-400'}`} />
                  {/* Just "Save" here, not describeSave's full label. This bar is a fixed 26px row
                      that already carries the session name, the draft/archived badge and the BASE
                      origin, and "Save — nothing to record" is wide enough to squeeze the badge out
                      of a narrow window. The reason lives in the tooltip, and the disabled styling
                      is what says it cannot be pressed. The menu sheet, which has a full row per
                      control, shows the whole sentence. */}
                  <span className={`text-[9px] font-bold uppercase tracking-widest transition-colors ${saveLook.disabled ? 'text-slate-700' : 'text-slate-500 group-hover:text-amber-400'}`}>
                    Save
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
                    onClick={syncLook.disabled ? undefined : () => { void handleSyncAll(); }}
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

          {/* Grid Container */}
          <div className="flex-1 overflow-auto relative">
            {/* Content */}
            <div className="absolute inset-0 pt-2 pb-2 px-4">
              {(activeTab === 'current' && currentMap) && <MapEditor mapData={currentMap} hitData={hitMap ?? undefined} {...coverageBands} weightData={weightMap ?? undefined} zoom={mapZoom.zoom} />}
              {(activeTab === 'new' && newMap) && (
                <div className="h-full w-full flex flex-col">
                  {/* What this log actually earned. The same shape of census RfKorrTable puts under
                      its grid, and here for the same reason: the evidence gate is adjustable, and a
                      threshold you cannot see the cost of is not one you can choose. Three numbers,
                      because "40 cells written" means nothing without knowing the log touched 120
                      and the map has 480. */}
                  {veCalc.coverage && (
                    <div className="shrink-0 px-3 py-1.5 bg-slate-900/50 border-b border-slate-800 text-[10px] font-mono text-slate-500">
                      <span className={veCalc.coverage.withEvidence === 0 ? 'text-red-400' : 'text-slate-300'}>
                        {veCalc.coverage.withEvidence}
                      </span>
                      {` of ${veCalc.coverage.total} cells met the evidence gate`}
                      <span className="text-slate-600">
                        {`  ·  ${veCalc.coverage.withAnyData} touched by this log`}
                        {`  ·  gate ${filterConfig.minVeCellSamples ?? 10} samples / weight ${filterConfig.minVeCellWeight ?? 5}`}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    <MapEditor
                      mapData={newMap}
                      hitData={hitMap || undefined} {...coverageBands}
                      weightData={weightMap || undefined}
                      zoom={mapZoom.zoom}
                    />
                  </div>
                </div>
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
                      mapData={diffVisualMap!}
                      diffData={diffMapForVisualization || undefined}
                      hitData={hitMap || undefined} {...coverageBands}
                      weightData={weightMap || undefined}
                      zoom={mapZoom.zoom}
                    />
                  </div>
                </div>
              )}
              {(activeTab === 'lambda' && correctionMap && newMap) && (
                <MapEditor
                  mapData={lambdaVisualMap!}
                  hitData={hitMap || undefined} {...coverageBands}
                  weightData={weightMap || undefined}
                  zoom={mapZoom.zoom}
                />
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

              {(activeTab === 'wot' && wotMap) && (
                <MapEditor mapData={wotMap} zoom={mapZoom.zoom} />
              )}

              {activeTab === 'inertia' && (
                <div className="h-full w-full overflow-y-auto p-3">
                  <InertiaWorkflow
                    startRun={dmeLink.startInertiaRun}
                    stopRun={dmeLink.stopTuning}
                    baseImage={binaryFileState.binaryBuffer}
                  />
                </div>
              )}

              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0">
                  <LogDataTable
                    data={displayedLogWindow}
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
                    onUploadLog={canSync(uploadSettings) ? handleUploadSessionLog : undefined}
                    uploadState={uploadState}
                    onFinalize={handleFinalizeSession}
                    /* Preview only, for the same reason the sync controls are — production has no
                       `/api` for this to talk to, so a store panel there could only ever report
                       failures. */
                    headerExtra={isPreviewBuild ? (
                      <SessionStorePanel
                        onSettingsChange={setUploadSettings}
                        onRestored={() => void sessionDb.refresh()}
                      />
                    ) : undefined}
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
        <div className={`[grid-area:1/1] flex min-[900px]:[grid-area:auto] ${narrowPane !== 'map' ? '' : 'invisible pointer-events-none min-[900px]:visible min-[900px]:pointer-events-auto'} min-h-0 min-[900px]:flex-none min-[900px]:h-full min-[900px]:w-[38.2%] flex-col bg-slate-900/20 backdrop-blur-sm relative z-20 overflow-hidden`}>

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
              {graphOnScreen && (activeTab === 'current' && currentMap) && <MapVisualizer mapData={currentMap} title="" zAxisLabel="RF %" />}
              {graphOnScreen && (activeTab === 'new' && newMap) && <MapVisualizer mapData={newMap} title="" zAxisLabel="RF %" />}
              {/* The two signed maps. Their neutral value differs — useComparison emits a percentage
                  difference (no change = 0), the VE calculator emits an STFT multiplier (no change =
                  1.0) — so each states its own midpoint rather than letting the scale guess. */}
              {graphOnScreen && (activeTab === 'diff' && diffMapForVisualization && (newMap || currentMap)) && (
                <MapVisualizer mapData={diffVisualMap!} title="" zAxisLabel="Diff %" scale="deviation" deviationMidpoint={0} />
              )}
              {graphOnScreen && (activeTab === 'lambda' && correctionMap && newMap) && (
                <MapVisualizer mapData={lambdaVisualMap!} title="" zAxisLabel="Lambda" scale="deviation" deviationMidpoint={1} />
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
              {graphOnScreen && (activeTab === 'rfkorr' && tunedRfKorr) && (
                <MapVisualizer
                  mapData={rfKorrSurface!.map}
                  title=""
                  xAxisLabel={RF_KORR_COL_LABEL}
                  yAxisLabel={RF_KORR_ROW_LABEL}
                  zAxisLabel={rfKorrSurface!.zAxisLabel}
                  scale="deviation"
                  deviationMidpoint={rfKorrSurface!.deviationMidpoint}
                />
              )}
              {graphOnScreen && (activeTab === 'warmup' && warmupMap) && <MapVisualizer mapData={warmupMap} title="" zAxisLabel="RF %" />}
              {graphOnScreen && (activeTab === 'wot' && wotMap) && <MapVisualizer mapData={wotMap} title="" zAxisLabel="RF %" />}
              {(activeTab === 'log' && processedLog) && (
                <div className="h-full w-full pb-0 relative">
                  {/* Chart Container - Absolute fill; chart flexes, window-scrub slider docked below it
                      (moved off the tab bar so tab scrolling isn't squeezed by it). */}
                  <div className="absolute inset-0 flex flex-col">
                    <div className="flex-1 min-h-0">
                      <LogTimeSeriesChart
                        data={displayedLogWindow}
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
            <div className={`flex ${narrowPane === 'graph' ? SPLIT_ONLY_HIDE : SPLIT_ONLY_GROW} flex-initial min-h-0 overflow-y-auto px-5 pt-2 pb-2 [@media(min-height:560px)]:pt-4 [@media(min-height:560px)]:pb-5 flex-col`}>

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
                    {/* Did the record reach the store? Silent-ish when it did (a tick and the size
                        on hover), plain when it did not. This sits with TIMING because they describe
                        the same artifact: the file you can save and the copy that went up. */}
                    {diagUpload.state !== 'idle' && (
                      <span
                        className={`text-[10px] font-mono ${diagUpload.state === 'stored' ? 'text-slate-600'
                          : diagUpload.state === 'sending' ? 'text-slate-500 animate-pulse'
                            : 'text-red-400'}`}
                        title={diagUpload.state === 'stored' ? `Diagnostic stored (${diagUpload.bytes} B compressed).`
                          : diagUpload.state === 'sending' ? 'Sending the diagnostic record…'
                            : diagUpload.state === 'none' ? 'Nothing to send — this operation produced no report, no events and no error.'
                              : `Diagnostic NOT stored: ${diagUpload.reason}

The TIMING button still has the full record; save it before running another operation.`}
                      >
                        {diagUpload.state === 'stored' ? 'DIAG ✓'
                          : diagUpload.state === 'sending' ? 'DIAG …'
                            : diagUpload.state === 'none' ? 'DIAG —' : 'DIAG ✕'}
                      </span>
                    )}
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
                        {/* Baud only applies to a real DME, so it's hidden under PRACTICE — but it stays
                            mounted and keeps its box. Unmounting it shrank this row, which shoved the
                            PRACTICE checkbox sideways out from under the pointer as you clicked it. */}
                        <label
                          className={`flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer ${dmeLink.mockMode ? 'invisible pointer-events-none' : ''}`}
                          aria-hidden={dmeLink.mockMode}
                          title={'Bulk-read baud rate. These are the only three the DME implements — asked for anything else it answers 0xB0 PARAMETER_ERROR and the read silently falls back to 9600.\n\n'
                            + '9600 — the default, the proven path, and on this car the only one that works. Sends no switch at all. 122.9s on desktop, 126.5s on Android, reproducibly. The wire is at its floor here: measured response 143.6ms against a theoretical 144.4, parked/total 98.8%.\n\n'
                            + '38400 — CLOSED, negative. Eleven attempts across both transports and all four block sizes died at exchange 0/0/0/1/3/5/6/15/22/23/116 of 538, every one "Timed out waiting for 2 byte(s) (received 0)" after five retries. The DME sends nothing — never a corrupted frame — and the death position does not track the block size. Android/WebUSB changes baud on the open handle with no port close/reopen and fails identically, which rules out the last host-side suspect. karter16 reached the same verdict: it was not stable enough to make a feature of.\n\n'
                            + '125000 — not reachable from a read at all. Per karter16 the DME only accepts it while in programming mode, and the bootloader has no way into programming mode over DS2 except through a valid flash wipe. It is a live option for the WRITE path, which erases anyway; it was never going to work here.\n\n'
                            + 'Both are left selectable because a different cable or a different car may answer differently, and a failed READ costs nothing but the attempt. Do not expect either to work on this one.'}

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
                        {/* What a WRITE will prove. Here rather than inside the confirm dialog because
                            the dialog's job is to state the consequence of the thing about to happen —
                            it names this mode in its text — and a control that changes the consequence
                            while the warning is on screen is the wrong shape for a destructive gate.
                            Opens on FULL for a DME that has never had the two checks agree; see
                            verifyPolicy.ts. */}
                        <label
                          className="flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer"
                          title={'How the flash proves it landed. Every chunk\'s verify byte is checked in BOTH modes — this chooses what happens after the last one.\n\n'
                            + 'QUICK — ask the DME for its own encoding checksum (DS2 0x0A). One exchange, ~50ms. Its authority is the CRC-16/ARC values the ECU stores in its own flash, covering 65528 of the pair\'s 65536 bytes. It cannot say WHERE a mismatch is, and it cannot catch a corruption that preserves CRC-16.\n\n'
                            + 'FULL — everything QUICK does, and read all 65536 bytes back and compare them byte for byte. Adds ~123s. The only check that can name an offset.\n\n'
                            + 'This opens on FULL until QUICK and FULL have agreed once on this VIN.'}
                        >
                          VERIFY
                          <select
                            value={verifyMode}
                            disabled={dmeLink.state !== 'connected'}
                            onChange={(e) => setVerifyMode(e.target.value as WriteVerifyMode)}
                            className="bg-slate-800 text-[9px] font-mono text-slate-300 rounded px-1 py-0.5 outline-none cursor-pointer border border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <option value="quick">QUICK</option>
                            <option value="full">FULL</option>
                          </select>
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
                    // The diagnostic outcome rides on the SAME line as the operation's own result.
                    //
                    // It was only a 10px marker up in the DME row, and that was reported as "the DIAG
                    // text does not appear anywhere" after a real read — which is the second time a
                    // number that mattered has been put somewhere too small to find in a car (the
                    // read's own throughput was the first, at 9px/slate-500). This line is the one
                    // surface already proven readable from the driver's seat, and a record that did
                    // not reach the store is exactly as much a result of the operation as its speed.
                    const diagTail = diagUpload.state === 'stored' ? ' · DIAG OK'
                      : diagUpload.state === 'failed' ? ` · DIAG FAILED: ${diagUpload.reason}`
                        : diagUpload.state === 'sending' ? ' · DIAG…'
                          : diagUpload.state === 'none' ? ' · DIAG none' : '';
                    const notice = (dmeLink.error ?? warning) ? `${dmeLink.error ?? warning}${diagTail}` : (diagTail ? diagTail.slice(3) : null);
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
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
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
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${applyWotDisable ? 'text-blue-400' : 'text-slate-500'}`}>
                        WOT TH
                      </span>
                      <span className={`text-[11px] font-mono font-bold tracking-wider ml-1 whitespace-nowrap ${applyWotDisable ? 'text-amber-500' : 'text-slate-500'}`}>
                        {applyWotDisable ? '102.3' : 'OEM'}
                      </span>
                    </div>

                    {/* ROW 1b: TANK VENT — the emissions one, and the only switch here that leaves
                        the car in a state it must not be driven in long-term.

                        Beside WOT TH because they are the same shape of thing: both are calibration
                        changes that exist to make a log measurable and both have to be put back.
                        Given its own label rather than being folded into the patch pair, because
                        those two are reversible from the driver's seat and this one stops the
                        charcoal canister being purged.

                        RED when armed, not amber. In this palette `amber-*` is aliased to the
                        M-violet ramp (text-amber-400 resolves to #B9A6EE), and violet already means
                        "derived diagnostic" — see globals.css and the log field registry. Blue means
                        "tuning option", which this is not: it is the one switch on the hub that
                        leaves an emissions device off. Red is the only honest step here. */}
                    <div className="h-7 flex items-center gap-3 ml-1 opacity-90 hover:opacity-100 transition-opacity shrink-0">
                      <label
                        className="py-3 -my-3 px-2 -mx-2 relative inline-flex items-center cursor-pointer group"
                        title={'Holds the tank-vent (evaporative purge) valve shut, by writing K_TE_TVTE_GA = 0 at slave 0xBF1 (stock 0x80).\n\n'
                          + 'Why: purged vapour is fuel the DME did not inject, so the lambda controller trims for it — and that trim is the single input this app derives the VE correction from. Measured on this car (Session #902): the valve was open for 82.8% of a 657s drive, at up to 99.9% duty. The stock map asks 94-99.6% above 2500 rpm at mid load, which is exactly where a tune is worth having.\n\n'
                          + 'Confirmed at instruction level: tetv_calc (slave 0x26ED6) is the only reader of this byte and the only writer of a non-zero duty, and zero forces exactly shut rather than a minimum.\n\n'
                          + 'TUNING ONLY. The canister stops being purged and will saturate; DTC 24 is the code for a valve that will not open. Turn this back off and write once more before driving the tune. The filename carries _TEVOFF while it is armed.'}
                      >
                        <input type="checkbox" className="sr-only peer" checked={applyTankVentDisable} disabled={dmeLink.state === 'writing'} onChange={(e) => setApplyTankVentDisable(e.target.checked)} />
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-900 peer-checked:after:bg-red-400"></div>
                      </label>
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${applyTankVentDisable ? 'text-red-400' : 'text-slate-500'}`}>
                        TANK VENT
                      </span>
                      <span className={`text-[11px] font-mono font-bold tracking-wider ml-1 whitespace-nowrap ${applyTankVentDisable ? 'text-red-400' : 'text-slate-500'}`}>
                        {applyTankVentDisable ? 'SHUT' : 'OEM'}
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
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span
                        className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${!derivedTablesLocked && writeWarmup ? 'text-blue-400' : 'text-slate-500'}`}
                        title={derivedTablesLocked ? derivedTablesLockReason : undefined}
                      >
                        {compact ? 'WARMUP' : 'WRITE WARMUP'}
                      </span>
                    </div>

                    {/* ROW 3: WRITE WOT — locked harder than its neighbour above. WRITE WARMUP needs only a
                        tune; this one also needs the top load row to have been measured, and the log to
                        have been taken with VL suppressed. See wotLocked. */}
                    <div className={`h-7 flex items-center gap-4 ml-8 pl-1 shrink-0 transition-opacity ${wotLocked ? 'opacity-40' : ''}`}>
                      <label
                        className={`py-3 -my-3 px-2 -mx-2 relative inline-flex items-center group ${wotLocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={wotLocked ? wotLockReason : WOT_CRITERION}
                      >
                        <input type="checkbox" className="sr-only peer" checked={!wotLocked && writeWot} disabled={wotLocked || dmeLink.state === 'writing'} onChange={(e) => setWriteWot(e.target.checked)} />
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span
                        className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${!wotLocked && writeWot ? 'text-blue-400' : 'text-slate-500'}`}
                        title={wotLocked ? wotLockReason : WOT_CRITERION}
                      >
                        {compact ? 'WOT' : 'WRITE WOT'}
                      </span>
                    </div>

                    {/* ROW 4: WRITE RF KORR (Close to Ring)
                        The fourth member of the family above: a table derived from this tune and
                        injected at flash time. Same shape, same lock behaviour, same reason for
                        deriving `checked` from the gate rather than clearing the stored flag.

                        Its gate is stricter than derivedTablesLocked, and not by preference. The
                        other two need only a tuned map; this one needs the binary's EGT tables to
                        decode, an exhaust temperature in the log to index Δ with, a back-calculation
                        that met its own evidence thresholds, and the PATCH on. rfKorrLockReason
                        names whichever is missing.

                        The arc is 1-8-8-1 now rather than 1-8-1: the middle two are pushed out, so a
                        fourth row extends the convex shape instead of breaking it. */}
                    <div className={`h-7 flex items-center gap-3 ml-1 transition-opacity shrink-0 ${canTuneRfKorr ? 'opacity-90' : 'opacity-40'}`}>
                      <label
                        className={`py-3 -my-3 px-2 -mx-2 relative inline-flex items-center group ${canTuneRfKorr ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                        title={canTuneRfKorr ? undefined : rfKorrLockReason}
                      >
                        <input type="checkbox" className="sr-only peer" checked={rfKorrArmed} disabled={!canTuneRfKorr || dmeLink.state === 'writing'} onChange={(e) => setWriteRfKorr(e.target.checked)} />
                        <div className="relative w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span
                        className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${rfKorrArmed ? 'text-blue-400' : 'text-slate-500'}`}
                        title={canTuneRfKorr ? undefined : rfKorrLockReason}
                      >
                        {compact ? 'RF KORR' : 'WRITE RF KORR'}
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

      {/* MOBILE FOOTER — the app's controls for a window that cannot spare a row at the top.
          Outside both panes on purpose: each pane hides the other below 900px, so anything living
          inside one of them takes the way back out of the other with it.

          MENU is centred absolutely rather than by flex order, so it stays on the screen's centre
          line whatever the groups either side of it happen to weigh — the pane labels are two short
          words today and the config cluster is three icons, and neither is a promise.

          The record counts sit ABOVE the control row rather than below it: below is the screen
          edge, where Android's gesture bar is, and a 9px readout is not something to put there. */}
      <div className="min-[900px]:hidden flex-none z-30 border-t border-slate-900 bg-slate-900/50 backdrop-blur-sm">
        {processedLog && (
          <div className="h-[16px] flex items-center justify-end gap-4 px-4">
            <span className="flex items-center gap-1.5 text-[9px] font-mono leading-none">
              <span className="text-slate-500">VALID</span>
              <span className="text-blue-400 font-bold">{processedLog.validCount.toLocaleString()}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[9px] font-mono leading-none">
              <span className="text-slate-600">TOTAL</span>
              <span className="text-slate-500">{(processedLog.validCount + processedLog.droppedCount).toLocaleString()}</span>
            </span>
          </div>
        )}
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
              enabled={filterConfig.enableCorrection}
              onToggle={(enabled) => handleConfigChange({ ...filterConfig, enableCorrection: enabled })}
              readOnly={isArchived}
              openUp
            />
            <FilterConfigPanel config={filterConfig} onConfigChange={handleConfigChange} readOnly={isArchived} hasTabg={logHasTabg} routeGap={routeGap} routeSamples={routeSamples} openUp />
            <FieldVisibilityPanel
              visibleFields={fieldVisibility.visibleFields}
              onToggle={fieldVisibility.toggleField}
              onShowCoreOnly={fieldVisibility.showCoreOnly}
              onShowAll={fieldVisibility.showAll}
              openUp
            />
          </div>
        </div>
      </div>

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

      {/* Above every other dialog in the app (DialogFrame is z-100/110), which is right: the
          messages routed here are the ones that stop a sequence — a run has ended, a write is about
          to go out, a write did not. Nothing should be able to paint over them. */}
      {message && <MessageDialog message={message} closeLabel={dialogText().btnClose} />}

      {menuOpen && (
        <MobileMenu
          onClose={() => setMenuOpen(false)}
          dragFrom={menuDrag}
          onDragEnd={() => setMenuDrag(null)}
          updateAvailable={updateAvailable}
          onReload={handleReload}
          installState={install.state}
          onInstall={() => { void install.promptInstall(); }}
          sync={syncStatus}
          onSync={() => { void handleSyncAll(); }}
          save={saveStatus}
          onSave={() => { void handleSaveSession(); }}
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
          onOpenFlash={() => setFlashDialogOpen(true)}
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
          /* Assembled here rather than inside the menu so the conditions stay next to the ones the
             desktop session bar uses — the same guards, not a second copy that can drift from them.
             DOWNLOAD PATCH-ON / TUNED are one builder split on whether a tune exists, and both stand
             down during a live run because bytes written mid-run would claim to be a finished one. */
          actions={[
            ...(currentSession && binaryBuffer && !newMap && (applyPatch || applyWotDisable) && dmeLink.state !== 'tuning'
              ? [{ label: 'Download Patch-On', kind: 'bin' as const, onClick: handleDownloadBin,
                   hint: 'The BASE with the PATCH applied and the checksum corrected — the exact bytes WRITE would send right now.' }] : []),
            ...(currentSession && binaryBuffer && newMap && dmeLink.state !== 'tuning'
              ? [{ label: 'Download Tuned', kind: 'bin' as const, onClick: handleDownloadBin,
                   hint: 'The TUNED bytes WRITE would send right now, built live from the current map and toggles.' }] : []),
            ...(currentSession?.baseOrigin
              ? [{ label: 'Download BASE', kind: 'base' as const, onClick: () => handleDownloadSessionBase(currentSession),
                   hint: "This session's BASE bytes — what it started from" }] : []),
            ...(currentSession && logFile
              ? [{ label: 'Download LOG CSV', kind: 'log' as const, onClick: () => handleDownloadSessionLog(currentSession),
                   hint: "This session's stored log" }] : []),
          ]}
        />
      )}

      {creditsDialogOpen && (
        <CreditsDialog
          onClose={() => setCreditsDialogOpen(false)}
          buildLabel={buildLabel ?? null}
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
