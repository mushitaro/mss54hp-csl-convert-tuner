import type { LogDataPoint, VEMap } from '@/lib/types';
import { isFullLoad, type LambdaLimits } from '@/lib/log-engine/lambdaGates';
import {
    type MovingResponseCalibration, type MovingResponseFrame, type CellShare,
    reconstructMovingController, veCellContributions,
} from './movingResponseInputs';

/** Conditional exhaust/fuel residence models. Their agreement is checked; none
 * is presented as a measured 1 s (or 3.5 s) ECU delay. */
export const MOVING_MODELS = [
    { name: 'instant', delay: 0 },
    ...[.25, .5, 1, 2].map(delay => ({ name: `delay-${delay}`, delay })),
    ...[.25, .5, 1].map(flowDelay => ({ name: `flow-${flowDelay}`, flowDelay })),
    ...[.25, .5, 1].map(flowDelay => ({ name: `flow-${flowDelay}-mix`, flowDelay, mixing: .25 })),
] as const;
export interface MovingTransport { name: string; delay?: number; flowDelay?: number; mixing?: number }
export interface CommandPoint {
    time: number; segment: number; rpm: number; rfSoll: number; k: number; speed: number;
    exhaust: number; sourceIndex: number; shares: CellShare[];
    normalStat?: boolean;
    /** No cylinder cut here: air continues through the engine during fuel cut. */
    base: [number, number]; lower: [number, number]; upper: [number, number];
}
export interface TransportPoint {
    time: number; segment: number;
    cells: [Map<number, number>, Map<number, number>];
    lower: [number, number]; upper: [number, number];
}
export interface CommandHistory {
    points: (CommandPoint | null)[]; start: number; step: number;
    injectionChecks: number; coneFailures: number; maxConeViolation: number;
}
const finite = Number.isFinite;
const mix = (a: number, b: number, w: number) => a + (b-a)*w;

/** Adjacent RAW frames only. Missing reads are not removed to bridge a hole. */
function bracket<T>(frames: readonly MovingResponseFrame[], t: number,
    select: (f: MovingResponseFrame) => { time: number; value: T } | null): { a: T; b: T; w: number; index: number } | null {
    let lo = 0, hi = frames.length-1;
    // Frame end times bound each exchange, including missing exchanges.
    while (lo < hi) { const m = (lo+hi) >>> 1; if (frames[m].time < t) lo=m+1; else hi=m; }
    for (let i=Math.max(0,lo-1); i<=Math.min(frames.length-2,lo+1); i++) {
        if (frames[i].segment !== frames[i+1].segment) continue;
        const a=select(frames[i]), b=select(frames[i+1]);
        if (!a || !b || b.time<=a.time || b.time-a.time>1.5 || t<a.time || t>b.time) continue;
        return { a:a.value, b:b.value, w:(t-a.time)/(b.time-a.time), index:i };
    }
    return null;
}

/** Actual TI / concurrently captured controller command is the untrimmed fuel
 * reference. It already contains applied RF KORR, temperature and TI factors.
 * Multiplying RF KORR into this reference again would recreate the old hill. */
export function buildCommandHistory(map: VEMap, raw: readonly LogDataPoint[],
    frames: readonly MovingResponseFrame[], calibration: MovingResponseCalibration,
    limits?: LambdaLimits): CommandHistory {
    const step=.1, start=frames.length ? Math.ceil(frames[0].time/step)*step : 0;
    const end=frames.at(-1)?.time ?? start, bad=new Set<number>();
    let injectionChecks=0, coneFailures=0, maxConeViolation=0;
    for (const f of frames) if (f.injection) for (const bank of [0,1] as const) {
        const r=reconstructMovingController(frames,f.injection.window,bank,calibration,{ segment:f.segment });
        if (!r) continue;
        injectionChecks++;
        const v=Math.max(0,r.lower-f.injection.trim[bank],f.injection.trim[bank]-r.upper);
        if (v>1/32768) { coneFailures++; maxConeViolation=Math.max(maxConeViolation,v); bad.add(f.index); }
    }
    const points: (CommandPoint|null)[]=[];
    for (let n=0; start+n*step<=end; n++) {
        const t=start+n*step;
        const s=bracket(frames,t,f=>f.standard ? {time:f.standard.window.mid,value:f.standard} : null);
        const inj=bracket(frames,t,f=>f.injection ? {time:f.injection.window.mid,value:f.injection} : null);
        const rf=bracket(frames,t,f=>f.rfSoll ? {time:f.rfSoll.window.mid,value:f.rfSoll.value} : null);
        const kk=bracket(frames,t,f=>f.rfKorr ? {time:f.rfKorr.window.mid,value:f.rfKorr.value} : null);
        if (!s || !inj || !rf || !kk || [inj.index-1,inj.index,inj.index+1,inj.index+2].some(i=>bad.has(i))) {
            points.push(null); continue;
        }
        const rpm=mix(s.a.rpm,s.b.rpm,s.w), load=mix(s.a.load,s.b.load,s.w);
        const shares=veCellContributions(map,rpm,load), rfSoll=mix(rf.a,rf.b,rf.w), k=mix(kk.a,kk.b,kk.w);
        const ri=s.index, speed=mix(raw[ri].vehicleSpeed!,raw[ri+1].vehicleSpeed!,s.w);
        const exhaust=mix(raw[ri].exhaustTemp!,raw[ri+1].exhaustTemp!,s.w);
        const segment=frames[s.index].segment;
        const normalStat=[raw[ri],raw[ri+1]].every(row=>row.llsSt!==undefined && !(row.llsSt&0x80)
            && Number.isFinite(row.wdk1) && (!limits || !isFullLoad(limits,row.wdk1,row.rpm,row.coolantTemp)));
        if (!shares || ![rpm,rfSoll,k,speed,exhaust].every(finite) || rfSoll<=0 || k<=0
            || frames[inj.index].segment!==segment || frames[rf.index].segment!==segment || frames[kk.index].segment!==segment) {
            points.push(null); continue;
        }
        const base: [number,number]=[0,0], lower: [number,number]=[0,0], upper: [number,number]=[0,0];
        // Unknown cylinder identities make partial bank fuel unobservable.
        // A cut/resume occurred somewhere between these packets. Its midpoint
        // is not an observed injection time; break history instead of inventing it.
        const cut=inj.a.actualBlank===inj.b.actualBlank?inj.a.actualBlank:NaN;
        let valid=cut===0 || cut===6;
        for (const b of [0,1] as const) {
            base[b]=mix(inj.a.commandMs[b]/inj.a.trim[b],inj.b.commandMs[b]/inj.b.trim[b],inj.w)*rpm/120;
            if (cut===6) { lower[b]=upper[b]=0; continue; }
            const cone=reconstructMovingController(frames,{start:t,end:t,mid:t},b,calibration,{segment});
            if (cone) { lower[b]=base[b]*cone.lower; upper[b]=base[b]*cone.upper; }
            else {
                // Both complete exchanges show lambda OFF with unit command.
                // Retain this known physical history; never invent an ON reset.
                const a=frames[inj.index].controller, z=frames[inj.index+1].controller;
                if (a && z && !a.active[b] && !z.active[b] && inj.a.trim[b]===1 && inj.b.trim[b]===1) {
                    lower[b]=upper[b]=base[b];
                } else valid=false;
            }
        }
        points.push(valid && base.every(v=>finite(v)&&v>0) ? {
            time:t,segment,rpm,rfSoll,k,speed,exhaust,sourceIndex:s.index,shares,base,lower,upper,normalStat,
        } : null);
    }
    return {points,start,step,injectionChecks,coneFailures,maxConeViolation};
}

