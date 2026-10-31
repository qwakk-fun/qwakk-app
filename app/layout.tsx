import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BRAND } from "../lib/brand";
import { ConsentGate } from "../components/ConsentGate";
import { NetworkProvider } from "../components/NetworkContext";
import { getQwakkNetwork, publicNetwork } from "../lib/qwakk-network";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = `${BRAND.name} | ${BRAND.tagline.replace(/\.$/, "")}`;

/** Absolute base for share images and links. Override per deployment with QWAKK_SITE_URL. */
const siteUrl = process.env.QWAKK_SITE_URL?.trim() || "https://qwakk.fun";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description: BRAND.description,
  openGraph: {
    title,
    description: BRAND.description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: BRAND.description,
    images: ["/og.png"],
  },
  icons: {
    icon: [{ url: "/brand-mark.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "32x32" }],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Font variables sit on <html> so the :root tokens in globals.css can read them.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        {/* QWAKK_NETWORK is read per request on the server, so the first render names the right network. */}
        <NetworkProvider network={publicNetwork(getQwakkNetwork())}>
          {children}
          <ConsentGate />
        </NetworkProvider>
      </body>
    </html>
  );
}
