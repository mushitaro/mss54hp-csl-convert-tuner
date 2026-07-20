'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import { AlertCircle, CheckCircle, Download, FileCode, FileSpreadsheet, Settings, Power, Zap, Play, Thermometer, Cpu, Trash2, Github, BookOpen, Square, Loader2, RotateCcw, Eraser, PlugZap, Database, Upload } from 'lucide-react';
import { LogFilterConfig, InterpolationPoint, LogDataPoint } from '@/lib/types';
import { TuningSession, TuneSettings, BaseOrigin } from '@/lib/db/schema';
import { AdaptationSnapshot } from '@/lib/dme-link/types';
import { TUNE_ADAPTATION_CLEAR } from '@/lib/dme-link/ds2';
import { downloadBlob, fileSafe, MIME_BIN, MIME_CSV } from '@/lib/download';
import { serializeLogFile } from '@/lib/log-engine/serializer';
import { sha256Hex } from '@/lib/db/sessionRepository';
import { useBinaryFile } from '@/hooks/useBinaryFile';
import { useLogFile } from '@/hooks/useLogFile';
import { useVeCalculation } from '@/hooks/useVeCalculation';
import { useComparison } from '@/hooks/useComparison';
import { useSessionDb } from '@/hooks/useSessionDb';
import { useFieldVisibility } from '@/hooks/useFieldVisibility';
import { useDmeLink } from '@/hooks/useDmeLink';

type TabId = 'startup' | 'current' | 'lambda' | 'new' | 'diff' | 'log' | 'warmup' | 'wot';

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

