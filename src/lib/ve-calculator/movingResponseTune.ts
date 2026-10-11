import type { LogDataPoint, VEMap, MovingResponseAudit } from '@/lib/types';
import type { VeCalcOptions, VECalculator, VeReject } from './calculator';
import { prepareMovingResponseInputs, type MovingResponseFrame } from './movingResponseInputs';
import { rawSignLookbackSeconds, hasFreshBothThresholdCrossings } from './movingResponseSensor';
import { fitMovingResponse, type MovingResponseConstraint, type MovingResponseFitResult } from './movingResponseFit';
import { buildCommandHistory, transportCommandHistory, MOVING_MODELS,
    type CommandHistory, type TransportPoint, type MovingTransport } from './movingResponseHistory';
import { plannedCommandRatios } from './movingResponsePlan';
import { isFullLoad } from '@/lib/log-engine/lambdaGates';
import { timeScaleSeconds } from '@/lib/log-engine/filter';

export const MOVING_RESPONSE_VERSION=1;
export const MOVING_RESPONSE_MAX_STEP=.05;
type Result=ReturnType<VECalculator['calculateNewVEMap']>;
interface Observation { index: number; bank: 1|2; rich: boolean; start: number; end: number; time: number; kind: string }
interface AuditGroup { key: string; before: number; after: number; rows: number; cells: Set<number> }
export interface MovingTuneDiagnostics {
    status: 'calibration-held'|'no-command-history'|'no-evidence'|'no-supported-update'|'validated';
    constraints: number; observationRows: number; historyPoints: number; injectionChecks: number;
    coneFailures: number; maxConeViolation: number; fit?: MovingResponseFitResult;
    revertedCells: number[]; finalAudit: {before:number;after:number;groups:number;worstIncrease:number};
    auditFailures: {attempt:number;key:string;before:number;after:number;cells:number[]}[];
}

const sum=(m: Map<number,number>) => { let s=0; for (const v of m.values()) s+=v; return s; };
const huber=(r: number) => { const a=Math.abs(r), d=.025; return a<=d ? r*r/2 : d*(a-d/2); };

/** I integration tracks the hysteretic, filtered controller sign, so it is NOT
 * turned into raw rich/lean duration. Three P executions, unlike two, prove
 * fresh crossings on both sides after the first possibly pre-armed update. */
function observations(frames: readonly MovingResponseFrame[], options: VeCalcOptions): Observation[] {
    const cal=options.movingCalibration!, out: Observation[]=[];
    for (let i=0;i<frames.length;i++) {
        const f=frames[i], c=f.controller;
        if (f.evidenceReason!=='eligible' || !c) continue;
        for (const bank of [1,2] as const) {
            const mv=c.oxygenMv[bank-1];
            const rich=mv>=cal.richMv;
            if (!rich && mv>cal.leanMv) continue;
            const age=rawSignLookbackSeconds(mv,rich,cal.sensor);
            if (age!==null) out.push({index:i,bank,rich,start:c.window.start-age,end:c.window.end,
                time:c.window.mid,kind:'point'});
        }
        const p=frames[i-1], pc=p?.controller;
        if (!p || p.segment!==f.segment || p.evidenceReason!=='eligible' || !pc
            || c.window.mid-pc.window.mid>1.5) continue;
        for (const bank of [1,2] as const) if (hasFreshBothThresholdCrossings(pc.count[bank-1],c.count[bank-1])) {
            for (const rich of [true,false]) {
                const age=rawSignLookbackSeconds(rich?cal.richMv:cal.leanMv,rich,cal.sensor);
                if (age!==null) out.push({index:i,bank,rich,start:pc.window.start-age,end:c.window.end,
                    time:(pc.window.mid+c.window.mid)/2,kind:'fresh-switch'});
            }
        }
    }
    return out;
}

