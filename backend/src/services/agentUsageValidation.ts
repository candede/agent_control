import { AppError } from "../errors.js";
import type { AgentUsageAssociationInput, AgentUsageAssociationRemoval, AgentUsageTarget } from "../types/agentUsage.js";

export type AgentUsageCandidateQuery = { search?: string; offset: number; limit: number };

export function agentUsageCandidateQuery(value: Record<string, unknown>): AgentUsageCandidateQuery {
  fields(value, ["search", "offset", "limit"]);
  const search = value.search === undefined ? undefined : boundedText(value.search, "search", 256, true);
  const integer = (input: unknown, fallback: number, minimum: number, maximum: number) => {
    if (input === undefined) return fallback;
    if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/.test(input)) invalid("Candidate paging requires bounded whole numbers.");
    const number = Number(input);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid("Candidate paging is outside the supported range.");
    return number;
  };
  return { ...(search?.trim() ? { search: search.trim() } : {}),
    offset: integer(value.offset, 0, 0, 100_000), limit: integer(value.limit, 50, 1, 250) };
}

export function agentUsageAssociationInput(value: unknown): AgentUsageAssociationInput {
  fields(value, [...commonFields, "target"]);
  return { ...removalFields(value), target: usageTarget(value.target) };
}

export function agentUsageAssociationRemoval(value: unknown): AgentUsageAssociationRemoval {
  fields(value, commonFields);
  return removalFields(value);
}

const commonFields = ["reportSetId", "reportAgentId", "expectedInventoryRevision", "expectedUsageRevision", "confirmed"];

function removalFields(value: Record<string, unknown>): AgentUsageAssociationRemoval {
  if (value.confirmed !== true) invalid("Explicit confirmation of this reporting-only association is required.");
  if (typeof value.reportSetId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.reportSetId)) {
    invalid("Select an exact accepted report set ID.");
  }
  const revision = (input: unknown) => {
    if (typeof input !== "string" || !/^[a-f0-9]{64}$/i.test(input)) invalid("A current inventory and usage revision are required.");
    return input.toLowerCase();
  };
  return {
    reportSetId: value.reportSetId.toLowerCase(),
    reportAgentId: boundedText(value.reportAgentId, "reportAgentId", 512),
    expectedInventoryRevision: revision(value.expectedInventoryRevision),
    expectedUsageRevision: revision(value.expectedUsageRevision),
    confirmed: true,
  };
}

function usageTarget(value: unknown): AgentUsageTarget {
  if (!isRecord(value)) invalid("Select one exact source-qualified inventory target.");
  if (value.source === "graph_packages") {
    fields(value, ["source", "packageId"]);
    return { source: value.source, packageId: boundedText(value.packageId, "packageId", 512) };
  }
  if (value.source === "power_platform") {
    fields(value, ["source", "nativeId", "environmentId"]);
    return { source: value.source, nativeId: boundedText(value.nativeId, "nativeId", 512),
      environmentId: value.environmentId === null ? null : boundedText(value.environmentId, "environmentId", 512) };
  }
  return invalid("Usage associations require a Graph package or Power Platform native target, not a reported app ID or canonical UUID.");
}

function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid("Usage association input contains unsupported fields.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
}

function boundedText(value: unknown, name: string, maximum: number, empty = false) {
  // Unicode mode rejects lone surrogates without rejecting valid supplementary characters.
  if (typeof value !== "string" || value.length > maximum || (!empty && (!value.trim() || value !== value.trim()))
    || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) invalid(`${name} must be bounded, exact Unicode text without control characters.`);
  return value;
}

function invalid(message: string): never {
  throw new AppError(400, "invalid_agent_usage_input", message);
}
