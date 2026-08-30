import type { ProcessId } from '@/lib/log-engine/logProfile';
import { useCallback, useEffect, useState } from 'react';
import { LogDataPoint, VEMap } from '@/lib/types';
import { TuningSession, BaseOrigin, TuneSettings, FlashRecord, AdaptationResetRecord, FlashCounterResetRecord, SessionBinariesRecord } from '@/lib/db/schema';
import {
    createDraft,
    setSessionBase,
    saveTune,
    renameSession,
    archiveSession,
    setSessionProcess,
    saveResearchRun,
    appendFlashRecord,
    appendAdaptationReset,
    appendFlashCounterReset,
    listSessions,
    getSessionLog,
    getSessionBinaries,
    deleteSession,
} from '@/lib/db/sessionRepository';
import type { InertiaSample, IdleSample } from '@/lib/dme-link/types';

export function useSessionDb() {
    const [sessions, setSessions] = useState<TuningSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setSessions(await listSessions());
            setError(null);
        } catch (e) {
            // Surfaced rather than swallowed: a blocked v2 upgrade lands here, and silently showing
            // an empty list would look like "my sessions are gone".
            console.error('Failed to load session DB', e);
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const newDraft = useCallback(async (label?: string) => {
        const s = await createDraft({ label });
        await refresh();
        return s;
    }, [refresh]);

    const setBase = useCallback(async (params: {
        sessionId: string; baseOrigin: BaseOrigin; baseBinaryBuffer: ArrayBuffer; baseFileName: string;
    }) => {
        const s = await setSessionBase(params);
        await refresh();
        return s;
    }, [refresh]);

    const saveSessionTune = useCallback(async (params: {
        sessionId: string; binaryFileName: string; tunedBinaryBuffer: ArrayBuffer;
        veMapSnapshot: VEMap; tuneSettings: TuneSettings; log: LogDataPoint[] | null;
    }) => {
        const s = await saveTune(params);
        await refresh();
        return s;
    }, [refresh]);

    const rename = useCallback(async (id: string, label: string) => {
        await renameSession(id, label);
        await refresh();
    }, [refresh]);

    const saveResearch = useCallback(async (params: {
        sessionId: string; process: ProcessId; log: LogDataPoint[];
        inertia?: InertiaSample[]; idle?: IdleSample[];
    }) => {
        const s = await saveResearchRun(params);
        await refresh();
        return s;
    }, [refresh]);

    const setProcess = useCallback(async (id: string, process: ProcessId) => {
        await setSessionProcess(id, process);
        await refresh();
    }, [refresh]);

    const archive = useCallback(async (id: string) => {
        await archiveSession(id);
        await refresh();
    }, [refresh]);

    const recordFlash = useCallback(async (id: string, record: FlashRecord) => {
        await appendFlashRecord(id, record);
        await refresh();
    }, [refresh]);

    const recordAdaptationReset = useCallback(async (id: string, record: AdaptationResetRecord) => {
        await appendAdaptationReset(id, record);
        await refresh();
    }, [refresh]);

    const recordFlashCounterReset = useCallback(async (id: string, record: FlashCounterResetRecord) => {
        await appendFlashCounterReset(id, record);
        await refresh();
    }, [refresh]);

    const remove = useCallback(async (id: string) => {
        await deleteSession(id);
        await refresh();
    }, [refresh]);

    const loadLog = useCallback((id: string) => getSessionLog(id), []);
    const loadBinaries = useCallback((id: string): Promise<SessionBinariesRecord | null> => getSessionBinaries(id), []);

    return {
        sessions, loading, error, refresh,
        newDraft, setBase, saveSessionTune, rename, archive, setProcess, saveResearch, recordFlash, recordAdaptationReset,
        recordFlashCounterReset, remove,
        loadLog, loadBinaries,
    };
}
