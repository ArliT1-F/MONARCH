"use client";

import type { EmbedDesign, EmbedField } from "@monarch/schemas";
import {
  AddButton,
  Checkbox,
  Counter,
  FieldLabel,
  PRESET_COLORS,
  SectionTitle,
  SmallButton,
  TextArea,
  TextInput,
} from "./ui";

/**
 * Property editor for one embed design. Fully controlled: every change goes
 * up through onChange so the builder can live-preview and autosave.
 */
export function EmbedEditor({
  embed,
  onChange,
}: {
  embed: EmbedDesign;
  onChange: (next: EmbedDesign) => void;
}) {
  const set = (patch: Partial<EmbedDesign>) => onChange({ ...embed, ...patch });

  const setField = (i: number, patch: Partial<EmbedField>) =>
    set({ fields: embed.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) });

  const removeField = (i: number) =>
    set({ fields: embed.fields.filter((_, idx) => idx !== i) });

  const moveField = (i: number, dir: -1 | 1) => {
    const fields = [...embed.fields];
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j]!, fields[i]!];
    set({ fields });
  };

  const addField = () =>
    set({
      fields: [
        ...embed.fields,
        { name: "Field name", value: "Field value — use {user} or {server} for dynamic content.", inline: false },
      ],
    });

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>Embed</SectionTitle>
        <div className="space-y-3">
          <div>
            <FieldLabel hint={<Counter value={embed.title?.length ?? 0} max={256} />}>Title</FieldLabel>
            <TextInput
              value={embed.title ?? ""}
              maxLength={256}
              placeholder="The main heading — supports {server}"
              onChange={(title) => set({ title: title || undefined })}
            />
          </div>
          <div>
            <FieldLabel hint={<Counter value={embed.url?.length ?? 0} max={2000} />}>URL (title link)</FieldLabel>
            <TextInput
              value={embed.url ?? ""}
              mono
              placeholder="https://…"
              onChange={(url) => set({ url: url || undefined })}
            />
          </div>
          <div>
            <FieldLabel hint={<Counter value={embed.description?.length ?? 0} max={4096} />}>
              Description
            </FieldLabel>
            <TextArea
              value={embed.description ?? ""}
              rows={5}
              maxLength={4096}
              placeholder="Multi-line description. Try {user}, {display_name}, {member_count} or {channel}."
              onChange={(description) => set({ description: description || undefined })}
            />
          </div>
          <div>
            <FieldLabel>Accent color</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set({ color: c })}
                  className={`h-7 w-7 rounded-full border-2 transition ${
                    embed.color === c ? "border-white" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
              <input
                type="text"
                value={embed.color ?? ""}
                placeholder="#5865f2"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  set({ color: v.startsWith("#") && v.length === 7 ? v : undefined });
                }}
                className="w-24 rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 font-mono text-[12px] text-ink-100 outline-none focus:border-royal-500"
              />
              <input
                type="color"
                value={embed.color ?? "#5865f2"}
                onChange={(e) => set({ color: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-ink-700 bg-ink-900"
              />
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>Author & footer</SectionTitle>
        <div className="space-y-3">
          <div>
            <FieldLabel>Author name</FieldLabel>
            <TextInput
              value={embed.author?.name ?? ""}
              maxLength={256}
              placeholder="e.g. {server} Staff"
              onChange={(name) =>
                set({ author: name ? { name, ...(embed.author?.url ? { url: embed.author.url } : {}), ...(embed.author?.iconUrl ? { iconUrl: embed.author.iconUrl } : {}) } : undefined })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Author URL</FieldLabel>
              <TextInput
                value={embed.author?.url ?? ""}
                mono
                placeholder="https://…"
                onChange={(url) =>
                  embed.author && set({ author: { ...embed.author, url: url || undefined } })
                }
              />
            </div>
            <div>
              <FieldLabel>Author icon</FieldLabel>
              <TextInput
                value={embed.author?.iconUrl ?? ""}
                mono
                placeholder="https://…"
                onChange={(iconUrl) =>
                  embed.author && set({ author: { ...embed.author, iconUrl: iconUrl || undefined } })
                }
              />
            </div>
          </div>
          <div>
            <FieldLabel>Footer text</FieldLabel>
            <TextInput
              value={embed.footer?.text ?? ""}
              maxLength={2048}
              placeholder="Small line under the embed"
              onChange={(text) => set({ footer: text ? { text, ...(embed.footer?.iconUrl ? { iconUrl: embed.footer.iconUrl } : {}) } : undefined })}
            />
          </div>
          <div>
            <FieldLabel>Footer icon</FieldLabel>
            <TextInput
              value={embed.footer?.iconUrl ?? ""}
              mono
              placeholder="https://…"
              onChange={(iconUrl) =>
                embed.footer && set({ footer: { ...embed.footer, iconUrl: iconUrl || undefined } })
              }
            />
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>Images & time</SectionTitle>
        <div className="space-y-3">
          <div>
            <FieldLabel>Large image URL</FieldLabel>
            <TextInput
              value={embed.imageUrl ?? ""}
              mono
              placeholder="https://…"
              onChange={(imageUrl) => set({ imageUrl: imageUrl || undefined })}
            />
          </div>
          <div>
            <FieldLabel>Thumbnail URL (top-right)</FieldLabel>
            <TextInput
              value={embed.thumbnailUrl ?? ""}
              mono
              placeholder="https://…"
              onChange={(thumbnailUrl) => set({ thumbnailUrl: thumbnailUrl || undefined })}
            />
          </div>
          <Checkbox
            checked={embed.timestamp === "now"}
            onChange={(timestamp) => set({ timestamp: timestamp ? "now" : undefined })}
            label="Stamp with the current time when sent"
          />
        </div>
      </section>

      <section>
        <SectionTitle>Fields {embed.fields.length > 0 && `(${embed.fields.length}/25)`}</SectionTitle>
        <div className="space-y-2.5">
          {embed.fields.map((f, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/50 p-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.inline}
                  onChange={(e) => setField(i, { inline: e.target.checked })}
                  title="Inline (side by side)"
                  className="h-3.5 w-3.5 accent-royal-500"
                />
                <TextInput
                  value={f.name}
                  maxLength={256}
                  placeholder="Field name"
                  onChange={(name) => setField(i, { name })}
                />
                <SmallButton onClick={() => moveField(i, -1)}>
                  ↑
                </SmallButton>
                <SmallButton onClick={() => moveField(i, 1)}>↓</SmallButton>
                <SmallButton tone="danger" onClick={() => removeField(i)}>
                  ✕
                </SmallButton>
              </div>
              <TextArea
                value={f.value}
                maxLength={1024}
                rows={2}
                placeholder="Field value"
                onChange={(value) => setField(i, { value })}
              />
            </div>
          ))}
          <AddButton onClick={addField}>+ Add field</AddButton>
        </div>
      </section>
    </div>
  );
}
