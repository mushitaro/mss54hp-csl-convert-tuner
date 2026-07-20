import type { Metadata } from "next";
import { Inter } from "next/font/google"; // Or standard font
import "./globals.css";

// Using standard font if Inter fails or just system fonts
const inter = Inter({ subsets: ["latin"] });

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
      <body className={`${inter.className} bg-slate-950 text-slate-100 min-h-screen`}>{children}</body>
    </html>
  );
}
