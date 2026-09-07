"use client";

import type { ReactNode } from "react";

/** Small shared controls for the content editors (keeps the two builders consistent). */

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-ink-400">
      {children}
      {hint && <span className="ml-2 normal-case text-ink-500">{hint}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  maxLength,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-ink-100 outline-none transition placeholder:text-ink-500 focus:border-royal-500 ${
        mono ? "font-mono text-[12px]" : ""
      }`}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] leading-relaxed text-ink-100 outline-none transition placeholder:text-ink-500 focus:border-royal-500"
    />
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-[13px] text-ink-100 outline-none focus:border-royal-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-royal-500"
      />
      {label}
    </label>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-400">
      {children}
      <span className="h-px flex-1 bg-ink-800" />
    </p>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-dashed border-ink-600 px-3 py-2 text-[12px] text-ink-300 transition hover:border-royal-500 hover:text-royal-400"
    >
      {children}
    </button>
  );
}

export function SmallButton({
  onClick,
  children,
  tone = "ghost",
  disabled,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  tone?: "ghost" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const cls =
    tone === "primary"
      ? "bg-royal-500 text-white hover:bg-royal-400 disabled:opacity-40"
      : tone === "danger"
        ? "border border-danger-400/40 text-danger-400 hover:bg-danger-400/10 disabled:opacity-40"
        : "border border-ink-700 text-ink-200 hover:border-ink-500 disabled:opacity-40";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  );
}

export function Counter({ value, max }: { value: number; max: number }) {
  const over = value > max;
  return (
    <span className={`text-[10px] tabular-nums ${over ? "text-danger-400" : "text-ink-500"}`}>
      {value}/{max}
    </span>
  );
}

export const PRESET_COLORS = ["#5865f2", "#e8b64c", "#eb4d4b", "#4cc38a", "#e5a53b", "#9b59b6", "#57c8f2"];
