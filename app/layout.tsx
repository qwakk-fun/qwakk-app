import type { Metadata } from "next";
import { Geist, Geist_Mono, Unbounded } from "next/font/google";
import "./globals.css";
import { BRAND } from "../lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["latin"],
});

const title = `${BRAND.name} | ${BRAND.tagline.replace(/\.$/, "")}`;

export const metadata: Metadata = {
  title,
  description: BRAND.description,
  openGraph: {
    title,
    description: BRAND.description,
    images: [{ url: "/og.png", width: 1734, height: 909, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: BRAND.description,
    images: ["/og.png"],
  },
  icons: {
    icon: "/brand-mark.svg",
    shortcut: "/brand-mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Font variables sit on <html> so the :root tokens in globals.css can read them.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${unbounded.variable}`}>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
