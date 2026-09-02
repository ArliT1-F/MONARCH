/**
 * Monarch variable system.
 *
 * Message-producing features ({user}, {server}, …) resolve variables against
 * a context at render/publish time. The registry is extensible: features can
 * register additional variables without touching this file.
 */
export interface VariableContext {
  user?: { id: string; username: string; displayName?: string };
  guild?: { id: string; name: string; memberCount?: number };
  channel?: { id: string; name: string };
}

export interface VariableDefinition {
  name: string;
  description: string;
  /** Example rendered value shown in previews. */
  example: string;
  resolve(ctx: VariableContext): string | undefined;
}

const registry = new Map<string, VariableDefinition>();

export function registerVariable(def: VariableDefinition) {
  registry.set(def.name, def);
}

export function listVariables(): VariableDefinition[] {
  return [...registry.values()];
}

const CORE_VARIABLES: VariableDefinition[] = [
  {
    name: "user",
    description: "Mentions the user",
    example: "@NewMember",
    resolve: (c) => (c.user ? `<@${c.user.id}>` : undefined),
  },
  {
    name: "username",
    description: "The user's Discord username",
    example: "newmember",
    resolve: (c) => c.user?.username,
  },
  {
    name: "display_name",
    description: "The user's display name",
    example: "New Member",
    resolve: (c) => c.user?.displayName ?? c.user?.username,
  },
  {
    name: "server",
    description: "The server name",
    example: "My Community",
    resolve: (c) => c.guild?.name,
  },
  {
    name: "member_count",
    description: "Current member count",
    example: "12,482",
    resolve: (c) =>
      c.guild?.memberCount !== undefined ? c.guild.memberCount.toLocaleString() : undefined,
  },
  {
    name: "channel",
    description: "Mentions the contextual channel",
    example: "#welcome",
    resolve: (c) => (c.channel ? `<#${c.channel.id}>` : undefined),
  },
];

for (const v of CORE_VARIABLES) registerVariable(v);

const VARIABLE_PATTERN = /\{([a-z_]+)\}/g;

/** Replace {variables} in text. Unknown/unresolvable variables are left as-is. */
export function renderVariables(text: string, ctx: VariableContext): string {
  return text.replace(VARIABLE_PATTERN, (raw, name: string) => {
    const def = registry.get(name);
    const value = def?.resolve(ctx);
    return value ?? raw;
  });
}

/** Preview-friendly rendering using each variable's example value. */
export function renderVariableExamples(text: string): string {
  return text.replace(VARIABLE_PATTERN, (raw, name: string) => {
    return registry.get(name)?.example ?? raw;
  });
}
