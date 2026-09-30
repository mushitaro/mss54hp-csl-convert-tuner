/**
 * Runs in `<head>` (layout.tsx), before the first paint: marks the document as one that runs script.
 *
 * That mark is what hides the guide's static copy (GuideStatic, `.no-js-only` in globals.css) from
 * everybody who will be shown the guide as a carousel instead. Anything that runs no script — a
 * crawler, an LLM's fetch — never gets the mark, and so is the only reader the static copy is for.
 *
 * Its own module because layout.tsx is a Server Component and GuideCarousel is not: importing the
 * string from there would drag the carousel's hooks into the server graph.
 */
export const JS_MARK_SCRIPT = "document.documentElement.setAttribute('data-js','')";
