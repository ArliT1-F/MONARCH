"use client";

import { useState } from "react";
import type { EmbedDesign, MessageDesign } from "@monarch/schemas";
import {
  validateEmbedDesign,
  validateMessageDesign,
  type ValidationReport,
} from "@monarch/validation";
import { EmbedEditor } from "./EmbedEditor";
import { MessageEditor } from "./MessageEditor";
import { EmbedPreview } from "./preview";
import { MessagePreview } from "./preview";
import { useWorkspace, type ContentKind } from "./use-workspace";
import { SmallButton } from "./ui";

/**
 * Shared shell for the Embed Builder and Message Designer:
 * live editor (left) + Discord preview (right) + autosave + test/publish
 * through the server-side pipeline.
 */
export function BuilderApp({ guildId, kind }: { guildId: string; kind: ContentKind }) {
  const w = useWorkspace<EmbedDesign | MessageDesign>(guildId, kind);

  const validation: ValidationReport | null = w.design
    ? kind === "embed"
      ? validateEmbedDesign(w.design as EmbedDesign)
      : validateMessageDesign(w.design as MessageDesign)
    : null;

  const title = kind === "embed" ? "Embed Builder" : "Message Designer";
  const subtitle =
    kind === "embed"
      ? "Design a rich embed — preview it, test it, publish it."
      : "Design a full message — content, embeds and buttons with live preview.";

  const canSend = !!w.design && !!validation?.valid;
  /** Phones show either the editor or the preview; desktop shows both. */
  const [mobilePane, setMobilePane] = useState<"editor" | "preview">("editor");

  return (
    <div className="flex h-[calc(100dvh-3.25rem)] flex-col md:h-screen">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 bg-ink-900/60 px-3 py-2 backdrop-blur sm:px-5 sm:py-2.5">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-ink-100">{title}</h1>
          <p className="hidden text-[11px] text-ink-400 sm:block">{subtitle}</p>
        </div>
        <div className="mx-2 hidden h-6 w-px bg-ink-700 sm:block" />
        <span className="hidden text-[11px] text-ink-400 sm:inline" aria-live="polite">
          {w.saveState === "saving" && "Saving draft…"}
          {w.saveState === "saved" && "✓ Saved"}
          {w.saveState === "error" && <span className="text-danger-400">Draft save failed</span>}
          {w.saveState === "idle" && "Autosaves as you type"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <SmallButton
            onClick={() => void w.send("test")}
            disabled={!canSend || w.sendState === "sending"}
            title={
              !validation?.valid
                ? "Fix validation errors first"
                : "Send to the designated testing channel (or your chosen channel)"
            }
          >
            {w.sendState === "sending" ? "Sending…" : "Send test"}
          </SmallButton>
          <SmallButton
            onClick={() => void w.send("publish")}
            disabled={!canSend || w.sendState === "sending"}
            title="Publish to the designated announcements channel"
            tone="primary"
          >
            Publish
          </SmallButton>
        </div>
      </header>

      {/* mobile pane switch */}
      <div className="flex border-b border-ink-800 bg-ink-900/40 md:hidden" role="tablist" aria-label="Builder panes">
        {(["editor", "preview"] as const).map((pane) => (
          <button
            key={pane}
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={`flex-1 py-2 text-xs font-medium capitalize transition ${
              mobilePane === pane ? "border-b-2 border-royal-400 text-royal-400" : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {pane}
          </button>
        ))}
      </div>

      {/* validation strip */}
      {validation && validation.issues.length > 0 && (
        <div
          className={`border-b px-3 py-1.5 text-[11px] sm:px-5 ${
            validation.errors.length > 0
              ? "border-danger-400/20 bg-danger-400/10 text-danger-400"
              : "border-warn-400/20 bg-warn-400/10 text-warn-400"
          }`}
        >
          {validation.errors.length > 0
            ? `${validation.errors.length} error(s) must be fixed before sending`
            : `${validation.warnings.length} warning(s)`}
          {" — "}
          {(validation.errors[0] ?? validation.warnings[0])?.message}
        </div>
      )}

      {/* send result */}
      {w.sendResult && (
        <div
          className={`border-b px-3 py-2 text-[12px] sm:px-5 ${
            w.sendResult.ok
              ? "border-ok-400/20 bg-ok-400/10 text-ok-400"
              : "border-danger-400/20 bg-danger-400/10 text-danger-400"
          }`}
        >
          {w.sendResult.ok ? (
            <span>
              ✓ Sent to #{w.sendResult.channelName} — check the channel!
              <button className="ml-2 text-ink-400 hover:text-ink-200" onClick={w.clearSendResult}>✕</button>
            </span>
          ) : (
            <span className="block">
              {w.sendResult.error?.message}
              {w.sendResult.error?.reason && <span className="text-ink-300"> {w.sendResult.error.reason}</span>}
              {w.sendResult.error?.fix && <em className="text-ink-400"> {w.sendResult.error.fix}</em>}
              <button className="ml-2 text-ink-400 hover:text-ink-200" onClick={w.clearSendResult}>✕</button>
            </span>
          )}
        </div>
      )}

      {w.loadError ? (
        <div className="flex flex-1 items-center justify-center px-8">
          <div className="max-w-sm rounded-2xl border border-danger-400/30 bg-danger-400/5 p-6 text-center">
            <p className="mb-2 text-sm font-medium text-danger-400">Couldn&apos;t open the {title.toLowerCase()}</p>
            <p className="text-xs text-ink-300">{w.loadError}</p>
          </div>
        </div>
      ) : !w.design ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-royal-500" />
          <span className="ml-3 text-xs text-ink-400">Loading your workspace…</span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className={`w-full shrink-0 overflow-y-auto border-ink-800 bg-ink-950/40 px-4 py-4 sm:px-5 sm:py-5 md:w-[420px] md:border-r lg:w-[460px] ${
              mobilePane === "editor" ? "block" : "hidden md:block"
            }`}
          >
            {kind === "embed" ? (
              <EmbedEditor embed={w.design as EmbedDesign} onChange={(e) => w.update(e)} />
            ) : (
              <MessageEditor message={w.design as MessageDesign} onChange={(m) => w.update(m)} />
            )}
          </div>
          <div
            className={`relative min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-8 sm:py-6 ${
              mobilePane === "preview" ? "block" : "hidden md:block"
            }`}
          >
            <div className="mx-auto max-w-2xl">
              <p className="mb-4 text-[11px] uppercase tracking-[0.18em] text-ink-500">
                Live Discord preview
              </p>
              <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-3 sm:p-6">
                {kind === "embed" ? (
                  <EmbedPreview embed={w.design as EmbedDesign} />
                ) : (
                  <MessagePreview message={w.design as MessageDesign} />
                )}
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-ink-500">
                This is how Discord renders it. Variables like {"{user}"}, {"{server}"} and{" "}
                {"{member_count}"} appear with example values here and are resolved with the real
                context when you send.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
