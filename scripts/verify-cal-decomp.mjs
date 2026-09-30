// Checks the decompiler corpus against the graph, and the copy against both.
//
// The bug this exists to catch already shipped once: the tab told the reader
// that the decompiler's output for a function "was never parsed into
// statements", over all 1,171 functions with no formulas, when for 110 of them
// the text existed and could have been shown. A sentence that is true of one
// population and false of another is worse than no sentence, and nothing in
// the build would have noticed — it is prose.
//
// So the populations are pinned here, AND the strings that quote them are
// checked for the numbers they claim. A re-vendor that moves 110 to 130 fails
// this file until the copy moves with it.
//
// Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs

import { readFileSync, existsSync } from 'node:fs';
import { index } from '../src/lib/calibration-graph/graph.ts';
import { makeContext } from '../src/lib/calibration-graph/logic-format.ts';
import { buildDiagram } from '../src/lib/calibration-graph/diagram-model.ts';
import { buildCode } from '../src/lib/calibration-graph/code-model.ts';
import { isCWord, sourceLines } from '../src/lib/calibration-graph/decomp.ts';

const PIN = {
    /**
     * Functions whose decompiled text ships — now all of them.
     *
     * It was 644. `export_relations.py` dropped every function still called
     * `FUN_`, which was 1,061 of the 1,705, so 62% of the controller was
     * filtered out by spelling and reached the viewer indistinguishable from
     * a function the decompiler had choked on. The clause is gone and the
     * corpus is the whole binary.
     */
    texts: 1705,
    /** Of those, the ones statements were parsed out of. Was 534. */
    parsed: 1384,
    /**
     * A body, and no parsed statements: what the quoted-C view is for.
     *
     * Was 110, when being NAMED was the only way to get decompiled at all.
     * Now 336, and 225 of them are unnamed — which is the positive proof the
     * filter is gone, so the old "every one of these is named" check has been
     * replaced by `texts === functions` below.
     */
    sourceOnly: 321,
    /**
     * Functions with no text at all. Zero, and it should stay zero.
     *
     * This is not a pin that is expected to move. If it ever does, a rebuild
     * lost something, and the tab has a sentence ready that says so.
     */
    dark: 0,
    /** Every function in the artifact. */
    functions: 1705,

    /** Lines of C, over the whole corpus. Was 32,660 across the 644. */
    lines: 76551,
    /**
     * Identifiers in it, and how many are symbols the graph can resolve.
     *
     * "Identifier" here means a NAME — `isCWord` excludes C itself, both the
     * grammar (`if`, `while`) and the width casts (`ushort`, `undefined4`),
     * because counting those would make the coverage ratio a statement about
     * how much C is C. What is left is symbols, RAM, calibrations, and the
     * decompiler's own scratch variables.
     */
    idents: 92954,
    identsKnown: 33173,
    /** Calls into another function by address. */
    funRefs: 2737,
    /**
     * Of those, the ones that resolve to nothing — and why that is allowed.
     *
     * Both are `SUB_00f7d000`, from `f:master:03cfb6` and `f:slave:03ea34`.
     * No node in either bank sits at 0xF7D000: it is outside the image, a
     * label Ghidra gave an indirect target that is not in the program. A
     * reference to nowhere is a fact about the binary, not a broken link, and
     * the renderer draws it as machine detail with the address in its tooltip.
     * Pinned rather than tolerated, so a third one is a failure.
     */
    funDead: 2,
};

let fails = 0;
function check(label, ok, detail = '') {
    if (ok) { console.log(`  ok  ${label}`); return; }
    fails += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

// The corpus is Ghidra's decompiled C of the BMW 0401 program. It is kept off both public branches
// (NOT_FOR_MAIN and NOT_FOR_PUBLIC in scripts/release-scope.mjs), so a clone of main or of preview
// does not have it — and everything below is about it. Absent is a SKIP, not a failure; the app
// falls back to quoted names without it.
const CORPUS = 'public/data/calibration-decomp.json';
if (!existsSync(CORPUS)) {
    console.log(`\n  SKIP  ${CORPUS} is absent (it stays off the public branches) — nothing here to check.`);
    process.exit(0);
}

const raw = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
const g = index(raw);
const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));

