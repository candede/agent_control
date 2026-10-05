import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";
import type { UnifiedAgentRecord } from "./api/client";

export const maximumExplicitAgentReferences = 5_000;
export type UnifiedAgentExportScope = "matching" | "selected";

type AgentExportRecord = {
  id: string;
  packages: ReadonlyArray<Pick<UnifiedAgentRecord["packages"][number], "id">>;
  powerPlatformResource: Pick<NonNullable<UnifiedAgentRecord["powerPlatformResource"]>, "environmentId" | "nativeId"> | null;
};

export function selectedAgentExportReferences(
  records: readonly AgentExportRecord[],
  packageIds: Iterable<string>,
  nativeKeys: Iterable<string>,
): string[] {
  const canonicalBySource = new Map<string, string | null>();
  for (const record of records) {
    const target = parseUnifiedAgentRecordId(record.id);
    const canonical = target?.source === "canonical" ? unifiedAgentRecordId(target) : null;
    const references = record.packages.map(item => unifiedAgentRecordId({ source: "graph_packages", packageId: item.id }));
    if (record.powerPlatformResource) references.push(unifiedAgentRecordId({
      source: "power_platform",
      environmentId: record.powerPlatformResource.environmentId,
      nativeId: record.powerPlatformResource.nativeId,
    }));
    for (const reference of references) {
      canonicalBySource.set(reference, canonicalBySource.has(reference) && canonicalBySource.get(reference) !== canonical ? null : canonical);
    }
  }

  const references = new Set<string>();
  for (const packageId of packageIds) {
    const reference = unifiedAgentRecordId({ source: "graph_packages", packageId });
    parseUnifiedAgentRecordId(reference);
    references.add(canonicalBySource.get(reference) ?? reference);
  }
  for (const key of nativeKeys) {
    const target = parseUnifiedAgentRecordId(key);
    if (!target || target.source === "graph_packages") throw new RangeError("A selected native agent must have an exact canonical or Power Platform reference.");
    const reference = unifiedAgentRecordId(target);
    references.add(canonicalBySource.get(reference) ?? reference);
  }
  if (references.size > maximumExplicitAgentReferences) throw new RangeError("Select at most 5,000 exact source references.");
  return [...references];
}
