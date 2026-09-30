import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { OfflineCache } from "@/components/OfflineCache";
import { JS_MARK_SCRIPT } from "@/lib/js-mark";
import pkg from "../../package.json";

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

/**
 * Where this tool lives — production's URL, named in every build.
 *
 * staging and preview carry the same canonical link and the same JSON-LD, pointing here: they are
 * the same pages under other origins, and a crawler that reaches one of them should learn that the
 * real one is here. What they refuse is the crawl itself — brand-preview.mjs replaces their
 * robots.txt with a Disallow and drops the sitemap (public/robots.txt and public/sitemap.xml are
 * production's).
 */
const PRODUCTION_URL = 'https://mss54hp-csl-convert-tuner.tsunagi.app/';

/**
 * One sentence that answers "what is this", for search results and for an LLM that was handed the
 * URL. English, like the page's own `lang`; the guide's static copy (GuideCarousel) carries both
 * languages in the body.
 */
const DESCRIPTION =
  "Tune a CSL-converted BMW E46 M3's MSS54HP DME from your own drive logs: Alpha-N VE correction from "
  + 'lambda, checksums corrected, and direct DME read, logging and flashing over K+DCAN. In the browser, '
  + 'free and open source.';

/**
 * The same facts as data, for anything that reads schema.org rather than prose. Every claim here is
 * one the README makes; `featureList` is its "Integrated Processes", `browserRequirements` its
 * "Technical Specifications". The publisher is m3.tsunagi.app's own Organization node, by the @id
 * that site's lib/jsonld.ts gives it, so the two sites describe one publisher rather than two.
 * `isBasedOn` is the NA M3 Forums thread whose method this tool automates (README, Credits).
 *
 * `isPartOf` names the set the tools are published as, TSUNAGI///Matrix (operator, 2026-09-30),
 * spelled as the operator spelled it. "Matrix" alone is also a chat protocol and a film, which is
 * why the name never appears here without TSUNAGI and the car beside it.
 */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      '@id': `${PRODUCTION_URL}#app`,
      name: 'MSS54HP CSL CONVERT /// TUNER',
      alternateName: ['CSL TUNER', 'mss54hp-csl-convert-tuner'],
      url: PRODUCTION_URL,
      description: DESCRIPTION,
      applicationCategory: 'UtilitiesApplication',
      browserRequirements:
        'Chrome, Edge or Opera. The file workflow runs in any Chromium browser. Talking to the DME needs a '
        + 'K+DCAN cable: Web Serial on a computer; on Android, Chrome over WebUSB with a USB OTG adapter and a '
        + 'genuine FTDI cable.',
      featureList: [
        'Alpha-N VE table correction from logged lambda',
        'Checksum correction',
        'MAP and LTFT compensation disabled for the log run and re-enabled afterwards',
        'Direct DME read, live logging and flashing over K+DCAN (DS2)',
        'DME adaptation reset',
        'Flash counter read and reset',
        'PRACTICE mode against a simulated DME',
      ],
      softwareVersion: pkg.version,
      isAccessibleForFree: true,
      license: 'https://opensource.org/licenses/MIT',
      inLanguage: ['ja', 'en'],
      sameAs: ['https://github.com/mushitaro/mss54hp-csl-convert-tuner'],
      isBasedOn:
        'https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability',
      isPartOf: {
        '@type': 'CreativeWork',
        name: 'TSUNAGI///Matrix',
        description: 'Browser tools for the BMW E46 M3: MSS54HP CSL CONVERT /// TUNER, E46M3 /// MONITORING, '
          + 'E46M3SMG2 /// MAPPING, MSS54HP CSL CONVERT /// BOOT and E46 M35080 /// MIGRATION.',
        publisher: { '@id': 'https://m3.tsunagi.app/#organization' },
      },
      publisher: { '@id': 'https://m3.tsunagi.app/#organization' },
    },
    {
      '@type': 'Organization',
      '@id': 'https://m3.tsunagi.app/#organization',
      name: 'M',
      url: 'https://m3.tsunagi.app',
    },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCTION_URL),
  title: "MSS54HP CSL CONVERT /// TUNER",
  description: DESCRIPTION,
  alternates: { canonical: '/' },
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
   *
   * The files are the M ICON family's `mapping` set (tsunagi-m-release §4), written by
   * tsunagi-m3's `scripts/m-icons.mjs --word mapping`: chosen, not drawn. MAPPING is the operator's
   * choice for TUNER (2026-09-22); `mss54hp-base` is the m3 site's own mark, not this app's. This is
   * PRODUCTION's set; `scripts/brand-preview.mjs` points every one of these references at the
   * `-dev-` twin for staging and preview, which is why the dev files sit beside them in public/icons.
   */
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icons/mapping-32.png',
    // iOS reads this and nothing else — it has no manifest support for icons, and it does not
    // honour transparency, compositing anything transparent onto black. 256 as it comes: the M
    // ICON files are opaque.
    apple: '/icons/mapping-256.png',
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
    // `suppressHydrationWarning` for `data-js` alone: JS_MARK_SCRIPT puts it on this element before
    // React arrives, which is the point of running it first — it hides the guide's static copy
    // before the first paint. It covers this element's attributes, not its children.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_MARK_SCRIPT }} />
      </head>
      {/* `min-h-[100svh]`, not `min-h-screen`, and matching the page's own `h-[100svh]`. Leaving
          100vh here meant that on Android, with the URL bar showing, the body was taller than the
          page by exactly the height of that bar and the whole document scrolled. svh rather than
          dvh for both: dvh is whatever the viewport is right now and grows when the browser
          retracts its chrome, so a layout built at the tall value loses the bottom of itself when
          the bar comes back — on a page with no scroll, permanently. svh is the small value, the
          one that is true at every moment. */}
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${inter.className} bg-slate-950 text-slate-100 min-h-[100svh]`}>
        {/* Renders nothing. Registers the offline cache — see OfflineCache. */}
        <OfflineCache />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
        {children}
      </body>
    </html>
  );
}
