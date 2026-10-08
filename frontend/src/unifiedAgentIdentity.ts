import { powerPlatformAgentKey } from "../../backend/src/services/inventoryIdentity";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";
import type { UnifiedAgentRecord } from "./api/client";

export function findUnifiedAgentRecord(
  records: UnifiedAgentRecord[],
  recordId: string,
  legacyEnvironmentId?: string,
): UnifiedAgentRecord | undefined {
  const target = parseUnifiedAgentRecordId(recordId);
  if (target?.source === "canonical") {
    const canonicalId = unifiedAgentRecordId(target);
    const matches = records.filter(record => record.id.startsWith("agent:") && record.id.toLowerCase() === canonicalId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (target?.source === "power_platform") {
    const key = powerPlatformAgentKey(target.environmentId, target.nativeId);
    const matches = records.filter(record =>
      record.powerPlatformResource
      && powerPlatformAgentKey(record.powerPlatformResource.environmentId, record.powerPlatformResource.nativeId) === key);
    return matches.length === 1 ? matches[0] : undefined;
  }

  const packageId = target?.packageId ?? recordId;
  const packages = records.filter(record => (!target && record.id === recordId)
    || record.packages.some(item => item.id === packageId));
  if (packages.length) return packages.length === 1 ? packages[0] : undefined;
  if (target || !legacyEnvironmentId) return undefined;

  const key = powerPlatformAgentKey(legacyEnvironmentId, recordId);
  const resources = records.filter(record => record.powerPlatformResource
    && powerPlatformAgentKey(record.powerPlatformResource.environmentId, record.powerPlatformResource.nativeId) === key);
  return resources.length === 1 ? resources[0] : undefined;
}
