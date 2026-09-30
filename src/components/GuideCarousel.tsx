import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Compass } from 'lucide-react';
import { DialogFrame } from '@/components/DialogFrame';
import { useDialogLang } from '@/hooks/useDialogLang';
import type { DialogLang } from '@/lib/dialog-text';

/**
 * How to use the tool — shown once, right after the disclaimer is agreed to, as a carousel.
 *
 * ## When it appears
 *
 * The disclaimer is the gate and stays one: nothing about using the app is said inside it. The
 * press that passes the gate is what offers this (useGuide), and it opens only if it has not been
 * closed before, because the disclaimer comes back on every visit for anyone who leaves "don't show
 * again" unticked, and a guide that came back with it would be read once and dismissed forever after.
 *
 * ## Written once, read two ways
 *
 * The carousel is a dialog, and a dialog exists only once a browser has run the app. A crawler —
 * an LLM's search fetch, Bing, Brave — runs nothing, and without the same words somewhere in the
 * static export it would describe this tool from the header and the tab names. So GuideStatic puts
 * every slide, in both languages, into the empty session list's loading state, which is what the
 * export shows. `.no-js-only` hides it from everybody whose browser runs script (JS_MARK_SCRIPT in
 * lib/js-mark.ts marks `<html data-js>` before the first paint), so it is never on screen beside the
 * carousel: the people who read it are the ones who cannot be shown the carousel at all.
 *
 * ## The words it names are the screen's words
 *
 * Every control it names is the label on screen, uppercase in both languages (chrome is not
 * translated), and listed in GUIDE_LABELS. `scripts/verify-guide.mjs` fails when one of them is no
 * longer in the source, so a rename cannot leave the guide pointing at a button that is gone.
 */

/** The screen's own labels this guide names — set apart in the text, and held to the source. */
export const GUIDE_LABELS = [
    'NEW SESSION', 'UPLOAD BIN', 'TESTO CSV', 'DOWNLOAD TUNED',
    'CONNECTION', 'READ', 'START TUNE', 'STOP', 'WRITE',
    'PRACTICE', 'BASE',
] as const;

interface Slide {
    /** For the two ways in: which way this is. */
    heading?: string;
    /** Prose. */
    body?: string[];
    /** What is pressed, in order. Numbered, as a dialog states a procedure (tsunagi-m-ux §13). */
    steps?: string[];
    /** The quiet line at the foot of the slide. */
    note?: string;
}

interface GuideText {
    /** The dialog's title. */
    title: string;
    /** The close button's accessible name. */
    close: string;
    slides: Slide[];
}

const JA: GuideText = {
    title: '使い方',
    close: '閉じる',
    slides: [
        {
            body: [
                'CSL 化した E46 M3 の MSS54HP DME を、自分の走行ログで合わせるツールです。ログのラムダから Alpha-N の VE テーブルを補正し、チェックサムも直します。',
                'PC の Chrome・Edge と、Android の Chrome で動きます。無料・オープンソース（MIT）。',
            ],
        },
        { heading: 'ファイルから（ケーブル不要）', steps: ['NEW SESSION', 'UPLOAD BIN と TESTO CSV', 'DOWNLOAD TUNED'] },
        {
            heading: '車とつないで（K+DCAN ケーブル）',
            steps: ['CONNECTION', 'READ', '走りながら START TUNE', 'STOP', 'WRITE'],
            note: '※ 書き込みはエンジンの動きを変えます。WRITE の前に BASE を保管してください。',
        },
        { body: ['PRACTICE にチェックを入れると、模擬の DME ですべて試せます。'] },
    ],
};

const EN: typeof JA = {
    title: 'How to use',
    close: 'Close',
    slides: [
        {
            body: [
                "Tune a CSL-converted E46 M3's MSS54HP DME from your own drive logs. The lambda you log corrects the Alpha-N VE table, and the checksums are corrected for you.",
                'Runs in Chrome or Edge on a computer, and in Chrome on Android. Free and open source (MIT).',
            ],
        },
        { heading: 'From files — no cable', steps: ['NEW SESSION', 'UPLOAD BIN and TESTO CSV', 'DOWNLOAD TUNED'] },
        {
            heading: 'With the car — K+DCAN cable',
            steps: ['CONNECTION', 'READ', 'START TUNE while you drive', 'STOP', 'WRITE'],
            // No ※: it is a Japanese mark, and to an English reader it is a symbol to decode.
            note: 'Writing changes how the engine runs. Keep your BASE before you WRITE.',
        },
        { body: ['Tick PRACTICE to try all of it against a simulated DME.'] },
    ],
};

export const GUIDE_TEXT: Record<DialogLang, GuideText> = { ja: JA, en: EN };

/** Chrome, not prose: the same words in both languages (tsunagi-m-ux §13). DONE rather than START,
 *  which would be a second address for the hub's START TUNE. */
const BACK = 'BACK';
const NEXT = 'NEXT';
const DONE = 'DONE';

/** Longest first, so a label is never split by a shorter one inside it; not inside a longer word. */
const LABEL_RUN = new RegExp(
    `(?<![A-Z])(${[...GUIDE_LABELS].sort((a, b) => b.length - a.length).join('|')})(?![A-Z])`,
    'g',
);

/** The labels are set apart the way the disclaimer sets apart its terms: brighter, bold, not blue —
 *  blue would make them look pressable, and here they are only named. */
function withLabels(text: string): React.ReactNode[] {
    return text.split(LABEL_RUN).map((part, i) =>
        i % 2 === 1 ? <span key={i} className="font-bold text-slate-100">{part}</span> : part,
    );
}

