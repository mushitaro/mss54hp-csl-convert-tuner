import { useState } from 'react';
import { FieldKey, DEFAULT_FIELD_VISIBILITY } from '@/lib/field-registry/registry';

export function useFieldVisibility() {
    const [visibleFields, setVisibleFields] = useState<Record<FieldKey, boolean>>(DEFAULT_FIELD_VISIBILITY);

    const toggleField = (key: FieldKey) => {
        setVisibleFields(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const showCoreOnly = () => {
        setVisibleFields(prev => {
            const next = { ...prev };
            (Object.keys(next) as FieldKey[]).forEach(k => { next[k] = false; });
            return { ...next, rpm: true, rawLoad: true, correctedLoad: true };
        });
    };

    const showAll = () => {
        setVisibleFields(DEFAULT_FIELD_VISIBILITY);
    };

    return { visibleFields, toggleField, showCoreOnly, showAll };
}
