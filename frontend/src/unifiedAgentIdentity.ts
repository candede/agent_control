import { parseUnifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";
import type { UnifiedAgentRecord } from "./api/client";

export function findUnifiedAgentRecord(
  records: UnifiedAgentRecord[],
  recordId: string,
  legacyEnvironmentId?: string,
): UnifiedAgentRecord | undefined {
  const exact = records.filter(record => record.id === recordId);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;

  const target = parseUnifiedAgentRecordId(recordId);
  if (target?.source === "canonical") return undefined;
  if (target?.source === "power_platform") {
    const matches = records.filter(record =>
      record.powerPlatformResource?.nativeId === target.nativeId
      && record.powerPlatformResource.environmentId === target.environmentId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  const packageId = target?.packageId ?? recordId;
  const packages = records.filter(record => record.packages.some(item => item.id === packageId));
  if (packages.length) return packages.length === 1 ? packages[0] : undefined;
  if (target || !legacyEnvironmentId) return undefined;

  const resources = records.filter(record =>
    record.powerPlatformResource?.nativeId === recordId
    && record.powerPlatformResource.environmentId === legacyEnvironmentId);
  return resources.length === 1 ? resources[0] : undefined;
}