const blendCells = (a: Map<number,number>, b: Map<number,number>, w: number) => {
    const out=new Map<number,number>();
    for (const [j,v] of a) if (v*(1-w)>1e-10) out.set(j,v*(1-w));
    for (const [j,v] of b) if (v*w>1e-10) out.set(j,(out.get(j)??0)+v*w);
    return out;
};

/** Positive linear flux transport before division; moving cell contributions
 * remain separate. Optional command ratios are used only for planned-map audit. */
export function transportCommandHistory(history: CommandHistory, model: MovingTransport,
    ratios?: readonly number[]): (TransportPoint|null)[] {
    const out: (TransportPoint|null)[]=Array(history.points.length).fill(null), p=history.points;
    let begin=0;
    while (begin<p.length) {
        while (begin<p.length && !p[begin]) begin++;
        if (begin>=p.length) break;
        let end=begin+1;
        while (end<p.length && p[end] && p[end]!.segment===p[begin]!.segment) end++;
        const clock=[0];
        for (let i=begin+1;i<end;i++) clock.push(clock.at(-1)!+
            (p[i-1]!.rpm*p[i-1]!.rfSoll+p[i]!.rpm*p[i]!.rfSoll)*50*history.step);
        let source=begin, firstReady=-1, previous: TransportPoint|null=null;
        for (let i=begin;i<end;i++) {
            let st=p[i]!.time-(model.delay??0);
            if (model.flowDelay) {
                const target=clock[i-begin]-model.flowDelay*2000*30;
                if (target<0) continue;
                while (source+1<end && clock[source+1-begin]<=target) source++;
                if (source+1>=end) continue;
                const w=(target-clock[source-begin])/(clock[source+1-begin]-clock[source-begin]);
                st=p[source]!.time+w*history.step;
            }
            const left=Math.floor((st-history.start)/history.step+1e-8);
            const w=Math.max(0,Math.min(1,(st-(history.start+left*history.step))/history.step));
            if (left<begin || left+1>=end || p[i]!.time-st>4) continue;
            const a=p[left]!, b=p[left+1]!;
            if (ratios && (![ratios[left],ratios[left+1]].every(v=>finite(v)&&v>0))) { previous=null; firstReady=-1; continue; }
            const cells: [Map<number,number>,Map<number,number>]=[new Map(),new Map()];
            const lower: [number,number]=[0,0], upper: [number,number]=[0,0];
            for (const bank of [0,1] as const) {
                for (const [q,weight,j] of [[a,1-w,left],[b,w,left+1]] as const) {
                    for (const share of q.shares) cells[bank].set(share.index,(cells[bank].get(share.index)??0)+
                        weight*q.base[bank]*share.share*(ratios?.[j]??1));
                }
                lower[bank]=mix(a.lower[bank],b.lower[bank],w); upper[bank]=mix(a.upper[bank],b.upper[bank],w);
            }
            let point: TransportPoint={time:p[i]!.time,segment:p[i]!.segment,cells,lower,upper};
            if (firstReady<0) firstReady=i;
            if (model.mixing && previous) {
                const gain=-Math.expm1(-history.step/model.mixing);
                point={...point,cells:[blendCells(previous.cells[0],cells[0],gain),blendCells(previous.cells[1],cells[1],gain)],
                    lower:[mix(previous.lower[0],lower[0],gain),mix(previous.lower[1],lower[1],gain)],
                    upper:[mix(previous.upper[0],upper[0],gain),mix(previous.upper[1],upper[1],gain)]};
            }
            previous=point;
            if ((i-firstReady)*history.step>=5*(model.mixing??0)) out[i]=point;
        }
        begin=end;
    }
    return out;
}
