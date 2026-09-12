"use client";

import { useMemo, useState } from "react";
import {
  COMMAND_CATALOG,
  COMMAND_GROUPS,
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  type CommandDoc,
  type CommandGroupId,
} from "@monarch/shared";

/**
 * The dashboard's Help section — every Monarch and music command, rendered
 * from the shared command catalog (the same data `/monarch help` and `!help`
 * show in Discord, so the three can't drift). Each command lists its slash
 * form *and* its prefix form, because both are real ways to run it.
 * Client-side because of search + the collapsible command cards.
 */
export function HelpPanel({ appUrl }: { appUrl: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["/burg", "/monarch burged", "/music play", "/music skip"]));

  const normalized = query.trim().toLowerCase();

  const groups = useMemo(() => {
    return COMMAND_GROUPS.map((group) => ({
      ...group,
      commands: COMMAND_CATALOG.filter((c) => {
        if (c.group !== group.id) return false;
        if (!normalized) return true;
        return (
          c.usage.toLowerCase().includes(normalized) ||
          (c.prefixUsage ?? "").toLowerCase().includes(normalized) ||
          (c.prefixAliases ?? []).some((a) => a.toLowerCase().includes(normalized)) ||
          c.summary.toLowerCase().includes(normalized) ||
          (c.details ?? "").toLowerCase().includes(normalized) ||
          c.who.toLowerCase().includes(normalized) ||
          (c.args ?? []).some((a) => a.name.toLowerCase().includes(normalized) || a.description.toLowerCase().includes(normalized))
        );
      }),
    })).filter((g) => g.commands.length > 0);
  }, [normalized]);

  const total = groups.reduce((n, g) => n + g.commands.length, 0);

  const toggle = (name: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div>
      {/* Search */}
      <div className="sticky top-0 z-10 -mx-4 mb-6 bg-ink-950/85 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
        <label className="relative block max-w-xl">
          <span className="sr-only">Search commands</span>
          <svg
            viewBox="0 0 20 20"
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5 17 17" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands — try “skip”, “backup”, “duration”…"
            className="w-full rounded-xl border border-ink-700 bg-ink-900 py-2 pr-3 pl-9 text-sm text-ink-100 placeholder:text-ink-400 focus:border-royal-500/60 focus:outline-none"
          />
        </label>
        <p className="mt-2 text-xs text-ink-400" role="status">
          {normalized
            ? `${total} command${total === 1 ? "" : "s"} matching “${query.trim()}”`
            : `${COMMAND_CATALOG.length} slash commands · everything runs in Discord, this page is the manual`}
        </p>
      </div>

      {groups.length === 0 && (
        <p className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-8 text-center text-sm text-ink-300">
          Nothing matches “{query.trim()}”. Try a command name or a word from its description.
        </p>
      )}

      {/* Groups */}
      <div className="space-y-10">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`}>
            <div className="mb-3 flex items-baseline gap-2">
              <span aria-hidden className="text-lg">
                {group.icon}
              </span>
              <h2 id={`group-${group.id}`} className="text-lg font-semibold tracking-tight text-ink-100">
                {group.label}
              </h2>
              <span className="text-xs text-ink-400">
                {group.commands.length} command{group.commands.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="mb-4 max-w-2xl text-sm leading-relaxed text-ink-300">{group.description}</p>
            <ul className="space-y-2">
              {group.commands.map((cmd) => (
                <CommandCard
                  key={cmd.name}
                  doc={cmd}
                  open={open.has(cmd.name)}
                  onToggle={() => toggle(cmd.name)}
                  appUrl={appUrl}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <SetupNotes />
    </div>
  );
}

function CommandCard({
  doc,
  open,
  onToggle,
  appUrl,
}: {
  doc: CommandDoc;
  open: boolean;
  onToggle: () => void;
  appUrl: string;
}) {
  const everyone = doc.who.toLowerCase() === "everyone" || doc.who.toLowerCase().startsWith("everyone ");
  return (
    <li className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900/60 transition hover:border-ink-700">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <code className="shrink-0 text-sm font-semibold text-gold-400">{doc.usage}</code>
        <span className="hidden min-w-0 flex-1 truncate text-sm text-ink-300 sm:block">{doc.summary}</span>
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            everyone ? "bg-emerald-400/10 text-emerald-400" : "bg-royal-500/15 text-royal-400"
          }`}
          title="Who can run this"
        >
          {doc.who}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-ink-800 px-4 py-4">
          <p className="text-sm text-ink-300 sm:hidden">{doc.summary}</p>
          {doc.details && <p className="max-w-3xl text-sm leading-relaxed text-ink-200">{doc.details}</p>}

          {doc.args && doc.args.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-ink-400 uppercase">Options</p>
              <ul className="space-y-1.5">
                {doc.args.map((arg) => (
                  <li key={arg.name} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-2">
                    <code className="shrink-0 text-royal-400">
                      {arg.required ? arg.name : `[${arg.name}]`}
                    </code>
                    <span className="text-ink-300">
                      {arg.description}
                      {!arg.required && <span className="ml-1 text-ink-400">(optional)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(doc.prefixUsage || (doc.prefixAliases ?? []).length > 0) && (
            <div>
              <p className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
                Prefix version
              </p>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <code className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-1.5 text-xs text-gold-300">
                  {doc.prefixUsage ?? doc.usage.replace("/", `${DEFAULT_COMMAND_PREFIX}`)}
                </code>
                {(doc.prefixAliases ?? []).length > 0 && (
                  <span className="text-xs text-ink-400">
                    short:{" "}
                    {(doc.prefixAliases ?? []).map((alias, i) => (
                      <span key={alias}>
                        {i > 0 && ", "}
                        <code className="text-ink-300">
                          {DEFAULT_COMMAND_PREFIX}
                          {alias}
                        </code>
                      </span>
                    ))}
                  </span>
                )}
              </p>
            </div>
          )}

          {doc.examples && doc.examples.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-ink-400 uppercase">Examples</p>
              <ul className="space-y-1">
                {doc.examples.map((ex) => (
                  <li key={ex}>
                    <code className="block overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 px-3 py-1.5 text-xs text-ink-200">
                      {ex}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {doc.notes && doc.notes.length > 0 && (
            <ul className="space-y-1">
              {doc.notes.map((note) => (
                <li key={note} className="flex gap-2 text-xs leading-relaxed text-ink-400">
                  <span aria-hidden className="text-gold-400">
                    ▸
                  </span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-ink-400">
            Run it in Discord: type <code className="text-ink-300">{doc.name}</code> and Discord autocompletes the
            options — or send it as a plain message with your server&apos;s prefix. Full guide:{" "}
            {appUrl}/s/&lt;server&gt;/help
          </p>
        </div>
      )}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden
      className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M5 7.5 10 12.5 15 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Environment-dependent features — what hosts need to turn on. */
function SetupNotes() {
  const notes: { id: CommandGroupId | "setup"; title: string; body: string }[] = [
    {
      id: "music",
      title: "Spotify links",
      body:
        "Spotify tracks, albums and playlists resolve through the official Spotify Web API. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the bot (free app at developer.spotify.com → Dashboard) and restart. Without them, /music play tells you Spotify isn't configured; YouTube links and search always work.",
    },
    {
      id: "music",
      title: "DJ & staff roles (skip without voting)",
      body:
        "Anyone with a role named DJ (configurable via MUSIC_DJ_ROLE_NAMES) or a Moderator/Staff role (MUSIC_STAFF_ROLE_NAMES: moderator, mod, staff, admin, administrator… by default), anyone with real moderation permissions (Manage Server, Timeout/Kick/Ban Members, Move Members), and whoever queued the current track skip instantly. Everyone else votes — a majority of the humans in the voice channel passes the skip.",
    },
    {
      id: "music",
      title: "Voice behaviour",
      body:
        "Monarch joins the voice channel of whoever runs /music play, leaves when everyone's gone (60s) or when nothing has played for 5 minutes, and needs Connect + Speak in that channel. Queue, volume (per session), loop and shuffle are per server.",
    },
    {
      id: "general",
      title: "Prefix (text) commands",
      body:
        `Every command also works as a normal message: ${DEFAULT_COMMAND_PREFIX}help, ${DEFAULT_COMMAND_PREFIX}play <song>, ${DEFAULT_COMMAND_PREFIX}burg @user, or "@Monarch help" — mentioning the bot always works as a prefix. Each server picks its own with ${DEFAULT_COMMAND_PREFIX}prefix set <new> (1–${MAX_COMMAND_PREFIX_LENGTH} characters from ${COMMAND_PREFIX_CHARS}), and ${DEFAULT_COMMAND_PREFIX}prefix reset restores the default; the default prefix keeps working either way, so nobody gets locked out. Unknown ${DEFAULT_COMMAND_PREFIX}words are ignored so other bots' prefixes are untouched.`,
    },
    {
      id: "setup",
      title: "Message Content intent (prefix commands + /burg)",
      body:
        "Prefix commands and /burg all read ordinary messages, so they need the privileged Message Content intent: Discord developer portal → Bot → Privileged Gateway Intents. Without it the bot still starts, slash commands keep working, and the text commands simply don't fire.",
    },
    {
      id: "setup",
      title: "INTERNAL_API_TOKEN (backups, export, publish)",
      body:
        `/monarch backup, /monarch export, /monarch embed previews, /monarch test — and saving a custom prefix with ${DEFAULT_COMMAND_PREFIX}prefix set — call the dashboard's internal API. Set the same INTERNAL_API_TOKEN in the dashboard and the bot environments. /monarch help, dashboard, status, all music commands and the default ${DEFAULT_COMMAND_PREFIX} prefix work without it.`,
    },
  ];

  return (
    <section className="mt-14" aria-labelledby="setup-notes">
      <h2 id="setup-notes" className="mb-1 text-lg font-semibold tracking-tight text-ink-100">
        ⚙️ Requirements &amp; setup
      </h2>
      <p className="mb-4 max-w-2xl text-sm leading-relaxed text-ink-300">
        Some commands depend on host-side configuration. If one replies with a setup hint, this is what it means.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {notes.map((note) => (
          <div key={note.title} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
            <p className="mb-1 text-sm font-semibold text-ink-100">{note.title}</p>
            <p className="text-xs leading-relaxed text-ink-300">{note.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}