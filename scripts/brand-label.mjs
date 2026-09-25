/** What a non-production build is CALLED, by what it IS (operator, 2026-09-25). Display only:
 *  code compares app-variant; nothing compares this; neither is derived from the other. */
export const BUILD_LABEL = Object.freeze({ preview: 'WORKS', staging: 'STAGING' });
export function labelFor(variant) {
    if (!Object.hasOwn(BUILD_LABEL, variant)) throw new Error(`no build label for variant "${variant}" (${Object.keys(BUILD_LABEL).join(' | ')})`);
    return BUILD_LABEL[variant];
}