export default function Home() {
  const binaryFileState = useBinaryFile();
  const logFileState = useLogFile();
  const veCalc = useVeCalculation();
  const sessionDb = useSessionDb();
  const fieldVisibility = useFieldVisibility();
  const dmeLink = useDmeLink();
  const comparison = useComparison(veCalc.newMap, binaryFileState.initialMapData, sessionDb.sessions);

  const [activeTab, setActiveTab] = useState<TabId>('startup');

  const liveSamplesRef = useRef<LogDataPoint[]>([]);
  const lastFlushRef = useRef<number>(0);
  // Hub/wing cluster auto-fit: measures real available space vs. the cluster's natural size and
  // returns a transform scale, so it always fits (any viewport) instead of estimating from raw
  // window dimensions.
  const { outerRef: clusterOuterRef, innerRef: clusterInnerRef, scale: clusterScale, minH: clusterMinH } = useFitScale(0.4);
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

  const {
    binaryFile, currentMap, binaryBuffer, patchStatus,
    applyPatch, setApplyPatch, applyWotDisable, setApplyWotDisable,
    writeWarmup, setWriteWarmup, writeWot, setWriteWot,
  } = binaryFileState;

  const {
    logFile, processedLog, filterConfig, interpolationTable,
    logWindowStart, setLogWindowStart, selectedLogIndex, setSelectedLogIndex,
    windowedLogData, LOG_WINDOW_SIZE,
  } = logFileState;

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
    setActiveTab('current');
  };

  const handleLogUpload = async (file: File) => {
    const processed = await logFileState.parseAndSetLog(file);
    if (processed && currentMap) {
      runCalculation(currentMap, processed.data);
      setActiveTab('diff'); // jump to the result only on the initial CSV load
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
    if (confirm('Are you sure you want to remove the CSV file?')) {
      logFileState.clear();
      veCalc.reset();
      if (activeTab === 'log' || activeTab === 'new' || activeTab === 'diff' || activeTab === 'lambda') {
        setActiveTab('current');
      }
    }
  };

  const handleDownloadBin = () => {
    binaryFileState.downloadBin(newMap);
  };

  // --- Session artifact downloads ---------------------------------------------------------------
  // These act on what the session has *stored*, which is what makes them unambiguous: the workspace
  // Download above the map builds bytes live from the current toggles, so it can't stand in for
  // these, and they can't stand in for it.

  const handleDownloadSessionBase = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert('This session has no stored binary.'); return; }
    downloadBlob(bins.baseBinaryBuffer, session.baseFileName ?? `${fileSafe(session.label)}_BASE.bin`, MIME_BIN);
  };

  const handleDownloadSessionTuned = async (session: TuningSession) => {
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins?.tunedBinaryBuffer) { alert('This session has no saved tune yet.'); return; }
    downloadBlob(bins.tunedBinaryBuffer, session.binaryFileName ?? `${fileSafe(session.label)}_TUNED.bin`, MIME_BIN);
  };

  const handleDownloadSessionLog = async (session: TuningSession) => {
    const points = await sessionDb.loadLog(session.id);
    if (!points?.length) { alert('This session has no stored log.'); return; }
    downloadBlob(serializeLogFile(points), `${fileSafe(session.label)}_log.csv`, MIME_CSV);
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

  // Clearing the log or swapping the BASE can disable the tab you're standing on; without this you'd
  // be stranded on a placeholder with its own tab greyed out.
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
    setActiveTab('startup');
    return created;
  };

  /** Opens a saved session. Draft -> keep tuning. Archived -> reference + flash only. */
  const handleOpenSession = async (session: TuningSession) => {
    if (!session.baseOrigin) { setActiveSessionId(session.id); setActiveTab('startup'); return; }
    const bins = await sessionDb.loadBinaries(session.id);
    if (!bins) { alert('This session has no stored binary.'); return; }

    resetDerived();
    setActiveSessionId(session.id);

    if (session.status === 'draft') {
      // Continue where it left off: the BASE is the working map.
      const map = await binaryFileState.loadFromBuffer(bins.baseBinaryBuffer, session.baseFileName ?? 'base.bin');
      if (!map) return;
      setActiveTab('current');
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
    if (!rebuilt) alert('This session could not be reconstructed from its stored log — flashing is disabled.');
    setActiveTab('current');
  };

  /** Starts a new session whose BASE is another session's TUNED (continue) or BASE (retry). */
  const handleNewFrom = async (session: TuningSession, which: NewFromWhich) => {
    const bins = await sessionDb.loadBinaries(session.id);
    const buffer = which === 'tuned' ? bins?.tunedBinaryBuffer : bins?.baseBinaryBuffer;
    if (!buffer) { alert(`This session has no ${which.toUpperCase()} binary.`); return; }

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
    setActiveTab('current');
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
    if (!target.baseOrigin) { alert('Set a BASE first (upload a BIN or read from the DME).'); return; }
    const patchedBuffer = binaryFileState.buildPatchedBuffer(newMap);
    if (!patchedBuffer) return;

    await sessionDb.saveSessionTune({
      sessionId: target.id,
      binaryFileName: binaryFileState.buildFileName(),
      tunedBinaryBuffer: patchedBuffer,
      veMapSnapshot: newMap,
      tuneSettings: buildSettings(),
      log: logFileState.rawLogData,
    });
    alert('Session saved.');
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
    setActiveTab('current');
  };

  const flushLiveSamples = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastFlushRef.current < 500) return;
    lastFlushRef.current = now;
    const processed = logFileState.loadRawLog([...liveSamplesRef.current], 'live-session.csv');
    if (processed && currentMap) {
      veCalc.runCalculation(currentMap, processed.data);
    }
  };

  const handleStartTune = () => {
    liveSamplesRef.current = [];
    lastFlushRef.current = 0;
    setLiveSample(null);
    dmeLink.startTuning((sample) => {
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
      setLiveSample(point); // live raw readout, independent of the VE filters
      flushLiveSamples(false);
    });
  };

  const handleStopTune = async () => {
    dmeLink.stopTuning();
    flushLiveSamples(true);

    // Logging runs with the engine going; writing needs it stopped, and stopping it ends the DME's
    // diagnostic session. So this connection physically cannot survive into the write — keeping it
    // on screen would just mean WRITE times out after the key cycle. Drop it and say what to do.
    await dmeLink.disconnect();
    alert(
      'データログを終了しました。\n\n' +
      'DMEへ書き込む場合は、次の手順で進めてください:\n' +
      '1. エンジンを停止(キーを OFF)\n' +
      '2. 再度イグニッションを ON にする(エンジンはかけない)\n' +
      '3. CONNECTION で接続し直す → WRITE\n\n' +
      '※ エンジンが回っているとDMEが書き込みを拒否します。\n' +
      '※ エンジンを止めると通信が切れるため、接続はここで解除しました。\n\n' +
      '書き込まない場合は、このまま Write Bytes で書き出せます(WRITEが送るバイト列そのもの)。'
    );
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
    const confirmed = confirm(
      'DMEへ書き込みます。\n\n' +
      `書き込む内容: ${newMap ? 'チューニング済みマップ' : '⚠ 未チューニング(読み込んだBINそのまま)'}\n` +
      (drift.length ? `\n⚠ 保存時と異なるオプションで書き込みます:\n  ${drift.join('\n  ')}\n` : '') +
      '\n⚠ エンジンが停止していること(キーOFF → 再度イグニッションON)を確認してください。\n' +
      '  エンジンが回っているとDMEが書き込みを拒否します。\n' +
      '⚠ 電源(バッテリー)を安定させてください。書き込みには約4分かかります。\n' +
      '  書き込み中は絶対に電源を切ったり、ケーブルを抜いたりしないでください。\n\n' +
      'チェックサムは自動補正されます。書き込み後にリードバック検証を行います。\n\n' +
      '続行しますか？'
    );
    if (!confirmed) return;

    const ok = await dmeLink.write(patchedBuffer);
    if (ok) {
      const target = currentSession ?? (await ensureDraft());
      const veMapSnapshot = newMap || currentMap;
      // saveSessionTune returns the updated record; `target` is a pre-save snapshot whose
      // binaryFileName is still unset for a draft, and re-tuning below needs that name.
      let flashed: TuningSession | null = target;
      if (target && veMapSnapshot) {
        // A draft's tune isn't in the DB yet; an archived session's already is and must not be
        // rewritten — only its flash history grows.
        if (target.status === 'draft' && target.baseOrigin) {
          flashed = await sessionDb.saveSessionTune({
            sessionId: target.id,
            binaryFileName: binaryFileState.buildFileName(),
            tunedBinaryBuffer: patchedBuffer,
            veMapSnapshot,
            tuneSettings: flashedSettings,
            log: logFileState.rawLogData,
          });
        }
        await sessionDb.recordFlash(target.id, {
          at: Date.now(),
          sha256: await sha256Hex(patchedBuffer),   // the bytes actually sent, not the stored ones
          settings: flashedSettings,
        });
        // These bytes are now in the ECU, so this session is a record of what was flashed, not a
        // workspace: archive it. Leaving it a draft let you keep tuning it afterwards, which would
        // drift its TUNED away from the bytes its own flash history points at — and the list would
        // show DRAFT and "flashed" at the same time. Continue via "Use as base -> TUNED".
        await sessionDb.archive(target.id);
      }

      // Post-write instruction: the DME must be power-cycled to reinitialize with the new data.
      alert(
        '✅ 書き込みが完了しました(リードバック検証OK)。\n\n' +
        '次の手順で終了してください:\n' +
        '1. イグニッションキーを OFF にする\n' +
        '2. そのまま 10秒間 待つ\n' +
        '3. キーを ON に戻す\n\n' +
        'DMEが新しいデータで再初期化されます。'
      );

      // The key-off power-cycle ends the DME's diagnostic session, so the serial connection is now
      // stale — disconnect to keep the UI honest. Reconnect when you want to read/verify again.
      await dmeLink.disconnect();

      // Re-tune: the next session starts from exactly the bytes now in the ECU. Asked here because
      // this is the moment you decide — otherwise you'd have to find the row and open its New From
      // menu. Same code path, so the BASE is still a copy and still provably the parent's TUNED.
      if (flashed?.binaryFileName && confirm(
        'このチューンの続きから、次のセッションを始めますか？\n\n' +
        'OK    = 新規セッションを作成(BASE = 今書き込んだTUNED)\n' +
        'キャンセル = セッション一覧に戻る'
      )) {
        await handleNewFrom(flashed, 'tuned');
        return;
      }
      setActiveTab('startup');
    }
  };

  /** Records what the DME had learned before this session's log was captured. Best-effort, and
   *  deliberately after the fact: by the time this runs the ECU is already cleared — that is the
   *  real side effect and it succeeded — so a failed bookkeeping write must not present itself as a
   *  failed reset. (The reference takes the same view: PreserveBeforeClearSnapshotAsync warns and
   *  carries on rather than aborting the clear.) */
  const handleAdaptationResetComplete = async (before: AdaptationSnapshot, after: AdaptationSnapshot) => {
    if (!currentSession) return; // unreachable: idleAction === 'tune' already requires a session
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

  /** Throws away the log just recorded so it can be re-driven, without touching the BASE. */
  const handleDiscardLog = () => {
    if (!confirm('Discard the log just recorded and start over?')) return;
    logFileState.clear();
    veCalc.reset();
    liveSamplesRef.current = [];
    setActiveTab('current');
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
  const idleAction: 'read' | 'tune' | 'write' =
    newMap ? 'write'
      : (currentMap && currentSession && !isArchived) ? 'tune'
        : 'read';

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
          // Tuning is a draft-only act: an archived session must never re-derive its own map.
          case 'tune': return { label: 'START TUNE', Icon: Play, onClick: handleStartTune, disabled: false, spin: false };
          case 'read': return { label: 'READ', Icon: Zap, onClick: handleDmeRead, disabled: false, spin: false };
        }
    }
  })();

  const dmeStatusColor = dmeLink.state === 'disconnected' ? 'bg-slate-600'
    : dmeLink.state === 'connecting' || dmeLink.state === 'reading' || dmeLink.state === 'writing' || dmeLink.state === 'resetting' ? 'bg-amber-500 animate-pulse'
      : dmeLink.error ? 'bg-red-500'
        : 'bg-emerald-500';

  return (
    <main className="h-screen flex flex-col bg-slate-950 font-sans text-slate-300 overflow-hidden selection:bg-blue-500/30">
      {/* App Header - Ultra Minimal */}
      <header className="px-6 py-3 flex justify-between items-center bg-slate-950/80 backdrop-blur-md border-b border-slate-900 z-10 shrink-0 h-[48px]">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className={`w-2 h-2 rounded-full ${dmeStatusColor} shadow-[0_0_8px_rgba(59,130,246,0.5)]`} title={`DME: ${dmeLink.state}${dmeLink.error ? ' — ' + dmeLink.error : ''}`}></div>
          <h1 className="shrink-0 text-sm font-bold tracking-widest text-slate-200 uppercase whitespace-nowrap overflow-hidden text-ellipsis">
            MSS54HP CSL CONVERT <span className="text-slate-600">///</span> TUNER
          </h1>
          <span className="shrink-0 text-[9px] font-mono text-slate-500 whitespace-nowrap">V2 β</span>
          <div className="flex-1 min-w-0 flex items-center gap-4 text-[9px] font-mono text-slate-500 whitespace-nowrap overflow-hidden ml-8 pl-8 border-l border-slate-800">
            <span>VIN <span className="text-slate-300">{dmeLink.identity?.vin ?? '-'}</span></span>
            <span>AIF <span className="text-slate-300">{dmeLink.identity?.aif ?? '-'}</span></span>
            <span>SW <span className="text-slate-300">{dmeLink.identity?.softwareVersion ?? '-'}</span></span>
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
        <div className="h-[40%] min-[900px]:h-full min-[900px]:w-[70%] flex flex-col border-b min-[900px]:border-b-0 border-r-0 min-[900px]:border-r border-slate-900 relative bg-slate-950/40 min-h-0">

          {/* Header Frame (Tabs) - Matches Right Column Header Height */}
          <div className="h-[44px] flex items-center px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none z-50">
            <div className="flex space-x-6 h-full mr-auto flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
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
                {/* Not "Download": that never said whether you got the BASE or the TUNED, and the
                    honest answer is neither — this builds the bytes live from the current map and
                    toggles, so it is the only way to inspect an unsaved tune in TunerPro before
                    flashing it. The session list downloads what each session has *stored*; this
                    downloads what WRITE would send right now. Both are needed, so both say which. */}
                {binaryBuffer && (
                  <button onClick={handleDownloadBin} className="group inline-flex items-center gap-1.5" title="Download the exact bytes WRITE would send right now — reflects the current map and toggles, saved or not">
                    <Download className="w-3 h-3 text-slate-600 group-hover:text-blue-400 transition-colors" />
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-blue-400 transition-colors">Write Bytes</span>
                  </button>
                )}
                {/* Keyed on there being a tune, not just bytes: Save records a TUNED, and with only a
                    BASE loaded there is no TUNED to record — the BASE was already stored when it was
                    chosen. Offering it anyway is what let a base-only session claim a tune. */}
                {newMap && !isArchived && (
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
                    selectedIndex={selectedLogIndex}
                    onRowClick={setSelectedLogIndex}
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
        <div className="flex-1 min-h-0 min-[900px]:flex-none min-[900px]:h-full min-[900px]:w-[30%] flex flex-col bg-slate-901/20 backdrop-blur-sm relative z-20 overflow-hidden">

          {/* Header Frame - Matches Left Column Height */}
          <div className="h-[44px] flex items-center justify-between px-4 border-b border-slate-900 bg-slate-900/50 backdrop-blur-sm flex-none">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Visualization & Inputs</span>
          </div>

          {/* CONTENT FLEX CONTAINER (6:4 Split) */}
          <div className="flex-1 flex flex-col min-h-0">

            {/* 3D Graph (Flex 7) */}
            {/* The visualizer is the elastic half. A 3D map reads fine at any size; the dial and its
                toggles do not. A fixed 7:3 split had it backwards — it pinned the picture and made
                the controls absorb every shortfall, squeezing the 80px dial down to 52px. */}
            <div className="flex-1 min-h-[140px] relative overflow-hidden bg-gradient-to-b from-slate-900/10 to-transparent">
              {/* Live raw telemetry readout — floats over the visualization during logging so it shows
                  the latest DME sample (independent of the VE filters) WITHOUT shifting the inputs /
                  dashboard layout: the panel below is identical whether logging or stopped. */}
              {dmeLink.state === 'tuning' && (
                <div className="absolute top-2 left-2 right-2 z-20 px-2 py-1.5 rounded bg-slate-950/85 border border-slate-800 backdrop-blur-sm grid grid-cols-6 gap-x-2 font-mono pointer-events-none">
                  {([
                    { label: 'RPM', value: liveSample ? liveSample.rpm.toFixed(0) : '—', color: 'text-slate-200' },
                    { label: 'RO %', value: liveSample ? liveSample.rawLoad.toFixed(1) : '—', color: 'text-blue-400' },
                    { label: 'TEMP', value: liveSample?.coolantTemp !== undefined ? `${liveSample.coolantTemp.toFixed(0)}°` : '—', color: 'text-amber-400' },
                    { label: 'SAMP', value: String(liveSamplesRef.current.length), color: 'text-slate-500' },
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
              {(activeTab === 'diff' && diffMapForVisualization && (newMap || currentMap)) && (
                <MapVisualizer mapData={{ ...(newMap || currentMap!), data: diffMapForVisualization }} title="" zAxisLabel="Diff %" />
              )}
              {(activeTab === 'lambda' && correctionMap && newMap) && (
                <MapVisualizer mapData={{ ...newMap, data: correctionMap }} title="" zAxisLabel="Lambda" />
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
                        selectedIndex={selectedLogIndex}
                        onPointClick={setSelectedLogIndex}
                        visibleFields={fieldVisibility.visibleFields}
                        presenceData={logFileState.rawLogData ?? undefined}
                      />
                    </div>
                    <div className="flex-none flex items-center gap-3 px-2.5 pt-2 pb-0.5">
                      <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap">
                        WIN: {logWindowStart} - {Math.min(processedLog.data.length, logWindowStart + LOG_WINDOW_SIZE)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, processedLog.data.length - LOG_WINDOW_SIZE)}
                        step={100}
                        value={logWindowStart}
                        onChange={(e) => setLogWindowStart(Number(e.target.value))}
                        className="flex-1 min-w-[60px] h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400 transition-colors"
                      />
                      <span className="text-[9px] text-slate-600 font-mono whitespace-nowrap">/ {processedLog.validCount}</span>
                    </div>
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
                    {dmeLink.state === 'disconnected' ? (
                      <>
                        <label className="flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer" title="Simulate a DME offline — no cable required">
                          <input
                            type="checkbox"
                            checked={dmeLink.mockMode}
                            onChange={(e) => dmeLink.setMockMode(e.target.checked)}
                            className="w-3 h-3 accent-amber-500 rounded bg-slate-700 border-none"
                          />
                          MOCK
                        </label>
                        {/* Baud only applies to a real DME, so it's hidden under MOCK — but it stays
                            mounted and keeps its box. Unmounting it shrank this row, which shoved the
                            MOCK checkbox sideways out from under the pointer as you clicked it. */}
                        <label
                          className={`flex items-center gap-1 text-[9px] text-slate-600 font-mono cursor-pointer ${dmeLink.mockMode ? 'invisible pointer-events-none' : ''}`}
                          aria-hidden={dmeLink.mockMode}
                          title="Bulk-read baud rate. 9600 is the proven path (no switch). 38400 / 125000 are the only other rates the DME accepts — they require a baud switch that is unproven on this cable; if it fails, cycle the ignition to reset the DME."
                        >
                          READ
                          <select
                            value={dmeLink.readBaud}
                            disabled={dmeLink.mockMode}
                            onChange={(e) => dmeLink.setReadBaud(Number(e.target.value) as 9600 | 38400 | 125000)}
                            className="bg-slate-800 text-[9px] font-mono text-slate-300 rounded px-1 py-0.5 outline-none cursor-pointer border border-slate-700"
                          >
                            <option value={9600}>9600</option>
                            <option value={38400}>38400</option>
                            <option value={125000}>125000</option>
                          </select>
                        </label>
                      </>
                    ) : (
                      <>
                        <span className="text-[9px] text-slate-600 font-mono uppercase">{dmeLink.mockMode ? 'mock' : 'live'} · {dmeLink.state}</span>
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
                    const warning = !dmeLink.mockMode && dmeLink.state === 'disconnected' && !dmeLink.isWebSerialSupported
                      ? 'Web Serial API not available in this browser — use Chrome/Edge, or check MOCK to test offline.'
                      : null;
                    const notice = dmeLink.error ?? warning;
                    if (!notice) return null;
                    return (
                      <p className={`text-[9px] font-mono truncate ${dmeLink.error ? 'text-red-400' : 'text-amber-500/80'}`} title={notice}>
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
                      <label className="relative inline-flex items-center cursor-pointer group">
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
                        <dmeButtonConfig.Icon className={`w-5 h-5 transition-transform duration-300 stroke-[1.5] ${dmeButtonConfig.spin ? 'animate-spin' : 'group-hover:scale-110'}`} />
                        <span className="text-[8px] font-bold tracking-widest uppercase leading-none text-center px-1">
                          {dmeLink.transferProgress !== null ? `${dmeLink.transferProgress}%` : dmeButtonConfig.label}
                        </span>
                      </button>
                    </div>

                  </div>


                  {/* --- RIGHT WING (Convex Arc) --- */}
                  <div className={`justify-self-start flex flex-col items-start gap-[18px] ml-3 shrink-0 ${patchStatus ? '' : 'invisible'}`}>

                    {/* ROW 1: WOT TH 100 (Close to Ring) */}
                    <div className="h-7 flex items-center gap-3 ml-1 opacity-90 hover:opacity-100 transition-opacity shrink-0">
                      <label className="relative inline-flex items-center cursor-pointer group">
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

                    {/* ROW 2: WRITE WARMUP (Pushed Away/Far) */}
                    <div className="h-7 flex items-center gap-4 ml-8 pl-1 shrink-0">
                      <label className="relative inline-flex items-center cursor-pointer group">
                        <input type="checkbox" className="sr-only peer" checked={writeWarmup} disabled={dmeLink.state === 'writing'} onChange={(e) => setWriteWarmup(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${writeWarmup ? 'text-blue-400' : 'text-slate-500'}`}>
                        {compact ? 'WARMUP' : 'WRITE WARMUP'}
                      </span>
                    </div>

                    {/* ROW 3: WRITE WOT (Close to Ring) */}
                    <div className="h-7 flex items-center gap-3 ml-1 opacity-90 transition-opacity shrink-0">
                      <label className="relative inline-flex items-center cursor-pointer group">
                        <input type="checkbox" className="sr-only peer" checked={writeWot} disabled={dmeLink.state === 'writing'} onChange={(e) => setWriteWot(e.target.checked)} />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:border-gray-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-900 peer-checked:after:bg-blue-400"></div>
                      </label>
                      <span className={`text-[10px] font-bold tracking-widest uppercase transition-colors whitespace-nowrap ${writeWot ? 'text-blue-400' : 'text-slate-500'}`}>
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
                     scaled down along with the dial. */}
              <div className="h-[46px] flex-none flex flex-col items-center justify-start gap-2 pt-2.5">
                {dmeLink.transferPhase && (
                  <span className={`whitespace-nowrap text-[9px] font-bold tracking-[0.2em] uppercase animate-pulse ${dmeLink.transferPhase === 'verifying' ? 'text-emerald-400' : dmeLink.transferPhase === 'erasing' ? 'text-amber-400' : 'text-blue-400'}`}>
                    {dmeLink.transferPhase === 'erasing' ? 'Erasing…'
                      : dmeLink.transferPhase === 'writing' ? 'Writing…'
                        : dmeLink.transferPhase === 'verifying' ? 'Verifying…'
                          : 'Reading…'}
                  </span>
                )}

                {/* Downloading is not here. "Write Bytes" on the session bar covers the live bytes in
                    every state rather than only after STOP, and the session list downloads each
                    stored artifact from the row that names it. Two buttons calling the same handler
                    is what made the old "Download BIN" / "Download BIN File" pair confusing.
                    Re-tuning isn't here either — it means "start the next session from this tune",
                    and by then the DME is disconnected for the key cycle. What is genuinely local to
                    this moment is throwing away a bad log.
                    Keyed on having a log rather than on state === 'stopped': STOP now drops the
                    connection for the key cycle, and this has to survive that. */}
                {processedLog && !isArchived && dmeLink.state !== 'tuning' && dmeLink.state !== 'writing' && (
                  <button
                    onClick={handleDiscardLog}
                    className="whitespace-nowrap flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" /> Discard log
                  </button>
                )}

                {/* Clearing the DME's learned values belongs exactly here: it is only meaningful in
                    the moment before START TUNE, so the next log is captured from a known base. The
                    condition is the same one that makes the hub say START TUNE, which is also why
                    this needs no disabled prop — and why currentSession is guaranteed by the time
                    the handler runs. Amber rather than the siblings' red: those two discard local
                    work, this one writes to the ECU. */}
                {dmeLink.state === 'connected' && idleAction === 'tune' && (
                  <button
                    onClick={() => setAdaptDialogOpen(true)}
                    className="whitespace-nowrap flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-amber-400 transition-colors"
                  >
                    <Eraser className="w-3 h-3" /> Reset Adapt
                  </button>
                )}

                {/* Cancel sub-button, shown while a partial-BIN read is in progress */}
                {dmeLink.state === 'reading' && (
                  <button
                    onClick={dmeLink.cancelRead}
                    className="whitespace-nowrap flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-red-400 transition-colors"
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
        />
      )}
    </main >
  );
}
