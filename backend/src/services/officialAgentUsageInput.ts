import { AppError } from "../errors.js";
import type { CandidateAgentUsageMutation } from "../types/officialReportApi.js";

const invalid = () => new AppError(400, "invalid_agent_usage", "Supply an exact confirmed report identity and source-qualified target.");
function uuid(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_identifier", "Expected a UUID.");
  return value;
}
export function exactUsageText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
export function officialAgentUsageMutation(value: unknown): CandidateAgentUsageMutation {
  const input = object(value, ["selectionId", "reportSetId", "usageRevision", "inventoryRevision", "reportAgentId", "confirmed", "target"]);
  if (input.confirmed !== true || !exactUsageText(input.reportAgentId)
    || typeof input.usageRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.usageRevision)
    || typeof input.inventoryRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.inventoryRevision)) throw invalid();
  let target: CandidateAgentUsageMutation["target"];
  if ("target" in input) {
    const source = object(input.target, ["source", "packageId", "nativeId", "environmentId"]);
    if (source.source === "graph_packages") {
      object(source, ["source", "packageId"]);
      if (!exactUsageText(source.packageId)) throw invalid();
      target = { source: source.source, packageId: source.packageId };
    } else if (source.source === "power_platform") {
      object(source, ["source", "nativeId", "environmentId"]);
      if (!exactUsageText(source.nativeId) || source.environmentId !== null && !exactUsageText(source.environmentId)) throw invalid();
      target = { source: source.source, nativeId: source.nativeId, environmentId: source.environmentId };
    } else throw invalid();
  }
  return { selectionId: uuid(input.selectionId), reportSetId: uuid(input.reportSetId),
    usageRevision: input.usageRevision, inventoryRevision: input.inventoryRevision, reportAgentId: input.reportAgentId,
    confirmed: true, ...(target ? { target } : {}) };
}
