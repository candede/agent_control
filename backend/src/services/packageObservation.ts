import { AppError } from "../errors.js";
import { isPackageAccessEntity, isPackageId, packageAccessCollectionLimit, packageObservationLimits, type CopilotPackageDetail } from "../types/copilotPackage.js";
import { isPackageElementType, validatePackageAgentMetadata } from "./packageAgentMetadata.js";
import { operationalLog } from "./telemetry.js";
import { isInventoryTimestamp } from "../types/inventoryTimestamp.js";
import { parseProviderContractJson } from "./providerJson.js";

const descriptionFields = ["shortDescription", "longDescription"] as const;
const facetFields = ["type", "publisher", "availableTo", "deployedTo", "platform", "version", "manifestVersion", "sensitivity"] as const;
const timestampFields = ["createdDateTime", "lastModifiedDateTime"] as const;
const identifierFields = ["manifestId", "appId", "assetId"] as const;
const facetCollections = ["supportedHosts", "elementTypes", "categories"] as const;
const accessCollections = ["allowedUsersAndGroups", "acquireUsersAndGroups"] as const;

export function parsePackageObservationJson(text: string): unknown {
  const packageFields = ["@odata.type", "id", "displayName", "isBlocked", ...descriptionFields, ...facetFields,
    ...timestampFields, ...identifierFields, ...facetCollections, ...accessCollections, "elementDetails"];
  const arrays = { elementDetails: "group", allowedUsersAndGroups: "principal", acquireUsersAndGroups: "principal" };
  return parseProviderContractJson(text, {
    root: { fields: ["value", "@odata.count", "@odata.nextLink", ...packageFields], arrays: { ...arrays, value: "package" } },
    package: { fields: packageFields, arrays },
    group: { fields: ["elementType", "elements"], arrays: { elements: "element" } },
    element: { fields: ["id", "definition"] },
    principal: { fields: ["resourceId", "resourceType"] },
  }, 7);
}

export function allowlistedPackage(input: unknown): CopilotPackageDetail {
  const row = observationRecord(input);
  if (row["@odata.type"] !== undefined && row["@odata.type"] !== "#microsoft.graph.copilotPackage"
    && row["@odata.type"] !== "#microsoft.graph.copilotPackageDetail") {
    throw new AppError(502, "provider_schema", "Package observation declared an unsupported resource type.");
  }
  if (!isPackageId(row.id) || !isPackageText(row.displayName) || typeof row.isBlocked !== "boolean") {
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
  for (const key of descriptionFields) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (!isPackageText(value)) throw new AppError(502, "provider_schema", "Package description text is invalid.");
    result[key] = boundedDescription(value, key === "longDescription" ? 32768 : 4096);
  }
  for (const key of facetFields) {
    const value = row[key];
    if (value === null && (key === "availableTo" || key === "deployedTo")) {
      throw new AppError(502, "provider_schema", "Package access scope must be a complete string when supplied.");
    }
    if (value === undefined || value === null) continue;
    if (!isPackageText(value) || value.length > 4096) throw new AppError(502, "provider_schema", "Package facet or version is invalid or oversized.");
    result[key] = value;
  }
  if (result.platform !== undefined) {
    result.authoringTool = result.platform;
    result.provenance.authoringTool = { sourceSystem: "graph_packages", path: "platform", maturity: "ga" };
  }
  for (const key of timestampFields) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    result[key] = packageTimestamp(value);
  }
  for (const key of identifierFields) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    if (!isPackageText(value) || value.length > 512 || /[\r\n]/.test(value)) {
      throw new AppError(502, "provider_schema", "Package identifiers must be bounded, unmodified strings.");
    }
    result[key] = value;
  }
  for (const key of facetCollections) {
    const values = row[key];
    if (values === undefined || values === null) continue;
    if (!Array.isArray(values) || values.length > 100) throw new AppError(502, "provider_schema", "Package facet collection is invalid or oversized.");
    result[key] = observationArray(values).map(value => {
      if (!isPackageText(value) || value.length > 256) throw new AppError(502, "provider_schema", "Package facet value is invalid or oversized.");
      return value;
    });
  }
  for (const key of accessCollections) {
    if (row[key] === undefined) continue;
    if (!Array.isArray(row[key]) || row[key].length > packageAccessCollectionLimit) throw new AppError(502,"provider_schema","Package access collection is invalid or oversized.");
    const values = row[key];
    result[key] = observationArray(values).map((value: unknown) => {
      if (!isPackageAccessEntity(value)) {
        throw new AppError(502,"provider_schema","Package principal identity is invalid.");
      }
      return { resourceId: value.resourceId, resourceType: value.resourceType };
    });
  }
  if (row.elementDetails !== undefined && row.elementDetails !== null) {
    if (!Array.isArray(row.elementDetails) || row.elementDetails.length > packageObservationLimits.elementGroups) {
      throw new AppError(502, "provider_schema", "Package element details are invalid or oversized.");
    }
    const groups = row.elementDetails;
    let elementBytes = 0;
    result.elementDetails = observationArray(groups).map((inputGroup: unknown) => {
      const group = observationRecord(inputGroup);
      if (!isPackageText(group.elementType) || !group.elementType || group.elementType.length > 256
        || !Array.isArray(group.elements) || group.elements.length > packageObservationLimits.elementsPerGroup) {
        throw new AppError(502, "provider_schema", "Package element group is invalid or oversized.");
      }
      const elementType = group.elementType;
      const elements = group.elements;
      return {
        elementType,
        elements: observationArray(elements).map((inputElement: unknown) => {
          const element = observationRecord(inputElement);
          if (!isPackageText(element.id) || element.id.length > 512
            || !isPackageText(element.definition)) {
            throw new AppError(502, "provider_schema", "Package element identity or definition is invalid.");
          }
          elementBytes += Buffer.byteLength(element.definition, "utf8");
          if (elementBytes > packageObservationLimits.bytes) {
            throw new AppError(502, "provider_result_limit", "Package details exceed the saved observation limit; no truncated identity was saved.");
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
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > packageObservationLimits.bytes) {
    throw new AppError(502, "provider_result_limit", "Package details exceed the saved observation limit; no truncated identity was saved.");
  }
  const knownFields = new Set([
    ...Object.keys(result), ...descriptionFields, ...facetFields, ...timestampFields, ...identifierFields,
    ...facetCollections, ...accessCollections, "elementDetails",
  ]);
  const omittedCount = Object.keys(row).filter(key => !knownFields.has(key) && !key.startsWith("@odata.")).length;
  if (omittedCount) operationalLog("warn", "provider_schema_omission", { provider: "graph_packages", count: omittedCount });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observationRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AppError(502, "provider_schema", "Invalid package observation object.");
  const result: Record<string, unknown> = Object.setPrototypeOf({}, null);
  for (const key of Object.getOwnPropertyNames(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, "value")) {
      throw new AppError(502, "provider_schema", "Package observations must contain own data properties.");
    }
    result[key] = property.value;
  }
  return result;
}

function observationArray(values: unknown[]): unknown[] {
  return Array.from({ length: values.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(values, index);
    if (!property || !Object.hasOwn(property, "value")) {
      throw new AppError(502, "provider_schema", "Package collections must contain own data entries.");
    }
    return property.value;
  });
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
  if (!isInventoryTimestamp(value)) {
    throw new AppError(502, "provider_schema", "Package timestamp must be a valid ISO 8601 instant with a timezone.");
  }
  return value;
}