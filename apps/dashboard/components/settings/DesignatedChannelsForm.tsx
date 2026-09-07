"use client";

import { useState } from "react";
import {
  apiErrorMessage,
  networkErrorMessage,
  readJsonSafe,
  type ApiErrorShape,
} from "@/lib/fetch-json";

const FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "welcome", label: "Welcome channel", hint: "Used by the Welcome Designer" },
  { key: "announcements", label: "Announcements", hint: "Default target for published announcements" },
  { key: "testing", label: "Testing", hint: "Default target for Send Test" },
  { key: "templateTesting", label: "Template testing", hint: "Where template previews are sent" },
];

export function DesignatedChannelsForm({
  guildId,
  channels,
  initial,
}: {
  guildId: string;
  channels: { id: string; name: string }[];
  initial: Record<string, string | undefined>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of FIELDS) v[f.key] = initial[f.key] ?? "";
    return v;
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testResult, setTestResult] = useState<string | null>(null);

  async function save() {
    setStatus("saving");
    const designatedChannels: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(values)) designatedChannels[k] = v || undefined;
    const res = await fetch(`/api/guilds/${guildId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designatedChannels }),
    });
    setStatus(res.ok ? "saved" : "error");
    if (res.ok) setTimeout(() => setStatus("idle"), 2000);
  }

  async function sendTest() {
    setTestResult(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/test-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { kind: "designated", key: "testing" },
          content: "👑 Monarch test — designated channels are configured for {server}.",
        }),
      });
      const data = await readJsonSafe<{ channelName?: string } & ApiErrorShape>(res);
      if (res.ok && data) {
        setTestResult(`✓ Test sent to #${data.channelName}`);
      } else {
        const err = data?.error;
        setTestResult(
          `✕ ${err?.message ?? apiErrorMessage(data, res, "Test failed.")} ${err?.fix ?? ""}`.trim(),
        );
      }
    } catch (e) {
      setTestResult(`✕ ${networkErrorMessage(e)}`);
    }
  }

  return (
    <div className="space-y-4">
      {FIELDS.map((f) => (
        <div
          key={f.key}
          className="flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-100">{f.label}</p>
            <p className="text-[11px] text-ink-400">{f.hint}</p>
          </div>
          <select
            value={values[f.key]}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            aria-label={f.label}
            className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-100 outline-none focus:border-royal-500 sm:w-52"
          >
            <option value="">Not designated</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          onClick={save}
          disabled={status === "saving"}
          className="rounded-lg bg-royal-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-royal-400 disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : "Save changes"}
        </button>
        <button
          onClick={sendTest}
          className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 transition hover:border-ink-600"
        >
          Send Test
        </button>
        {status === "error" && <span className="text-xs text-danger-400">Couldn&apos;t save.</span>}
      </div>
      {testResult && <p className="text-xs text-ink-300">{testResult}</p>}
    </div>
  );
}