// --------------------------------------------------------------------------
// the corpus is exactly the functions the graph says have code
// --------------------------------------------------------------------------
{
    const funcs = raw.nodes.filter((n) => n.t === 'func');
    const hasCode = funcs.filter((n) => n.hasCode);
    const ids = new Set(Object.keys(corpus.texts));

    check(`${PIN.texts} decompiled texts ship`, ids.size === PIN.texts, `${ids.size}`);
    check(`${PIN.functions} functions in the artifact`, funcs.length === PIN.functions, `${funcs.length}`);

    const orphans = [...ids].filter((id) => !hasCode.some((n) => n.id === id));
    const missing = hasCode.filter((n) => !ids.has(n.id));
    check('every text belongs to a node claiming hasCode', orphans.length === 0, `${orphans.length}`);
    check('every node claiming hasCode has a text', missing.length === 0, `${missing.length}`);

    const parsed = funcs.filter((n) => n.stmts?.length);
    const sourceOnly = funcs.filter((n) => n.hasCode && !n.stmts?.length);
    const dark = funcs.filter((n) => !n.hasCode && !n.stmts?.length);
    check(`${PIN.parsed} functions have parsed statements`, parsed.length === PIN.parsed, `${parsed.length}`);
    check(`${PIN.sourceOnly} have text but no statements`, sourceOnly.length === PIN.sourceOnly, `${sourceOnly.length}`);
    check(`${PIN.dark} have neither`, dark.length === PIN.dark, `${dark.length}`);
    check(
        'the three populations account for every function',
        parsed.length + sourceOnly.length + dark.length === funcs.length,
    );

    // The filter is gone, and this is what says so.
    //
    // These two checks used to assert the opposite correlation — that every
    // text-only function was NAMED and every dark one UNNAMED — because being
    // named was precisely what got a function decompiled. That was the proof
    // the filter, not the decompiler, was the cause. Now that the clause is
    // removed the correlation is meant to be broken: 225 of the 336 are
    // unnamed and have their bodies anyway.
    check(
        'every function in the artifact has its decompiled body',
        funcs.length === ids.size,
        `${funcs.length} functions, ${ids.size} texts`,
    );
    check(
        'the text-only population is no longer explained by naming',
        sourceOnly.some((n) => !n.named) && sourceOnly.some((n) => n.named),
        `${sourceOnly.filter((n) => !n.named).length} unnamed of ${sourceOnly.length}`,
    );
}

// --------------------------------------------------------------------------
// the tokenizer quotes, it does not rewrite
// --------------------------------------------------------------------------
{
    let lines = 0;
    let idents = 0;
    let known = 0;
    let funRefs = 0;
    let funResolved = 0;
    let broken = 0;
    let firstBreak = '';

    for (const [id, text] of Object.entries(corpus.texts)) {
        const bank = id.split(':')[1];
        const raws = text.replace(/\r\n/g, '\n').split('\n');
        lines += raws.length;
        for (const line of sourceLines(g, bank, text)) {
            if (line.comment) continue;
            const joined = line.tokens.map((tk) => tk.text).join('');
            // The invariant: what is drawn is what Ghidra emitted. A tokenizer
            // that drops a character is a tokenizer that silently edits the
            // source it claims to be quoting.
            const original = raws.find((r) => r.trim() && r.slice(line.indent).replace(/\s+$/, '') === joined);
            if (!original && joined) {
                const back = joined;
                if (!text.includes(back)) {
                    broken += 1;
                    if (!firstBreak) firstBreak = `${id}: ${back.slice(0, 60)}`;
                }
            }
            for (const tk of line.tokens) {
                if (!/^[A-Za-z_]\w*$/.test(tk.text) || isCWord(tk.text)) continue;
                idents += 1;
                if (tk.name) known += 1;
                if (/^(FUN|SUB|CODE)_[0-9a-fA-F]{6,8}$/.test(tk.text)) {
                    funRefs += 1;
                    if (tk.target) funResolved += 1;
                }
            }
        }
    }

    check(`${PIN.lines} lines of C in the corpus`, lines === PIN.lines, `${lines}`);
    check('every tokenized line concatenates back to its source', broken === 0, firstBreak);
    check(`${PIN.idents} identifiers`, idents === PIN.idents, `${idents}`);
    check(`${PIN.identsKnown} of them resolve to a graph symbol`, known === PIN.identsKnown, `${known}`);
    check(`${PIN.funRefs} calls by address`, funRefs === PIN.funRefs, `${funRefs}`);
    check(
        `${PIN.funRefs - PIN.funDead} of ${PIN.funRefs} calls by address open a real function`,
        funRefs - funResolved === PIN.funDead,
        `${funRefs - funResolved} dead`,
    );
    // And the ones that do not must point outside the image, not at a node
    // this tool failed to find. A dead link to an address a node DOES occupy
    // would be a bug in `byAddress`, and would look identical from outside.
    {
        let inImage = 0;
        for (const [id, text] of Object.entries(corpus.texts)) {
            const bank = id.split(':')[1];
            for (const line of sourceLines(g, bank, text)) {
                for (const tk of line.tokens) {
                    if (!/^(FUN|SUB|CODE)_[0-9a-fA-F]{6,8}$/.test(tk.text) || tk.target) continue;
                    const addr = parseInt(tk.text.split('_')[1], 16);
                    if (raw.nodes.some((n) => n.addr === addr)) inImage += 1;
                }
            }
        }
        check('every dead call points outside the image', inImage === 0, `${inImage} had a node`);
    }
}

