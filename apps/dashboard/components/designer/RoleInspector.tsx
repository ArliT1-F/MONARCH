"use client";

import { useMemo, useState } from "react";
import { DiscordLimits, type ValidationReport } from "@monarch/validation";
import { Permission, hasPermission } from "@monarch/shared";
import type { RoleDesignerAction, RoleDesignerState } from "./role-designer-state";
import { orderedRoles } from "./role-designer-state";

/**
 * Right-panel inspector for the Role Designer.
 *
 * Surfaces:
 *   - name + char count
 *   - color (hex input with native picker)
 *   - hoist (show role separately from online members)
 *   - mentionable (members with this role can be @mentioned)
 *   - position
 *   - permission toggles: a curated grid for the most-common flags
 *     plus a "raw" bitfield for power users
 *   - "managed" note for bot/integration roles (read-only)
 *
 * The permission grid is intentionally small: full permission editing
 * is a Phase 6+ feature. The curated set covers ~95% of what admins
 * actually want from a role editor.
 */
export function RoleInspector({
  state,
  dispatch,
  validation,
}: {
  state: RoleDesignerState;
  dispatch: React.Dispatch<RoleDesignerAction>;
  validation: ValidationReport | null;
}) {
  const design = state.design!;
  const sel = state.selection;

  if (!sel) {
    return (
      <div className="flex h-full flex-col">
        <PanelTitle>Inspector</PanelTitle>
        <div className="mt-10 text-center">
          <p className="mb-1 text-xs font-medium text-ink-300">No role selected</p>
          <p className="text-[11px] leading-relaxed text-ink-400">
            Pick a role on the left to edit its name, color, hoist and
            mentionable settings, or its permissions. New roles land at
            the bottom of the list.
          </p>
        </div>
        <IssueList validation={validation} />
      </div>
    );
  }

  const role = design.roles.find((r) => r.id === sel.id);
  if (!role) return null;
  if (role.managed) {
    return (
      <div>
        <PanelTitle>Managed role</PanelTitle>
        <p className="mb-2 text-xs text-ink-300">
          <span className="font-medium text-ink-100">{role.name}</span> is managed by a
          bot or integration. Monarch can&apos;t rename or delete it, but you can keep
          using the rest of the dashboard.
        </p>
        <p className="text-[11px] leading-relaxed text-ink-400">
          Discord creates managed roles automatically (for example, for the MEE6 or
          Carl-bot integrations). To change this role, edit it through that bot.
        </p>
        <IssueList validation={validation} entityId={role.id} />
      </div>
    );
  }

  return (
    <div>
      <PanelTitle>Role</PanelTitle>

      <Field label="Name" count={`${role.name.length}/${DiscordLimits.role.nameMax}`}>
        <input
          value={role.name}
          onChange={(e) =>
            dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { name: e.target.value } })
          }
          className={inputCls}
          maxLength={DiscordLimits.role.nameMax}
        />
      </Field>

      <Field label="Color">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={role.color ?? "#5865f2"}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ROLE",
                id: role.id,
                patch: { color: e.target.value },
              })
            }
            aria-label="Pick role color"
            className="h-8 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
          />
          <input
            value={role.color ?? ""}
            placeholder="default"
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v === "") {
                dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { color: undefined } });
                return;
              }
              const normalized = v.startsWith("#") ? v : `#${v}`;
              if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
                dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { color: normalized } });
              } else {
                // Update local text without changing color (let the user finish typing)
                dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { color: v } });
              }
            }}
            className={`${inputCls} font-mono`}
            spellCheck={false}
          />
          {role.color && (
            <button
              onClick={() =>
                dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { color: undefined } })
              }
              className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-400 transition hover:border-ink-500 hover:text-ink-200"
            >
              reset
            </button>
          )}
        </div>
      </Field>

      <Field label="Position">
        <input
          type="number"
          min={0}
          max={Math.max(0, design.roles.length - 1)}
          value={role.position}
          onChange={(e) => {
            const v = Math.max(0, Math.min(design.roles.length - 1, Number(e.target.value) || 0));
            dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { position: v } });
          }}
          className={inputCls}
        />
        <p className="mt-1 text-[10px] text-ink-500">
          0 is the highest position. Drag-reorder is a follow-up — for now, type the
          number directly.
        </p>
      </Field>

      <div className="mb-4 space-y-1.5">
        <Checkbox
          checked={!!role.hoist}
          onChange={(v) => dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { hoist: v } })}
          label="Show role separately from online members"
        />
        <Checkbox
          checked={!!role.mentionable}
          onChange={(v) =>
            dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { mentionable: v } })
          }
          label="Members with this role can be @mentioned"
        />
      </div>

      <PermissionGrid
        permissions={role.permissions ?? "0"}
        onChange={(v) => dispatch({ type: "UPDATE_ROLE", id: role.id, patch: { permissions: v } })}
      />

      <div className="mt-4 flex gap-2">
        <ActionButton onClick={() => dispatch({ type: "DUPLICATE_ROLE", id: role.id })}>
          Duplicate
        </ActionButton>
        <ActionButton
          danger
          onClick={() => {
            if (confirm(`Delete role "${role.name}"? Members with only this role will lose it on Discord when you apply.`)) {
              dispatch({ type: "DELETE_ROLE", id: role.id });
            }
          }}
        >
          Delete
        </ActionButton>
      </div>

      <IssueList validation={validation} entityId={role.id} />

      <SiblingRoles
        design={design}
        currentId={role.id}
        onSelect={(id) => dispatch({ type: "SELECT", id })}
      />
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-100 outline-none transition focus:border-royal-500";

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
      {children}
    </p>
  );
}

