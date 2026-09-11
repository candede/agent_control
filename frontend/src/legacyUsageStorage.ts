export const legacyUsageStorageKey = "agent-control:usage-reports:v1";

export function hasLegacyUsageStorage(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
  if (!storage) return false;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      if (storage.key(index) === legacyUsageStorageKey) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function clearLegacyUsageStorage(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
  storage?.removeItem(legacyUsageStorageKey);
}
