'use client';

import React from 'react';
import { FTDI_DATA_8E1_TX_BREAK } from '@/lib/dme-link/webUsbFtdiTransport';

/**
 * A bench probe for the WebUSB/FTDI path — deliberately standalone.
 *
 * The whole Android port rests on one question that no amount of code review can answer: can Chrome
 * for Android actually claim the interface on this phone, with this cable? If the kernel's
 * `ftdi_sio` holds it, or OTG will not supply VBUS, everything else is wasted work. So this page
 * exists to answer that first, and it imports nothing from the link layer — it cannot be broken by,
 * or break, the transport it is used to validate.
 *
 * It also covers the things a car cannot be used to test safely: whether the divisor constants
 * produce the baud rates they claim, whether a break is really visible as the BI bit, whether the
 * RX flush value is 2 and not 1, and whether a backgrounded tab survives four minutes.
 *
 * Everything logs on-screen because a phone has no console.
 *
 * **Bench wiring:** use a bare FT232R breakout with TX and RX jumpered together. A K+DCAN cable
 * will *not* self-echo on a desk — the K-line pull-up comes from the vehicle (OBD pin 16), so with
 * no car attached there is nothing to echo. Do not plug into a car for any of this.
 */

const FTDI_VENDOR_ID = 0x0403;
const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;
const SIO_GET_LATENCY_TIMER = 0x0A;
const PORT = 1;

const DIVISORS: Record<number, { value: number; index: number }> = {
    9600: { value: 0x4138, index: 0 },
    38400: { value: 0xC04E, index: 0 },
    125000: { value: 0x0018, index: 0 },
};

const CHIP_NAMES: Record<number, string> = {
    2: 'FT232AM', 4: 'FT232BM', 5: 'FT2232C', 6: 'FT232R',
    7: 'FT2232H', 8: 'FT4232H', 9: 'FT232H', 16: 'FT-X',
};

