import { useState } from 'react';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { BinaryPatcher } from '@/lib/binary-engine/patcher';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import { VECalculator } from '@/lib/ve-calculator/calculator';
import { VEMap } from '@/lib/types';
import { MAP_DIMENSIONS } from '@/config/constants';
import { dialogText } from '@/lib/dialog-text';

function getFormattedDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const H = String(now.getHours()).padStart(2, '0');
  const M = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}${H}${M}`;
}

/** Explicit toggle values for a load. Anything omitted falls back to detection-from-bytes
 *  (applyPatch / applyWotDisable) or to OFF (writeWarmup / writeWot). */
export type ToggleOverrides = {
  applyPatch?: boolean;
  applyWotDisable?: boolean;
  writeWarmup?: boolean;
  writeWot?: boolean;
  writeRfKorr?: boolean;
};

/** Tables that are not derived from the VE map and so cannot be rebuilt from it. */
export type PatchExtras = {
  /** The back-calculated KF_RF_KORR_DRREL, 6 x 12 physical values. Null writes nothing. */
  tunedRfKorr?: number[][] | null;
};

/**
 * What the correction table is allowed to hold, as written.
 *
 * The floor is the important one: below 1.000 the table would LEAN the mixture at exactly the
 * condition BMW chose to enrich, which is the thing 20-egt-correction.md says not to do. The
 * tuner already clamps to the same range; this repeats it at the byte boundary so no future
 * caller can route around it.
 */
const RF_KORR_WRITE_BOUNDS = { min: 1.0, max: 1.40 };

export function useBinaryFile() {
  const [binaryFile, setBinaryFile] = useState<File | null>(null);
  const [binaryBuffer, setBinaryBuffer] = useState<ArrayBuffer | null>(null);
  const [currentMap, setCurrentMap] = useState<VEMap | null>(null);
  const [initialMapData, setInitialMapData] = useState<number[][]>(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));

  // What the LOADED BYTES say, as opposed to what the toggles are asking for. Keeping wotDisabled
  // here — it used to be computed in uploadBinary and thrown away after seeding the toggle — is what
  // lets the hub compare the two and offer a write when they disagree.
  const [patchStatus, setPatchStatus] = useState<{ mapOff: boolean; tempLimit: boolean; wotDisabled: boolean } | null>(null);
  const [debugHex, setDebugHex] = useState<string>('');
  const [applyPatch, setApplyPatch] = useState<boolean>(false);

  // [EXPERIMENTAL] UI Controls
  const [applyWotDisable, setApplyWotDisable] = useState<boolean>(false); // Default OFF
  const [writeWarmup, setWriteWarmup] = useState<boolean>(false); // Default OFF
  const [writeWot, setWriteWot] = useState<boolean>(false); // Default OFF
  // Default OFF like the two above. This one rewrites KF_RF_KORR_DRREL, which changes fuelling
  // across the whole cold-exhaust region — it is not something a build should arm on its own.
  const [writeRfKorr, setWriteRfKorr] = useState<boolean>(false);

  const uploadBinary = async (file: File, overrides?: ToggleOverrides) => {
    try {
      const buffer = await file.arrayBuffer();
      const parser = new BinaryParser(buffer);
      const map = parser.getVETable();

      setBinaryFile(file);
      setBinaryBuffer(buffer);
      setCurrentMap(map);
      setInitialMapData(map.data); // Store initial map data for comparison

      // Debug: Read first 16 bytes at VE Table Data address
      try {
        const offset = 0xD356;
        const view = new DataView(buffer);
        let hex = '';
        for (let i = 0; i < 16; i++) {
          hex += view.getUint8(offset + i).toString(16).padStart(2, '0').toUpperCase() + ' ';
        }
        setDebugHex(hex);
      } catch (e) { }

      // Check patch status
      const isMapOff = parser.getMapCorrectionStatus();
      const tempVal = parser.getTempThreshold();
      const isTempHigh = tempVal >= 99;

      // Check WOT status
      const isWotDisabled = parser.getWOTThresholdStatus();

      setPatchStatus({
        mapOff: isMapOff, // True if OFF
        tempLimit: isTempHigh,
        wotDisabled: isWotDisabled,
      });

      // Detection off the bytes is right when a BASE arrives fresh (upload / DME read), but wrong
      // when reopening a saved session: that loads the BASE, which is normally unpatched, so the
      // detected value would silently overwrite the settings the tune was actually built with.
      setApplyPatch(overrides?.applyPatch ?? (isMapOff && isTempHigh));
      setApplyWotDisable(overrides?.applyWotDisable ?? isWotDisabled);
      // These two leave no detectable trace in the bytes, so there is nothing to fall back on:
      // default them OFF on every load. Otherwise they persist from the previous session and
      // silently inject derived warmup/WOT tables into an unrelated binary.
      setWriteWarmup(overrides?.writeWarmup ?? false);
      setWriteWot(overrides?.writeWot ?? false);
      setWriteRfKorr(overrides?.writeRfKorr ?? false);

      console.log('Parsed Map:', map);
      return map;
    } catch (e: any) {
      alert(dialogText().parseBinaryFailed(e.message));
      return null;
    }
  };

  // Applies all patches (VE table, experimental maps, logic patch, WOT threshold, checksum
  // correction) to a fresh clone of binaryBuffer and returns the resulting bytes. Shared by the
  // file-download flow and DB session saving, so both are guaranteed byte-identical.
  //
  // `settings` overrides the live toggle state. Needed because this reads that state through a
  // closure: a caller that restores toggles and rebuilds in the same handler would otherwise hash
  // the pre-restore values and "verify" nothing.
  const buildPatchedBuffer = (
    newMap: VEMap | null,
    settings?: ToggleOverrides,
    extras?: PatchExtras,
  ): ArrayBuffer | null => {
    if (!binaryBuffer) return null;

    const usePatch = settings?.applyPatch ?? applyPatch;
    const useWotDisable = settings?.applyWotDisable ?? applyWotDisable;
    const useWarmup = settings?.writeWarmup ?? writeWarmup;
    const useWot = settings?.writeWot ?? writeWot;

    const patcher = new BinaryPatcher(binaryBuffer);

    // Apply New Map if exists
    if (newMap) {
      patcher.setVETable(newMap);

      // [EXPERIMENTAL] Auto-gen derivative maps
      const calc = new VECalculator();

      if (useWarmup) {
        const warmupMap = calc.generateWarmupMap(newMap);
        patcher.setWarmupTable(warmupMap);
      }

      if (useWot) {
        const wotData = calc.generateWOTMap(newMap);
        patcher.setWOTMap(wotData);
      }
    }

    // Apply or Revert Logic Patch
    if (usePatch) {
      patcher.disableMapCorrection();
    } else {
      patcher.enableMapCorrection();
    }

    // [EXPERIMENTAL] WOT Threshold Patch (Independent of Logic Patch)
    patcher.setWOTThreshold(useWotDisable);

    // The back-calculated EGT correction. Threaded in explicitly rather than read off hook state
    // for the same reason `settings` is: a caller that rebuilds inside one handler would otherwise
    // hash a value the render has not caught up with.
    //
    // Not optional relative to the VE map it was built with. The 'tuned' VE mode divides by this
    // table, so a map written without it would be read by the DME through the OLD one and come out
    // lean by k_new/k_old — up to 27 % at the stock peak. page.tsx derives both from a single
    // value so the pair cannot come apart.
    if (extras?.tunedRfKorr) {
      const def = findEcuItem('KF_RF_KORR_DRREL');
      if (def?.kind === 'map') {
        patcher.setEcuMapValues(def, extras.tunedRfKorr, RF_KORR_WRITE_BOUNDS);
      }
    }

    // Recalculate checksum last, after all other patches have been applied
    patcher.applyChecksumCorrection();

    return patcher.getBuffer();
  };

  /** `newMap` is required, not optional, so that adding a caller cannot silently default to
   *  claiming a tune. It decides the prefix only — the bytes come from buildPatchedBuffer. */
  const buildFileName = (newMap: VEMap | null): string => {
    const dateStr = getFormattedDate();
    let baseName = binaryFile?.name.replace(/\.bin$/i, '') || 'tune';

    // Clean up existing prefixes/suffixes to avoid duplication like "Tune_..._Tune_...". Both
    // prefixes have to be stripped, or re-downloading a file this function already named would
    // nest them ("Tune_..._Base_...") and the outer prefix would win while the inner one lingers.
    baseName = baseName.replace(/^(?:Tune|Base)_\d{12}_/, '');
    baseName = baseName.replace(/(_PatchON|_PatchOFF|_LTFT&MAPOFFPached)$/, '');

    // PATCH or WOT TH: both rewrite DME logic in place, so either one alone means these bytes are
    // patched and the name has to say so. This is the same expression that decides whether the
    // DOWNLOAD PATCH-ON button appears, which is what keeps the button and the file it produces from
    // contradicting each other. writeWarmup / writeWot are excluded on purpose — they inject derived
    // TABLES rather than patching logic, and they are already implied by the `Tune_` prefix, since
    // buildPatchedBuffer only ever applies them when there is a map to derive them from.
    const patchSuffix = (applyPatch || applyWotDisable) ? '_PatchON' : '_PatchOFF';
    // Without a derived map buildPatchedBuffer returns the BASE with the toggles applied. That is a
    // real artifact — it is the PATCH-ON BIN you flash for a log run — but it is not a tune, and a
    // `Tune_` prefix would be the one claim about these bytes that the file itself cannot support.
    const prefix = newMap ? 'Tune' : 'Base';
    return `${prefix}_${dateStr}_${baseName}${patchSuffix}.bin`;
  };

  const downloadBin = (newMap: VEMap | null, extras?: PatchExtras) => {
    const patchedBuffer = buildPatchedBuffer(newMap, undefined, extras);
    if (!patchedBuffer) return;

    const blob = new Blob([patchedBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildFileName(newMap);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Loads a buffer as if it were freshly uploaded/read from the DME, reusing uploadBinary's
  // parsing + patch-status detection. Pass `overrides` when the toggles are known from a saved
  // session rather than inferable from these bytes.
  const loadFromBuffer = async (buffer: ArrayBuffer, fileName: string, overrides?: ToggleOverrides) => {
    const file = new File([buffer], fileName, { type: 'application/octet-stream' });
    return uploadBinary(file, overrides);
  };

  /** Drops the loaded binary and everything read out of it. A new session with no BASE must not
   *  inherit the previous one's map: its tabs would stay live and CURRENT MAP would show a binary
   *  that session doesn't have. */
  const clear = () => {
    setBinaryFile(null);
    setBinaryBuffer(null);
    setCurrentMap(null);
    setInitialMapData(Array(MAP_DIMENSIONS.rows).fill(Array(MAP_DIMENSIONS.cols).fill(0)));
    setPatchStatus(null);
    setDebugHex('');
    setApplyPatch(false);
    setApplyWotDisable(false);
    setWriteWarmup(false);
    setWriteWot(false);
  };

  return {
    binaryFile,
    binaryBuffer,
    currentMap,
    initialMapData,
    patchStatus,
    debugHex,
    applyPatch,
    setApplyPatch,
    applyWotDisable,
    setApplyWotDisable,
    writeWarmup,
    setWriteWarmup,
    writeWot,
    setWriteWot,
    writeRfKorr,
    setWriteRfKorr,
    uploadBinary,
    loadFromBuffer,
    clear,
    buildPatchedBuffer,
    buildFileName,
    downloadBin,
  };
}
