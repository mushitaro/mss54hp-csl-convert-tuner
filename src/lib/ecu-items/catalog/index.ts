import type { EcuItemDef } from '../types';
import { EGT_ITEMS } from './egt';
import { FUEL_ITEMS } from './fuel';
import { IDLE_ITEMS } from './idle';
import { INERTIA_ITEMS } from './inertia';

/**
 * Every calibration item this app can decode out of a partial BIN, in display order.
 *
 * Read-only. The point of surfacing them is to check an address and its scaling against a real
 * binary before anyone considers writing one back — `src/config/constants.ts` carries the standing
 * warning that these addresses need verifying against the user's own BIN version, and this is the
 * mechanism for doing that at zero risk.
 */
export const ECU_ITEMS: EcuItemDef[] = [...EGT_ITEMS, ...FUEL_ITEMS, ...IDLE_ITEMS, ...INERTIA_ITEMS];

export function findEcuItem(symbol: string): EcuItemDef | undefined {
    return ECU_ITEMS.find(i => i.symbol === symbol);
}

export { EGT_ITEMS, FUEL_ITEMS, IDLE_ITEMS, INERTIA_ITEMS };
