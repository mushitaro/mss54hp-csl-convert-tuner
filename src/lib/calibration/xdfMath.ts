import type { EcuScaling } from '@/lib/ecu-items/types';
import { rawLimits } from '@/lib/ecu-items/quantise';

/**
 * The XDF <MATH equation> strings, evaluated safely.
 *
 * The reference implementation is the notes repo's tools/pipeline/xdfmath.py:
 * an AST allowlist, never eval. This is the same idea as a hand-written
 * recursive-descent parser (no `new Function` — the strings are vendored data,
 * but the CSP and the principle both say treat them as untrusted).
 *
 * The one trap worth stating twice: TunerPro spells exponentiation `^`. In
 * JS/Python `^` is XOR and binds LOOSER than `/`, so `x/2^14` read natively
 * becomes `(x/2)^14` — and four constants (`K_KA_FILT_*`) use exactly that
 * form. Here `^` is exponentiation, right-associative, binding tighter than
 * `*`/`/` and than a unary minus to its left, so `x/2^14` is x/16384.
 *
 * Case is folded for the variables because the XDF is inconsistent (`x` and
 * `X`, `k` and `K`). A `k` is another item's value (VAR type="link", 2 items);
 * compiling it is refused and the parameter goes read-only rather than being
 * evaluated against a guessed constant.
 */

type Node = (x: number) => number;

const FUNCTIONS: Record<string, (args: number[]) => number> = {
    abs: a => Math.abs(a[0]),
    sqrt: a => Math.sqrt(a[0]),
    round: a => Math.round(a[0]),
    exp: a => Math.exp(a[0]),
    min: a => Math.min(...a),
    max: a => Math.max(...a),
};

interface ParseState {
    text: string;
    pos: number;
    usesK: boolean;
    failed: boolean;
}

function skipWs(s: ParseState): void {
    while (s.pos < s.text.length && /\s/.test(s.text[s.pos])) s.pos++;
}

function fail(s: ParseState): Node {
    s.failed = true;
    return () => NaN;
}

/** number := digits[.digits][e[+-]digits] | .digits — `.4*x` appears once. */
function parseNumber(s: ParseState): Node | null {
    const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.text.slice(s.pos));
    if (!m) return null;
    s.pos += m[0].length;
    const v = Number(m[0]);
    return () => v;
}

function parseAtom(s: ParseState): Node {
    skipWs(s);
    const num = parseNumber(s);
    if (num) return num;

    const ident = /^[A-Za-z_]\w*/.exec(s.text.slice(s.pos));
    if (ident) {
        const name = ident[0];
        s.pos += name.length;
        skipWs(s);
        if (s.text[s.pos] === '(') {
            const fn = FUNCTIONS[name.toLowerCase()];
            if (!fn) return fail(s);
            s.pos++; // '('
            const args: Node[] = [];
            for (;;) {
                args.push(parseExpr(s));
                skipWs(s);
                if (s.text[s.pos] === ',') { s.pos++; continue; }
                break;
            }
            if (s.text[s.pos] !== ')') return fail(s);
            s.pos++;
            return x => fn(args.map(a => a(x)));
        }
        const lower = name.toLowerCase();
        if (lower === 'x') return x => x;
        if (lower === 'k') { s.usesK = true; return fail(s); }
        return fail(s);
    }

    if (s.text[s.pos] === '(') {
        s.pos++;
        const inner = parseExpr(s);
        skipWs(s);
        if (s.text[s.pos] !== ')') return fail(s);
        s.pos++;
        return inner;
    }
    return fail(s);
}

/** power := atom ['^' unary] — right-associative, exponent may be signed. */
function parsePower(s: ParseState): Node {
    const base = parseAtom(s);
    skipWs(s);
    if (s.text[s.pos] === '^') {
        s.pos++;
        const exp = parseUnary(s);
        return x => Math.pow(base(x), exp(x));
    }
    return base;
}

function parseUnary(s: ParseState): Node {
    skipWs(s);
    if (s.text[s.pos] === '-') {
        s.pos++;
        const inner = parseUnary(s);
        return x => -inner(x);
    }
    if (s.text[s.pos] === '+') {
        s.pos++;
        return parseUnary(s);
    }
    return parsePower(s);
}

function parseTerm(s: ParseState): Node {
    let left = parseUnary(s);
    for (;;) {
        skipWs(s);
        const op = s.text[s.pos];
        if (op === '*' || op === '/' || op === '%') {
            s.pos++;
            const right = parseUnary(s);
            const l = left;
            left = op === '*' ? x => l(x) * right(x)
                : op === '/' ? x => l(x) / right(x)
                    : x => l(x) % right(x);
        } else {
            return left;
        }
    }
}

function parseExpr(s: ParseState): Node {
    let left = parseTerm(s);
    for (;;) {
        skipWs(s);
        const op = s.text[s.pos];
        if (op === '+' || op === '-') {
            s.pos++;
            const right = parseTerm(s);
            const l = left;
            left = op === '+' ? x => l(x) + right(x) : x => l(x) - right(x);
        } else {
            return left;
        }
    }
}