// --------------------------------------------------------------------------
// the listing shows it, and the box says the right one of three things
// --------------------------------------------------------------------------
{
    const ctx = makeContext(raw.nodes, raw.nameIndex, g.byId, raw.glossary, 'en', true);
    const sourceOnly = raw.nodes.filter((n) => n.t === 'func' && n.hasCode && !n.stmts?.length);

    let quoted = 0;
    let stillEmpty = 0;
    for (const node of sourceOnly.slice(0, 40)) {
        const d = buildDiagram(g, node.id, { ctx, maxPorts: 14, depth: 0, expanded: new Set() });
        if (!d) continue;
        const listing = buildCode(g, d, ctx, { corpus });
        const rows = listing.lines.filter((l) => l.kind === 'source');
        if (rows.length) quoted += 1;
        else stillEmpty += 1;
        // Without the corpus the same listing must fall back, not throw: a
        // failed fetch is the state the app is in until the file arrives.
        const bare = buildCode(g, d, ctx);
        if (bare.lines.some((l) => l.kind === 'source')) stillEmpty += 100;
    }
    check('a function with only text is listed as quoted C', stillEmpty === 0, `${stillEmpty}`);
    check(`${quoted} of the first 40 quote their body`, quoted > 0, `${quoted}`);

    check(
        'an empty box never says noFormula about a function whose text ships',
        raw.nodes
            .filter((n) => n.t === 'func' && n.hasCode && !n.stmts?.length)
            .every((n) => corpus.texts[n.id]),
    );

    // The box's states, sampled from each population rather than from the head
    // of the node list — the first two hundred nodes are all parsed ones, so a
    // slice off the front tests nothing and says it passed.
    //
    // `noFormula` is not sampled because its population is empty; an empty
    // sample passes vacuously and reads as a check that ran. It is asserted as
    // empty instead, which is the claim actually worth holding.
    const dark = raw.nodes.filter((n) => n.t === 'func' && !n.hasCode && !n.stmts?.length);
    check('no box has to say "no decompiler output" at all', dark.length === 0, `${dark.length} do`);
    const want = [['sourceOnly', sourceOnly]];
    for (const [expect, population] of want) {
        let right = 0;
        let seen = 0;
        for (const node of population.slice(0, 40)) {
            // `openBlocks` because a shut box is a name and says nothing about
            // why it is empty — the label under test only exists once the
            // reader has opened it, which is the state this asserts.
            const d = buildDiagram(g, node.id, {
                ctx, maxPorts: 14, depth: 0, expanded: new Set(), openBlocks: true,
            });
            const box = d?.nodes.find((n) => n.target === node.id && n.rows);
            if (!box) continue;
            seen += 1;
            if (box.empty === expect) right += 1;
        }
        check(`${seen} sampled boxes all say "${expect}"`, seen > 0 && right === seen, `${right}/${seen}`);
    }
}

// --------------------------------------------------------------------------
// the copy quotes the numbers this file just measured
// --------------------------------------------------------------------------
{
    // The STRINGS, not the file: the note above `blockNoFormula` explains the
    // merged 1,171 on purpose, and a check that could not tell a comment from
    // a sentence the reader sees would force that history to be deleted.
    const copy = readFileSync('src/lib/calibration-graph/calib-i18n.ts', 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
        .join('\n');
    const says = (n) => copy.includes(n.toLocaleString('en-US'));
    check(`the text-only copy quotes ${PIN.sourceOnly}`, says(PIN.sourceOnly));
    check('it quotes the 1,705 it is a share of', says(PIN.functions));
    check(
        'no copy still claims 1,171 functions were never parsed',
        !copy.includes('1,171'),
        'the merged number is back',
    );
    // The sentence for the empty population has to say it is empty. Left
    // saying "1,061 of the 1,705 are in that state" it would be a confident,
    // specific, wrong claim on a screen nobody can currently reach.
    check(
        'the no-output copy says the population is now zero',
        /現在 0 個|No function is in this state any more/.test(copy),
        'it still describes 1,061 as current',
    );
}

console.log(fails === 0 ? '\nverify-cal-decomp: all checks passed' : `\nverify-cal-decomp: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
