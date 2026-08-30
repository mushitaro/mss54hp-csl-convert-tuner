/** The name of the event `downloadBlob` fires, and what rides on it. A DOM event rather than a
 *  React state setter because the seven call sites are spread across page.tsx and the hooks, and
 *  the notice has to be impossible to forget — see the comment in `downloadBlob`. */
export const DOWNLOAD_EVENT = 'app:download';

export interface DownloadNotice {
    fileName: string;
}

/** Triggers a browser download of in-memory data. Shared so every download in the app produces a
 *  file the same way, is always announced, and the object URL is always revoked. */
export function downloadBlob(data: BlobPart, fileName: string, mimeType: string): void {
    const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Deferred, NOT synchronous — this was a real defect, not a tidy-up.
    //
    // Chrome on Android begins reading the blob AFTER the click handler returns, so revoking in
    // the same tick can invalidate the URL before a single byte is written and the download is
    // dropped silently. Desktop survives it because the fetch starts inside `click()`, which is
    // exactly why this only ever failed on the device it matters on. 60 s is far past any local
    // blob read, and the URL dies with the document regardless.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    // And say that it happened.
    //
    // The manifest declares `display: standalone`, so an installed app has NO browser chrome: no
    // download bubble, no shelf, no address bar. The file does land in Downloads and Chrome posts
    // an OS notification, but with the app fullscreen the driver never sees it — from inside the
    // app the tap produced nothing at all, which is what was reported.
    //
    // Fired here rather than at the seven call sites so a download added later cannot forget to
    // announce itself. This function already promises that every download happens the same way;
    // this makes it promise that every download SAYS so the same way.
    window.dispatchEvent(new CustomEvent<DownloadNotice>(DOWNLOAD_EVENT, { detail: { fileName } }));
}

export const MIME_BIN = 'application/octet-stream';
export const MIME_CSV = 'text/csv';
export const MIME_JSON = 'application/json';

/** Makes a session label safe for a filename without losing which session it was ("Session #3" ->
 *  "Session_3"). */
export function fileSafe(label: string): string {
    return label.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
}
