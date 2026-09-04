"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DiscordIcon } from "./DiscordIcon";

/**
 * "Invite Monarch" button.
 *
 * Opens /api/invite in a new tab (the server owns the client ID, scopes and
 * permission bitfield). Discord's install dialog lives on discord.com, so we
 * can't observe its outcome — instead, when the user comes back to this tab
 * we refresh the route so the freshly installed bot shows up immediately.
 *
 * In demo mode there is no Discord app: the route simulates the install
 * against the mock gateway, so we navigate in the same tab.
 */
export function InviteBotButton({
  guildId,
  demo = false,
  label,
  variant = "primary",
  className = "",
}: {
  /** Pre-select this server in Discord's install dialog. */
  guildId?: string;
  /** Demo mode — install is simulated, navigate in-place. */
  demo?: boolean;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => {
      setWaiting(false);
      // Re-run the server components: botInstalled may have flipped.
      router.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, router]);

  const href = guildId ? `/api/invite?guild_id=${encodeURIComponent(guildId)}` : "/api/invite";
  const text = label ?? (demo ? "Install Monarch (demo)" : "Add Monarch to Discord");

  return (
    <a
      href={href}
      {...(demo ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      onClick={() => {
        if (!demo) setWaiting(true);
      }}
      className={`${styles[variant]} ${className}`}
    >
      <DiscordIcon className="h-4 w-4 shrink-0" />
      <span className="truncate">{waiting ? "Finish in Discord…" : text}</span>
    </a>
  );
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition";

const styles: Record<string, string> = {
  primary: `${base} bg-royal-500 px-4 py-2 text-white shadow-lg shadow-royal-500/20 hover:bg-royal-400`,
  secondary: `${base} border border-ink-700 bg-ink-850 px-4 py-2 text-ink-100 hover:border-ink-600 hover:bg-ink-800`,
  ghost: `${base} px-3 py-1.5 text-xs text-royal-400 hover:text-royal-300 hover:underline`,
};
