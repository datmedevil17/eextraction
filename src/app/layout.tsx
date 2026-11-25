import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Extraction",
  description: "Stake in, grab what you can, get out alive.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
