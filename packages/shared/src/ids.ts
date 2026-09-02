/**
 * ID helpers. Design entities that don't exist on Discord yet carry a
 * local id with the `new_` prefix so the diff engine can tell "create"
 * apart from "modify" without guessing by name.
 */
export const LOCAL_ID_PREFIX = "new_";

export function isLocalId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(LOCAL_ID_PREFIX);
}

export function createLocalId(): string {
  return `${LOCAL_ID_PREFIX}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
