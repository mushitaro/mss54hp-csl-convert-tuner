// Checks that what docs/ecu-logic cites still exists.
//
// It does NOT check that the documents are right. A machine can tell whether a
// citation POINTS at something; only a person can tell whether the thing it
// points at supports the sentence. See docs/ecu-logic/91-evidence.md §5.
//
// What it is for: the artifact is regenerated from the notes pipeline, and when
// it is, a reference in prose can go stale without anything failing. Function
// addresses move when Ghidra re-analyses. Symbols get renamed. This turns that
// into a build failure instead of a wrong sentence nobody re-read.
//
// Runner: node

import { readFileSync, readdirSync, existsSync } from 'node:fs';

const PIN = {
    /**
     * Every `master 0xNNNN` / `slave 0xNNNN` in the prose, as a FLOOR.
     *
     * It was an equality and that was wrong: writing documentation adds
     * citations, so an exact pin fired on every honest edit. A check that
     * fails when someone does the right thing teaches people to bump the
     * number without reading it, and then it catches nothing.
     *
     * The hazard worth catching is citations DISAPPEARING — a bulk rewrite
     * that strips them, or a document deleted with its evidence. That is a
     * floor.
     */
    addresses: 145,
    /**
     * Cited addresses that are nowhere in the artifact.
     *
     * Known and allowed at this count, not approved: 0x3FFC and 0xBFFC are the
     * checksum slots, which are real positions in the binary with no parameter
     * at them, and a couple are placeholders in worked examples. This is a
     * number to drive DOWN. It is pinned so it cannot drift UP.
     */
    addressesNowhere: 11,
    /** Backticked names shaped like an ECU symbol. A floor, for the same reason. */
    symbols: 832,
    /** Of those, ones the artifact does not have. A CEILING: drive it down. */
    symbolsUnknown: 9,
};

