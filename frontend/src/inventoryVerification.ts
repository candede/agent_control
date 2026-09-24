import type { InventoryCoverageStatus, InventorySnapshot, UnifiedAgentInventoryPage } from "./api/client";

export const powerPlatformInventoryCaveat = "Microsoft Power Platform inventory excludes classic/V1 bots. Recent changes may take about 20 minutes to appear.";

export function inventoryAttentionReasons(inventory?: UnifiedAgentInventoryPage, error?: string): string[] {
  if (error) return [error];
  if (!inventory) return [];
  const reasons = new Set([
    ...inventory.errors.map(item => item.message),
    ...Object.values(inventory.sources).flatMap(source => source.error ? [source.error.message] : []),
  ]);
  if (!inventory.verification.checks.sourceScopes && !reasons.size) {
    reasons.add("Saved source coverage is incomplete. Check source permissions and refresh the affected source in Data sync.");
  }
  const pending = inventory.identityCollection?.pendingPackages ?? 0;
  const invalid = inventory.identityCollection?.invalidPackages ?? 0;
  if (pending) reasons.add(`${pending.toLocaleString()} package${pending === 1 ? "" : "s"} awaiting identity metadata. These details are enriched separately in the background after catalog sync.`);
  if (invalid) reasons.add(`${invalid.toLocaleString()} package${invalid === 1 ? "" : "s"} with invalid matching metadata. Use diagnostics to refresh matching details for the affected packages.`);
  if (!inventory.verification.checks.packageMetadata && !pending && !invalid) {
    reasons.add("Package identity metadata has not been verified. Open diagnostics to inspect or refresh matching details.");
  }
  if (!inventory.verification.checks.identityLinks || inventory.summary.conflicting || inventory.summary.ambiguous) {
    reasons.add(`${inventory.summary.conflicting.toLocaleString()} conflicting and ${inventory.summary.ambiguous.toLocaleString()} ambiguous identity links. Review the affected agents' matching details; names alone cannot resolve them.`);
  }
  if (!reasons.size && (inventory.partial || inventory.verification.status === "needs_attention")) {
    reasons.add("Saved inventory checks are incomplete. Open diagnostics to recheck source coverage and identity accounting.");
  }
  return [...reasons];
}

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