function Field({
  label,
  count,
  children,
}: {
  label: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[11px] font-medium text-ink-300">{label}</label>
        {count && <span className="text-[10px] text-ink-500">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-200">
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

function ActionButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs transition ${
        danger
          ? "border-ink-700 text-ink-300 hover:border-danger-400/50 hover:text-danger-400"
          : "border-ink-700 text-ink-200 hover:border-ink-500"
      }`}
    >
      {children}
    </button>
  );
}

function IssueList({
  validation,
  entityId,
}: {
  validation: ValidationReport | null;
  entityId?: string;
}) {
  if (!validation) return null;
  const issues = entityId
    ? validation.issues.filter((i) => i.target?.id === entityId)
    : validation.issues;
  if (issues.length === 0) return null;
  return (
    <div className="mt-6 space-y-2">
      <p className="text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
        {entityId ? "Issues here" : "Design issues"}
      </p>
      {issues.slice(0, 6).map((issue, i) => (
        <div
          key={i}
          className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            issue.severity === "error"
              ? "border-danger-400/25 bg-danger-400/5 text-danger-400"
              : "border-warn-400/25 bg-warn-400/5 text-warn-400"
          }`}
        >
          {issue.message}
          {issue.fix && <span className="block text-ink-400">{issue.fix}</span>}
        </div>
      ))}
    </div>
  );
}