/** Compile raw→physical, or null when the equation uses `k` or anything unknown. */
export function compileForward(math: string): ((x: number) => number) | null {
    const s: ParseState = { text: math, pos: 0, usesK: false, failed: false };
    const node = parseExpr(s);
    skipWs(s);
    if (s.failed || s.pos !== s.text.length) return null;
    return node;
}

export type InverseKind = 'affine' | 'bisection' | 'scan';

/** First raw in [min,max] where `f` is finite, walking up from min. */
function firstFinite(f: Node, min: number, max: number): number | null {
    for (let r = min; r <= Math.min(max, min + 16); r++) {
        if (Number.isFinite(f(r))) return r;
    }
    return null;
}

/**
 * A full EcuScaling for an XDF equation over a raw domain, or null when the
 * forward will not compile. `quantise`/`quantiseToward` consume the result
 * unchanged; `toRaw` returns a fractional raw and the writer rounds.
 *
 * Inverse strategy, in order:
 *  1. affine — three probes with vanishing second difference → analytic.
 *  2. bisection — strictly monotone over sampled points → integer bisection
 *     plus one linear refinement (keeps round/floor/ceil semantics exact).
 *     Reciprocal forms invert direction; that is handled, not special-cased.
 *  3. scan — cached argmin over the whole domain (65,536 evals worst case,
 *     once per parameter, only for the shapes nothing else fits).
 */
export function buildScaling(
    math: string,
    domain: { min: number; max: number },
): (EcuScaling & { inverse: InverseKind }) | null {
    const f = compileForward(math);
    if (!f) return null;

    const toPhysical = (raw: number) => f(raw);
    const lo = domain.min;
    const hi = domain.max;

    // ---- 1. affine ---------------------------------------------------------
    const p0 = firstFinite(f, lo, hi);
    if (p0 !== null && p0 + 2 <= hi) {
        const f0 = f(p0);
        const f1 = f(p0 + 1);
        const f2 = f(p0 + 2);
        const slope = f1 - f0;
        const scale = Math.max(1, Math.abs(f0), Math.abs(f1));
        if (
            Number.isFinite(f0) && Number.isFinite(f1) && Number.isFinite(f2) &&
            Math.abs((f2 - f1) - slope) <= 1e-9 * scale && slope !== 0
        ) {
            // Guard against a shape that is only locally linear: the far end
            // must sit on the same line.
            const fEnd = f(hi);
            const predicted = f0 + (hi - p0) * slope;
            if (Number.isFinite(fEnd) && Math.abs(fEnd - predicted) <= 1e-6 * Math.max(1, Math.abs(fEnd))) {
                return {
                    math,
                    toPhysical,
                    toRaw: v => p0 + (v - f0) / slope,
                    inverse: 'affine',
                };
            }
        }
    }

    // ---- 2. monotone bisection --------------------------------------------
    // Non-finite cells (5.12/x at raw 0) sit at the domain edge; bisect over
    // the contiguous finite region instead of refusing the whole shape.
    const bLo = firstFinite(f, lo, hi);
    if (bLo !== null) {
        const samples: Array<{ r: number; v: number }> = [];
        const steps = 16;
        for (let i = 0; i <= steps; i++) {
            const r = Math.round(bLo + ((hi - bLo) * i) / steps);
            const v = f(r);
            if (Number.isFinite(v)) samples.push({ r, v });
        }
        const finite = samples.filter((s, i) => i === 0 || s.r !== samples[i - 1].r);
        if (finite.length >= 4) {
            const increasing = finite[1].v > finite[0].v;
            const monotone = finite.every(
                (s, i) => i === 0 || (increasing ? s.v > finite[i - 1].v : s.v < finite[i - 1].v),
            );
            if (monotone) {
                const toRaw = (v: number): number => {
                    let a = bLo;
                    let b = hi;
                    if (increasing ? v <= f(a) : v >= f(a)) return a;
                    if (increasing ? v >= f(b) : v <= f(b)) return b;
                    while (b - a > 1) {
                        const mid = (a + b) >> 1;
                        const fm = f(mid);
                        if (increasing ? fm <= v : fm >= v) a = mid;
                        else b = mid;
                    }
                    const fa = f(a);
                    const fb = f(b);
                    return fb === fa ? a : a + (v - fa) / (fb - fa);
                };
                return { math, toPhysical, toRaw, inverse: 'bisection' };
            }
        }
    }

    // ---- 3. nearest-by-scan ------------------------------------------------
    let table: Float64Array | null = null;
    const toRaw = (v: number): number => {
        if (!table) {
            table = new Float64Array(hi - lo + 1);
            for (let r = lo; r <= hi; r++) table[r - lo] = f(r);
        }
        let best = lo;
        let bestDist = Infinity;
        for (let r = lo; r <= hi; r++) {
            const d = Math.abs(table[r - lo] - v);
            if (d < bestDist) { bestDist = d; best = r; }
        }
        return best;
    };
    return { math, toPhysical, toRaw, inverse: 'scan' };
}

/** Raw limits for a field — THE rule, from lib/ecu-items/quantise.ts, re-shaped for callers
 *  that hold bits/signed loose rather than in an EcuNumericDef. */
export function rawDomain(bits: 8 | 16, signed: boolean): { min: number; max: number } {
    return rawLimits({ bits, signed });
}
