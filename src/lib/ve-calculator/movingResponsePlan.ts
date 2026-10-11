import { interpCurve, interpMap2d, rfKorrAt, tabgModelAt, type EgtTables } from './egtTables';
import type { MovingResponseCalibration } from './movingResponseInputs';
import type { CommandHistory } from './movingResponseHistory';

/** A conditional short-step replay, not a claim that the sparse log observed
 * every background-task execution. Audit BOTH the retained observed K and the
 * recorded calibration's enter/hold/reset response. No learned RF exponent. */
export function plannedCommandRatios(history: CommandHistory, factors: readonly number[],
    calibration: MovingResponseCalibration, egt: EgtTables,
    mode: 'retained' | 'gate'): number[] {
    const unchanged=factors.every(v=>v===1);
    if (unchanged) return history.points.map(p=>p ? 1 : NaN);
    const reference=mode==='gate' ? gateReplay(history,factors.map(()=>1),egt) : null;
    const planned=mode==='gate' ? gateReplay(history,factors,egt) : null;
    const stat=calibration.tiStat;
    return history.points.map((p,i)=>{
        if (!p) return NaN;
        const ve=p.shares.reduce((v,s)=>v+s.share*factors[s.index],0);
        const relativeK=planned && reference ? planned[i]/reference[i] : 1;
        if (p.normalStat===false && Math.abs(ve*relativeK-1)>1e-12) return NaN;
        const oldRf=p.rfSoll*p.k, newRf=oldRf*ve*relativeK;
        const before=interpMap2d(stat.rpm,stat.rf,stat.values,p.rpm,oldRf);
        const after=interpMap2d(stat.rpm,stat.rf,stat.values,p.rpm,newRf);
        return before>0 && after>0 ? ve*relativeK*after/before : NaN;
    });
}

function gateReplay(history: CommandHistory, factors: readonly number[], egt: EgtTables): number[] {
    let held: number|undefined, segment=-1;
    return history.points.map(p=>{
        if (!p) { held=undefined; segment=-1; return NaN; }
        if (p.segment!==segment) { held=undefined; segment=p.segment; }
        const ve=p.shares.reduce((v,s)=>v+s.share*factors[s.index],0);
        if (!(ve>0) || !Number.isFinite(ve)) return NaN;
        const oldRf=p.rfSoll*p.k, newSoll=p.rfSoll*ve;
        let nextK=p.k;
        {
            const floor=interpCurve(egt.rfKorrMin.rpm,egt.rfKorrMin.values,p.rpm);
            if (newSoll>floor && p.speed>egt.vMin) {
                // Anchor to what the DME actually applied. TABG is coarse and
                // asynchronous, so its absolute table estimate must not replace
                // observed K even when VE is unchanged.
                const delta=Math.max(0,tabgModelAt(egt,p.rpm,oldRf)-p.exhaust);
                const oldTable=rfKorrAt(egt,p.rpm,delta);
                let converged=false;
                for (let n=0;n<12;n++) {
                    const shifted=Math.max(0,delta+tabgModelAt(egt,p.rpm,newSoll*nextK)-tabgModelAt(egt,p.rpm,oldRf));
                    const proposal=Math.max(1,p.k*rfKorrAt(egt,p.rpm,shifted)/oldTable);
                    if (Math.abs(proposal-nextK)<1e-7) { nextK=proposal; converged=true; break; }
                    nextK=proposal;
                }
                if (!converged) {held=undefined;return NaN;}
            } else if (newSoll>=floor-egt.hys && p.speed>=egt.vMin) {
                nextK=held??p.k;
            } else nextK=1;
            held=nextK;
        }
        return nextK;
    });
}
