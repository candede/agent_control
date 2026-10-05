import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { parseUnifiedAgentRecordId, type UnifiedAgentTarget } from "../types/unifiedAgents.js";
import { exactUsageText } from "./officialAgentUsageInput.js";
export function parseRecordId(value: string): UnifiedAgentTarget {
  try {
    if (!exactUsageText(value, 10_000)) throw new Error();
    const target = parseUnifiedAgentRecordId(value);
    if (target) {
      const ids = target.source === "canonical" ? [target.agentId]
        : target.source === "graph_packages" ? [target.packageId] : [target.nativeId, ...(target.environmentId ? [target.environmentId] : [])];
      if (ids.every(id => exactUsageText(id, 10_000))) return target;
    }
  } catch { /* Malformed source references cannot reach database lookups. */ }
  throw new AppError(400, "invalid_agent_usage_record", "Select an exact canonical or source-qualified agent reference.");
}
export function associationSourceHash(source: { source: string; normalized_environment_id: string; normalized_native_id: string }) {
  const key = JSON.stringify([source.source, source.normalized_environment_id, source.normalized_native_id]);
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}
