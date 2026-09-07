"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MonarchMark } from "@/components/ui/MonarchMark";

/**
 * Responsive shell for /s/[guildId]/*.
 *
 * ≥ md: a fixed 240px sidebar (rendered by the server layout via `sidebar`)
 *       with the page content offset beside it.
 * <  md: a sticky top bar with the Monarch mark, the current server name and
 *        a menu button; the same sidebar slides in as a drawer. The drawer
 *        closes on navigation and on Escape, and locks body scroll while open.
 */
export function GuildShell({
  sidebar,
  guildName,
  demo,
  children,
}: {
  sidebar: React.ReactNode;
  guildName: string;
  demo: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-ink-800 bg-ink-900/80 backdrop-blur md:flex">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${open ? "" : "pointer-events-none"}`}
        aria-hidden={!open}
      >
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          role="dialog"
          aria-label="Navigation"
          aria-modal="true"
          className={`absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r border-ink-800 bg-ink-900 shadow-2xl shadow-black/50 transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="absolute top-4 right-3 rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-800 hover:text-ink-100"
          >
            <CloseIcon />
          </button>
          {sidebar}
        </aside>
      </div>

      <div className="min-w-0 flex-1 md:ml-60">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-ink-800 bg-ink-950/85 px-3 py-2.5 backdrop-blur md:hidden">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="rounded-lg p-2 text-ink-200 transition hover:bg-ink-800 active:bg-ink-800"
          >
            <MenuIcon />
          </button>
          <Link href="/select" className="flex items-center gap-2" aria-label="Choose a server">
            <MonarchMark className="h-6 w-6" />
          </Link>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">{guildName}</span>
          {demo && (
            <span className="rounded-full bg-gold-400/10 px-2 py-0.5 text-[10px] font-medium text-gold-400">
              demo
            </span>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}