function windowIndices(history: CommandHistory, points: readonly (TransportPoint|null)[], o: Observation): number[]|null {
    const first=Math.max(0,Math.floor((o.start-history.start)/history.step+.5));
    const last=Math.min(points.length-1,Math.ceil((o.end-history.start)/history.step-.5));
    if (last<first || o.start<history.start-history.step/2
        || o.end>history.start+(points.length-.5)*history.step) return null;
    const ids: number[]=[]; let segment: number|undefined;
    for (let i=first;i<=last;i++) {
        const p=points[i];
        if (!p || (segment!==undefined && p.segment!==segment)) return null;
        segment=p.segment; ids.push(i);
    }
    return ids.length ? ids : null;
}

/** Necessary outer inequalities. Per-cell extrema are deliberately NOT
 * normalized back to sum=1; that would manufacture fixed operating points. */
function constraints(history: CommandHistory, points: readonly (TransportPoint|null)[], obs: readonly Observation[],
    model: string): MovingResponseConstraint[] {
    const rows: MovingResponseConstraint[]=[];
    for (const o of obs) {
        const ids=windowIndices(history,points,o); if (!ids) continue;
        const bank=o.bank-1;
        let coefficients: Map<number,number>|undefined, bound=o.rich ? -Infinity : Infinity;
        let valid=true;
        for (const i of ids) {
            const p=points[i]!, total=sum(p.cells[bank]);
            if (!(total>0)) { valid=false; break; }
            const q=(o.rich?p.upper[bank]:p.lower[bank])/total;
            if (!Number.isFinite(q) || q<0) {valid=false;break;}
            bound=o.rich?Math.max(bound,q):Math.min(bound,q);
            const x=new Map([...p.cells[bank]].map(([j,v])=>[j,v/total]));
            if (!coefficients) coefficients=x;
            else if (o.rich) for (const [j,v] of coefficients) {
                const z=Math.min(v,x.get(j)??0); if (z>1e-10) coefficients.set(j,z); else coefficients.delete(j);
            } else for (const [j,v] of x) coefficients.set(j,Math.max(v,coefficients.get(j)??0));
        }
        if (!valid || !coefficients?.size) continue;
        rows.push({shares:[...coefficients].map(([cell,weight])=>({cell,weight})),
            ...(o.rich?{upper:bound}:{lower:bound}),index:o.index,bank:o.bank,time:o.time,model});
    }
    return rows;
}

/** Recheck the combined QUANTIZED map, keeping candidate command and observed
 * fuel at the same time. Unchanged-map residuals are the comparator: model
 * mismatch remains visible rather than being forced to zero by fitted slack. */
function auditModel(history: CommandHistory, baseline: readonly (TransportPoint|null)[],
    candidate: readonly (TransportPoint|null)[], obs: readonly Observation[], model: string,
    factors: readonly number[]): AuditGroup[] {
    const groups=new Map<string,AuditGroup>();
    for (const o of obs) {
        const ids=windowIndices(history,baseline,o); if (!ids) continue;
        const bank=o.bank-1; let before=Infinity, after=Infinity;
        const touched=new Set<number>(); let valid=true;
        for (const i of ids) {
            const a=baseline[i]!, b=candidate[i], total=sum(a.cells[bank]);
            if (!(total>0)) {valid=false;break;}
            const fuel=o.rich?a.upper[bank]:a.lower[bank];
            before=Math.min(before,o.rich?(total-fuel)/total:(fuel-total)/total);
            const planned=b?sum(b.cells[bank]):NaN;
            if (!Number.isFinite(planned)) after=NaN;
            else after=Math.min(after,o.rich?(planned-fuel)/total:(fuel-planned)/total);
            for (const [j,v] of a.cells[bank]) if (v/total>.001 && factors[j]!==1) touched.add(j);
        }
        if (!valid) continue;
        // Sparse O2/overlay/model error can make an individual observation
        // disagree at arbitrarily small steps. Validate complete chronological
        // fifths, while the fitter separately requires independent revisits.
        const duration=history.points.length*history.step;
        const fold=Math.min(4,Math.max(0,Math.floor(5*(o.time-history.start)/duration)));
        const key=JSON.stringify([model,o.bank,fold]);
        const g=groups.get(key)??{key,before:0,after:0,rows:0,cells:new Set<number>()};
        g.before+=huber(Math.max(0,before)); g.after+=Number.isFinite(after)?huber(Math.max(0,after)):Infinity; g.rows++;
        for (const j of touched) g.cells.add(j);
        groups.set(key,g);
    }
    return [...groups.values()].map(g=>({...g,before:g.before/g.rows,after:g.after/g.rows}));
}

