"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbedDesign, MessageDesign } from "@monarch/schemas";

/**
 * Workspace editor state: load the saved design, autosave (debounced) on
 * every change, and send test/publish through the server-side pipeline
 * (validation → Target Resolver → renderer → gateway).
 */

export type ContentKind = "embed" | "message";
export type SendMode = "test" | "publish";

export interface SendError {
  code: string;
  message: string;
  reason?: string;
  fix?: string;
}

export interface SendResult {
  ok: boolean;
  channelName?: string;
  error?: SendError;
}

export function useWorkspace<T extends EmbedDesign | MessageDesign>(
  guildId: string,
  kind: ContentKind,
) {
  const [design, setDesign] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [sendState, setSendState] = useState<"idle" | "sending">("idle");
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const designRef = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/guilds/${guildId}/workspace`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? "Couldn't load the saved design.");
        const saved = data.workspace?.[kind];
        const next: T = saved ? (saved as T) : (emptyDesign(kind) as T);
        if (!cancelled) {
          designRef.current = next;
          setDesign(next);
        }
      } catch (e) {
        if (!cancelled) setLoadError(String((e as Error).message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guildId, kind]);

  const persist = useCallback(
    async (value: T) => {
      try {
        const res = await fetch(`/api/guilds/${guildId}/workspace`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [kind]: value }),
        });
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    },
    [guildId, kind],
  );

  /** Update the design and schedule an autosave. */
  const update = useCallback(
    (next: T) => {
      designRef.current = next;
      setDesign(next);
      if (timer.current) clearTimeout(timer.current);
      setSaveState("saving");
      timer.current = setTimeout(() => void persist(next), 900);
    },
    [persist],
  );

  /** Send the CURRENT (in-memory) design — never a stale saved copy. */
  const send = useCallback(
    async (mode: SendMode) => {
      setSendResult(null);
      setSendState("sending");
      try {
        const res = await fetch(`/api/guilds/${guildId}/workspace/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, mode, design: designRef.current }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setSendResult({ ok: true, channelName: data.channelName });
        } else {
          const err = data?.error ?? { code: "workspace.send-failed", message: "Send failed." };
          setSendResult({ ok: false, error: err });
        }
      } catch {
        setSendResult({ ok: false, error: { code: "network", message: "Network error while sending." } });
      } finally {
        setSendState("idle");
      }
    },
    [guildId, kind],
  );

  const clearSendResult = useCallback(() => setSendResult(null), []);

  return { design, loading, loadError, update, saveState, send, sendState, sendResult, clearSendResult };
}

export function emptyDesign(kind: ContentKind): EmbedDesign | MessageDesign {
  return kind === "embed"
    ? { fields: [] }
    : { content: "", embeds: [], buttons: [] };
}
