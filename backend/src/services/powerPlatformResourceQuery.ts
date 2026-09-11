import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.js";
import {
  powerPlatformResourceTypes,
  type InventoryConnector,
  type InventoryConnectorOperation,
  type InventoryFieldMaturity,
  type InventoryFieldProvenance,
  type InventoryIdentifier,
  type PowerPlatformResource,
  type PowerPlatformResourceDetails,
  type PowerPlatformResourceType,
  type ResourceQueryResult,
} from "../types/powerPlatformInventory.js";
import { sortIdentifiers } from "./inventoryIdentity.js";
import { boundedProviderJson } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";

const resourceQueryEndpoint = "https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01";
const defaultPageSize = 100;
const maximumPages = 50;
const maximumRows = 5_000;
const queryDeadlineMs = 30_000;
const maximumConnectors = 200;
const maximumOperations = 200;

export { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  delay: (delayMs: number) => Promise<unknown>;
};

export type ResourceQueryOptions = {
  signal?: AbortSignal;
  cloud?: "global" | "usgov" | "china";
  expectedTenantId?: string;
  environmentId?: string;
  onProgress?: (progress: { pages: number; observedCount: number; totalRecords: number }) => Promise<void> | void;
};

type ResourceQueryPage = {
  totalRecords?: unknown;
  count?: unknown;
  resultTruncated?: unknown;
  skipToken?: unknown;
  data?: unknown;
};

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maximumDelayMs: 10_000,
  delay,
};

export class PowerPlatformResourceQueryClient {
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy };
  }

  async query(accessToken: string, types: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes, options: ResourceQueryOptions = {}): Promise<ResourceQueryResult> {
    if (options.cloud && options.cloud !== "global") throw new AppError(501, "unsupported_cloud", "Power Platform inventory is implemented only for the documented global-cloud endpoint.");
    const requestedTypes = validateTypes(types);
    const environmentId = validateEnvironmentId(options.environmentId);
    const expectedTenantId = validateExpectedTenantId(options.expectedTenantId);
    const deadlineSignal = AbortSignal.timeout(queryDeadlineMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
    const resources: PowerPlatformResource[] = [];
    const visitedTokens = new Set<string>();
    let skipToken: string | undefined;
    let totalRecords: number | undefined;
    let pages = 0;
    let unknownFieldCount = 0;
    const identities = new Set<string>();

    do {
      if (pages >= maximumPages || resources.length >= maximumRows) {
        throw new AppError(502, "provider_result_limit", "Power Platform inventory exceeded the bounded page or row limit.");
      }
      if (skipToken) {
        if (visitedTokens.has(skipToken)) throw new AppError(502, "provider_schema", "Power Platform inventory returned a repeated continuation token.");
        visitedTokens.add(skipToken);
      }

      const page = await this.requestPage(accessToken, requestedTypes, skipToken, signal, environmentId);
      const parsed = parsePage(page, requestedTypes, environmentId, expectedTenantId);
      pages += 1;
      totalRecords ??= parsed.totalRecords;
      if (parsed.totalRecords !== totalRecords) throw new AppError(502, "provider_schema", "Power Platform inventory changed totalRecords during paging.");
      if (resources.length + parsed.resources.length > maximumRows) throw new AppError(502, "provider_result_limit", "Power Platform inventory exceeded the bounded row limit.");
      for (const resource of parsed.resources) {
        const identity = `${resource.tenantId}\0${resource.type}\0${resource.environmentId ?? ""}\0${resource.nativeId}`;
        if (identities.has(identity)) throw new AppError(502, "provider_schema", "Power Platform inventory returned a duplicate resource identity.");
        identities.add(identity);
        resources.push(resource);
        unknownFieldCount += resource.unknownFieldCount;
      }
      skipToken = parsed.skipToken;
      unknownFieldCount += parsed.unknownFieldCount;
      await options.onProgress?.({ pages, observedCount: resources.length, totalRecords });
    } while (skipToken);

    if (resources.length !== totalRecords) {
      throw new AppError(502, "provider_schema", "Power Platform inventory ended before the documented total was enumerated.");
    }

    return { resources, totalRecords: totalRecords ?? 0, pages, unknownFieldCount };
  }

  private async requestPage(accessToken: string, types: readonly PowerPlatformResourceType[], skipToken: string | undefined, signal: AbortSignal, environmentId?: string): Promise<ResourceQueryPage> {
    const body = {
      TableName: "PowerPlatformResources",
      Clauses: [{
        $type: "where",
        FieldName: "type",
        Operator: "in~",
        Values: types.map(type => `'${type.replaceAll("'", "''")}'`),
      }, ...(environmentId ? [{ $type: "where", FieldName: "properties.environmentId", Operator: "==", Values: [JSON.stringify(environmentId)] }] : [])],
      Options: {
        Top: defaultPageSize,
        Skip: 0,
        ...(skipToken ? { SkipToken: skipToken } : {}),
      },
    };

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      if (signal.aborted) throw signal.reason;
      let response: Response;
      try {
        response = await this.fetcher(resourceQueryEndpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (attempt === this.retryPolicy.maxAttempts) throw error;
        await this.waitForRetry(Math.min(this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs), signal);
        continue;
      }

      if (response.redirected || response.url && new URL(response.url).origin !== new URL(resourceQueryEndpoint).origin) {
        await disposeResponse(response);
        throw new AppError(502, "invalid_provider_link", "Power Platform inventory refused a redirected or foreign-origin response.");
      }
      if (response.ok) {
        try {
          return await boundedProviderJson<ResourceQueryPage>(response);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof AppError || attempt === this.retryPolicy.maxAttempts) throw error;
          await disposeResponse(response);
          await this.waitForRetry(Math.min(this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs), signal);
          continue;
        }
      }
      await disposeResponse(response);
      if (attempt === this.retryPolicy.maxAttempts || (response.status !== 429 && response.status < 500)) {
        throw new AppError(response.status, "provider_error", "Power Platform inventory query failed.");
      }
      await this.waitForRetry(retryAfterMs(response.headers.get("retry-after"), this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs), signal);
    }

    throw new AppError(500, "retry_exhausted", "Power Platform inventory retry attempts were exhausted.");
  }

  private async waitForRetry(delayMs: number, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    let removeAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    try { await Promise.race([this.retryPolicy.delay(delayMs), aborted]); }
    finally { removeAbort(); }
  }
}

