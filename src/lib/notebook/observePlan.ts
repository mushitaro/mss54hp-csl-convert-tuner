import { activeSteps, type ObservePlan, type ObserveLane } from '@/lib/log-engine/observe';
import type { NotebookAuthor, NotebookEntry, PlanWatch } from './rules';

/**
 * The OBSERVE plan on screen ↔ a plan in the notebook.
 *
 * The plan used to be page state and nothing else: a reload lost it, and only its title and reads
 * reached the log, as the first sample's mark — never its steps. Kept in the notebook, it survives
 * the reload, travels with the session to the desk, and says who wrote it.
 */

const hex6 = (address: number) => address.toString(16).toUpperCase().padStart(6, '0');

/** A plan entry for the plan on screen. The caller has checked it with `planProblems` first. */
export function planEntryFromObserve(plan: ObservePlan, ctx: {
    id: string; sessionId: string; at: number; by: NotebookAuthor; v: number; re?: string; carriedFrom?: string;
}): NotebookEntry {
    const watch: PlanWatch[] = plan.reads.map(r => ({
        address: hex6(r.address), bytes: r.count, every: r.every, ...(r.label.trim() ? { label: r.label.trim() } : {}),
    }));
    return {
        id: ctx.id, sessionId: ctx.sessionId, at: ctx.at, by: ctx.by,
        body: {
            kind: 'plan', v: ctx.v,
            ...(ctx.re ? { re: ctx.re } : {}),
            ...(ctx.carriedFrom ? { carriedFrom: ctx.carriedFrom } : {}),
            // A plan with no title still has a purpose the notebook can show: the addresses it watches.
            purpose: plan.title.trim() || `OBSERVE ${watch.map(w => w.address).join(', ')}`,
            steps: activeSteps(plan).map((s, i) => ({ n: i + 1, do: s })),
            ...(watch.length ? { watch } : {}),
        },
    };
}

/** The plan on screen for a plan entry. Steps come back as one line each. */
export function observeFromPlanEntry(entry: NotebookEntry): ObservePlan | null {
    if (entry.body.kind !== 'plan') return null;
    return {
        title: entry.body.purpose,
        reads: (entry.body.watch ?? []).map(w => ({
            address: parseInt(w.address, 16), count: w.bytes, every: w.every as ObserveLane, label: w.label ?? '',
        })),
        steps: entry.body.steps.map(s => s.do),
    };
}

/** Whether the plan on screen says what the stored plan says: purpose, steps and reads, compared as
 *  the entry this plan would be written as. */
export function samePlan(plan: ObservePlan, entry: NotebookEntry | null): boolean {
    if (!entry || entry.body.kind !== 'plan') return false;
    const would = planEntryFromObserve(plan, { id: entry.id, sessionId: entry.sessionId, at: entry.at, by: entry.by, v: entry.body.v });
    if (would.body.kind !== 'plan') return false;
    const gist = (b: typeof would.body & { kind: 'plan' }) => JSON.stringify([b.purpose, b.steps, b.watch ?? []]);
    return gist(would.body) === gist(entry.body);
}
