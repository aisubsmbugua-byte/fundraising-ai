import { Inter } from "next/font/google";
import "./globals.css";
import { colors } from "@/lib/ui";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  title: "Fundraising AI",
  description: "AI-assisted advancement platform for nonprofits",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body
        style={{
          margin: 0,
          fontFamily: "var(--font-inter), ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: colors.canvas,
          color: colors.text,
        }}
      >
        {children}
      </body>
    </html>
  );
}