function validateEnvironmentId(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory environment scope is invalid.");
  return value;
}

function validateExpectedTenantId(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!validText(value, 128) || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory tenant scope is invalid.");
  return value;
}

function validateTypes(types: readonly PowerPlatformResourceType[]) {
  const allowed = new Set<string>(powerPlatformResourceTypes);
  const unique = [...new Set(types)];
  if (unique.length === 0 || unique.some(type => !allowed.has(type))) throw new AppError(400, "invalid_inventory_scope", "Inventory resource types must use the supported allowlist.");
  return unique;
}

function parsePage(page: unknown, requestedTypes: readonly PowerPlatformResourceType[], expectedEnvironmentId?: string, expectedTenantId?: string) {
  if (!isRecord(page) || !Number.isSafeInteger(page.totalRecords) || (page.totalRecords as number) < 0 || (page.totalRecords as number) > maximumRows || !Number.isSafeInteger(page.count) || (page.count as number) < 0 || (page.count as number) > defaultPageSize || !Array.isArray(page.data) || page.data.length !== page.count) {
    throw new AppError(502, "provider_schema", "Power Platform inventory returned an invalid page shape.");
  }
  const skipToken = page.skipToken === undefined || page.skipToken === null || page.skipToken === ""
    ? undefined
    : typeof page.skipToken === "string" && page.skipToken.length <= 4_096
      ? page.skipToken
      : invalidContinuationToken();
  if (![0, 1, false, true].includes(page.resultTruncated as never)) {
    throw new AppError(502, "provider_schema", "Power Platform inventory returned an invalid truncation marker.");
  }
  const pageTruncated = page.resultTruncated === 1 || page.resultTruncated === true;
  if (pageTruncated && !skipToken) throw new AppError(502, "provider_schema", "Power Platform inventory marked a page truncated without a continuation token.");
  if (!pageTruncated && skipToken || skipToken && page.count === 0) throw new AppError(502, "provider_schema", "Power Platform inventory returned inconsistent continuation metadata.");
  const resources = page.data.map(parseResource);
  const requested = new Set(requestedTypes);
  for (const resource of resources) {
    if (!requested.has(resource.type) || expectedEnvironmentId && resource.environmentId !== expectedEnvironmentId || expectedTenantId && resource.tenantId !== expectedTenantId) {
      throw new AppError(502, "provider_schema", "Power Platform inventory returned data outside the requested tenant, environment, or resource type scope.");
    }
  }
  return {
    totalRecords: page.totalRecords as number,
    resources,
    skipToken,
    unknownFieldCount: Object.keys(page).filter(key => !["totalRecords", "count", "resultTruncated", "skipToken", "data"].includes(key)).length,
  };
}

