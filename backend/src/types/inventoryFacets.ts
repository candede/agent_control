export type InventoryFacetValue = string | null | { kind: "some-or-all" };

export function encodeInventoryFacet(value: InventoryFacetValue): string {
  if (value === null) return "~null";
  if (typeof value === "string") return `~string:${value}`;
  if (value.kind === "some-or-all") return "~some-or-all";
  throw new Error("invalid_inventory_facet");
}

export function decodeInventoryFacet(value: string): InventoryFacetValue {
  if (value === "~null") return null;
  if (value === "~some-or-all") return { kind: "some-or-all" };
  if (value.startsWith("~string:")) return value.slice(8);
  throw new Error("invalid_inventory_facet");
}

export function inventoryFacetLabel(value: InventoryFacetValue): string {
  return value === null ? "Unknown" : typeof value === "string" ? value : "Allowed for Some or All";
}

export const inventoryFacetFields = ["type", "publisher", "availableTo", "host", "platform", "environmentId"] as const;
