"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GuildSummary } from "@monarch/schemas";

/**
 * Server context switcher. The selected server is always visible; switching
 * navigates to the other server's overview (drafts are stored per-guild, so
 * nothing leaks across servers).
 */
export function ServerSwitcher({ current }: { current: GuildSummary }) {
  const [open, setOpen] = useState(false);
  const [guilds, setGuilds] = useState<GuildSummary[] | null>(null);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || guilds) return;
    fetch("/api/guilds")
      .then((r) => r.json())
      .then((d) => setGuilds((d.guilds as GuildSummary[]).filter((g) => g.userCanDesign)))
      .catch(() => setGuilds([]));
  }, [open, guilds]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-left transition hover:border-ink-600"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-royal-500/20 text-[10px] font-bold text-royal-400">
          {current.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink-100">{current.name}</span>
          <span className="block text-[10px] text-ink-400">
            {current.memberCount !== null ? `${current.memberCount.toLocaleString()} members` : "server"}
          </span>
        </span>
        <svg viewBox="0 0 16 16" className="h-3 w-3 text-ink-400" fill="currentColor" aria-hidden>
          <path d="M4.5 6l3.5 4 3.5-4h-7z" />
        </svg>
      </button>

      {open && (
        <div className="animate-fade-up absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-xl shadow-black/40">
          {!guilds ? (
            <p className="px-3 py-3 text-xs text-ink-400">Loading servers…</p>
          ) : (
            guilds.map((g) =>
              // Servers without the bot aren't designable — offer the invite
              // instead of a dead-end row.
              !g.botInstalled && g.id !== current.id ? (
                <a
                  key={g.id}
                  href={`/api/invite?guild_id=${encodeURIComponent(g.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-400 transition hover:bg-ink-800 hover:text-ink-200"
                >
                  <span className="truncate">{g.name}</span>
                  <span className="ml-auto text-[9px] tracking-wide text-royal-400 uppercase">
                    invite
                  </span>
                </a>
              ) : (
                <button
                  key={g.id}
                  onClick={() => {
                    setOpen(false);
                    if (g.id !== current.id) router.push(`/s/${g.id}`);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition ${
                    g.id === current.id
                      ? "bg-royal-500/10 text-royal-400"
                      : "text-ink-200 hover:bg-ink-800"
                  }`}
                >
                  <span className="truncate">{g.name}</span>
                  {!g.botInstalled && <span className="ml-auto text-[9px] uppercase">no bot</span>}
                </button>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