function parseResource(value: unknown): PowerPlatformResource {
  if (!isRecord(value) || typeof value.tenantId !== "string" || typeof value.name !== "string" || typeof value.type !== "string" || !powerPlatformResourceTypes.includes(value.type as PowerPlatformResourceType)) {
    throw new AppError(502, "provider_schema", "Power Platform inventory returned an invalid resource identity.");
  }
  if (!validText(value.tenantId, 128) || !validText(value.name, 512)) throw new AppError(502, "provider_schema", "Power Platform inventory returned an oversized resource identity.");
  if (value.location !== undefined && value.location !== null && typeof value.location !== "string") {
    throw new AppError(502, "provider_schema", "Power Platform inventory returned an invalid resource location.");
  }
  const type = value.type as PowerPlatformResourceType;
  const context = projectionContext(value.properties, type);
  context.omittedCount += Object.keys(value).filter(key => !["tenantId", "name", "type", "location", "properties"].includes(key)).length;
  const displayName = optionalString(context, "displayName", "properties.displayName", "ga", 512);
  const environmentId = optionalString(context, "environmentId", "properties.environmentId", "ga", 512);
  const createdAt = optionalDate(context, "createdAt", "properties.createdAt", "ga");
  const createdBy = optionalString(context, "createdBy", "properties.createdBy", "ga", 512);
  const lastPublishedAt = optionalDate(context, "lastPublishedAt", "properties.lastPublishedAt", "ga");
  const createdIn = optionalString(context, "createdIn", "properties.createdIn", "ga", 256);
  const propertiesName = optionalString(context, "name", "properties.name", "ga", 512);
  const botId = optionalString(context, "botId", "properties.botId", "ga", 512);
  const identifiers: InventoryIdentifier[] = [
    { kind: "power_platform_resource_id", value: value.name },
    ...(environmentId ? [{ kind: "environment_id" as const, value: environmentId }] : []),
    ...(propertiesName ? [{ kind: "cds_bot_id" as const, value: propertiesName }] : []),
    ...(botId && botId !== propertiesName ? [{ kind: "cds_bot_id" as const, value: botId }] : []),
    ...identifier(context, "entraAppId", "entra_app_id"),
    ...identifier(context, "entraAgentId", "entra_agent_id"),
    ...identifier(context, "entraAgentBlueprintId", "entra_blueprint_id"),
  ];
  const details = projectDetails(context, type);
  const authoringTool = deriveAuthoringTool(type, createdIn);
  const agentKind = deriveAgentKind(type, createdIn, details.subType);
  const lifecycle = deriveLifecycle(type, context.properties.lastPublishedAt, Object.hasOwn(context.properties, "lastPublishedAt"), lastPublishedAt);
  context.provenance.sourceSystem = { sourceSystem: "power_platform", path: "PowerPlatformResources", maturity: "ga" };
  context.provenance.authoringTool = { sourceSystem: "power_platform", path: authoringTool && type === "microsoft.copilotstudio/agents" ? "properties.createdIn" : authoringTool ? "type" : "not_supplied", maturity: "ga" };
  context.provenance.agentKind = { sourceSystem: "power_platform", path: details.subType ? "properties.subType" : type === "microsoft.copilotstudio/agents" && agentKind !== "agent" ? "properties.createdIn" : "type", maturity: "ga" };
  context.provenance.lifecycle = { sourceSystem: "power_platform", path: type === "microsoft.copilotstudio/agents" && Object.hasOwn(context.properties, "lastPublishedAt") ? "properties.lastPublishedAt" : "type", maturity: "ga" };
  context.provenance.creatorType = { sourceSystem: "power_platform", path: "not_supplied", maturity: "ga" };
  context.provenance.identityConfidence = { sourceSystem: "power_platform", path: "name", maturity: "ga" };
  if (context.omittedCount) operationalLog("warn", "provider_schema_omission", { provider: "power_platform", count: context.omittedCount });
  return {
    tenantId: value.tenantId,
    nativeId: value.name,
    type,
    location: type !== "microsoft.powerplatformconnector/connectors" && typeof value.location === "string" ? value.location.slice(0, 256) : null,
    displayName,
    environmentId,
    createdAt,
    createdBy,
    lastPublishedAt,
    sourceSystem: "power_platform",
    authoringTool,
    creatorType: "unknown",
    agentKind,
    lifecycle,
    identityConfidence: identifiers.length > 1 ? "exact_native" : "partial",
    identifiers: sortIdentifiers(identifiers),
    provenance: context.provenance,
    details,
    unknownFieldCount: context.omittedCount,
  };
}

