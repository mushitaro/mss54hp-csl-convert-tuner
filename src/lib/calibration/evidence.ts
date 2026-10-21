import type { Indexed } from '@/lib/calibration-graph/graph';
import type { CalParamDef } from './types';

/**
 * What the catalog can say about a parameter beyond its value — the evidence an assistant (or a
 * person) needs before saying what a value MEANS, rather than guessing from the name.
 *
 * Three sources, each already in the vendored graph:
 *   - the XDF's own enumeration (TXTEQ), when the XDF lists what each value selects;
 *   - the free text of the XDF description, with the find routine's bookkeeping taken out;
 *   - the DME code: which functions read it, and every condition those functions test it in.
 *     The conditions are the value space the DME itself tells apart — `cfg_m_getriebetyp == 0x40`
 *     says 0x40 is one case; a value the code never compares with falls in "none of them".
 *
 * Read-only, pure, and bounded: a parameter read by fifty functions yields its twelve most
 * common conditions, not a dump.
 */

export interface ParamChoice {
    /** The value as the XDF writes it, or 'else' for its catch-all. */
    value: number | 'else';
    label: string;
}

/** The XDF's TXTEQ enumeration — `TXTEQ(x::0 1 aus V-Fz :1 1 aus S_Gang :2 1 aus S_Kuppl )`. */
export function paramChoices(desc: string): ParamChoice[] | null {
    const m = desc.match(/TXTEQ\(x::([\s\S]*?)\)/);
    if (!m) return null;
    const out: ParamChoice[] = [];
    for (const item of m[1].split(':')) {
        const one = item.trim().match(/^(\$[0-9a-fA-F]+|\d+|ELSE)\s+1\s+(.+)$/i);
        if (!one) continue;
        const v = one[1].toUpperCase() === 'ELSE' ? 'else'
            : one[1].startsWith('$') ? parseInt(one[1].slice(1), 16) : Number(one[1]);
        out.push({ value: v, label: one[2].trim() });
    }
    return out.length ? out : null;
}

// Lines the XDF's find routine wrote about itself — where it matched, not what the item is.
const BOOKKEEPING = [
    /^HW:/, /^Created by find routine/, /^BMWFlash/, /^Matched Length/, /^BlockFound/,
    /^Units-/, /^Function:/, /^Description:\s*None\s*$/i, /^TXTEQ\(/,
];

/** The XDF description without the find routine's bookkeeping; '' when nothing else is left. */
export function paramNote(desc: string): string {
    return desc.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !BOOKKEEPING.some(re => re.test(l)))
        .map(l => l.replace(/^Description:\s*/i, ''))
        .join(' / ');
}