function empty(map: VEMap): Result {
    const grid=<T>(v:T):T[][]=>map.yAxis.map(()=>map.xAxis.map(()=>v));
    return {newMap:null,diffMap:grid(100),hitMap:grid(0),correctionMap:grid(1),weightMap:grid(0),
        rfKorrMap:grid(1),rfKorrSpreadMap:grid(0),tunedUsedMap:grid(false),acceptedMap:grid(false),
        realisedMap:grid(1),demandMap:grid(1),rejectMap:grid<VeReject|null>('no-evidence'),
        coverage:{withEvidence:0,withAnyData:0,total:map.xAxis.length*map.yAxis.length}};
}

export function calculateMovingResponseDetails(map: VEMap, raw: LogDataPoint[], options: VeCalcOptions,
    models: readonly MovingTransport[]=MOVING_MODELS): {result:Result;diagnostics:MovingTuneDiagnostics} {
    const result=empty(map), diagnostics: MovingTuneDiagnostics={status:'calibration-held',constraints:0,
        observationRows:0,historyPoints:0,injectionChecks:0,coneFailures:0,maxConeViolation:0,revertedCells:[],
        finalAudit:{before:0,after:0,groups:0,worstIncrease:0},auditFailures:[]};
    const done=()=>({result,diagnostics});
    const cal=options.movingCalibration;
    if (!cal || !options.egt || options.steadyCalibrationHold!==null || options.writeRfKorr
        || !options.steadyLambdaLimits || !models.length || !raw.length) return done();
    if (JSON.stringify([map.xAxis,map.yAxis,map.data])!==
        JSON.stringify([cal.recordedVe.xAxis,cal.recordedVe.yAxis,cal.recordedVe.data])) return done();
    const rate=options.veLearningRate??1;
    if (!(rate>0) || !Number.isFinite(rate)) return done();
    const frames=prepareMovingResponseInputs(map,raw,{calibration:cal,secondsPerTimeUnit:timeScaleSeconds(raw),
        minCoolantTemp:options.steadyFilterConfig?.minTemp??65,
        excludeTimeRanges:options.steadyFilterConfig?.excludeTimeRanges});
    // TI_F_STAT takes another table in VL or LL + LLS_ST bit7. Keep their actual
    // command history, but do not attribute this branch's response to KF_TI_N_RF.
    for (const f of frames) {
        const p=raw[f.index];
        if (p.llsSt===undefined || (p.llsSt&0x80)!==0 || !Number.isFinite(p.wdk1)
            || isFullLoad(options.steadyLambdaLimits,p.wdk1,p.rpm,p.coolantTemp)) f.evidenceReason='operating-condition';
    }
    const history=buildCommandHistory(map,raw,frames,cal,options.steadyLambdaLimits);
    diagnostics.historyPoints=history.points.filter(Boolean).length;
    diagnostics.injectionChecks=history.injectionChecks;diagnostics.coneFailures=history.coneFailures;
    diagnostics.maxConeViolation=history.maxConeViolation;
    if (!diagnostics.historyPoints) {diagnostics.status='no-command-history';return done();}
    const obs=observations(frames,options), rows: MovingResponseConstraint[]=[];
    for (const model of models) rows.push(...constraints(history,transportCommandHistory(history,model),obs,model.name));
    diagnostics.constraints=rows.length;diagnostics.observationRows=new Set(rows.map(r=>r.index)).size;
    if (!rows.length) {diagnostics.status='no-evidence';return done();}
    const fit=fitMovingResponse(rows,map.xAxis.length*map.yAxis.length,{
        maxStep:MOVING_RESPONSE_MAX_STEP*Math.min(1,rate),validationFolds:5,crossValidate:true,embargoSec:20});
    diagnostics.fit=fit;
    const base=map.data.flat();
    const quantizedFactor=(f:number,j:number)=>{
        // The binary writer stores thousandths. Round toward the recorded map
        // so one quantized write cannot exceed the declared trust step.
        const value=f<1?Math.ceil(base[j]*f*1000-1e-9)/1000:f>1?Math.floor(base[j]*f*1000+1e-9)/1000:base[j];
        return value/base[j];
    };
    const factors=fit.factors.map(quantizedFactor);
    // Bound replay cost. Every failed audit removes at least one active cell;
    // an unresolved remainder is rejected, never published under a success tag.
    let auditPassed=false;
    for (let attempt=0;attempt<9;attempt++) {
        const groups: AuditGroup[]=[];
        for (const mode of ['retained','gate'] as const) {
            const ratios=plannedCommandRatios(history,factors,cal,options.egt,mode);
            for (const model of models) groups.push(...auditModel(history,transportCommandHistory(history,model),
                transportCommandHistory(history,model,ratios),obs,`${model.name}:${mode}`,factors));
        }
        const bad=groups.filter(g=>!Number.isFinite(g.after)||g.after>g.before+1e-11);
        diagnostics.auditFailures.push(...bad.map(g=>({attempt,key:g.key,before:g.before,after:g.after,cells:[...g.cells]})));
        diagnostics.finalAudit={before:groups.reduce((s,g)=>s+g.before,0),after:groups.reduce((s,g)=>s+g.after,0),
            groups:groups.length,worstIncrease:Math.max(0,...groups.map(g=>g.after-g.before))};
        if (!bad.length) {auditPassed=true;break;}
        const revert=new Set(bad.flatMap(g=>[...g.cells]));
        if (!revert.size) break;
        for (const j of revert) if (factors[j]!==1) {
            factors[j]=attempt<6?quantizedFactor(1+(factors[j]-1)/2,j):1;
            if (factors[j]===1) diagnostics.revertedCells.push(j);
        }
    }
    if (!auditPassed) factors.fill(1);
    let accepted=0, touched=0;
    for (let j=0;j<base.length;j++) {
        const r=Math.floor(j/map.xAxis.length),c=j%map.xAxis.length,cell=fit.cells[j],f=factors[j];
        result.hitMap[r][c]=cell.observations;result.weightMap[r][c]=cell.support;
        result.demandMap[r][c]=fit.demand[j];
        if (cell.observations) touched++;
        if (Math.abs(f-1)>1e-10) {
            accepted++;result.acceptedMap[r][c]=true;result.correctionMap[r][c]=f;result.realisedMap[r][c]=f;
            result.diffMap[r][c]=100*f;result.rejectMap[r][c]=null;
        } else result.rejectMap[r][c]=cell.reason==='unsupported'?'no-evidence'
            :cell.reason==='insufficient-passes'?'thin-independent':cell.reason==='no-direction'?'not-significant':'scatter';
    }
    result.coverage={withEvidence:accepted,withAnyData:touched,total:base.length};
    if (accepted) {
        const audit: MovingResponseAudit={version:1,maxStepPercent:MOVING_RESPONSE_MAX_STEP*Math.min(1,rate)*100,
            acceptedCells:accepted,evidenceRows:diagnostics.observationRows,
            validationPasses:Math.min(...fit.cells.filter(c=>factors[c.cell]!==1).flatMap(c=>c.passes)),
            maxCommandConeViolation:history.maxConeViolation,modelNames:models.map(m=>m.name),
            beforeLoss:diagnostics.finalAudit.before,afterLoss:diagnostics.finalAudit.after};
        result.newMap={xAxis:[...map.xAxis],yAxis:[...map.yAxis],data:map.data.map((row,r)=>row.map((v,c)=>
            Math.round(v*factors[r*row.length+c]*1000)/1000)),calibrationStatus:'moving-validated',movingResponseAudit:audit};
        diagnostics.status='validated';
    } else diagnostics.status='no-supported-update';
    return done();
}

export function calculateMovingResponseTune(map: VEMap, raw: LogDataPoint[], options: VeCalcOptions): Result {
    return calculateMovingResponseDetails(map,raw,options).result;
}
