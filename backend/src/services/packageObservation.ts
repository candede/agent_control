import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { isPackageElementType, validatePackageAgentMetadata } from "./packageAgentMetadata.js";
import { operationalLog } from "./telemetry.js";

export function allowlistedPackage(input: unknown): CopilotPackageDetail {
  if (!isRecord(input)) throw new AppError(502, "provider_schema", "Invalid package observation.");
  const row = input;
  if (!isPackageText(row.id) || !row.id || row.id.length > 512 || !isPackageText(row.displayName) || typeof row.isBlocked !== "boolean") {
    throw new AppError(502, "provider_schema", "Package identity or control state is invalid.");
  }
  const result: CopilotPackageDetail = {
    id: row.id, displayName: boundedDescription(row.displayName, 256), isBlocked: row.isBlocked,
    sourceSystem: "graph_packages", authoringTool: null,
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native",
    provenance: {
      id: { sourceSystem: "graph_packages", path: "id", maturity: "ga" },
      displayName: { sourceSystem: "graph_packages", path: "displayName", maturity: "ga" },
    },
  };
  for (const key of ["shortDescription", "longDescription"] as const) {
    const value = row[key];
    if (typeof value !== "string") continue;
    if (!isPackageText(value)) throw new AppError(502, "provider_schema", "Package description text is invalid.");
    result[key] = boundedDescription(value, key === "longDescription" ? 32768 : 4096);
  }
  for (const key of ["type", "publisher", "availableTo", "deployedTo", "platform", "version", "manifestVersion", "sensitivity"] as const) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (!isPackageText(value) || value.length > 4096) throw new AppError(502, "provider_schema", "Package facet or version is invalid or oversized.");
    result[key] = value;
  }
  if (result.platform !== undefined) {
    result.authoringTool = result.platform;
    result.provenance.authoringTool = { sourceSystem: "graph_packages", path: "platform", maturity: "ga" };
  }
  for (const key of ["createdDateTime", "lastModifiedDateTime"] as const) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    result[key] = packageTimestamp(value);
  }
  for (const key of ["manifestId", "appId", "assetId"] as const) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    if (!isPackageText(value) || value.length > 512 || /[\r\n]/.test(value)) {
      throw new AppError(502, "provider_schema", "Package identifiers must be bounded, unmodified strings.");
    }
    result[key] = value;
  }
  for (const key of ["supportedHosts","elementTypes","categories"] as const) {
    const values = row[key];
    if (values === undefined || values === null) continue;
    if (!Array.isArray(values) || values.length > 100) throw new AppError(502, "provider_schema", "Package facet collection is invalid or oversized.");
    result[key] = values.map(value => {
      if (!isPackageText(value) || value.length > 256) throw new AppError(502, "provider_schema", "Package facet value is invalid or oversized.");
      return value;
    });
  }
  for (const key of ["allowedUsersAndGroups","acquireUsersAndGroups"] as const) {
    if (row[key] === undefined) continue;
    if (!Array.isArray(row[key]) || row[key].length > 5000) throw new AppError(502,"provider_schema","Package access collection is invalid or oversized.");
    result[key] = row[key].map((value: unknown) => {
      if (!isRecord(value) || !isPackageText(value.resourceId) || !value.resourceId || value.resourceId.length > 512
        || !isPackageText(value.resourceType) || !value.resourceType || value.resourceType.length > 64) {
        throw new AppError(502,"provider_schema","Package principal identity is invalid.");
      }
      return { resourceId: value.resourceId, resourceType: value.resourceType };
    });
  }
  if (row.elementDetails !== undefined && row.elementDetails !== null) {
    if (!Array.isArray(row.elementDetails) || row.elementDetails.length > 50) {
      throw new AppError(502, "provider_schema", "Package element details are invalid or oversized.");
    }
    result.elementDetails = row.elementDetails.map((group: unknown) => {
      if (!isRecord(group) || !isPackageText(group.elementType) || !group.elementType || group.elementType.length > 256
        || !Array.isArray(group.elements) || group.elements.length > 100) {
        throw new AppError(502, "provider_schema", "Package element group is invalid or oversized.");
      }
      const elementType = group.elementType;
      return {
        elementType,
        elements: group.elements.map((element: unknown) => {
          if (!isRecord(element) || !isPackageText(element.id) || element.id.length > 512
            || !isPackageText(element.definition)) {
            throw new AppError(502, "provider_schema", "Package element identity or definition is invalid.");
          }
          return {
            id: element.id,
            definition: isPackageElementType(elementType, "AgentMetadatas")
              ? validatePackageAgentMetadata(element.definition) : element.definition,
          };
        }),
      };
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 2_048_000) {
    throw new AppError(502, "provider_result_limit", "Package details exceed the saved observation limit; no truncated identity was saved.");
  }
  const omittedCount = Object.keys(row).filter(key => !(key in result) && !key.startsWith("@odata.")).length;
  if (omittedCount) operationalLog("warn", "provider_schema_omission", { provider: "graph_packages", count: omittedCount });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageText(value: unknown): value is string {
  // With Unicode matching, the surrogate range matches only unpaired code units, which JSONB cannot store.
  return typeof value === "string" && !/[\0\uD800-\uDFFF]/u.test(value);
}

function boundedDescription(value: string, maximum: number) {
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

function packageTimestamp(value: unknown) {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(Z|[+-](\d{2}):([0-5]\d))$/.exec(value) : null;
  if (typeof value !== "string" || !match || match[1].startsWith("0000") || Number(match[3]) > 14 || Number(match[3]) === 14 && Number(match[4]) !== 0
    || !Number.isFinite(Date.parse(value))
    || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) {
    throw new AppError(502, "provider_schema", "Package timestamp must be a valid ISO 8601 instant with a timezone.");
  }
  return value;
}