const sharedProperties = fields("ga", "displayName", "createdAt", "createdBy");
const ownedResourceProperties = fields("ga", "ownerId", "environmentId", "lastModifiedAt", "lastModifiedBy");
const connectorUsageProperties = fields("preview", "powerPlatformConnectors");
const resourcePropertySchemas: Record<PowerPlatformResourceType, ReadonlyMap<string, InventoryFieldMaturity>> = {
  "microsoft.powerapps/canvasapps": schema(sharedProperties, ownedResourceProperties, fields("ga", "isQuarantined"), connectorUsageProperties),
  "microsoft.powerapps/modeldrivenapps": schema(sharedProperties, fields("ga", "environmentId", "lastModifiedAt", "lastModifiedBy", "isQuarantined", "appModuleId", "logicalName"), connectorUsageProperties),
  "microsoft.powerapps/codeapps": schema(sharedProperties, ownedResourceProperties, fields("ga", "isQuarantined", "subType")),
  "microsoft.powerapps/apps": schema(sharedProperties, ownedResourceProperties, fields("ga", "isQuarantined", "subType")),
  "microsoft.powerautomate/cloudflows": schema(sharedProperties, ownedResourceProperties, fields("ga", "workflowEntityId"), connectorUsageProperties, fields("preview", "trigger", "triggerOperation")),
  "microsoft.powerautomate/agentflows": schema(sharedProperties, ownedResourceProperties, fields("ga", "workflowEntityId"), connectorUsageProperties, fields("preview", "trigger", "triggerOperation")),
  "microsoft.powerautomate/m365agentflows": schema(sharedProperties, ownedResourceProperties, fields("ga", "workflowEntityId"), connectorUsageProperties, fields("preview", "trigger", "triggerOperation")),
  "microsoft.copilotstudio/agents": schema(sharedProperties, ownedResourceProperties, fields("ga", "lastPublishedAt", "createdIn", "schemaName", "name", "botId", "entraAppId", "entraAgentId", "entraAgentBlueprintId"), fields("preview", "isQuarantined", "quarantinedAt", "isManaged", "orchestration", "model", "authentication", "channels", "capabilitiesCounts", "IsWebSearchEnabledForKnowledge"), connectorUsageProperties),
  "microsoft.powerplatformconnector/connectors": schema(fields("ga", "displayName"), fields("preview", "connectorId", "description", "publisher", "tier", "releaseTag", "isDeprecated", "operations")),
  "microsoft.powerplatform/environments": schema(sharedProperties, fields("ga", "environmentType", "isManaged", "environmentGroup", "environmentGroupId", "lastModifiedAt")),
  "microsoft.powerplatform/environmentgroups": schema(sharedProperties, fields("ga", "description", "lastModifiedAt")),
};

