import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/** Display serif for the brand wordmark and editorial headings. */
const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Praetor", template: "%s · Praetor" },
  description:
    "Praetor: gestão jurídica corporativa preventiva e contenciosa, com prazos, contratos, documentos e análises de apoio por IA.",
  applicationName: "Praetor",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0B1A2C",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${display.variable}`}>
      <body className="min-h-dvh bg-canvas font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