export default function UsbCheckPage() {
    const [lines, setLines] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);
    const deviceRef = React.useRef<USBDevice | null>(null);
    const epRef = React.useRef({ inEp: 0, outEp: 0, packetSize: 64, iface: 0 });

    const log = React.useCallback((text: string) => {
        setLines(prev => [...prev, text]);
    }, []);

    const run = (label: string, fn: () => Promise<void>) => async () => {
        setBusy(true);
        log(`\n=== ${label} ===`);
        try { await fn(); }
        catch (e: unknown) {
            const err = e as Error;
            log(`✗ ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`);
        }
        finally { setBusy(false); }
    };

    const device = () => {
        const d = deviceRef.current;
        if (!d) throw new Error('No device — run step 1 first');
        return d;
    };

    const sio = async (request: number, value: number, index = PORT) => {
        const r = await device().controlTransferOut({
            requestType: 'vendor', recipient: 'device', request, value, index,
        });
        if (r.status !== 'ok') throw new Error(`control 0x${request.toString(16)} -> ${r.status}`);
    };

    // --- 1. choose + identify -------------------------------------------------
    const step1 = run('1. Choose device', async () => {
        if (!navigator.usb) { log('✗ navigator.usb is undefined — WebUSB unavailable'); return; }
        const granted = (await navigator.usb.getDevices()).filter(d => d.vendorId === FTDI_VENDOR_ID);
        if (granted.length) log(`(${granted.length} device already granted to this origin)`);
        const d = granted[0] ?? await navigator.usb.requestDevice({ filters: [{ vendorId: FTDI_VENDOR_ID }] });
        deviceRef.current = d;
        const major = d.deviceVersionMajor;
        log(`✓ VID 0x${d.vendorId.toString(16).padStart(4, '0')} PID 0x${d.productId.toString(16).padStart(4, '0')}`);
        log(`  bcdDevice ${major}.${d.deviceVersionMinor} -> ${CHIP_NAMES[major] ?? 'UNKNOWN'}`);
        log(`  manufacturer: ${d.manufacturerName ?? '-'}`);
        log(`  product:      ${d.productName ?? '-'}`);
        log(`  serial:       ${d.serialNumber ?? '-'}`);
        if (![2, 4, 6].includes(major)) {
            log('  ⚠ This chip family uses a different clock/divisor encoding than the transport implements.');
        }
        if (d.manufacturerName && !/ftdi/i.test(d.manufacturerName)) {
            log('  ⚠ Manufacturer string is not FTDI — possible clone. Clone chips are common on K+DCAN cables.');
        }
    });

    // --- 2. THE question: claim ----------------------------------------------
    const step2 = run('2. Open + claim interface', async () => {
        const d = device();
        await d.open();
        log('✓ open()');
        if (!d.configuration) { await d.selectConfiguration(1); log('✓ selectConfiguration(1)'); }
        for (const iface of d.configuration?.interfaces ?? []) {
            log(`  interface ${iface.interfaceNumber} (claimed=${iface.claimed})`);
            for (const ep of iface.alternate.endpoints) {
                log(`    ep ${ep.endpointNumber} ${ep.direction} ${ep.type} packetSize=${ep.packetSize}`);
            }
            const inEp = iface.alternate.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
            const outEp = iface.alternate.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
            if (inEp && outEp) {
                epRef.current = {
                    inEp: inEp.endpointNumber, outEp: outEp.endpointNumber,
                    packetSize: inEp.packetSize || 64, iface: iface.interfaceNumber,
                };
            }
        }
        await d.claimInterface(epRef.current.iface);
        log(`✓ claimInterface(${epRef.current.iface}) — THIS IS THE ONE THAT MATTERS`);
        log('  If you got here, Chrome detached any kernel driver and the port is viable.');
    });

    // --- 3. vendor requests, both directions ---------------------------------
    const step3 = run('3. Vendor requests', async () => {
        await sio(SIO_RESET, 0); log('✓ SIO_RESET(0)');
        await sio(SIO_SET_LATENCY_TIMER, 16); log('✓ SET_LATENCY_TIMER(16)');
        await sio(SIO_SET_FLOW_CTRL, 0, 0x0000 | PORT); log('✓ SET_FLOW_CTRL(none)');
        await sio(SIO_SET_BAUD_RATE, DIVISORS[9600].value, DIVISORS[9600].index); log('✓ SET_BAUD_RATE(9600)');
        await sio(SIO_SET_DATA, 0x0208); log('✓ SET_DATA(8E1 = 0x0208)');
        await sio(SIO_SET_MODEM_CTRL, 0x0300); log('✓ SET_MODEM_CTRL(DTR low, RTS low = 0x0300)');
        const back = await device().controlTransferIn({
            requestType: 'vendor', recipient: 'device', request: SIO_GET_LATENCY_TIMER, value: 0, index: PORT,
        }, 1);
        const got = back.data?.getUint8(0);
        log(got === 16
            ? '✓ GET_LATENCY_TIMER read back 16 — control transfers work both ways'
            : `⚠ GET_LATENCY_TIMER returned ${got} (expected 16)`);
    });

    /** Reads until `want` payload bytes have arrived or the deadline passes, stripping the 2-byte
     *  status header from every packet. Returns payload plus any line-status faults seen. */
    const readPayload = async (want: number, timeoutMs: number) => {
        const { inEp, packetSize } = epRef.current;
        const out: number[] = [];
        let lsrSeen = 0;
        const deadline = Date.now() + timeoutMs;
        while (out.length < want && Date.now() < deadline) {
            const r = await device().transferIn(inEp, 8 * packetSize);
            const view = r.data;
            if (!view) continue;
            for (let off = 0; off + 2 <= view.byteLength; off += packetSize) {
                lsrSeen |= view.getUint8(off + 1);
                const n = Math.min(packetSize, view.byteLength - off) - 2;
                for (let i = 0; i < n; i++) out.push(view.getUint8(off + 2 + i));
            }
        }
        return { bytes: out, lsrSeen };
    };

    // --- 4. loopback at each rate --------------------------------------------
    const step4 = run('4. Loopback (needs TX-RX jumper)', async () => {
        for (const baud of [9600, 38400, 125000]) {
            await sio(SIO_SET_BAUD_RATE, DIVISORS[baud].value, DIVISORS[baud].index);
            await sio(SIO_RESET, 2); // purge RX
            const pattern = new Uint8Array(1024);
            for (let i = 0; i < pattern.length; i++) pattern[i] = i & 0xFF;
            const t0 = performance.now();
            await device().transferOut(epRef.current.outEp, pattern);
            const { bytes, lsrSeen } = await readPayload(pattern.length, 10_000);
            const elapsed = performance.now() - t0;
            // 8E1 is 11 bits per byte on the wire.
            const theory = (pattern.length * 11 * 1000) / baud;
            const exact = bytes.length === pattern.length && bytes.every((b, i) => b === pattern[i]);
            log(`${exact ? '✓' : '✗'} ${baud}: ${bytes.length}/${pattern.length} bytes, ` +
                `${elapsed.toFixed(0)} ms (theory ${theory.toFixed(0)} ms), lsr=0x${lsrSeen.toString(16)}`);
            if (!exact && bytes.length) {
                const bad = bytes.findIndex((b, i) => b !== pattern[i]);
                log(`   first mismatch at ${bad}: got 0x${bytes[bad]?.toString(16)} want 0x${pattern[bad]?.toString(16)}`);
            }
            // A wrong divisor shows up as garbage, or as an elapsed time far from theory.
            if (elapsed > theory * 2.5) log('   ⚠ far slower than theory — suspect a wrong divisor');
        }
        await sio(SIO_SET_BAUD_RATE, DIVISORS[9600].value, DIVISORS[9600].index);
    });

    // --- 5. break generation + detection --------------------------------------
    const step5 = run('5. TX break -> BI bit (needs jumper)', async () => {
        await sio(SIO_SET_BAUD_RATE, DIVISORS[9600].value, DIVISORS[9600].index);
        await sio(SIO_RESET, 2);
        await sio(SIO_SET_DATA, FTDI_DATA_8E1_TX_BREAK);
        await new Promise(r => setTimeout(r, 50));
        await sio(SIO_SET_DATA, 0x0208);
        const { lsrSeen } = await readPayload(1, 1500);
        log((lsrSeen & 0x10)
            ? '✓ BI (0x10) observed — break detection works, so recoverRead has something to react to'
            : `✗ no BI bit; lsr=0x${lsrSeen.toString(16)}. Break recovery would be untested/dark.`);
    });

    // --- 6. RX flush polarity --------------------------------------------------
    const step6 = run('6. RX flush polarity (1 vs 2)', async () => {
        for (const value of [2, 1]) {
            await sio(SIO_SET_BAUD_RATE, DIVISORS[9600].value, DIVISORS[9600].index);
            await sio(SIO_RESET, 2);
            await device().transferOut(epRef.current.outEp, new Uint8Array([0xAA, 0x55, 0xAA, 0x55]));
            await new Promise(r => setTimeout(r, 300)); // let them land in the chip's FIFO
            await sio(SIO_RESET, value);
            const { bytes } = await readPayload(4, 600);
            log(`SIO_RESET(${value}): ${bytes.length} byte(s) survived the flush ` +
                `${bytes.length === 0 ? '-> this value flushes RX' : ''}`);
        }
    });

    // --- 7. endurance / backgrounding -----------------------------------------
    const step7 = run('7. 5-minute endurance (background the app during this)', async () => {
        await sio(SIO_SET_BAUD_RATE, DIVISORS[9600].value, DIVISORS[9600].index);
        let wakeLock: WakeLockSentinel | null = null;
        try { wakeLock = (await navigator.wakeLock?.request('screen')) ?? null; log('wake lock acquired'); }
        catch { log('wake lock unavailable'); }
        let hidden = false;
        const onVis = () => { if (document.visibilityState === 'hidden') hidden = true; };
        document.addEventListener('visibilitychange', onVis);
        const end = Date.now() + 5 * 60_000;
        let maxGap = 0, rounds = 0, errors = 0;
        let last = performance.now();
        try {
            while (Date.now() < end) {
                try {
                    await device().transferOut(epRef.current.outEp, new Uint8Array([0x00]));
                    await readPayload(1, 2000);
                } catch { errors++; }
                const now = performance.now();
                maxGap = Math.max(maxGap, now - last);
                last = now;
                if (++rounds % 200 === 0) log(`  ${rounds} rounds, max gap ${maxGap.toFixed(0)} ms, ${errors} errors`);
            }
        } finally {
            document.removeEventListener('visibilitychange', onVis);
            await wakeLock?.release().catch(() => { });
        }
        log(`done: ${rounds} rounds, max gap ${maxGap.toFixed(0)} ms, ${errors} errors, backgrounded=${hidden}`);
        log(maxGap > 10_000
            ? '⚠ A gap over 10 s means the tab was frozen — a 4-minute flash is at risk on this device.'
            : '✓ No long freeze observed.');
    });

    const close = run('Close', async () => {
        try { await deviceRef.current?.releaseInterface(epRef.current.iface); } catch { }
        await deviceRef.current?.close();
        deviceRef.current = null;
        log('✓ closed');
    });

    const buttons: Array<[string, () => void]> = [
        ['1. Choose', step1], ['2. Claim', step2], ['3. Vendor', step3],
        ['4. Loopback', step4], ['5. Break', step5], ['6. Flush', step6],
        ['7. Endurance', step7], ['Close', close],
    ];

    return (
        <main className="min-h-[100dvh] bg-slate-950 text-slate-300 font-mono text-xs p-4">
            <h1 className="text-sm font-bold tracking-widest uppercase mb-1">WebUSB / FTDI bench probe</h1>
            <p className="text-[11px] text-slate-500 mb-3">
                Bare FT232R breakout with TX–RX jumpered. Not a car, and not a K+DCAN cable on a desk —
                its K-line pull-up comes from the vehicle, so it cannot self-echo.
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
                {buttons.map(([label, onClick]) => (
                    <button
                        key={label}
                        onClick={onClick}
                        disabled={busy}
                        className="px-3 py-2 min-h-[44px] border border-slate-700 rounded bg-slate-900
                                   hover:border-slate-500 disabled:opacity-40 text-[11px] font-bold tracking-wider"
                    >
                        {label}
                    </button>
                ))}
                <button
                    onClick={() => setLines([])}
                    className="px-3 py-2 min-h-[44px] border border-slate-800 rounded text-slate-500 text-[11px]"
                >
                    Clear
                </button>
            </div>
            <pre className="whitespace-pre-wrap break-words leading-relaxed border-t border-slate-800 pt-3">
                {lines.join('\n') || 'Ready.'}
            </pre>
        </main>
    );
}
