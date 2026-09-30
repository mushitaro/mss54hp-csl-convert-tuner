import { TRANSIENT_SETTLE_SEC_DEFAULT, type LogFilterConfig } from '@/lib/types';
import { VE_MIN_WEIGHT_DEFAULT, RF_KORR_SETTLE_SEC_DEFAULT } from '@/lib/ve-calculator/calculator';

/**
 * The filter configuration a first load gets.
 *
 * Here rather than inside useLogFile, where it used to be, so that something with no React can run
 * the file workflow under the same defaults the app does: scripts/verify-file-workflow.mjs imports
 * this, not a copy of it that could drift. useLogFile imports it too; it is still the hook's
 * starting state and nothing else.
 */
export const DEFAULT_FILTER_CONFIG: LogFilterConfig = {
  enableCorrection: true,
  enableMinTemp: true,
  minTemp: 65,
  enableTransient: true,
  transientWindow: 4,
  // Stated, and it was not. Without it every NEW session took the legacy sample-count path — which
  // means the wait was 4 samples, i.e. 1.4 s at 2.95 Hz and 0.6 s at 6.6 Hz: a different physical
  // requirement per link speed, on a filter whose whole job is "has the DME finished adjusting".
  // The absence is only meant to describe sessions saved BEFORE the setting existed, and it was
  // describing every session there is.
  transientSettleSec: TRANSIENT_SETTLE_SEC_DEFAULT,
  // Stated, and it was not: absent used to mean 0 and now means 2.5, so a session saved without it
  // re-derives under a bar it was never built with. New sessions carry the value they used.
  minVeCellWeight: VE_MIN_WEIGHT_DEFAULT,
  // Stated for the same reason: absent means 1.0 today, and a session saved without it would
  // re-derive under whatever the default becomes. See RF_KORR_SETTLE_SEC_DEFAULT.
  rfKorrSettleSec: RF_KORR_SETTLE_SEC_DEFAULT,
  // OFF by default, and the reason is that the premise did not survive measurement.
  //
  // The wait was justified by rf_korr STEPPING when filling crosses the EGT-correction floor while
  // the trim walks after it. Measured on #928 and #929 with the filling held to 75-85 %RF, rf_korr
  // moves about 3 % across a pull while `trim x rf_korr` moves 7-9 % — so the walk is the lambda
  // integrator settling after a load step, which is the TRANSIENT test's job, and that test is now
  // sized at the loop's own response time.
  //
  // Six seconds of it was also being charged to the wrong stream: `rfKorrData` is collected before
  // this gate runs, so the rf_korr derivation never paid it and the VE map paid all of it. On
  // session #931 it refused 158 samples of a 15-minute drive.
  //
  // Still available, and it belongs to RF KORR work — see LogFilterConfig.highLoadSettleSec.
  highLoadSettleSec: 0,
  rpmStableThreshold: 10,
  tpsStableThreshold: 5,
};
