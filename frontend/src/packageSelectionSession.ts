import type { SessionUser } from "./api/client";
import { maximumPackageSelection } from "./workbenchRouting";

const storageVersion = 1;
const storagePrefix = "agent-control:package-selection:v1:";

type StoredSelection = {
  version: typeof storageVersion;
  owner: string;
  ids: string[];
};

export type StoredPackageSelectionResult =
  | { status: "restored"; ids: string[] }
  | { status: "unavailable" };

export function storePackageSelection(user: SessionUser, selectedIds: string[]) {
  const ids = [...new Set(selectedIds)];
  if (ids.length === 0 || ids.length > maximumPackageSelection || ids.some(id => !validId(id))) return false;
  const owner = selectionOwner(user);
  try {
    window.sessionStorage.setItem(storageKey(user), JSON.stringify({ version: storageVersion, owner, ids } satisfies StoredSelection));
    return true;
  } catch {
    return false;
  }
}

export function restorePackageSelection(user: SessionUser, expectedCount: number): StoredPackageSelectionResult {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(user)) ?? "null") as Partial<StoredSelection> | null;
    if (!parsed || parsed.version !== storageVersion || parsed.owner !== selectionOwner(user) || !Array.isArray(parsed.ids)) {
      return { status: "unavailable" };
    }
    const ids = [...new Set(parsed.ids)];
    if (ids.length !== expectedCount || ids.length > maximumPackageSelection || ids.some(id => !validId(id))) {
      return { status: "unavailable" };
    }
    return { status: "restored", ids };
  } catch {
    return { status: "unavailable" };
  }
}

export function clearPackageSelection(user: SessionUser | undefined) {
  if (!user) return;
  try {
    window.sessionStorage.removeItem(storageKey(user));
  } catch {
    // Selection storage is optional UI continuity, never an authorization source.
  }
}

function storageKey(user: SessionUser) {
  return `${storagePrefix}${encodeURIComponent(selectionOwner(user))}`;
}

function selectionOwner(user: SessionUser) {
  return `${user.tenantId ?? ""}:${user.homeAccountId}`;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}
