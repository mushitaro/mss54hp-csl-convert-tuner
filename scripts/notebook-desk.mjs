/**
 * The pure half of `npm run notebook` (scripts/notebook.mjs): reading a plan file, building the
 * desk's entries, the SQL that adds one, and the notebook.md a pull writes. No store, no files —
 * so verify:notebook can hold every rule here without a database.
 *
 * Every entry goes through src/lib/notebook/rules.ts before it is offered to the store, the same
 * rules the tab and the store's API run. The desk is `by: 'desk'` and cannot write a `note`: what
 * the desk thinks the driver did is a question for the driver (`ask`), never their words.
 */
import { randomUUID } from 'node:crypto';
import {
    currentPlan, entryProblem, nextPlanVersion, openAsks, statusOf, stepsDone,
} from '../src/lib/notebook/rules.ts';
import { parseAddress, planProblems, watchKey } from '../src/lib/log-engine/observe.ts';

const EVERY = new Set([1, 2, 4, 8]);

/** "2400-2800" or "2400–2800" → [2400, 2800]. */
function rangeOf(text) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[-–~]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text));
    return m ? [Number(m[1]), Number(m[2])] : null;
}

/** A step's `{gear: 3, rpm: 2400-2800, ro: 6-8, hold: 3, times: 4}`. */
function stepAttributes(text, n) {
    const out = {};
    for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^([a-z_]+)\s*:\s*(.+)$/i.exec(part);
        if (!m) throw new Error(`step ${n}: "${part}" is not key: value`);
        const key = m[1].toLowerCase(), value = m[2].trim();
        if (key === 'gear') out.gear = value;
        else if (key === 'rpm' || key === 'ro') {
            const r = rangeOf(value);
            if (!r) throw new Error(`step ${n}: ${key} must be from-to, e.g. 2400-2800`);
            out[key] = r;
        } else if (key === 'hold' || key === 'hold_s' || key === 'holds') out.holdS = Number(value.replace(/s$/i, ''));
        else if (key === 'times') out.times = Number(value.replace(/^x/i, ''));
        else throw new Error(`step ${n}: unknown "${key}" (gear, rpm, ro, hold, times)`);
    }
    return out;
}

/** A watch line's address, bytes, every and label, checked as the OBSERVE panel checks them. */
function watchOf(reads, purpose) {
    const parsed = reads.map((r, i) => {
        const address = typeof r.address === 'number' ? r.address : parseAddress(String(r.address ?? ''));
        if (address === null) throw new Error(`watch ${i + 1}: "${r.address}" is not an address (DAT_00ffd1a2, 0xFFD1A2 or FFD1A2)`);
        const every = Number(r.every ?? 2);
        if (!EVERY.has(every)) throw new Error(`watch ${i + 1}: every must be 1, 2, 4 or 8`);
        return { address, count: Number(r.bytes ?? 2), every, label: r.label ? String(r.label) : undefined };
    });
    const problems = parsed.length ? planProblems({ title: purpose, reads: parsed, steps: [] }) : [];
    if (problems.length) throw new Error(problems.join(' '));
    return parsed.map(r => ({ address: watchKey(r.address), bytes: r.count, every: r.every, ...(r.label ? { label: r.label } : {}) }));
}

/**
 * A plan file → the plan's fields (purpose, hypothesis, criteria, steps, watch). JSON, or Markdown:
 *
 *     # What the drive is for, in a line
 *
 *     Hypothesis: what you expect to see, and why      (仮説: も可)
 *     Criteria: how the result is judged               (判定: も可)
 *
 *     ## Steps
 *     1. Idle 30 s
 *     2. Slow tip-in {gear: 3, rpm: 2400-2800, ro: 6-8, hold: 3, times: 4}
 *
 *     ## Watch
 *     - DAT_00ffd1a2 2 every 2 label words
 *
 * Steps are numbered in the order given. Everything else in the file is ignored, so a plan can
 * carry its own reasoning in prose without it going into the notebook.
 */
