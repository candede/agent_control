import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { isPackageElementType, validatePackageAgentMetadata } from "./packageAgentMetadata.js";
import { operationalLog } from "./telemetry.js";

export function allowlistedPackage(input: unknown): CopilotPackageDetail {
  if (!isRecord(input)) throw new AppError(502, "provider_schema", "Invalid package observation.");
  const row = input;
  if (typeof row.id !== "string" || !row.id || row.id.length > 512 || typeof row.displayName !== "string" || typeof row.isBlocked !== "boolean") {
    throw new AppError(502, "provider_schema", "Package identity or control state is invalid.");
  }
  const result: CopilotPackageDetail = {
    id: row.id, displayName: row.displayName.slice(0,256), isBlocked: row.isBlocked,
    sourceSystem: "graph_packages", authoringTool: typeof row.platform === "string" ? row.platform.slice(0, 4096) : null,
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native",
    provenance: {
      id: { sourceSystem: "graph_packages", path: "id", maturity: "ga" },
      displayName: { sourceSystem: "graph_packages", path: "displayName", maturity: "ga" },
      ...(typeof row.platform === "string" ? { authoringTool: { sourceSystem: "graph_packages", path: "platform", maturity: "ga" } } : {}),
    },
  };
  for (const key of ["type","shortDescription","createdDateTime","lastModifiedDateTime","publisher","availableTo","deployedTo","platform","version","manifestVersion","longDescription","sensitivity"] as const) {
    if (typeof row[key] === "string") result[key] = row[key].slice(0, key === "longDescription" ? 32768 : 4096);
  }
  for (const key of ["manifestId", "appId", "assetId"] as const) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value)) {
      throw new AppError(502, "provider_schema", "Package identifiers must be bounded, unmodified strings.");
    }
    result[key] = value;
  }
  for (const key of ["supportedHosts","elementTypes","categories"] as const) {
    if (Array.isArray(row[key])) result[key] = row[key].filter(value => typeof value === "string").slice(0,100).map(value => value.slice(0,256));
  }
  for (const key of ["allowedUsersAndGroups","acquireUsersAndGroups"] as const) {
    if (row[key] === undefined) continue;
    if (!Array.isArray(row[key]) || row[key].length > 5000) throw new AppError(502,"provider_schema","Package access collection is invalid or oversized.");
    result[key] = row[key].map((value: unknown) => {
      if (!isRecord(value) || typeof value.resourceId !== "string" || !value.resourceId || value.resourceId.length > 512
        || typeof value.resourceType !== "string" || !value.resourceType || value.resourceType.length > 64) {
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
      if (!isRecord(group) || typeof group.elementType !== "string" || !group.elementType || group.elementType.length > 256
        || !Array.isArray(group.elements) || group.elements.length > 100) {
        throw new AppError(502, "provider_schema", "Package element group is invalid or oversized.");
      }
      const elementType = group.elementType;
      return {
        elementType,
        elements: group.elements.map((element: unknown) => {
          if (!isRecord(element) || typeof element.id !== "string" || element.id.length > 512
            || typeof element.definition !== "string") {
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