import type { Metadata } from "next";
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
  icons: {
    icon: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${inter.className} bg-slate-950 text-slate-100 min-h-screen`}>{children}</body>
    </html>
  );
}