type ProjectionContext = {
  properties: Record<string, unknown>;
  schema: ReadonlyMap<string, InventoryFieldMaturity>;
  provenance: Record<string, InventoryFieldProvenance>;
  omittedCount: number;
  capabilityDetailsTruncated: boolean;
  retainedOperations: number;
};

function projectionContext(value: unknown, type: PowerPlatformResourceType): ProjectionContext {
  const propertySchema = resourcePropertySchemas[type];
  if (value === undefined || value === null) return { properties: {}, schema: propertySchema, provenance: {}, omittedCount: 0, capabilityDetailsTruncated: false, retainedOperations: 0 };
  if (!isRecord(value)) return { properties: {}, schema: propertySchema, provenance: {}, omittedCount: 1, capabilityDetailsTruncated: false, retainedOperations: 0 };
  return {
    properties: value,
    schema: propertySchema,
    provenance: {},
    omittedCount: Object.keys(value).filter(key => !propertySchema.has(key)).length,
    capabilityDetailsTruncated: false,
    retainedOperations: 0,
  };
}

function projectDetails(context: ProjectionContext, type: PowerPlatformResourceType): PowerPlatformResourceDetails {
  const details: PowerPlatformResourceDetails = {};
  assign(details, "ownerId", optionalString(context, "ownerId", "properties.ownerId", "ga", 512));
  assign(details, "lastModifiedAt", optionalDate(context, "lastModifiedAt", "properties.lastModifiedAt", "ga"));
  assign(details, "lastModifiedBy", optionalString(context, "lastModifiedBy", "properties.lastModifiedBy", "ga", 512));
  assign(details, "isQuarantined", optionalBoolean(context, "isQuarantined", "properties.isQuarantined", maturity(context, "isQuarantined")));
  assign(details, "quarantinedAt", optionalDate(context, "quarantinedAt", "properties.quarantinedAt", "preview"));
  assign(details, "isManaged", optionalBoolean(context, "isManaged", "properties.isManaged", maturity(context, "isManaged")));
  for (const key of ["schemaName", "appModuleId", "logicalName", "subType", "workflowEntityId", "trigger", "triggerOperation", "environmentType", "environmentGroup", "environmentGroupId", "connectorId", "publisher", "tier", "releaseTag", "orchestration", "model", "authentication"] as const) {
    assign(details, key, optionalString(context, key, `properties.${key}`, maturity(context, key), 512));
  }
  assign(details, "description", optionalString(context, "description", "properties.description", maturity(context, "description"), 16_384));
  assign(details, "isDeprecated", optionalBoolean(context, "isDeprecated", "properties.isDeprecated", "preview"));
  assign(details, "isWebSearchEnabledForKnowledge", optionalBoolean(context, "IsWebSearchEnabledForKnowledge", "properties.IsWebSearchEnabledForKnowledge", "preview"));
  const channels = optionalStringArray(context, "channels", "properties.channels", "preview", 50);
  if (channels) details.channels = channels;
  const connectorKey = type === "microsoft.powerplatformconnector/connectors" ? "operations" : "powerPlatformConnectors";
  const supportsConnectorDetails = context.schema.has(connectorKey);
  const connectorDetailsSupplied = supportsConnectorDetails && Object.hasOwn(context.properties, connectorKey) && context.properties[connectorKey] !== null;
  const connectors = !supportsConnectorDetails ? undefined : connectorKey === "operations" ? connectorResource(context) : resourceConnectors(context);
  if (connectors !== undefined) details.connectors = connectors;
  const counts = context.schema.has("capabilitiesCounts") && isRecord(context.properties.capabilitiesCounts) ? context.properties.capabilitiesCounts : undefined;
  if (context.properties.capabilitiesCounts !== undefined && !counts) context.omittedCount += 1;
  if (counts) {
    const connectorCount = safeCount(counts.distinctPowerPlatformConnectors);
    const operationCount = safeCount(counts.distinctPowerPlatformConnectorsOperations);
    if (connectorCount !== undefined) details.distinctPowerPlatformConnectors = connectorCount;
    if (operationCount !== undefined) details.distinctPowerPlatformConnectorsOperations = operationCount;
    context.provenance.capabilityCounts = { sourceSystem: "power_platform", path: "properties.capabilitiesCounts", maturity: "preview" };
    const retainedConnectors = details.connectors?.length ?? 0;
    const retainedOperations = details.connectors?.reduce((sum, connector) => sum + (connector.operations?.length ?? 0), 0) ?? 0;
    if (connectorCount !== undefined && connectorCount > retainedConnectors || operationCount !== undefined && operationCount > retainedOperations) details.capabilityDetailsTruncated = true;
    context.omittedCount += Object.keys(counts).filter(key => !["distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations"].includes(key)).length;
  }
  if (context.capabilityDetailsTruncated) details.capabilityDetailsTruncated = true;
  if (supportsConnectorDetails) details.connectorDetailsStatus = !connectorDetailsSupplied ? "not_supplied" : details.capabilityDetailsTruncated ? "partial" : "complete";
  return details;
}

