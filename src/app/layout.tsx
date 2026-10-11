import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Praetor", template: "%s · Praetor" },
  description:
    "Praetor — gestão jurídica corporativa preventiva e contenciosa, com prazos, contratos, documentos e análises de apoio por IA.",
  applicationName: "Praetor",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0f1f33",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-dvh bg-canvas font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
