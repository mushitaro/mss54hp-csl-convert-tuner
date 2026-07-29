/** Triggers a browser download of in-memory data. Shared so every download in the app produces a
 *  file the same way, and the object URL is always revoked. */
export function downloadBlob(data: BlobPart, fileName: string, mimeType: string): void {
    const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export const MIME_BIN = 'application/octet-stream';
export const MIME_CSV = 'text/csv';
export const MIME_JSON = 'application/json';

/** Makes a session label safe for a filename without losing which session it was ("Session #3" ->
 *  "Session_3"). */
export function fileSafe(label: string): string {
    return label.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
}