const SlideBody: React.FC<{ slide: Slide }> = ({ slide }) => (
    <div className="space-y-4">
        {slide.heading && <p className="font-bold text-slate-100">{slide.heading}</p>}
        {slide.body?.map((p, i) => <p key={i}>{withLabels(p)}</p>)}
        {slide.steps && (
            <ol className="space-y-2">
                {slide.steps.map((step, i) => (
                    <li key={step} className="flex gap-3">
                        <span className="w-3 shrink-0 text-right font-mono text-slate-600">{i + 1}</span>
                        <span>{withLabels(step)}</span>
                    </li>
                ))}
            </ol>
        )}
        {slide.note && <p className="text-[11px] text-slate-500">{withLabels(slide.note)}</p>}
    </div>
);

/**
 * The carousel as a function of its language and its position. Exported for verify:guide, which
 * renders every slide in both languages with react-dom/server.
 *
 * All slides sit side by side in one row that moves, so the box is as tall as the tallest slide
 * from the first frame and does not change height as the reader moves through them. The slides
 * off screen are `inert`: out of the tab order and off the accessibility tree.
 */
export const GuideCarouselView: React.FC<{
    lang: DialogLang;
    index: number;
    /** Go to a slide. Out-of-range values are the caller's to clamp. */
    onGo: (index: number) => void;
    onClose: () => void;
}> = ({ lang, index, onGo, onClose }) => {
    const t = GUIDE_TEXT[lang];
    const count = t.slides.length;
    const last = index === count - 1;
    /** Where a swipe started. A horizontal drag of 40px moves one slide; a vertical one is a scroll. */
    const swipe = useRef<{ x: number; y: number } | null>(null);

    return (
        <DialogFrame
            icon={<Compass className="w-3.5 h-3.5 text-slate-400" />}
            title={t.title}
            closeLabel={t.close}
            onClose={onClose}
            autoHeight
        >
            <div role="region" aria-roledescription="carousel" aria-label={t.title} className="flex min-h-0 flex-col">
                <div
                    className="overflow-hidden touch-pan-y select-none"
                    onPointerDown={e => { swipe.current = { x: e.clientX, y: e.clientY }; }}
                    onPointerCancel={() => { swipe.current = null; }}
                    onPointerUp={e => {
                        const start = swipe.current;
                        swipe.current = null;
                        if (!start) return;
                        const dx = e.clientX - start.x;
                        const dy = e.clientY - start.y;
                        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) onGo(index + (dx < 0 ? 1 : -1));
                    }}
                >
                    <div
                        className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
                        style={{ transform: `translateX(-${index * 100}%)` }}
                    >
                        {t.slides.map((slide, i) => (
                            <section
                                key={i}
                                role="group"
                                aria-roledescription="slide"
                                aria-label={`${i + 1} / ${count}`}
                                aria-hidden={i !== index}
                                inert={i !== index}
                                className="flex w-full shrink-0 flex-col justify-center px-1 py-3 text-[12px] leading-relaxed text-slate-300"
                            >
                                <SlideBody slide={slide} />
                            </section>
                        ))}
                    </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3">
                    {/* Kept in place on the first slide, not removed: the dots and NEXT must not move
                        when it appears. */}
                    <button
                        type="button"
                        onClick={() => onGo(index - 1)}
                        className={`-mx-2 px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 transition-colors hover:text-slate-300 ${index === 0 ? 'invisible' : ''}`}
                    >
                        {BACK}
                    </button>
                    <div className="flex items-center">
                        {t.slides.map((_, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => onGo(i)}
                                aria-label={`${i + 1} / ${count}`}
                                aria-current={i === index ? 'step' : undefined}
                                className="p-2"
                            >
                                <span className={`block h-1.5 w-1.5 rounded-full transition-colors ${i === index ? 'bg-blue-400' : 'bg-slate-700'}`} />
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => (last ? onClose() : onGo(index + 1))}
                        className="-mx-2 px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-blue-400 transition-colors hover:text-blue-300"
                    >
                        {last ? DONE : NEXT}
                    </button>
                </div>
            </div>
        </DialogFrame>
    );
};

/** The carousel, with its position and its keys. Closing it by any route — DONE, ×, the backdrop,
 *  Esc — is the one `onClose`, which is what records it as seen. */
export const GuideCarousel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const lang = useDialogLang();
    const count = GUIDE_TEXT[lang].slides.length;
    const [index, setIndex] = useState(0);
    const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(count - 1, i))), [count]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowRight') setIndex(i => Math.min(count - 1, i + 1));
            else if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
            else if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [count, onClose]);

    return <GuideCarouselView lang={lang} index={index} onGo={go} onClose={onClose} />;
};

/**
 * Every slide, both languages, as plain text — for the reader that runs no script and so never
 * sees the carousel. Hidden from everybody else by `.no-js-only`; without script `<html lang>` is
 * the export's `en`, so it shows its English half, and the Japanese half is in the HTML regardless.
 */
export const GuideStatic: React.FC = () => (
    <div className="no-js-only w-full max-w-[440px] space-y-10">
        {(['ja', 'en'] as const).map(lang => (
            <section
                key={lang}
                lang={lang}
                data-guide-lang={lang}
                className="space-y-6 text-[12px] leading-relaxed text-slate-400"
            >
                {GUIDE_TEXT[lang].slides.map((slide, i) => <SlideBody key={i} slide={slide} />)}
            </section>
        ))}
    </div>
);
