import type { CopilotPackage, PackageAccessUpdate, UnifiedAgentRecord } from "./api/client";

export function projectVerifiedAccessScope(
  agent: CopilotPackage,
  update: PackageAccessUpdate,
): CopilotPackage {
  const scope = update.scope === "none" ? "none" : "some";
  return update.target === "availability"
    ? { ...agent, availableTo: scope }
    : { ...agent, deployedTo: scope };
}

export function projectVerifiedAgentMutation(
  record: UnifiedAgentRecord,
  changedIds: ReadonlySet<string>,
  mutation: { isBlocked: boolean } | { accessUpdate: PackageAccessUpdate },
): UnifiedAgentRecord {
  if (!changedIds.size || record.packagesComplete !== false && !record.packages.some(item => changedIds.has(item.id))) return record;
  const packages = record.packages.map(item => !changedIds.has(item.id) ? item
    : "isBlocked" in mutation ? { ...item, isBlocked: mutation.isBlocked }
      : projectVerifiedAccessScope(item, mutation.accessUpdate));
  const columns = { ...record.columns };
  const affected = "isBlocked" in mutation ? ["status", "availability"]
    : [mutation.accessUpdate.target === "availability" ? "availability" : "deployment"];
  for (const column of affected) {
    // A bounded preview cannot prove an aggregate or exclude changed off-preview members.
    if (record.packagesComplete === false) columns[column] = null;
    else delete columns[column];
  }
  return { ...record, packages, columns };
}