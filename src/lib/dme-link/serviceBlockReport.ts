/**
 * Read-only inspection of the DME's service information blocks.
 *
 * This exists because three very different situations all look identical from outside — a service
 * block that reads back as all-0xFF might mean:
 *
 *   1. the read is not landing where this code thinks it is (wrong address),
 *   2. the block really is blank, e.g. a tune that failed years ago wiped the AIF/VIN,
 *   3. the block is legitimately empty because the identity records live on the other processor.
 *
 * Nothing in the app could tell them apart, and the flash-counter reset guessed — it assumed a
 * fourth thing ("a reset was interrupted") and offered a destructive remedy on that basis. So the
 * first step is to stop guessing and look. Everything here is analysis over bytes already read;
 * nothing in this file writes to anything.
 */

import { ServiceBlockLayout, FlashCounterRegion, analyzeFlashCounter, extractCounterFromServiceBlock } from './flashCounter';
import { parseAifEntries, AIF_TOTAL_LENGTH } from './identity';

/** The system-address-table pointers, so the report can say where the DME itself puts each record. */
export interface ServiceBlockPointers {
    dif: number | null;
    zifBackup: number | null;
    brif: number | null;
    zif: number | null;
    aif: number | null;
}

export interface ServiceBlockRegionReport {
    name: string;
    address: number;
    length: number;
    /** Every byte is 0xFF — the state erased flash reads as. */
    allErased: boolean;
    erasedBytes: number;
    erasedPercent: number;
    /** How many distinct byte values occur. 1 means the whole block is a single value. */
    distinctBytes: number;
    /** First bytes of the counter run, for eyeballing against the decoded numbers. */
    counterHead: string;
    counter: FlashCounterRegion;
}

export interface AifSlotReport {
    index: number;
    blank: boolean;
    vin: string;
    softwareNumber: string;
}

export interface ServiceBlockReport {
    readAt: number;
    master: ServiceBlockRegionReport;
    slave: ServiceBlockRegionReport;
    pointers: ServiceBlockPointers;
    /**
     * Which processor's service block the DME's own AIF pointer falls inside, if either.
     *
     * The single most useful line in this report. If the pointer lands in the master block, then a
     * blank slave block says nothing about the AIF at all and the reset's premise was wrong in a way
     * that has nothing to do with the cable.
     */
    aifLocation: 'master' | 'slave' | 'outside' | 'unavailable';
    /** Parsed only when the AIF actually lies inside one of the two blocks that were read. */
    aifSlots: AifSlotReport[] | null;
    aifPopulatedCount: number | null;
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function describeRegion(name: string, address: number, image: Uint8Array): ServiceBlockRegionReport {
    let erased = 0;
    const seen = new Set<number>();
    for (let i = 0; i < image.length; i++) {
        if (image[i] === 0xFF) erased++;
        seen.add(image[i]);
    }
    const counterBytes = extractCounterFromServiceBlock(image);
    return {
        name,
        address,
        length: image.length,
        allErased: erased === image.length,
        erasedBytes: erased,
        erasedPercent: (erased * 100) / image.length,
        distinctBytes: seen.size,
        counterHead: hex(counterBytes.subarray(0, 16)),
        counter: analyzeFlashCounter(name, address + ServiceBlockLayout.counterOffset, counterBytes),
    };
}

/** Where `address` sits relative to the two blocks that were read. */
function locate(address: number | null): ServiceBlockReport['aifLocation'] {
    if (address === null) return 'unavailable';
    const { master, slave } = ServiceBlockLayout;
    if (address >= master.address && address < master.address + master.length) return 'master';
    if (address >= slave.address && address < slave.address + slave.length) return 'slave';
    return 'outside';
}

export function buildServiceBlockReport(
    masterImage: Uint8Array,
    slaveImage: Uint8Array,
    pointers: ServiceBlockPointers,
): ServiceBlockReport {
    const { master, slave } = ServiceBlockLayout;
    const aifLocation = locate(pointers.aif);

    // Only parse the AIF when its bytes are actually in hand. Reading it from the wrong place would
    // manufacture exactly the kind of confident-but-wrong answer this report exists to replace.
    let aifSlots: AifSlotReport[] | null = null;
    if (pointers.aif !== null && (aifLocation === 'master' || aifLocation === 'slave')) {
        const base = aifLocation === 'master' ? master.address : slave.address;
        const image = aifLocation === 'master' ? masterImage : slaveImage;
        const offset = pointers.aif - base;
        if (offset + AIF_TOTAL_LENGTH <= image.length) {
            aifSlots = parseAifEntries(image.subarray(offset, offset + AIF_TOTAL_LENGTH))
                .map((e, i) => ({ index: i + 1, blank: e.isBlank, vin: e.vin, softwareNumber: e.softwareNumber }));
        }
    }

    return {
        readAt: Date.now(),
        master: describeRegion(master.name, master.address, masterImage),
        slave: describeRegion(slave.name, slave.address, slaveImage),
        pointers,
        aifLocation,
        aifSlots,
        aifPopulatedCount: aifSlots ? aifSlots.filter(s => !s.blank).length : null,
    };
}

/** A plain-text summary, so the whole finding can be copied out of the dialog in one go. */
export function formatServiceBlockReport(r: ServiceBlockReport): string {
    const p = (v: number | null) => (v === null ? 'unavailable' : `0x${v.toString(16).toUpperCase().padStart(6, '0')}`);
    const lines: string[] = [
        `DME service block report — ${new Date(r.readAt).toISOString()}`,
        '',
        'System address table pointers:',
        `  DIF        ${p(r.pointers.dif)}`,
        `  ZIF backup ${p(r.pointers.zifBackup)}`,
        `  BRIF       ${p(r.pointers.brif)}`,
        `  ZIF        ${p(r.pointers.zif)}`,
        `  AIF        ${p(r.pointers.aif)}   -> lies in: ${r.aifLocation}`,
        '',
    ];
    for (const region of [r.master, r.slave]) {
        lines.push(
            `${region.name} block @ ${p(region.address)}, ${region.length} bytes`,
            `  all erased (0xFF): ${region.allErased ? 'YES' : 'no'}   0xFF ${region.erasedPercent.toFixed(1)}%   distinct byte values ${region.distinctBytes}`,
            `  flash counter @ ${p(region.counter.address)}: ${region.counter.used}/${ServiceBlockLayout.limitPerProcessor} used, ` +
            `marker 0x${region.counter.firstOpenMarker.toString(16).toUpperCase().padStart(4, '0')}, state ${region.counter.state}`,
            `  counter first 16 bytes: ${region.counterHead}`,
            '',
        );
    }
    if (r.aifSlots) {
        lines.push(`AIF slots (${r.aifPopulatedCount}/${r.aifSlots.length} populated):`);
        for (const s of r.aifSlots) {
            lines.push(`  ${String(s.index).padStart(2, '0')}  ${s.blank ? 'blank' : `VIN ${s.vin}  SW ${s.softwareNumber}`}`);
        }
    } else {
        lines.push('AIF slots: not parsed — the AIF pointer does not lie inside either block that was read.');
    }
    return lines.join('\n');
}
