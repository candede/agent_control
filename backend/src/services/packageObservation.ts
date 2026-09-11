import { AppError } from "../errors.js";
import type { CopilotPackageDetail, PackageAccessEntity } from "../types/copilotPackage.js";
import { operationalLog } from "./telemetry.js";

export function allowlistedPackage(input: unknown): CopilotPackageDetail {
  if (!input || typeof input !== "object") throw new AppError(502, "provider_schema", "Invalid package observation.");
  const row = input as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || row.id.length > 512 || typeof row.displayName !== "string" || typeof row.isBlocked !== "boolean") {
    throw new AppError(502, "provider_schema", "Package identity or control state is invalid.");
  }
  const result: Record<string, unknown> = {
    id: row.id, displayName: row.displayName.slice(0,256), isBlocked: row.isBlocked,
    sourceSystem: "graph_packages", authoringTool: typeof row.platform === "string" ? row.platform.slice(0, 4096) : null,
    creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native",
    provenance: {
      id: { sourceSystem: "graph_packages", path: "id", maturity: "ga" },
      displayName: { sourceSystem: "graph_packages", path: "displayName", maturity: "ga" },
      ...(typeof row.platform === "string" ? { authoringTool: { sourceSystem: "graph_packages", path: "platform", maturity: "ga" } } : {}),
    },
  };
  for (const key of ["type","shortDescription","createdDateTime","lastModifiedDateTime","publisher","availableTo","deployedTo","platform","version","manifestVersion","manifestId","appId","assetId","longDescription","sensitivity"]) {
    if (typeof row[key] === "string") result[key] = row[key].slice(0, key === "longDescription" ? 32768 : 4096);
  }
  for (const key of ["supportedHosts","elementTypes","categories"]) {
    if (Array.isArray(row[key])) result[key] = row[key].filter(value => typeof value === "string").slice(0,100).map(value => value.slice(0,256));
  }
  for (const key of ["allowedUsersAndGroups","acquireUsersAndGroups"]) {
    if (row[key] === undefined) continue;
    if (!Array.isArray(row[key]) || row[key].length > 5000) throw new AppError(502,"provider_schema","Package access collection is invalid or oversized.");
    result[key] = row[key].map((value: PackageAccessEntity) => {
      if (typeof value?.resourceId !== "string" || typeof value.resourceType !== "string" || value.resourceId.length > 512) throw new AppError(502,"provider_schema","Package principal identity is invalid.");
      return { resourceId: value.resourceId, resourceType: value.resourceType.slice(0,64) };
    });
  }
  if (Array.isArray(row.elementDetails)) result.elementDetails = row.elementDetails.slice(0,50).flatMap(value => {
    if (typeof value?.elementType !== "string" || !Array.isArray(value.elements)) return [];
    return [{ elementType: value.elementType.slice(0,256), elements: value.elements.slice(0,100).flatMap((element: Record<string, unknown>) =>
      typeof element?.id === "string" && typeof element.definition === "string" ? [{ id: element.id.slice(0,512), definition: element.definition.slice(0,32768) }] : []) }];
  });
  const omittedCount = Object.keys(row).filter(key => !(key in result) && !key.startsWith("@odata.")).length;
  if (omittedCount) operationalLog("warn", "provider_schema_omission", { provider: "graph_packages", count: omittedCount });
  return result as CopilotPackageDetail;
}