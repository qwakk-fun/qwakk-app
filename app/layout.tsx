import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Qora — Simple swaps on QoreChain",
  description: "A clean, native trading surface for QoreChain's x/amm liquidity layer.",
  openGraph: {
    title: "Qora — Simple swaps on QoreChain",
    description: "Native swaps, native settlement.",
    images: [{ url: "/og.png", width: 1734, height: 909, alt: "Qora — Simple swaps on QoreChain" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Qora — Simple swaps on QoreChain",
    description: "Native swaps, native settlement.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/qora-mark.png",
    shortcut: "/qora-mark.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
