'use client';

import React, { useCallback } from 'react';
import { UploadCloud } from 'lucide-react';

/**
 * What the Testo CSV inputs accept.
 *
 * `.csv` alone is what broke this on a phone. Chrome for Android turns the accept list into
 * `EXTRA_MIME_TYPES` for the system document picker, and the picker greys out every file whose
 * PROVIDER-declared type is not in that set. A CSV that arrived by email, over USB from the Testo
 * software, or out of Drive is then unselectable, because those sources variously declare it
 * `application/vnd.ms-excel`, `text/comma-separated-values`, `text/plain` or
 * `application/octet-stream`. There is no one correct MIME type for a CSV in the wild.
 *
 * So the MIME half is deliberately broad and the real check happens after the pick:
 * `parseAndSetLog` refuses anything `parseLogFile` finds no rows in, and says so. A file that is
 * merely wrong gets an explanation; a file that cannot be selected at all is a dead end with none,
 * and that is the worse failure.
 *
 * The EXTENSIONS are what the desktop dialog filters on and stay narrow for that reason — the two
 * halves of this string are read by two different pickers.
 *
 * The `.bin` inputs are left alone: `application/octet-stream` is both what Android maps `.bin` to
 * and what a DME image actually is, so that one agrees with itself. This is a CSV problem.
 */
export const ACCEPT_CSV = [
    '.csv', '.txt',
    'text/csv', 'text/comma-separated-values', 'text/plain',
    'application/csv', 'application/vnd.ms-excel', 'application/octet-stream',
].join(',');

interface Props {
    onFileSelect: (file: File) => void;
    accept: string;
    label: string;
    className?: string;
}

export const DropZone: React.FC<Props> = ({ onFileSelect, accept, label, className = '' }) => {
    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                onFileSelect(e.dataTransfer.files[0]);
                e.dataTransfer.clearData();
            }
        },
        [onFileSelect]
    );

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFileSelect(e.target.files[0]);
        }
    };

    return (
        <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            className={`relative border-2 border-dashed border-slate-600 rounded-lg p-6 flex flex-col items-center justify-center text-center hover:border-blue-400 hover:bg-slate-800 transition-colors cursor-pointer ${className}`}
        >
            <input
                type="file"
                accept={accept}
                onChange={handleChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <UploadCloud className="w-10 h-10 text-slate-400 mb-2" />
            <span className="text-slate-300 font-medium">{label}</span>
            <span className="text-xs text-slate-500 mt-1">Drag & drop or click to browse</span>
        </div>
    );
};