export function parsePlanFile(text, name = 'plan') {
    if (/\.json$/i.test(name) || /^\s*\{/.test(text)) {
        const j = JSON.parse(text);
        const steps = (j.steps ?? []).map((s, i) => {
            if (typeof s === 'string') return { n: i + 1, do: s };
            const hold = s.holdS ?? s.hold_s ?? s.hold;
            return {
                n: i + 1, do: s.do,
                ...(s.gear !== undefined ? { gear: String(s.gear) } : {}),
                ...(s.rpm ? { rpm: s.rpm } : {}), ...(s.ro ? { ro: s.ro } : {}),
                ...(hold !== undefined ? { holdS: Number(hold) } : {}),
                ...(s.times !== undefined ? { times: Number(s.times) } : {}),
            };
        });
        return {
            purpose: String(j.purpose ?? '').trim(),
            ...(j.hypothesis ? { hypothesis: String(j.hypothesis).trim() } : {}),
            ...(j.criteria ? { criteria: String(j.criteria).trim() } : {}),
            steps,
            ...(Array.isArray(j.watch) && j.watch.length ? { watch: watchOf(j.watch, String(j.purpose ?? '')) } : {}),
        };
    }
    let purpose = '', hypothesis, criteria, section = null;
    const steps = [], reads = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let m;
        if (!purpose && (m = /^#\s+(.+)$/.exec(line))) { purpose = m[1].trim(); continue; }
        if ((m = /^##\s+(.+)$/.exec(line))) {
            const h = m[1].toLowerCase();
            section = /step|手順/.test(h) ? 'steps' : /watch|観察|アドレス/.test(h) ? 'watch' : null;
            continue;
        }
        if ((m = /^(hypothesis|仮説)\s*[:：]\s*(.+)$/i.exec(line))) { hypothesis = m[2].trim(); continue; }
        if ((m = /^(criteria|判定)\s*[:：]\s*(.+)$/i.exec(line))) { criteria = m[2].trim(); continue; }
        if (section === 'steps' && (m = /^\d+[.)]\s+(.+)$/.exec(line))) {
            const n = steps.length + 1;
            const attrs = /^(.*?)\s*\{([^}]*)\}\s*$/.exec(m[1]);
            steps.push(attrs ? { n, do: attrs[1].trim(), ...stepAttributes(attrs[2], n) } : { n, do: m[1].trim() });
            continue;
        }
        if (section === 'watch' && (m = /^[-*]\s+(\S+)\s+(\d)\s*(?:b|bytes?)?\s+every\s+(\d)\s*(.*)$/i.exec(line))) {
            reads.push({ address: m[1], bytes: Number(m[2]), every: Number(m[3]), label: m[4].trim() || undefined });
        }
    }
    return {
        purpose,
        ...(hypothesis ? { hypothesis } : {}),
        ...(criteria ? { criteria } : {}),
        steps,
        ...(reads.length ? { watch: watchOf(reads, purpose) } : {}),
    };
}

/** "RUN:FROM-TO:CH,CH[:DECODE]", e.g. "2:361-367:stft1,pwg1" → evidence. */
export function parseEvidence(text) {
    const m = /^(\d+):([\d.]+)\s*[-–]\s*([\d.]+):([^:]+)(?::(.+))?$/.exec(String(text).trim());
    if (!m) throw new Error(`"${text}" is not RUN:FROM-TO:CHANNELS[:DECODE], e.g. 2:361-367:stft1,pwg1`);
    return {
        run: Number(m[1]), from: Number(m[2]), to: Number(m[3]),
        channels: m[4].split(',').map(s => s.trim()).filter(Boolean),
        ...(m[5] ? { decode: m[5].trim() } : {}),
    };
}

/** A desk entry for `sessionId`, checked by the notebook's own rules. Throws the rule's sentence. */
export function deskEntry(sessionId, body, at = Date.now(), id = randomUUID()) {
    const entry = { id, sessionId, at, by: 'desk', body };
    const problem = entryProblem(entry);
    if (problem) throw new Error(problem);
    return entry;
}

/**
 * The next plan: the next version, rewriting the plan to drive by. Refused while two rewrites of
 * one plan are open — the driver chooses between those, not the desk.
 */
export function planBody(entries, fields) {
    const { plan, forked } = currentPlan(entries);
    if (forked) throw new Error('Two rewrites of the current plan are open. The driver chooses which to drive by (on the screen, or through the assistant); rewrite after that.');
    return { kind: 'plan', v: nextPlanVersion(entries), ...(plan ? { re: plan.id } : {}), ...fields };
}

/** An answer to a question put to the desk. A question to the driver is the driver's to answer. */
export function answerBody(entries, askId, text) {
    const ask = entries.find(e => e.id === askId);
    if (!ask || ask.body.kind !== 'ask') throw new Error(`${askId} is not a question in this notebook`);
    if (ask.body.to !== 'desk') throw new Error(`That question is for the ${ask.body.to}, not the desk: they answer it`);
    return { kind: 'answer', re: askId, text };
}

/** A reference (`re`) must be an entry of this notebook. */
export function mustExist(entries, id) {
    if (!entries.some(e => e.id === id)) throw new Error(`${id} is not an entry of this notebook (pull it to see the ids)`);
    return id;
}

const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The one statement that adds an entry. The row's owner is the session's own — copied from its row,
 * so an entry can only land in a session that is in the store, under whoever it belongs to — and
 * INSERT OR IGNORE makes sending it twice a no-op, as the API's insert does.
 */
export function insertSql(entry, storedAt = Date.now()) {
    return 'INSERT OR IGNORE INTO notebook_entries (id, session_id, owner, at, author, kind, body_json, stored_at) '
        + `SELECT ${sql(entry.id)}, ${sql(entry.sessionId)}, owner, ${Number(entry.at)}, ${sql(entry.by)}, `
        + `${sql(entry.body.kind)}, ${sql(JSON.stringify(entry.body))}, ${Number(storedAt)} `
        + `FROM sessions WHERE id = ${sql(entry.sessionId)} AND owner IS NOT NULL`;
}

/** Store rows → entries, as the API's GET builds them. */
export function entriesOf(rows) {
    return rows.map(r => ({ id: r.id, sessionId: r.session_id, at: r.at, by: r.author, body: JSON.parse(r.body_json) }));
}

const WHO = { driver: 'DRIVER', chat: 'CHAT', desk: 'DESK', owner: 'OWNER' };
const clock = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
const evidenceLine = (e) => `RUN ${e.run} ${e.from}–${e.to} s · ${e.channels.join(', ')}${e.decode ? ` · ${e.decode}` : ''}`;
const range = (r, unit) => (r ? ` ${r[0]}–${r[1]}${unit}` : '');

function stepLine(s) {
    const detail = [s.gear ? `gear ${s.gear}` : '', range(s.rpm, ' rpm').trim(), range(s.ro, ' % RO').trim(),
        s.holdS !== undefined ? `${s.holdS} s` : '', s.times ? `×${s.times}` : ''].filter(Boolean).join(', ');
    return `${s.do}${detail ? ` (${detail})` : ''}`;
}

/** Where an entry sits in a run, when it does: "R2 359.5". */
function placeOf(b) {
    if (b.kind === 'step') return `R${b.run} ${b.t.toFixed(1)}`;
    if (b.kind === 'note' && b.run !== null) return `R${b.run} ${b.t.toFixed(1)}`;
    if (b.kind === 'fact') return `R${b.evidence.run} ${b.evidence.from}`;
    if ((b.kind === 'read' && b.evidence)) return `R${b.evidence.run} ${b.evidence.from}`;
    if (b.kind === 'ask' && b.about) return `R${b.about.run} ${b.about.from}`;
    return null;
}

/** The plan that was the one to drive by when `at` came: a step is numbered against that plan, not
 *  against one written after the run. */
function planAt(entries, at) {
    return currentPlan(entries.filter(x => x.at <= at)).plan;
}

/** Words a person said or typed are quoted 「…」; the assistant's and the desk's are not. */
const said = (e, text) => (e.by === 'driver' || e.by === 'owner' ? `「${text}」` : text);

function entryLine(e, entries) {
    const b = e.body;
    const status = statusOf(entries, e.id);
    const tag = status === 'disputed' ? 'DISPUTED ' : status === 'withdrawn' ? 'WITHDRAWN ' : status === 'agreed' ? 'AGREED ' : '';
    const where = placeOf(b) ?? clock(e.at);
    const who = WHO[e.by];
    let what;
    switch (b.kind) {
        case 'plan': what = `PLAN v${b.v} — ${b.purpose}`; break;
        case 'step': {
            const plan = planAt(entries, e.at);
            const step = plan?.body.steps.find(s => s.n === b.n);
            what = `STEP ${b.n} done${step ? ` — ${step.do} (plan v${plan.body.v})` : ''}`;
            break;
        }
        case 'note': what = `「${b.text}」`; break;
        case 'fact': what = `FACT ${b.text} [${evidenceLine(b.evidence)}]`; break;
        case 'read': what = `READ (${b.sure}) ${b.text}${b.evidence ? ` [${evidenceLine(b.evidence)}]` : ''}${b.re ? ` — re ${b.re}` : ''}`; break;
        case 'ask': what = `ASK → ${WHO[b.to]}: ${b.text}${b.about ? ` [${evidenceLine(b.about)}]` : ''}`; break;
        case 'answer': what = `ANSWER to ${b.re}: ${said(e, b.text)}`; break;
        case 'status': what = `STATUS ${b.re} → ${b.to}`; break;
        default: what = JSON.stringify(b);
    }
    return `- \`${where}\` ${tag}${who} ${what}  <sub>${e.id}</sub>`;
}

/**
 * notebook.md: what a desk reads before it analyses anything. Questions waiting first (the driver's
 * answers decide what the data means), then the plan to drive by and the steps done in each run,
 * then everything in the order it was written, then the earlier sessions this one continues.
 */
export function renderNotebook({ session, runs, entries, parents = [] }) {
    const out = [];
    out.push(`# #${session.seq} ${session.label} — experiment notebook`, '');
    out.push(`- session \`${session.id}\`, mode ${session.process ?? 'VE'}, created ${clock(session.createdAt)}`);
    out.push(`- runs: ${runs.length ? runs.map(r => `RUN ${r.n} · ${r.points} pts`).join(', ') : 'none stored'}`);
    out.push('- The driver\'s words (「…」) are what they said. What you think they did is a question: `npm run notebook -- ask`.', '');

    const waiting = openAsks(entries);
    out.push('## Questions waiting', '');
    out.push(...(waiting.length ? waiting.map(e => entryLine(e, entries)) : ['- none']), '');

    const { plan, heads, forked } = currentPlan(entries);
    out.push('## Plan', '');
    if (!plan) out.push('- no plan in this notebook');
    for (const p of forked ? heads : plan ? [plan] : []) {
        const b = p.body;
        out.push(`### v${b.v} — ${WHO[p.by]}, ${clock(p.at)}${forked ? ' (FORK: the driver chooses)' : ''}`, '');
        out.push(`- purpose: ${b.purpose}`);
        if (b.hypothesis) out.push(`- hypothesis: ${b.hypothesis}`);
        if (b.criteria) out.push(`- criteria: ${b.criteria}`);
        if (b.carriedFrom) out.push(`- carried from the parent's plan \`${b.carriedFrom}\``);
        b.steps.forEach(s => out.push(`  ${s.n}. ${stepLine(s)}`));
        if (b.watch?.length) out.push(`- watch: ${b.watch.map(w => `${w.address} ${w.bytes} B every ${w.every}${w.label ? ` (${w.label})` : ''}`).join(', ')}`);
        // Only the steps marked while this plan was the one to drive by: a run driven to an
        // earlier version ticked that version's steps, whatever their numbers.
        const ticked = entries.filter(e => e.body.kind !== 'step' || planAt(entries, e.at)?.id === p.id);
        for (const r of runs) {
            const done = stepsDone(ticked, r.n);
            if (done.size) out.push(`- RUN ${r.n} steps done: ${[...done].map(([n, t]) => `${n} @ ${t.toFixed(1)} s`).join(', ')}`);
        }
        out.push('');
    }

    out.push('## In the order written', '');
    out.push(...(entries.length ? entries.map(e => entryLine(e, entries)) : ['- empty']), '');

    if (parents.length) {
        out.push('## Earlier sessions this one continues', '');
        for (const p of parents) {
            out.push(`### #${p.session.seq} ${p.session.label}`, '');
            const kept = p.entries.filter(e => ['plan', 'ask', 'answer', 'fact', 'read', 'note'].includes(e.body.kind));
            out.push(...(kept.length ? kept.map(e => entryLine(e, p.entries)) : ['- no notebook']), '');
        }
    }
    return out.join('\n');
}
