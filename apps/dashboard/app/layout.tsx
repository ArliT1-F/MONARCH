import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Monarch — Design your Discord",
  description:
    "Monarch is a visual design studio for Discord servers: design structure, preview changes, and deploy with confidence.",
  applicationName: "Monarch",
  appleWebApp: { capable: true, title: "Monarch", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0b0e",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
