import type { SessionUser } from "./api/client";
import { maximumPackageSelection } from "./workbenchRouting";

const storageVersion = 2;
const storagePrefix = "agent-control:package-selection:v2:";

export type StoredInventorySelection = {
  id: string;
  query: string;
  cursor?: string;
  page: number;
  groups?: string[];
  allMatching?: boolean;
  count: number;
};

type StoredSelection = {
  version: typeof storageVersion;
  owner: string;
  roles: string[];
  ids: string[];
  inventory?: StoredInventorySelection;
};

type StoredPackageSelectionResult =
  | { status: "restored"; ids: string[]; inventory?: StoredInventorySelection }
  | { status: "unavailable" };

export function storePackageSelection(user: SessionUser, selectedIds: string[], inventory?: StoredInventorySelection) {
  const ids = [...new Set(selectedIds)];
  if ((!ids.length && !inventory) || ids.length > maximumPackageSelection || ids.some(id => !validId(id))
    || inventory && !validInventorySelection(inventory, ids)) return false;
  const owner = selectionOwner(user);
  try {
    window.sessionStorage.setItem(storageKey(user), JSON.stringify({
      version: storageVersion, owner, roles: [...user.roles].sort(), ids, ...(inventory ? { inventory } : {}),
    } satisfies StoredSelection));
    return true;
  } catch {
    return false;
  }
}

export function restorePackageSelection(user: SessionUser, expectedCount: number): StoredPackageSelectionResult {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(user)) ?? "null") as Partial<StoredSelection> | null;
    if (!parsed || parsed.version !== storageVersion || parsed.owner !== selectionOwner(user) || !Array.isArray(parsed.ids)
      || JSON.stringify(parsed.roles) !== JSON.stringify([...user.roles].sort())) {
      return { status: "unavailable" };
    }
    const ids = [...new Set(parsed.ids)];
    if ((parsed.inventory?.count ?? ids.length) !== expectedCount || ids.length > maximumPackageSelection || ids.some(id => !validId(id))
      || parsed.inventory !== undefined && !validInventorySelection(parsed.inventory, ids)) {
      return { status: "unavailable" };
    }
    return { status: "restored", ids, ...(parsed.inventory ? { inventory: parsed.inventory } : {}) };
  } catch {
    return { status: "unavailable" };
  }
}

export function clearPackageSelection(user: SessionUser | undefined) {
  if (!user) return;
  try {
    window.sessionStorage.removeItem(storageKey(user));
    window.sessionStorage.removeItem(`agent-control:package-selection:v1:${encodeURIComponent(selectionOwner(user))}`);
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

function validInventorySelection(value: StoredInventorySelection, ids: string[]) {
  return value !== null && typeof value === "object" && validId(value.id)
    && typeof value.query === "string" && value.query.length > 0 && value.query.length <= 65_536
    && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length > 0 && value.cursor.length <= 4_096)
    && Number.isSafeInteger(value.page) && value.page >= 0 && value.page <= 10_000
    && Number.isSafeInteger(value.count) && value.count > 0 && value.count <= maximumPackageSelection
    && (value.allMatching === undefined || typeof value.allMatching === "boolean")
    && (value.allMatching === true
      ? ids.length === 0 && value.groups === undefined
      : Array.isArray(value.groups) && value.groups.length > 0 && value.groups.length <= maximumPackageSelection
        && value.groups.every(validId) && new Set(value.groups).size === value.groups.length);
}
