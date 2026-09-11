"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Global navigation. Sections mirror the product IA; features not yet built
 * link to a phase-labelled placeholder instead of dead-ends.
 */
const SECTIONS: { label: string | null; items: { name: string; slug: string; soon?: boolean }[] }[] = [
  { label: null, items: [{ name: "Overview", slug: "" }] },
  {
    label: "Design",
    items: [
      { name: "Server Designer", slug: "designer" },
      { name: "Embed Builder", slug: "embeds" },
      { name: "Message Designer", slug: "messages" },
      { name: "Role Designer", slug: "roles" },
      { name: "Welcome Designer", slug: "welcome", soon: true },
      { name: "Branding", slug: "branding", soon: true },
    ],
  },
  {
    label: "Library",
    items: [
      { name: "Template Library", slug: "library" },
      { name: "Templates · Import / Export", slug: "import-export" },
    ],
  },
  {
    label: "Manage",
    items: [
      { name: "Backups & History", slug: "history" },
      { name: "Design Analyzer", slug: "analyzer" },
    ],
  },
  {
    label: "Settings",
    items: [{ name: "Designated Channels", slug: "settings/channels" }],
  },
  {
    label: "Help",
    items: [{ name: "Commands & Help", slug: "help" }],
  },
];

export function SidebarNav({ guildId }: { guildId: string }) {
  const pathname = usePathname();
  const base = `/s/${guildId}`;

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
      {SECTIONS.map((section, i) => (
        <div key={i}>
          {section.label && (
            <p className="mb-1 px-2 text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
              {section.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const href = item.slug ? `${base}/${item.slug}` : base;
              const active = pathname === href;
              return (
                <li key={item.slug}>
                  <Link
                    href={href}
                    className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] transition ${
                      active
                        ? "bg-royal-500/15 font-medium text-royal-400"
                        : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                    }`}
                  >
                    {item.name}
                    {item.soon && (
                      <span className="text-[9px] font-medium tracking-wide text-ink-400 uppercase">
                        soon
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