let fails = 0;
function check(label, ok, detail = '') {
    if (ok) { console.log(`  ok  ${label}`); return; }
    fails += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const raw = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
// Ghidra's decompiled C of the BMW 0401 program — kept off both public branches (NOT_FOR_MAIN and
// NOT_FOR_PUBLIC in scripts/release-scope.mjs). Without it, the addresses and symbols are still
// checked against the graph and every [C] citation must still name a function node; only "the
// decompiled text is really there" is SKIPPED, and said so.
const CORPUS = 'public/data/calibration-decomp.json';
const corpus = existsSync(CORPUS) ? JSON.parse(readFileSync(CORPUS, 'utf8')) : null;
if (!corpus) console.log(`\n  SKIP  ${CORPUS} is absent (it stays off the public branches) — [C] citations are checked against function nodes only.\n`);

// The XDF stores a title beside the symbol — `KF_EVAN1_SOLL (Map_ VANOS
// Intake_Target)` — so the bare symbol is everything before the first " (".
const bare = (s) => s.split(' (')[0].trim();

const known = new Set();
const exact = new Map();
const funcs = [];
for (const n of raw.nodes) {
    if (n.name) {
        known.add(bare(n.name));
        known.add(bare(n.name).toLowerCase());
    }
    if (n.addr != null) {
        exact.set(`${n.bank ?? '-'}:${n.addr}`, n);
        exact.set(`any:${n.addr}`, n);
        if (n.t === 'func') funcs.push(n);
    }
}

const insideFunction = (bank, addr) =>
    funcs.some((f) => f.bank === bank && addr >= f.addr && addr < f.addr + (f.size ?? 0));

const ADDR = /\b(master|slave)\s*`?(?:0x)([0-9A-Fa-f]{4,6})`?/g;
const SYM = /`([A-Za-z_][A-Za-z0-9_]{2,})`/g;
// Only names shaped like an ECU symbol. Bare ALL-CAPS words in these documents
// are this application's own vocabulary — TUNED, NOMINAL, DIRECT — and are not
// claims about the ECU at all.
const ECU_SHAPE = /^(?:K|KL|KF|k|kl|kf|B)_[A-Za-z0-9_]+$|_(?:calc|init|filter)$/;
// The evidence tag from 91-evidence.md: [C master/021a70]
const CITE_C = /\[C\s+(master|slave)\/([0-9a-fA-F]{6})\]/g;

const DIR = 'docs/ecu-logic';
const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();

let addresses = 0;
let nowhere = 0;
const nowhereList = [];
let symbols = 0;
let unknown = 0;
const unknownList = new Map();
let cites = 0;
const citeBad = [];

// The document ABOUT citations quotes broken ones on purpose — §6 names
// `k_log` and `k_old` as placeholders precisely so a reader knows they are.
// Scanning it for ECU claims charges it for its own examples. Its [C] examples
// are still checked below, because those must point at something real or the
// document is teaching a form that does not work.
const META = '91-evidence.md';

for (const f of files) {
    const text = readFileSync(`${DIR}/${f}`, 'utf8');
    let m;

    if (f !== META) {
        ADDR.lastIndex = 0;
        while ((m = ADDR.exec(text))) {
            addresses += 1;
            const a = parseInt(m[2], 16);
            if (exact.has(`${m[1]}:${a}`) || exact.has(`any:${a}`)) continue;
            if (insideFunction(m[1], a)) continue;
            nowhere += 1;
            nowhereList.push(`${f}: ${m[1]} 0x${m[2]}`);
        }

        SYM.lastIndex = 0;
        while ((m = SYM.exec(text))) {
            if (!ECU_SHAPE.test(m[1])) continue;
            symbols += 1;
            if (known.has(m[1]) || known.has(m[1].toLowerCase())) continue;
            unknown += 1;
            unknownList.set(m[1], (unknownList.get(m[1]) ?? 0) + 1);
        }
    }

    // A [C] citation is the one tag the rule in 91-evidence.md turns on, so it
    // is held to a stricter standard than a bare address: the text must exist
    // AND a function node must sit at that address.
    CITE_C.lastIndex = 0;
    while ((m = CITE_C.exec(text))) {
        cites += 1;
        const id = `f:${m[1]}:${m[2].toLowerCase()}`;
        const hasText = corpus ? Boolean(corpus.texts[id]) : true;
        const hasNode = exact.get(`${m[1]}:${parseInt(m[2], 16)}`)?.t === 'func';
        if (!hasText || !hasNode) {
            citeBad.push(`${f}: [C ${m[1]}/${m[2]}]${hasText ? '' : ' no text'}${hasNode ? '' : ' no function node'}`);
        }
    }
}

check(`${files.length} documents read`, files.length > 0);
check('91-evidence.md is present', existsSync(`${DIR}/91-evidence.md`));

check(`${addresses} addresses cited`, addresses >= PIN.addresses,
    `fewer than the ${PIN.addresses} pinned — citations were removed`);
check(
    `${nowhere} cited addresses are nowhere in the artifact`,
    nowhere <= PIN.addressesNowhere,
    `pinned at most ${PIN.addressesNowhere}\n      ` + nowhereList.join('\n      '),
);

check(`${symbols} ECU symbols cited`, symbols >= PIN.symbols,
    `fewer than the ${PIN.symbols} pinned — citations were removed`);
check(
    `${unknown} cited symbols are not in the artifact`,
    unknown <= PIN.symbolsUnknown,
    `pinned at most ${PIN.symbolsUnknown}: ` + [...unknownList.keys()].join(', '),
);

check(`${cites} [C] citations`, cites > 0, 'the tag is defined but never used');
check(corpus ? 'every [C] citation names a real decompiled function' : 'every [C] citation names a function node (decompiled text SKIPPED: no corpus)',
    citeBad.length === 0, citeBad.join('; '));

console.log(fails === 0 ? '\nverify-cal-docs: all checks passed' : `\nverify-cal-docs: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
