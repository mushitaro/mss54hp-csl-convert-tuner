import { useState } from 'react';
import {
    FieldKey, DEFAULT_FIELD_VISIBILITY, CORE_ONLY_VISIBILITY, isLastOfRequiredGroup,
} from '@/lib/field-registry/registry';

export function useFieldVisibility() {
    const [visibleFields, setVisibleFields] = useState<Record<FieldKey, boolean>>(DEFAULT_FIELD_VISIBILITY);

    /**
     * Refuses the one change that would leave the view unreadable: switching off the last lambda
     * controller factor. See REQUIRED_FIELD_GROUPS — that column is the only input the correction
     * has, and both banks could be unchecked.
     *
     * A no-op rather than a swap to the other bank: the panel draws that checkbox disabled, so the
     * tap does not arrive in the first place, and this is the backstop for any other caller.
     */
    const toggleField = (key: FieldKey) => {
        setVisibleFields(prev => (isLastOfRequiredGroup(key, prev) ? prev : { ...prev, [key]: !prev[key] }));
    };

    /** The fewest columns the log can be read from — the operating point plus the correction's
     *  input. Owned by the registry so `verify:field-registry` can ask it the same questions. */
    const showCoreOnly = () => {
        setVisibleFields(CORE_ONLY_VISIBILITY);
    };

    /**
    * Back to the columns a fresh session opens with — NOT every column there is.
    *
    * It was called `showAll` and the button said "Show All", and three fields are off in
    * `DEFAULT_FIELD_VISIBILITY` (`wdk1`, `egtFromRfKorr`, `rfKorrFromEgt`) — so pressing it while
    * looking for one of them did nothing visible, twice, before anyone read the constant. The
    * behaviour is right; the name was the lie. Renamed rather than changed: "show me everything" is
    * a different feature, and quietly turning on three columns would move the table under someone
    * who pressed a button labelled "defaults".
    */
    const showDefaults = () => {
        setVisibleFields(DEFAULT_FIELD_VISIBILITY);
    };

    return { visibleFields, toggleField, showCoreOnly, showDefaults };
}
