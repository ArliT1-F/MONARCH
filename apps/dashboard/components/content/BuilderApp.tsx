"use client";

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

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-800 bg-ink-900/60 px-5 py-2.5 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold text-ink-100">{title}</h1>
          <p className="text-[11px] text-ink-400">{subtitle}</p>
        </div>
        <div className="mx-2 h-6 w-px bg-ink-700" />
        <span className="text-[11px] text-ink-400">
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

      {/* validation strip */}
      {validation && validation.issues.length > 0 && (
        <div
          className={`border-b px-5 py-1.5 text-[11px] ${
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
          className={`border-b px-5 py-2 text-[12px] ${
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
          <div className="w-[460px] shrink-0 overflow-y-auto border-r border-ink-800 bg-ink-950/40 px-5 py-5">
            {kind === "embed" ? (
              <EmbedEditor embed={w.design as EmbedDesign} onChange={(e) => w.update(e)} />
            ) : (
              <MessageEditor message={w.design as MessageDesign} onChange={(m) => w.update(m)} />
            )}
          </div>
          <div className="relative min-w-0 flex-1 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-2xl">
              <p className="mb-4 text-[11px] uppercase tracking-[0.18em] text-ink-500">
                Live Discord preview
              </p>
              <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-6">
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