/** C character literals as the numbers they are: '@' → 0x40, '\0' → 0x00, '\x02' → 0x02. */
function hexLiterals(s: string): string {
    return s.replace(/'(\\x[0-9a-fA-F]{1,2}|\\0|\\[nrt]|[^'\\])'/g, (_, c: string) => {
        const code = c === '\\0' ? 0 : c.startsWith('\\x') ? parseInt(c.slice(2), 16)
            : c === '\\n' ? 10 : c === '\\r' ? 13 : c === '\\t' ? 9 : c.charCodeAt(0);
        return `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    });
}

/** One clause of a condition, its stray brackets and a leading `not` taken off. */
function tidy(clause: string): string {
    let s = clause.trim().replace(/^not\s+/, '');
    for (let i = 0; i < 6; i++) {
        const opens = (s.match(/\(/g) ?? []).length, closes = (s.match(/\)/g) ?? []).length;
        if (opens > closes && s.startsWith('(')) s = s.slice(1).trim();
        else if (closes > opens && s.endsWith(')')) s = s.slice(0, -1).trim();
        else if (s.startsWith('(') && s.endsWith(')') && opens === closes && balancedInside(s)) s = s.slice(1, -1).trim();
        else break;
        s = s.replace(/^not\s+/, '');
    }
    return s;
}

function balancedInside(s: string): boolean {
    let depth = 0;
    for (let i = 1; i < s.length - 1; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth < 0) return false;
    }
    return depth === 0;
}

export interface CodeUses {
    /** How many functions read it, and the first few by name. */
    readBy: { count: number; names: string[] };
    /** The conditions it is tested in, most widespread first, with where. */
    conditions: { when: string; in: string[] }[];
}

const MAX_CONDITIONS = 12;
const MAX_PLACES = 4;

export function codeUses(graph: Indexed, def: CalParamDef): CodeUses {
    const readers = new Map<string, string>();
    for (const e of graph.in.get(def.id) ?? []) {
        if (e.k !== 'read') continue;
        const fn = graph.byId.get(e.s);
        if (fn?.t === 'func') readers.set(fn.id, fn.name);
    }
    // The decompiler writes the symbol with '_' where the XDF has '.': cfg_m.getriebetyp is
    // cfg_m_getriebetyp in the code.
    const ident = def.name.replace(/[^A-Za-z0-9_]/g, '_');
    const word = new RegExp(`(^|[^A-Za-z0-9_])${ident}([^A-Za-z0-9_]|$)`);
    const found = new Map<string, Set<string>>();
    for (const id of readers.keys()) {
        const fn = graph.byId.get(id);
        for (const st of fn?.stmts ?? []) {
            for (const text of [...st.guards, st.expr]) {
                if (!word.test(text)) continue;
                for (const part of hexLiterals(text).split(/&&|\|\|/)) {
                    const clause = tidy(part);
                    if (!word.test(clause) || clause === ident) continue;
                    const places = found.get(clause) ?? new Set<string>();
                    places.add(fn!.name);
                    found.set(clause, places);
                }
            }
        }
    }
    const conditions = [...found]
        .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
        .slice(0, MAX_CONDITIONS)
        .map(([when, places]) => ({ when, in: [...places].slice(0, MAX_PLACES) }));
    return { readBy: { count: readers.size, names: [...readers.values()].slice(0, 6) }, conditions };
}

// --- RAM -----------------------------------------------------------------------------------------

export interface RamHit {
    name: string;
    bank: 'master' | 'slave';
    address: number;
    /** Whether an OBSERVE run can read it: master RAM inside the windows the DME serves over DS2. */
    observable: boolean;
    /** Where the DME code assigns it, and what — the first few, the C literals as hex. */
    writes: { in: string; value: string }[];
    /** How many functions read it. */
    readers: number;
}

const MAX_RAM_WRITES = 4;

/**
 * RAM symbols by name or address, for planning an OBSERVE run: the assistant could not find an
 * address it was asked to watch, and the catalog holds 2,563 of them by name.
 *
 * An address is taken as one only when it is written as one (DAT_00ffd1a2, 0xFFD1A2, or four or more
 * hex digits); "ad" is a word to look for, not 0xAD. Exact names first, then names containing it.
 */
export function ramFind(
    graph: Indexed, query: string, limit: number,
    observableAt: (bank: 'master' | 'slave', address: number) => boolean,
): RamHit[] {
    const q = query.trim();
    const asAddress = /^(DAT_|0x)/i.test(q) || /^[0-9a-f]{4,8}$/i.test(q) ? parseInt(q.replace(/^(DAT_|0x)/i, ''), 16) : NaN;
    const ram = graph.raw.nodes.filter(n => n.t === 'ram' && typeof n.addr === 'number');
    const lower = q.toLowerCase();
    const hits = Number.isFinite(asAddress)
        ? ram.filter(n => n.addr === asAddress)
        : [...ram.filter(n => n.name.toLowerCase() === lower), ...ram.filter(n => n.name.toLowerCase() !== lower && n.name.toLowerCase().includes(lower))];
    return hits.slice(0, limit).map(n => {
        const address = n.addr!;
        const bank = (n.bank ?? 'master') as 'master' | 'slave';
        const alias = `DAT_00${address.toString(16).padStart(6, '0')}`;
        const writes: RamHit['writes'] = [];
        for (const fn of graph.raw.nodes) {
            if (fn.t !== 'func' || fn.bank !== bank || writes.length >= MAX_RAM_WRITES) continue;
            for (const st of fn.stmts ?? []) {
                if (st.out !== n.name && st.out.toLowerCase() !== alias) continue;
                writes.push({ in: fn.name, value: hexLiterals(st.expr) });
                if (writes.length >= MAX_RAM_WRITES) break;
            }
        }
        const readers = (graph.in.get(n.id) ?? []).filter(e => e.k === 'read' && graph.byId.get(e.s)?.t === 'func').length;
        return { name: n.name, bank, address, observable: observableAt(bank, address), writes, readers };
    });
}