function connectorResource(context: ProjectionContext): InventoryConnector[] | undefined {
  const value = context.properties.operations;
  if (value === undefined || value === null) return undefined;
  const connectorId = typeof context.properties.connectorId === "string" ? context.properties.connectorId.slice(0, 512) : "catalog";
  const operations = parseOperations(context, value, "properties.operations", true);
  return operations === undefined ? undefined : [{ connectorId, operations }];
}

function resourceConnectors(context: ProjectionContext): InventoryConnector[] | undefined {
  const value = context.properties.powerPlatformConnectors;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return undefined; }
  if (value.length > maximumConnectors) { context.omittedCount += value.length - maximumConnectors; context.capabilityDetailsTruncated = true; }
  const connectors = value.slice(0, maximumConnectors).flatMap((entry, index) => {
    if (!isRecord(entry) || !validText(entry.connectorId, 512)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return []; }
    context.omittedCount += Object.keys(entry).filter(key => !["connectorId", "operations"].includes(key)).length;
    const operations = parseOperations(context, entry.operations, `properties.powerPlatformConnectors[${index}].operations`, false);
    return [{ connectorId: entry.connectorId, ...(operations === undefined ? {} : { operations }) }];
  });
  context.provenance.connectors = { sourceSystem: "power_platform", path: "properties.powerPlatformConnectors", maturity: "preview" };
  return connectors;
}

function parseOperations(context: ProjectionContext, value: unknown, path: string, catalog: boolean) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return undefined; }
  const remaining = Math.max(maximumOperations - context.retainedOperations, 0);
  if (value.length > remaining) { context.omittedCount += value.length - remaining; context.capabilityDetailsTruncated = true; }
  const operations = value.slice(0, remaining).flatMap(entry => {
    if (!isRecord(entry) || !validText(entry.operationId, 512)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return []; }
    const operation: InventoryConnectorOperation = { operationId: entry.operationId };
    for (const key of catalog ? ["displayName", "description", "method"] as const : ["usedAs", "whenCanBeUsed", "connectionProvider"] as const) {
      if (typeof entry[key] === "string") operation[key] = entry[key].slice(0, key === "description" ? 1_024 : 512);
      else if (entry[key] !== undefined && entry[key] !== null) context.omittedCount += 1;
    }
    if (!catalog) for (const key of ["isEnabled", "requiresEndUserConsent"] as const) {
      if (typeof entry[key] === "boolean") operation[key] = entry[key];
      else if (entry[key] !== undefined && entry[key] !== null) context.omittedCount += 1;
    }
    context.omittedCount += Object.keys(entry).filter(key => !["operationId", "displayName", "description", "method", "usedAs", "isEnabled", "requiresEndUserConsent", "whenCanBeUsed", "connectionProvider"].includes(key)).length;
    return [operation];
  });
  context.retainedOperations += operations.length;
  context.provenance.connectors = { sourceSystem: "power_platform", path, maturity: "preview" };
  return operations;
}