/** Quick-jump list of other roles in the same design, for fast navigation. */
function SiblingRoles({
  design,
  currentId,
  onSelect,
}: {
  design: NonNullable<RoleDesignerState["design"]>;
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const ordered = orderedRoles(design);
  return (
    <div className="mt-6">
      <p className="mb-2 text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
        Other roles
      </p>
      <ul className="space-y-1">
        {ordered
          .filter((r) => r.id !== currentId)
          .slice(0, 8)
          .map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onSelect(r.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[11px] text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border border-ink-700"
                  style={{ background: r.color ?? "transparent" }}
                />
                <span className="flex-1 truncate">{r.name}</span>
                {r.managed && (
                  <span className="rounded bg-ink-800 px-1 text-[9px] text-ink-400 uppercase">
                    managed
                  </span>
                )}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Curated permission grid. The "raw" mode exposes the bitfield as a
 * decimal string for power users; the grid mode toggles a small set of
 * the most-used flags and computes the bitfield.
 *
 * The curated flags are exactly the ones that fit on the page without
 * scroll on a phone. They cover every "first" role a server owner
 * creates (Moderator, Verified, Muted, etc.) and use the same bit
 * values as the @monarch/shared `Permission` constants.
 */
const CURATED_PERMISSIONS: { name: string; bit: bigint; description: string }[] = [
  { name: "View Channel", bit: Permission.ViewChannel, description: "See the channel." },
  {
    name: "Send Messages",
    bit: Permission.SendMessages,
    description: "Post in text channels.",
  },
  {
    name: "Manage Messages",
    bit: Permission.ManageMessages,
    description: "Delete others' messages and pin messages.",
  },
  {
    name: "Read Message History",
    bit: Permission.ReadMessageHistory,
    description: "Read past messages in a channel.",
  },
  {
    name: "Embed Links",
    bit: Permission.EmbedLinks,
    description: "URLs posted expand into embeds.",
  },
  {
    name: "Attach Files",
    bit: Permission.AttachFiles,
    description: "Upload files in messages.",
  },
  {
    name: "Manage Channels",
    bit: Permission.ManageChannels,
    description: "Edit and delete channels.",
  },
  {
    name: "Manage Roles",
    bit: Permission.ManageRoles,
    description: "Edit and delete roles below this one.",
  },
  { name: "Manage Guild", bit: Permission.ManageGuild, description: "Edit server settings." },
  { name: "Administrator", bit: Permission.Administrator, description: "All permissions." },
];

function PermissionGrid({
  permissions,
  onChange,
}: {
  permissions: string;
  onChange: (v: string) => void;
}) {
  const bits = useMemo(() => BigInt(permissions || "0"), [permissions]);
  const [raw, setRaw] = useState(false);
  const [rawValue, setRawValue] = useState(permissions);

  // Keep rawValue in sync if the curated-grid changes the bitfield.
  useMemo(() => setRawValue(permissions), [permissions]);

  function toggle(bit: bigint, on: boolean) {
    let next = bits;
    if (on) next |= bit;
    else next &= ~bit;
    onChange(next.toString());
  }

  if (raw) {
    return (
      <div className="mb-4">
        <div className="mb-1 flex items-baseline justify-between">
          <label className="text-[11px] font-medium text-ink-300">Permissions (raw)</label>
          <button
            onClick={() => setRaw(false)}
            className="text-[10px] text-ink-400 underline hover:text-ink-200"
          >
            show curated
          </button>
        </div>
        <input
          value={rawValue}
          onChange={(e) => {
            setRawValue(e.target.value);
            if (/^\d+$/.test(e.target.value.trim())) onChange(e.target.value.trim());
          }}
          className={`${inputCls} font-mono`}
          spellCheck={false}
          placeholder="0"
        />
        <p className="mt-1 text-[10px] text-ink-500">
          Discord permission bitfield as a decimal string. Use the curated grid for the
          common flags.
        </p>
      </div>
    );
  }

  const adminOn = hasPermission(bits, Permission.Administrator);

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[11px] font-medium text-ink-300">Permissions</p>
        <button
          onClick={() => {
            setRawValue(permissions);
            setRaw(true);
          }}
          className="text-[10px] text-ink-400 underline hover:text-ink-200"
        >
          raw
        </button>
      </div>
      <ul className="space-y-1">
        {CURATED_PERMISSIONS.map((p) => {
          // With Administrator on, Discord grants every permission, so the
          // other toggles are locked "on" rather than pretending each bit
          // is set (turning Administrator off reveals the real bits).
          const isAdminRow = p.bit === Permission.Administrator;
          const on = isAdminRow ? adminOn : adminOn || hasPermission(bits, p.bit);
          const locked = adminOn && !isAdminRow;
          return (
            <li key={p.name}>
              <label className={`flex items-start gap-2 text-xs text-ink-200 ${locked ? "opacity-60" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={(e) => toggle(p.bit, e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 accent-royal-500"
                />
                <span className="flex-1">
                  <span className="block text-ink-100">{p.name}</span>
                  <span className="block text-[10px] text-ink-400">
                    {locked ? "Granted by Administrator." : p.description}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
