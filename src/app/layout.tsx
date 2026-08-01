import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Two families, split by meaning: Inter for UI chrome, JetBrains Mono for
// machine data (IDs, RPM, table cells, hashes, timestamps). Both are exposed
// as CSS variables that globals.css maps onto Tailwind's --font-sans /
// --font-mono, so the font-sans / font-mono utilities actually resolve.
// JetBrains Mono is chosen for its tall x-height and slashed zero, which stay
// legible at the 8-10px sizes the readouts and log tables render at.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "MSS54HP CSL CONVERT /// TUNER",
  description: "Alpha-N Tuning and Log Analysis Tool for E46 M3 CSL",
  /**
   * Added to Home screen, Android picked its own default glyph rather than any of this, because
   * there was no manifest at all — `icons.icon` alone feeds the browser tab, and the install path
   * reads the manifest's PNG list instead. An SVG would not have been enough either: the install
   * prompt wants a 192 and a 512.
   *
   * `maskable` is a separate entry rather than a second purpose on the same file. Android crops a
   * maskable icon to whatever shape the launcher uses and only the central 80% is guaranteed to
   * survive, so that variant carries the mark smaller; declaring one file as both would have the
   * launcher crop the full-size version and clip the outer stripes.
   */
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon.svg',
    // iOS reads this and nothing else — it has no manifest support for icons, and it does not
    // honour transparency, compositing anything transparent onto black.
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'CSL TUNER',
    // 'black', not 'black-translucent'. The translucent one pulls content up under the status bar,
    // which needs env(safe-area-inset-*) on every top-edge container to be survivable — the same
    // reason viewportFit stays off below.
    statusBarStyle: 'black',
  },
};

/**
 * Stated rather than inherited from Next's default, so the two things this app depends on are
 * written down where someone can see them.
 *
 * `viewportFit` is deliberately NOT 'cover': it only helps once every edge-touching container also
 * pads by `env(safe-area-inset-*)`, and nothing here does — turning it on alone moves content UNDER
 * the notch and the gesture bar rather than away from them. `interactiveWidget` is deliberately left
 * alone too: shrinking the visual viewport for the keyboard would re-run useFitScale and relayout
 * the dashboard mid-write.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The instrument is dark-only. Without this, native controls — the three <select>s, and the option
  // sheet Chrome for Android opens full-screen — render in the OS's light scheme: a white panel over
  // a black dashboard, at night, in a car.
  colorScheme: 'dark',
  // Paints Android's status bar to match the instrument once it is launched from the home screen.
  // Same value as the manifest's theme_color; they are read at different moments and both matter.
  themeColor: '#000000',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* `min-h-[100dvh]`, not `min-h-screen`. The page itself is sized to `100dvh` and never
          scrolls; leaving 100vh on the body meant that on Android, with the URL bar showing, the
          body was taller than the page by exactly the height of that bar — so the whole document
          scrolled, which is the thing the dvh switch inside the page was made to stop. */}
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${inter.className} bg-slate-950 text-slate-100 min-h-[100dvh]`}>{children}</body>
    </html>
  );
}