function identifier(context: ProjectionContext, property: string, kind: InventoryIdentifier["kind"]): InventoryIdentifier[] {
  const value = optionalString(context, property, `properties.${property}`, "ga", 512);
  return value ? [{ kind, value }] : [];
}

function optionalString(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity, maximumLength: number) {
  if (!context.schema.has(property)) return null;
  const value = context.properties[property];
  if (value === undefined || value === null) return null;
  if (!validText(value, maximumLength)) { context.omittedCount += 1; return null; }
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return value.slice(0, maximumLength);
}

function optionalDate(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity) {
  const value = optionalString(context, property, path, fieldMaturity, 64);
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) { context.omittedCount += 1; delete context.provenance[property]; return null; }
  return date.toISOString();
}

function optionalBoolean(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity) {
  if (!context.schema.has(property)) return undefined;
  const value = context.properties[property];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") { context.omittedCount += 1; return undefined; }
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return value;
}

function optionalStringArray(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity, limit: number) {
  if (!context.schema.has(property)) return undefined;
  const value = context.properties[property];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { context.omittedCount += 1; return undefined; }
  const retained = value.slice(0, limit).flatMap(entry => typeof entry === "string" && entry.length <= 512 ? [entry] : []);
  context.omittedCount += value.length - retained.length;
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return retained;
}

function deriveAuthoringTool(type: PowerPlatformResourceType, createdIn: string | null) {
  if (type === "microsoft.copilotstudio/agents") return createdIn === "Copilot Studio" || createdIn === "Microsoft 365 Copilot Agent Builder" ? createdIn : null;
  if (type.startsWith("microsoft.powerapps/")) return "Power Apps";
  if (type === "microsoft.powerautomate/cloudflows" || type === "microsoft.powerautomate/agentflows") return "Power Automate";
  return null;
}

function deriveAgentKind(type: PowerPlatformResourceType, createdIn: string | null, subType?: string) {
  if (type === "microsoft.copilotstudio/agents") return createdIn === "Microsoft 365 Copilot Agent Builder" ? "agent_builder_agent" : createdIn === "Copilot Studio" ? "copilot_studio_agent" : "agent";
  if (type === "microsoft.powerautomate/agentflows") return "agent_flow";
  if (type === "microsoft.powerautomate/m365agentflows") return "workflow_agent_flow";
  if (type === "microsoft.powerapps/codeapps") return subType === "vibeApp" ? "vibe_app" : "code_app";
  if (type === "microsoft.powerapps/apps") return "app_builder_app";
  return "not_agent";
}

function deriveLifecycle(type: PowerPlatformResourceType, rawLastPublishedAt: unknown, supplied: boolean, lastPublishedAt: string | null): PowerPlatformResource["lifecycle"] {
  if (type === "microsoft.powerapps/modeldrivenapps") return "published";
  if (type !== "microsoft.copilotstudio/agents") return "not_applicable";
  if (lastPublishedAt) return "published";
  if (supplied && (rawLastPublishedAt === null || rawLastPublishedAt === "")) return "draft";
  return "unknown";
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined) {
  if (value !== null && value !== undefined) target[key] = value;
}

function maturity(context: ProjectionContext, property: string): InventoryFieldMaturity {
  return context.schema.get(property) ?? "ga";
}

function fields(fieldMaturity: InventoryFieldMaturity, ...properties: string[]) {
  return new Map(properties.map(property => [property, fieldMaturity] as const));
}

function schema(...parts: ReadonlyMap<string, InventoryFieldMaturity>[]) {
  return new Map(parts.flatMap(part => [...part]));
}

function retryAfterMs(value: string | null, fallbackMs: number, maximumMs: number) {
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(Math.max(Number(value) * 1_000, 0), maximumMs);
  if (value !== null) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maximumMs);
  }
  return Math.min(Math.max(fallbackMs, 0), maximumMs);
}

async function disposeResponse(response: Response) {
  try { await response.body?.cancel(); } catch { /* The failed provider stream is already unusable. */ }
}

function safeCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function validText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function invalidContinuationToken(): never {
  throw new AppError(502, "provider_schema", "Power Platform inventory returned an invalid continuation token.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}