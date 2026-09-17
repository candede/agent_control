import type { InventoryCoverageStatus, InventorySnapshot } from "./api/client";

export const powerPlatformInventoryCaveat = "Microsoft Power Platform inventory excludes classic/V1 bots. Recent changes may take about 20 minutes to appear.";

export function inventoryRoleHint(scope?: InventorySnapshot["roleScope"] | null) {
  switch (scope) {
    case "full": return "Full (hint only)";
    case "ai": return "AI (hint only)";
    case "unknown":
    case undefined:
    case null: return "Not supplied";
    default: return "Unrecognized role hint";
  }
}

export function inventoryRequestScope(environmentScope: string | null) {
  return environmentScope === null ? "All environments requested" : `Environment requested: ${environmentScope}`;
}

export function inventoryCoverageLabel(status: InventoryCoverageStatus) {
  const labels: Record<InventoryCoverageStatus, string> = {
    covered: "Authorized query verified",
    not_requested: "Not requested",
    not_authorized_scope: "Not queried (role scope)",
    unknown: "Unknown (not verified)",
  };
  return labels[status];
}

export function inventoryCoverageValue(status: InventoryCoverageStatus, count: number | null) {
  if (status === "covered") return count === null ? "Count not established" : count.toLocaleString();
  if (status === "unknown" && count !== null) return `${count.toLocaleString()} observed; completeness not verified`;
  return inventoryCoverageLabel(status);
}

export function savedInventoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid saved timestamp" : date.toLocaleString();
}
