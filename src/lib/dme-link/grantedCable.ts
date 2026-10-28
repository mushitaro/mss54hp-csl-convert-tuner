/**
 * Whether a cable this page was already allowed on is on the USB bus — the only cable the assistant
 * may reconnect by voice (operator, 2026-10-28). WebUSB keeps a page's permission for a device it was
 * granted once on the screen, and `getDevices()` lists those without the chooser, which only a person
 * can answer. Web Serial (the desktop path) always asks with its chooser here, so it never counts.
 */
const FTDI_VENDOR_ID = 0x0403;

export async function hasGrantedUsbCable(): Promise<boolean> {
    try {
        const usb = (navigator as Navigator & { usb?: { getDevices(): Promise<{ vendorId: number }[]> } }).usb;
        if (!usb) return false;
        return (await usb.getDevices()).some(d => d.vendorId === FTDI_VENDOR_ID);
    } catch {
        return false;
    }
}
