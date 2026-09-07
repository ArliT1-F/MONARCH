"use client";

import type { EmbedDesign, MessageButton, MessageDesign } from "@monarch/schemas";
import { EmbedEditor } from "./EmbedEditor";
import {
  AddButton,
  Checkbox,
  Counter,
  FieldLabel,
  SectionTitle,
  Select,
  SmallButton,
  TextArea,
  TextInput,
} from "./ui";

let buttonId = 0;
const nextButtonId = () => `btn_${Date.now().toString(36)}_${buttonId++}`;

/**
 * Message Designer editor: content + buttons + a stack of embeds.
 * Fully controlled — preview and autosave live beside it.
 */
export function MessageEditor({
  message,
  onChange,
}: {
  message: MessageDesign;
  onChange: (next: MessageDesign) => void;
}) {
  const set = (patch: Partial<MessageDesign>) => onChange({ ...message, ...patch });

  const setButton = (i: number, patch: Partial<MessageButton>) =>
    set({ buttons: message.buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });

  const removeButton = (i: number) => set({ buttons: message.buttons.filter((_, idx) => idx !== i) });

  const moveButton = (i: number, dir: -1 | 1) => {
    const buttons = [...message.buttons];
    const j = i + dir;
    if (j < 0 || j >= buttons.length) return;
    [buttons[i], buttons[j]] = [buttons[j]!, buttons[i]!];
    set({ buttons });
  };

  const addButton = () =>
    set({
      buttons: [
        ...message.buttons,
        { id: nextButtonId(), label: "Click me", style: "primary", disabled: false },
      ],
    });

  const setEmbed = (i: number, embed: EmbedDesign) =>
    set({ embeds: message.embeds.map((e, idx) => (idx === i ? embed : e)) });

  const removeEmbed = (i: number) => set({ embeds: message.embeds.filter((_, idx) => idx !== i) });

  const moveEmbed = (i: number, dir: -1 | 1) => {
    const embeds = [...message.embeds];
    const j = i + dir;
    if (j < 0 || j >= embeds.length) return;
    [embeds[i], embeds[j]] = [embeds[j]!, embeds[i]!];
    set({ embeds });
  };

  const addEmbed = () =>
    set({ embeds: [...message.embeds, { fields: [] }] });

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>Content</SectionTitle>
        <FieldLabel hint={<Counter value={message.content.length} max={2000} />}>
          Plain text (before embeds)
        </FieldLabel>
        <TextArea
          value={message.content}
          rows={4}
          maxLength={2000}
          placeholder={"Say hi! Supports {user}, {display_name}, {server}, {member_count}, {channel}…"}
          onChange={(content) => set({ content })}
        />
        <p className="mt-2 text-[11px] text-ink-500">
          Variables like {"{user}"} are resolved with the real user/server at send time.
        </p>
      </section>

      <section>
        <SectionTitle>Buttons {message.buttons.length > 0 && `(${message.buttons.length}/25)`}</SectionTitle>
        <div className="space-y-2.5">
          {message.buttons.map((b, i) => (
            <div key={b.id} className="flex flex-wrap items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/50 p-3">
              <div className="w-28">
                <Select
                  value={b.style}
                  onChange={(style) => setButton(i, { style: style as MessageButton["style"] })}
                  options={[
                    { value: "primary", label: "Primary" },
                    { value: "secondary", label: "Secondary" },
                    { value: "success", label: "Success" },
                    { value: "danger", label: "Danger" },
                    { value: "link", label: "Link" },
                  ]}
                />
              </div>
              <div className="min-w-36 flex-1">
                <TextInput
                  value={b.label}
                  maxLength={80}
                  placeholder="Button label"
                  onChange={(label) => setButton(i, { label })}
                />
              </div>
              {b.style === "link" && (
                <div className="min-w-40 flex-1">
                  <TextInput
                    value={b.url ?? ""}
                    mono
                    placeholder="https://…"
                    onChange={(url) => setButton(i, { url: url || undefined })}
                  />
                </div>
              )}
              <div className="flex items-center gap-1 pt-2">
                <Checkbox checked={b.disabled} onChange={(disabled) => setButton(i, { disabled })} label="Off" />
                <SmallButton onClick={() => moveButton(i, -1)}>↑</SmallButton>
                <SmallButton onClick={() => moveButton(i, 1)}>↓</SmallButton>
                <SmallButton tone="danger" onClick={() => removeButton(i)}>✕</SmallButton>
              </div>
            </div>
          ))}
          <AddButton onClick={addButton}>+ Add button</AddButton>
        </div>
        <p className="mt-2 text-[11px] text-ink-500">
          Monarch currently creates <strong className="text-ink-300">link buttons</strong>. Interactive buttons
          (custom_id actions) arrive with the interaction feature.
        </p>
      </section>

      <section>
        <SectionTitle>Embeds {message.embeds.length > 0 && `(${message.embeds.length}/10)`}</SectionTitle>
        <div className="space-y-3">
          {message.embeds.map((e, i) => (
            <div key={i} className="rounded-xl border border-ink-700 bg-ink-900/40 p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-royal-400">
                  Embed {i + 1}
                </p>
                <div className="flex items-center gap-1">
                  <SmallButton onClick={() => moveEmbed(i, -1)}>↑</SmallButton>
                  <SmallButton onClick={() => moveEmbed(i, 1)}>↓</SmallButton>
                  <SmallButton tone="danger" onClick={() => removeEmbed(i)}>Remove</SmallButton>
                </div>
              </div>
              <EmbedEditor embed={e} onChange={(embed) => setEmbed(i, embed)} />
            </div>
          ))}
          <AddButton onClick={addEmbed}>+ Add embed</AddButton>
        </div>
      </section>
    </div>
  );
}
