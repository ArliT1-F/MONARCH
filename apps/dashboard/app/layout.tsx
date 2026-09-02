import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Monarch — Design your Discord",
  description:
    "Monarch is a visual design studio for Discord servers: design structure, preview changes, and deploy with confidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
