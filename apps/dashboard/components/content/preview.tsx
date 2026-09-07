"use client";

import type { EmbedDesign, MessageDesign, MessageButton } from "@monarch/schemas";
import { renderVariableExamples } from "@monarch/shared";

/**
 * Pixel-faithful-ish Discord previews for embeds and full messages.
 * {variables} are shown with their example values (real values are resolved
 * only at send time).
 */

const BUTTON_TONES: Record<MessageButton["style"], string> = {
  primary: "bg-[#5865f2] text-white border-transparent",
  secondary: "bg-ink-800 text-ink-100 border-ink-700",
  success: "bg-[#248046] text-white border-transparent",
  danger: "bg-[#da373c] text-white border-transparent",
  link: "bg-ink-900 text-[#00a8fc] border-ink-700",
};

export function EmbedPreview({ embed }: { embed: EmbedDesign }) {
  const color = embed.color ?? "#5865f2";
  const timestamp = embed.timestamp
    ? embed.timestamp === "now"
      ? new Date()
      : new Date(embed.timestamp)
    : null;

  return (
    <div className="flex w-full max-w-[440px]">
      <div className="w-1 shrink-0 rounded-l-md" style={{ backgroundColor: color }} />
      <div className="min-w-0 flex-1 rounded-r-md border border-ink-800 bg-ink-850 px-4 py-3">
        {embed.thumbnailUrl && (
          <div className="float-right ml-4 mb-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={renderVariableExamples(embed.thumbnailUrl)}
              alt=""
              className="h-20 w-20 rounded-lg object-cover"
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
          </div>
        )}

        {embed.author && (
          <div className="mb-1 flex items-center gap-2">
            {embed.author.iconUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={renderVariableExamples(embed.author.iconUrl)}
                alt=""
                className="h-6 w-6 rounded-full object-cover"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            )}
            <span className="text-[13px] font-medium text-ink-100">
              {renderVariableExamples(embed.author.name)}
            </span>
          </div>
        )}

        {embed.title && (
          <p className="text-[15px] font-semibold text-[#00a8fc]">
            {renderVariableExamples(embed.title)}
          </p>
        )}

        {embed.description && (
          <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-200">
            {renderVariableExamples(embed.description)}
          </p>
        )}

        {embed.fields.length > 0 && (
          <div
            className="mt-2 grid gap-x-4 gap-y-2"
            style={{
              gridTemplateColumns: embed.fields.every((f) => f.inline)
                ? "repeat(auto-fit, minmax(120px, 1fr))"
                : "1fr",
            }}
          >
            {embed.fields.map((f, i) => (
              <div key={i} className="min-w-0">
                <p className="text-[13px] font-semibold text-ink-100">
                  {renderVariableExamples(f.name)}
                </p>
                <p className="whitespace-pre-wrap text-[13px] text-ink-200">
                  {renderVariableExamples(f.value)}
                </p>
              </div>
            ))}
          </div>
        )}

        {embed.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={renderVariableExamples(embed.imageUrl)}
            alt=""
            className="mt-3 max-h-72 w-full max-w-[400px] rounded-lg object-cover"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        )}

        {(embed.footer || timestamp) && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-400">
            {embed.footer?.iconUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={renderVariableExamples(embed.footer.iconUrl)}
                alt=""
                className="h-4 w-4 rounded-full object-cover"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            )}
            <span className="truncate">{embed.footer && renderVariableExamples(embed.footer.text)}</span>
            {embed.footer && timestamp && <span>•</span>}
            {timestamp && (
              <span className="whitespace-nowrap">
                {timestamp.toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessagePreview({ message }: { message: MessageDesign }) {
  return (
    <div className="w-full max-w-[520px] rounded-2xl border border-ink-800 bg-ink-900/70 p-4">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-royal-500/25 text-sm font-bold text-royal-400">
          M
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-100">
            Monarch Bot{" "}
            <span className="ml-1 rounded bg-ink-700 px-1 py-0.5 text-[9px] font-semibold uppercase text-ink-300">
              app
            </span>
          </p>
          {message.content && (
            <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-100">
              {renderVariableExamples(message.content)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 space-y-2 pl-0">
        {message.embeds.map((e, i) => (
          <EmbedPreview key={i} embed={e} />
        ))}
      </div>

      {message.buttons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.buttons.map((b) => (
            <button
              key={b.id}
              disabled={b.disabled}
              className={`rounded-lg border px-4 py-1.5 text-[12px] font-medium transition ${
                BUTTON_TONES[b.style]
              } disabled:opacity-45`}
            >
              {renderVariableExamples(b.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
