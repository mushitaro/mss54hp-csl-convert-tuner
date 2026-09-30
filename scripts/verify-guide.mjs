/**
 * The "how to use" guide, held to the screen it describes and to the two ways it is read.
 *
 * GuideCarousel is prose that names controls, and prose that names controls is coupled to them
 * (tsunagi-m-ux §13): a rename of "Download Tuned" would leave a first-time reader told to press a
 * button that no longer exists, and nothing would fail. It is also written once and read twice —
 * as a carousel after the disclaimer, and as plain text in the static export for a reader that runs
 * no script — and the second reading rests on three pieces agreeing. So:
 *
 *   1. every label it names (GUIDE_LABELS) is still a label in the UI source — a string literal or
 *      a JSX text node, case-insensitively; the hub's verbs only by the hub's own `label: '…'`;
 *   2. both languages walk the same flow: the same slides, the same labels in the same order;
 *   3. the carousel, rendered at every position in both languages, shows one slide and makes the
 *      rest inert, keeps BACK in place but invisible on the first, and ends on DONE;
 *   4. the static copy carries every slide in both languages, and is hidden from exactly the readers
 *      who get the carousel: GuideStatic is `.no-js-only`, globals.css hides that under
 *      `html[data-js]`, and JS_MARK_SCRIPT is what sets `data-js`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GUIDE_LABELS, GUIDE_TEXT, GuideCarouselView, GuideStatic } from '../src/components/GuideCarousel.tsx';
import { JS_MARK_SCRIPT } from '../src/lib/js-mark.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + (d ?? ''))); if (!c) fails++; };

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = (dir) => readdirSync(dir).flatMap(e => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? files(full) : ['.ts', '.tsx'].includes(extname(full)) ? [full] : [];
});
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What renderToStaticMarkup escapes, back to text, so a sentence can be looked for as written. */
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const LABEL_RUN = new RegExp(`(?<![A-Z])(${[...GUIDE_LABELS].sort((a, b) => b.length - a.length).join('|')})(?![A-Z])`, 'g');
/** A slide's labels: the steps IN ORDER, since the order is the procedure; the prose's as a set,
 *  since "WRITE の前に BASE" and "your BASE before you WRITE" name the same two in each language's
 *  own word order. */
const labelsIn = (slide) => {
    const steps = (slide.steps ?? []).flatMap(s => s.match(LABEL_RUN) ?? []);
    const prose = [...(slide.body ?? []), slide.note ?? ''].flatMap(s => s.match(LABEL_RUN) ?? []).sort();
    return [...steps, ...(prose.length ? [`{${prose.join(', ')}}`] : [])];
};

console.log('\n[every label the guide names is still on the screen]');
{
    const sources = files(SRC)
        .filter(f => !f.endsWith(join('components', 'GuideCarousel.tsx')))
        .map(f => ({ f: relative(SRC, f), text: readFileSync(f, 'utf8') }));
    // The hub's verbs are common words — 'READ' and 'WRITE' are quoted all over the source — so for
    // them only the hub's own `label: '…'` counts: a renamed hub face must fail here.
    const HUB = new Set(['CONNECTION', 'READ', 'START TUNE', 'STOP', 'WRITE']);
    for (const label of GUIDE_LABELS) {
        const re = HUB.has(label)
            ? new RegExp(`label:\\s*'${escapeRe(label)}'`)
            : new RegExp(`(['"\`>])\\s*${escapeRe(label).replace(/ /g, '\\s+')}\\s*(['"\`<])`, 'i');
        const hit = sources.find(s => re.test(s.text));
        check(label, !!hit, 'no string literal or JSX text says this any more — rename it in GuideCarousel too');
        if (hit) console.log(`          at src/${hit.f.replace(/\\/g, '/')}:${hit.text.slice(0, hit.text.search(re)).split('\n').length}`);
    }
}

console.log('\n[both languages walk the same flow]');
{
    const { ja, en } = GUIDE_TEXT;
    check('the same number of slides', ja.slides.length === en.slides.length, `${ja.slides.length} vs ${en.slides.length}`);
    ja.slides.forEach((slide, i) => {
        const a = labelsIn(slide).join(' → ') || '(no labels)';
        const b = en.slides[i] ? labelsIn(en.slides[i]).join(' → ') || '(no labels)' : '(missing)';
        check(`slide ${i + 1}: ${a}`, a === b, `en says ${b}`);
    });
}

console.log('\n[the carousel, at every position, in both languages]');
for (const lang of ['ja', 'en']) {
    const count = GUIDE_TEXT[lang].slides.length;
    for (let index = 0; index < count; index++) {
        const html = renderToStaticMarkup(createElement(GuideCarouselView, { lang, index, onGo() {}, onClose() {} }));
        const slides = [...html.matchAll(/<section\b[^>]*aria-roledescription="slide"[^>]*>/g)].map(m => m[0]);
        const inert = slides.filter(s => /\binert=""/.test(s)).length;
        const back = /<button[^>]*class="[^"]*\binvisible\b[^"]*"[^>]*>BACK<\/button>/.test(html);
        const forward = index === count - 1 ? 'DONE' : 'NEXT';
        const current = (html.match(/aria-current="step"/g) ?? []).length;
        const ok = slides.length === count && inert === count - 1 && back === (index === 0)
            && html.includes(`>${forward}</button>`) && current === 1;
        check(`${lang} ${index + 1}/${count}: one slide live, ${inert} inert, BACK ${index === 0 ? 'hidden' : 'shown'}, ${forward}`, ok,
            JSON.stringify({ slides: slides.length, inert, backHidden: back, forward: html.includes(`>${forward}</button>`), current }));
    }
}

console.log('\n[the static copy, and what hides it]');
{
    const html = renderToStaticMarkup(createElement(GuideStatic));
    // Tags out, entities back: the text as a crawler that reads the HTML ends up with it.
    const plain = text(html.replace(/<[^>]+>/g, ''));
    check('GuideStatic is .no-js-only', /class="no-js-only\b/.test(html));
    for (const lang of ['ja', 'en']) {
        const missing = GUIDE_TEXT[lang].slides.flatMap(s => [s.heading, ...(s.body ?? []), ...(s.steps ?? []), s.note])
            .filter(Boolean)
            .filter(t => !plain.includes(t));
        check(`every slide's ${lang} text is in it (lang="${lang}")`,
            html.includes(`lang="${lang}"`) && html.includes(`data-guide-lang="${lang}"`) && missing.length === 0,
            missing.slice(0, 3).join(' | '));
    }
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    check('globals.css hides .no-js-only under html[data-js]', /html\[data-js\]\s+\.no-js-only\s*\{[^}]*display:\s*none/.test(css));
    const attrs = {};
    vm.runInNewContext(JS_MARK_SCRIPT, { document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } } });
    check('JS_MARK_SCRIPT sets data-js on <html>', 'data-js' in attrs, JSON.stringify(attrs));
    const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
    check('layout.tsx runs JS_MARK_SCRIPT in <head>', /<head>[\s\S]*__html:\s*JS_MARK_SCRIPT[\s\S]*<\/head>/.test(layout));
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS');
process.exit(fails ? 1 : 0);
