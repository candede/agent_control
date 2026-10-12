import { AppError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import {
  defenderHuntingTemplateIds,
  defenderHuntingTemplates,
  defenderHuntingFieldAvailable,
  isDefenderHuntingRequestId,
  type DefenderAgentActivityRow,
  type DefenderAgentInventoryRow,
  type DefenderHuntingFilters,
  type DefenderHuntingQueryResult,
  type DefenderHuntingRow,
  type DefenderHuntingTemplateId,
} from "../types/defenderHunting.js";
import { boundedProviderText, parseProviderContractJson } from "./providerJson.js";

const endpoint = "https://graph.microsoft.com/v1.0/security/runHuntingQuery";
const maximumAttempts = 3;
const maximumRequestBudgetMs = 30_000;
const maximumResponseBytes = 2_000_000;
const maximumStoredRows = 200;
export const defenderHuntingMaximumWindowMs = 7 * 24 * 60 * 60 * 1000;
export const defenderHuntingQualificationMaximumWindowMs = 60 * 60 * 1000;

type Dependencies = {
  fetch: typeof fetch;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now?: () => number;
  requestTimeoutMs?: number;
};

type QueryOptions = {
  signal?: AbortSignal;
  correlationId?: string;
  tenantId?: string;
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
  assertCurrent?: () => void;
  onResponse?: (providerRequestId: string | null, signal: AbortSignal) => Promise<void>;
};

const defaultDependencies: Dependencies = {
  fetch,
  wait: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
  random: Math.random,
  now: Date.now,
};

const inventoryColumns = [
  "ObservationTime", "AgentId", "AgentName", "Platform", "AgentDescription", "Version", "SourceAgentId",
  "EntraAgentId", "EntraBlueprintId", "ObservabilityId", "PublishedStatus", "LifecycleStatus", "Availability",
  "CreatedDateTime", "LastPublishedDateTime", "LastUpdatedDateTime", "InstanceCount", "Model", "OwnerCount",
  "SharedWithCount", "PermissionMetadataKeyCount", "AuthenticationMetadataKeyCount",
  "OwnersState", "SharedWithState", "PermissionsState", "AuthenticationState", "RiskState", "ProjectionValid",
] as const;

const activityColumns = [
  "Timestamp", "ActionType", "Application", "ApplicationId", "AppInstanceId", "AccountObjectId", "AccountId",
  "ObjectId", "ReportId", "OAuthAppId", "Operation", "OrganizationId", "TargetAgentId", "TargetAgentName",
  "TargetAgentBlueprintId", "AgentId", "AgentName", "AgentBlueprintId", "PlatformTargetAgentId", "ConversationId",
  "PlatformAgentType", "ThreadId", "SessionIdentity", "ChannelName", "HumanUserKey", "HumanUserId", "AgentUserKey", "AgentUserId",
  "TargetAgentUserKey", "OpId", "ParentId", "CreationTime", "CompletionTime", "ErrorType", "ToolName", "ToolType", "ToolId", "InvokeSource",
  "ProjectionValid",
  "ConversationIdState", "ThreadIdState", "ChannelNameState", "HumanUserKeyState", "AgentUserKeyState", "TargetAgentUserKeyState",
  "CompletionTimeState", "ErrorTypeState", "PlatformAgentIdState", "PlatformAgentTypeState",
] as const;

export class GraphHuntingClient {
  constructor(private readonly dependencies: Dependencies = defaultDependencies) {}

  async runQuery(token: string, filters: DefenderHuntingFilters, options: QueryOptions = {}): Promise<DefenderHuntingQueryResult> {
    const request = createHuntingRequest(filters);
    const startedAt = this.now();
    const deadline = AbortSignal.timeout(maximumRequestBudgetMs);
    const querySignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let received: Response | undefined;
    try {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        options.signal?.throwIfAborted();
        options.assertCurrent?.();
        querySignal.throwIfAborted();
        const remainingBudget = maximumRequestBudgetMs - (this.now() - startedAt);
        if (remainingBudget <= 0) throw received && received.status !== 200 ? providerFailure(received, this.now())
          : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget.");
        const requestTimeoutMs = Math.max(1, Math.min(this.dependencies.requestTimeoutMs ?? 10_000, remainingBudget));
        const attemptDeadlineAt = this.now() + requestTimeoutMs;
        const timeout = AbortSignal.timeout(requestTimeoutMs);
        const signal = AbortSignal.any([querySignal, timeout]);
        const assertDeadline = () => {
          signal.throwIfAborted();
          const now = this.now();
          if (now >= attemptDeadlineAt || now - startedAt >= maximumRequestBudgetMs) {
            throw received && received.status !== 200 ? providerFailure(received, now)
              : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget.", received && responseDetails(received, now));
          }
        };
        let response: Response | undefined;
        let undeliveredResponse: Response | undefined;
        let retryTransportFailure = false;
        let consumingResponse = false;
        try {
          await awaitCurrent(() => options.beforeRequest?.(signal), signal, options.assertCurrent);
          assertDeadline();
          options.assertCurrent?.();
          retryTransportFailure = true;
          const fetching = this.dependencies.fetch(endpoint, {
            method: "POST",
            redirect: "manual",
            signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/json; charset=utf-8",
              ...(options.correlationId ? { "client-request-id": options.correlationId, "return-client-request-id": "true" } : {}),
            },
            body: JSON.stringify(request),
          });
          void fetching.then(value => {
            undeliveredResponse = value;
            if (signal.aborted) disposeResponse(value);
          }, () => undefined);
          response = await abortable(fetching, signal);
          undeliveredResponse = undefined;
          received = response;
          retryTransportFailure = false;
          assertDeadline();
          options.assertCurrent?.();
          await awaitCurrent(() => options.onResponse?.(providerRequestId(response!), signal), signal, options.assertCurrent);
          assertDeadline();
          if (response.status >= 300 && response.status < 400) {
            throw new AppError(502, "invalid_provider_link", "Microsoft Graph hunting returned an unexpected redirect.", responseDetails(response, this.now()));
          }
          if (response.status === 200) {
            consumingResponse = true;
            const text = await awaitCurrent(() => boundedProviderText(response!, maximumResponseBytes, signal), signal, options.assertCurrent);
            assertDeadline();
            const result = parseHuntingResponse(parseJson(text, filters.templateId), filters, options.tenantId, Buffer.byteLength(text));
            assertDeadline();
            options.assertCurrent?.();
            return result;
          }
          if (attempt < maximumAttempts && (response.status === 429 || response.status >= 500 && response.status < 600)) {
            const waitMs = retryDelay(response, attempt, this.dependencies.random(), this.now());
            if (waitMs < maximumRequestBudgetMs - (this.now() - startedAt)) {
              disposeResponse(response);
              response = undefined;
              await this.waitForRetry(waitMs, querySignal, options, received);
              continue;
            }
          }
          throw providerFailure(response, this.now());
        } catch (error) {
          if (undeliveredResponse) {
            received = undeliveredResponse;
            disposeResponse(undeliveredResponse);
          }
          options.signal?.throwIfAborted();
          options.assertCurrent?.();
          if (signal.aborted || querySignal.aborted) throw received && received.status !== 200 ? providerFailure(received, this.now())
            : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget.", received && responseDetails(received, this.now()));
          if (error instanceof AppError) {
            if (consumingResponse && received) error.details = responseDetails(received, this.now());
            throw error;
          }
          if (!retryTransportFailure) {
            if (consumingResponse) throw new AppError(502, "provider_error", "Microsoft Graph hunting response consumption failed.", received && responseDetails(received, this.now()));
            throw error;
          }
          if (attempt === maximumAttempts) throw new AppError(502, "provider_error", "Microsoft Graph hunting failed within its bounded retry budget.", received && responseDetails(received, this.now()));
          const waitMs = Math.min(1_000 * (2 ** (attempt - 1)) + Math.floor(this.dependencies.random() * 250), 5_000);
          if (waitMs >= maximumRequestBudgetMs - (this.now() - startedAt)) throw received && received.status !== 200 ? providerFailure(received, this.now())
            : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget before retry.");
          await this.waitForRetry(waitMs, querySignal, options, received);
        } finally {
          if (response) disposeResponse(response);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      options.assertCurrent?.();
      if (querySignal.aborted) throw received && received.status !== 200 ? providerFailure(received, this.now())
        : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget.", received && responseDetails(received, this.now()));
      throw error;
    }
    throw new AppError(502, "provider_error", "Microsoft Graph hunting failed.");
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async waitForRetry(milliseconds: number, signal: AbortSignal, options: QueryOptions, response?: Response) {
    try {
      await awaitCurrent(() => this.dependencies.wait(milliseconds, signal), signal, options.assertCurrent);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      if (signal.aborted) throw response && response.status !== 200 ? providerFailure(response, this.now())
        : new AppError(502, "provider_error", "Microsoft Graph hunting exhausted its request time budget.");
      if (error instanceof AppError) throw error;
      throw new AppError(500, "internal_error", "Hunting retry scheduling failed.");
    }
  }
}

export function validateDefenderHuntingFilters(value: unknown, options: { now?: Date; qualification?: boolean } = {}): DefenderHuntingFilters {
  if (!isObject(value)) throw new AppError(400, "invalid_hunting_filters", "Hunting filters must be a structured object.");
  const allowedKeys = new Set(["templateId", "startDateTime", "endDateTime", "agentIds", "entraAgentIds", "entraAgentApplicationIds", "blueprintIds", "actorObjectIds", "userObjectId", "operations"]);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) throw new AppError(400, "invalid_hunting_filters", "Hunting filters contain an unsupported field.");
  if (typeof value.templateId !== "string" || !defenderHuntingTemplateIds.includes(value.templateId as DefenderHuntingTemplateId)) {
    throw new AppError(400, "invalid_hunting_filters", "Select a supported code-owned hunting template.");
  }
  const templateId = value.templateId as DefenderHuntingTemplateId;
  const startDateTime = utcInstant(value.startDateTime, "startDateTime");
  const endDateTime = utcInstant(value.endDateTime, "endDateTime");
  const start = Date.parse(startDateTime);
  const end = Date.parse(endDateTime);
  const now = (options.now ?? new Date()).getTime();
  const maximumWindowMs = options.qualification ? defenderHuntingQualificationMaximumWindowMs : defenderHuntingMaximumWindowMs;
  if (end <= start || end - start > maximumWindowMs || end > now + 5 * 60 * 1000 || start < now - 30 * 24 * 60 * 60 * 1000) {
    throw new AppError(400, "invalid_hunting_range", `Hunting requires a recent UTC range no longer than ${maximumWindowMs / 3_600_000} hour(s).`);
  }
  const availableOperations = defenderHuntingTemplates[templateId].operations;
  const operations = stringList(value.operations, "operations", item => availableOperations.includes(item), 128);
  if (templateId === "agents_inventory" && operations.length || templateId !== "agents_inventory" && operations.length === 0) {
    throw new AppError(400, "invalid_hunting_filters", "Hunting operations must match the selected fixed template.");
  }
  const actorObjectIds = stringList(value.actorObjectIds, "actorObjectIds", isDirectoryObjectId, 128);
  if (templateId === "agents_inventory" && actorObjectIds.length) throw new AppError(400, "invalid_hunting_filters", "Actor filters are not available for the inventory template.");
  if (value.userObjectId !== undefined && (typeof value.userObjectId !== "string" || !isDirectoryObjectId(value.userObjectId)
    || templateId !== "agent_activity" || operations.length !== 1 || operations[0] !== "InvokeAgent")) {
    throw new AppError(400, "invalid_hunting_filters", "User investigations require an exact directory user and the human-attributed agent invocation operation.");
  }
  const filters: DefenderHuntingFilters = {
    templateId,
    startDateTime,
    endDateTime,
    agentIds: stringList(value.agentIds, "agentIds", () => true),
    ...(value.entraAgentIds !== undefined ? { entraAgentIds: [...new Set(stringList(value.entraAgentIds, "entraAgentIds", isDirectoryObjectId, 128).map(id => id.toLowerCase()))].sort() } : {}),
    ...(value.entraAgentApplicationIds !== undefined ? { entraAgentApplicationIds: [...new Set(stringList(value.entraAgentApplicationIds, "entraAgentApplicationIds", isDirectoryObjectId, 128).map(id => id.toLowerCase()))].sort() } : {}),
    blueprintIds: stringList(value.blueprintIds, "blueprintIds", isDirectoryObjectId, 128),
    actorObjectIds,
    ...(typeof value.userObjectId === "string" ? { userObjectId: value.userObjectId.toLowerCase() } : {}),
    operations,
  };
  validateEntraNamespace(filters);
  return filters;
}

export function createHuntingRequest(filters: DefenderHuntingFilters) {
  validateEntraNamespace(filters);
  return {
    Query: filters.templateId === "agents_inventory" ? inventoryQuery(filters) : activityQuery(filters),
    Timespan: `${filters.startDateTime}/${filters.endDateTime}`,
  };
}

function validateEntraNamespace(filters: DefenderHuntingFilters) {
  if (filters.templateId === "agents_inventory" ? filters.entraAgentApplicationIds?.length : filters.entraAgentIds?.length) {
    throw new AppError(400, "invalid_hunting_filters", "Inventory requires enterprise-application object IDs; runtime activity requires application/client IDs. These namespaces cannot substitute.");
  }
}

export function expectedHuntingSchema(templateId: DefenderHuntingTemplateId) {
  const columns = templateId === "agents_inventory" ? inventoryColumns : activityColumns;
  return columns.map(name => ({ name, type: "String" }));
}

const scalarShape = (source: string) => `(isnull(${source}) or gettype(${source}) in ("string","long","int","real","decimal","datetime","guid","bool"))`;
const dateShape = (source: string) => `(isnull(${source}) or (${scalarShape(source)} and isnotnull(todatetime(${source}))))`;
const optionalDateShape = (source: string) => `(${dateShape(source)} or (gettype(${source})=="string" and tostring(${source})==""))`;
const inventoryScalarFields = ["Timestamp", "AgentId", "AgentName", "Platform", "AgentDescription", "Version", "SourceAgentId", "EntraAgentId",
  "EntraBlueprintId", "ObservabilityId", "PublishedStatus", "LifecycleStatus", "Availability", "CreatedDateTime", "LastPublishedDateTime",
  "LastUpdatedDateTime", "InstanceCount", "Model"] as const;
const inventoryProjectionValid = [...inventoryScalarFields.filter(field => !field.endsWith("DateTime") && field !== "Timestamp").map(scalarShape),
  dateShape("Timestamp"), dateShape("CreatedDateTime"), dateShape("LastPublishedDateTime"), dateShape("LastUpdatedDateTime")].join(" and ");
const inventoryProjectionTail = "RiskState=\"not_exposed\"";

const activityDirectFields = ["Timestamp", "ActionType", "Application", "ApplicationId", "AppInstanceId", "AccountObjectId", "AccountId", "ObjectId", "ReportId", "OAuthAppId"] as const;
const activityEventScalarFields = ["Operation", "OrganizationId", "TargetAgentId", "TargetAgentName", "TargetAgentBlueprintID", "AgentId", "AgentName",
  "AgentBlueprintId", "PlatformTargetAgentId", "PlatformAgentId", "PlatformTargetAgentType", "PlatformAgentType", "ConversationId", "SessionIdentity",
  "ChannelName", "UserKey", "UserId", "TargetAgentUserKey", "OpId", "ParentId", "CreationTime", "CompletionTime", "ErrorType", "ToolName", "ToolType",
  "ToolId", "InvokeSource"] as const;
const activityCopilotScalarFields = ["PlatformAgentType", "ConversationId", "ThreadId", "CompletionTime", "ErrorType"] as const;
const activityProjectionValid = [dateShape("Timestamp"), ...activityDirectFields.filter(field => field !== "Timestamp").map(scalarShape),
  'gettype(Event)=="dictionary"', '(isnull(Event.CopilotEventData) or gettype(CopilotEventData)=="dictionary")',
  ...activityEventScalarFields.filter(field => !["CreationTime", "CompletionTime"].includes(field)).map(field => scalarShape(`Event.${field}`)),
  optionalDateShape("Event.CreationTime"), optionalDateShape("Event.CompletionTime"),
  ...activityCopilotScalarFields.filter(field => field !== "CompletionTime").map(field => scalarShape(`CopilotEventData.${field}`)),
  optionalDateShape("CopilotEventData.CompletionTime")].join(" and ");

function inventoryQuery(filters: DefenderHuntingFilters) {
  const predicates = [
    inPredicate("AgentId", filters.agentIds),
    inPredicate("EntraAgentId", filters.entraAgentIds ?? [], true),
    inPredicate("EntraBlueprintId", filters.blueprintIds, true),
  ].filter(Boolean);
  return [
    "AgentsInfo",
    `| where ${timePredicate(filters)}`,
    "| summarize arg_max(Timestamp, AgentName, Platform, AgentDescription, Version, SourceAgentId, EntraAgentId, EntraBlueprintId, ObservabilityId, PublishedStatus, LifecycleStatus, Availability, CreatedDateTime, LastPublishedDateTime, LastUpdatedDateTime, InstanceCount, Model, Owners, SharedWith, Permissions, ToolsAuthenticationType) by AgentId",
    `| extend ProjectionValid=${inventoryProjectionValid}`,
    ...predicates.map(predicate => `| where ${predicate}`),
    `| extend ${inventoryScalarFields.map(field => `${field}=iff(ProjectionValid,${field},dynamic(null))`).join(", ")}`,
    "| project ObservationTime=format_datetime(Timestamp, 'yyyy-MM-ddTHH:mm:ss.fffZ'), AgentId=tostring(AgentId), AgentName=substring(tostring(AgentName),0,512), Platform=substring(tostring(Platform),0,256), AgentDescription=substring(tostring(AgentDescription),0,2048), Version=substring(tostring(Version),0,256), SourceAgentId=tostring(SourceAgentId), EntraAgentId=tostring(EntraAgentId), EntraBlueprintId=tostring(EntraBlueprintId), ObservabilityId=iff(gettype(ObservabilityId)==\"string\",tostring(ObservabilityId),\"\"), PublishedStatus=substring(tostring(PublishedStatus),0,64), LifecycleStatus=substring(tostring(LifecycleStatus),0,64), Availability=substring(tostring(Availability),0,256), CreatedDateTime=iff(isnull(CreatedDateTime),\"\",format_datetime(todatetime(CreatedDateTime),'yyyy-MM-ddTHH:mm:ss.fffZ')), LastPublishedDateTime=iff(isnull(LastPublishedDateTime),\"\",format_datetime(todatetime(LastPublishedDateTime),'yyyy-MM-ddTHH:mm:ss.fffZ')), LastUpdatedDateTime=iff(isnull(LastUpdatedDateTime),\"\",format_datetime(todatetime(LastUpdatedDateTime),'yyyy-MM-ddTHH:mm:ss.fffZ')), InstanceCount=substring(tostring(InstanceCount),0,32), Model=substring(tostring(Model),0,512), OwnerCount=substring(tostring(array_length(Owners)),0,32), SharedWithCount=substring(tostring(array_length(SharedWith)),0,32), PermissionMetadataKeyCount=substring(tostring(array_length(bag_keys(Permissions))),0,32), AuthenticationMetadataKeyCount=substring(tostring(array_length(bag_keys(ToolsAuthenticationType))),0,32), OwnersState=case(isnull(Owners),\"not_supplied\",tostring(Owners) in (\"\",\"[]\",\"{}\"),\"empty\",\"present_unqualified_shape\"), SharedWithState=case(isnull(SharedWith),\"not_supplied\",tostring(SharedWith) in (\"\",\"[]\",\"{}\"),\"empty\",\"present_unqualified_shape\"), PermissionsState=case(isnull(Permissions),\"not_supplied\",tostring(Permissions) in (\"\",\"[]\",\"{}\"),\"empty\",\"present_unqualified_shape\"), AuthenticationState=case(isnull(ToolsAuthenticationType),\"not_supplied\",tostring(ToolsAuthenticationType) in (\"\",\"[]\",\"{}\"),\"empty\",\"present_unqualified_shape\"), RiskState=\"not_exposed\"",
    "| order by ObservationTime desc, AgentId asc",
    `| take ${maximumStoredRows + 1}`,
  ].join("\n").replace(inventoryProjectionTail, `${inventoryProjectionTail}, ProjectionValid=tostring(ProjectionValid)`);
}

function activityQuery(filters: DefenderHuntingFilters) {
  const platformAgentTypeProjection = 'PlatformAgentType=case(ActionType=="InvokeAgent",tostring(Event.PlatformTargetAgentType),ActionType=="InferenceCall",tostring(CopilotEventData.PlatformAgentType),tostring(Event.PlatformAgentType))';
  const conversationIdProjection = 'ConversationId=iff(ActionType=="InferenceCall",tostring(CopilotEventData.ConversationId),tostring(Event.ConversationId))';
  const predicates = [
    inPredicate("ActionType", filters.operations),
    anyInPredicate(["tostring(Event.TargetAgentId)", "tostring(Event.AgentId)", 'iff(ActionType=="InvokeAgent",tostring(Event.PlatformTargetAgentId),tostring(Event.PlatformAgentId))'], filters.agentIds),
    anyInPredicate(["tolower(tostring(Event.TargetAgentId))", "tolower(tostring(Event.AgentId))"], filters.entraAgentApplicationIds ?? []),
    anyInPredicate(["tostring(Event.TargetAgentBlueprintID)", "tostring(Event.AgentBlueprintId)"], filters.blueprintIds, true),
    inPredicate("AccountObjectId", filters.actorObjectIds, true),
    inPredicate("tostring(Event.UserKey)", filters.userObjectId ? [filters.userObjectId] : [], true),
  ].filter(Boolean);
  return [
    "CloudAppEvents",
    `| where ${timePredicate(filters)}`,
    "| extend Event=parse_json(tostring(RawEventData))",
    "| extend CopilotEventData=parse_json(tostring(Event.CopilotEventData))",
    `| extend ProjectionValid=${activityProjectionValid}`,
    ...predicates.map(predicate => `| where ${predicate}`),
    `| extend ${activityDirectFields.map(field => `${field}=iff(ProjectionValid,${field},dynamic(null))`).join(", ")}, Event=iff(ProjectionValid,Event,dynamic(null)), CopilotEventData=iff(ProjectionValid,CopilotEventData,dynamic(null))`,
    "| project Timestamp=format_datetime(Timestamp, 'yyyy-MM-ddTHH:mm:ss.fffZ'), ActionType=substring(tostring(ActionType),0,128), Application=substring(tostring(Application),0,256), ApplicationId=substring(tostring(ApplicationId),0,32), AppInstanceId=substring(tostring(AppInstanceId),0,32), AccountObjectId=tostring(AccountObjectId), AccountId=substring(tostring(AccountId),0,512), ObjectId=tostring(ObjectId), ReportId=tostring(ReportId), OAuthAppId=tostring(OAuthAppId), Operation=substring(tostring(Event.Operation),0,128), OrganizationId=tostring(Event.OrganizationId), TargetAgentId=tostring(Event.TargetAgentId), TargetAgentName=substring(tostring(Event.TargetAgentName),0,512), TargetAgentBlueprintId=tostring(Event.TargetAgentBlueprintID), AgentId=tostring(Event.AgentId), AgentName=substring(tostring(Event.AgentName),0,512), AgentBlueprintId=tostring(Event.AgentBlueprintId), PlatformTargetAgentId=iff(ActionType==\"InvokeAgent\",tostring(Event.PlatformTargetAgentId),tostring(Event.PlatformAgentId)), PlatformAgentType=case(ActionType==\"InvokeAgent\",tostring(Event.PlatformTargetAgentType),ActionType==\"InferenceCall\",tostring(CopilotEventData.PlatformAgentType),tostring(Event.PlatformAgentType)), ConversationId=iff(ActionType==\"InferenceCall\",tostring(CopilotEventData.ConversationId),tostring(Event.ConversationId)), ThreadId=iff(ActionType==\"InferenceCall\",tostring(CopilotEventData.ThreadId),\"\"), SessionIdentity=substring(tostring(Event.SessionIdentity),0,512), ChannelName=iff(ActionType==\"InferenceCall\",\"\",substring(tostring(Event.ChannelName),0,128)), HumanUserKey=iff(ActionType==\"InvokeAgent\",tostring(Event.UserKey),\"\"), HumanUserId=iff(ActionType==\"InvokeAgent\",substring(tostring(Event.UserId),0,512),\"\"), AgentUserKey=iff(ActionType==\"InvokeAgent\",\"\",tostring(Event.UserKey)), AgentUserId=iff(ActionType==\"InvokeAgent\",\"\",substring(tostring(Event.UserId),0,512)), TargetAgentUserKey=iff(ActionType==\"InvokeAgent\",tostring(Event.TargetAgentUserKey),\"\"), OpId=tostring(Event.OpId), ParentId=tostring(Event.ParentId), CreationTime=iff(isnull(Event.CreationTime),\"\",format_datetime(todatetime(Event.CreationTime),'yyyy-MM-ddTHH:mm:ss.fffZ')), CompletionTime=iff(ActionType==\"InferenceCall\",iff(isnull(CopilotEventData.CompletionTime),\"\",format_datetime(todatetime(CopilotEventData.CompletionTime),'yyyy-MM-ddTHH:mm:ss.fffZ')),iff(isnull(Event.CompletionTime),\"\",format_datetime(todatetime(Event.CompletionTime),'yyyy-MM-ddTHH:mm:ss.fffZ'))), ErrorType=case(ActionType==\"InvokeAgent\",substring(tostring(Event.ErrorType),0,256),ActionType==\"InferenceCall\",substring(tostring(CopilotEventData.ErrorType),0,256),\"\"), ToolName=substring(tostring(Event.ToolName),0,512), ToolType=substring(tostring(Event.ToolType),0,128), ToolId=tostring(Event.ToolId), InvokeSource=substring(tostring(Event.InvokeSource),0,256)",
    "| order by Timestamp desc, ReportId asc, OpId asc",
    `| take ${maximumStoredRows + 1}`,
  ].join("\n")
    .replace(`${platformAgentTypeProjection}, ${conversationIdProjection}`, `${conversationIdProjection}, ${platformAgentTypeProjection}`)
    .replace(activityProjectionTail, `${activityProjectionTail}, ProjectionValid=tostring(ProjectionValid), ${activityStateProjection}`);
}

const activityProjectionTail = "InvokeSource=substring(tostring(Event.InvokeSource),0,256)";
const projectedState = (source: string) => `case(isnull(${source}),\"null\",tostring(${source})==\"\",\"empty\",\"value\")`;
const activityStateProjection = [
  `ConversationIdState=case(ActionType==\"InferenceCall\",${projectedState("CopilotEventData.ConversationId")},${projectedState("Event.ConversationId")})`,
  `ThreadIdState=iff(ActionType==\"InferenceCall\",${projectedState("CopilotEventData.ThreadId")},\"unavailable\")`,
  `ChannelNameState=iff(ActionType==\"InferenceCall\",\"unavailable\",${projectedState("Event.ChannelName")})`,
  `HumanUserKeyState=iff(ActionType==\"InvokeAgent\",${projectedState("Event.UserKey")},\"unavailable\")`,
  `AgentUserKeyState=iff(ActionType==\"InvokeAgent\",\"unavailable\",${projectedState("Event.UserKey")})`,
  `TargetAgentUserKeyState=iff(ActionType==\"InvokeAgent\",${projectedState("Event.TargetAgentUserKey")},\"unavailable\")`,
  `CompletionTimeState=iff(ActionType==\"InferenceCall\",${projectedState("CopilotEventData.CompletionTime")},${projectedState("Event.CompletionTime")})`,
  `ErrorTypeState=case(ActionType startswith \"ExecuteTool\",\"unavailable\",ActionType==\"InferenceCall\",${projectedState("CopilotEventData.ErrorType")},${projectedState("Event.ErrorType")})`,
  `PlatformAgentIdState=iff(ActionType==\"InvokeAgent\",${projectedState("Event.PlatformTargetAgentId")},${projectedState("Event.PlatformAgentId")})`,
  `PlatformAgentTypeState=case(ActionType==\"InvokeAgent\",${projectedState("Event.PlatformTargetAgentType")},ActionType==\"InferenceCall\",${projectedState("CopilotEventData.PlatformAgentType")},${projectedState("Event.PlatformAgentType")})`,
].join(", ");

function parseHuntingResponse(value: unknown, filters: DefenderHuntingFilters, tenantId: string | undefined, byteCount: number): DefenderHuntingQueryResult {
  if (!isObject(value) || !Array.isArray(value.schema) || !Array.isArray(value.results)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid hunting response envelope.");
  if (Object.keys(value).some(key => !["@odata.context", "schema", "results"].includes(key))) throw new AppError(502, "provider_schema", "Microsoft Graph returned unknown hunting response fields.");
  const expectedSchema = expectedHuntingSchema(filters.templateId);
  if (value.schema.length !== expectedSchema.length || value.schema.some((entry, index) => !isObject(entry)
    || Object.keys(entry).some(key => !["name", "type"].includes(key))
    || entry.name !== expectedSchema[index]?.name || entry.type !== expectedSchema[index]?.type)) {
    throw new AppError(502, "provider_schema", "Microsoft Graph returned a hunting schema outside the selected projection contract.");
  }
  if (value.results.length > maximumStoredRows + 1) throw new AppError(502, "provider_schema", "Microsoft Graph returned more hunting rows than the code-owned query permits.");
  const parsedRows = value.results.map(row => parseRow(row, filters.templateId));
  parsedRows.forEach(row => validateReturnedRow(row, filters, tenantId));
  const rows = parsedRows.slice(0, maximumStoredRows);
  const complete = value.results.length <= maximumStoredRows;
  return {
    rows,
    providerRowCount: value.results.length,
    storedRowCount: rows.length,
    byteCount,
    complete,
    partialReason: complete ? null : "hunting_row_limit",
  };
}

function parseRow(value: unknown, templateId: DefenderHuntingTemplateId): DefenderHuntingRow {
  if (!isObject(value)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid hunting row.");
  const expectedColumns = templateId === "agents_inventory" ? inventoryColumns : activityColumns;
  if (Object.keys(value).length !== expectedColumns.length || expectedColumns.some(column => !Object.hasOwn(value, column))) {
    throw new AppError(502, "provider_schema", "Microsoft Graph returned a hunting row outside the selected projection.");
  }
  if (templateId === "agents_inventory") return parseInventoryRow(value);
  return parseActivityRow(value);
}

function parseInventoryRow(value: Record<string, unknown>): DefenderAgentInventoryRow {
  requireProjectionValid(value.ProjectionValid);
  return {
    projectionVersion: 3,
    sourceTable: "AgentsInfo",
    observationTime: requiredInstant(value.ObservationTime, "ObservationTime"),
    agentId: requiredString(value.AgentId, "AgentId", 512),
    agentName: optionalString(value.AgentName, "AgentName", 512),
    platform: optionalString(value.Platform, "Platform", 256),
    agentDescription: optionalString(value.AgentDescription, "AgentDescription", 2048),
    version: optionalString(value.Version, "Version", 256),
    sourceAgentId: optionalString(value.SourceAgentId, "SourceAgentId", 512),
    entraAgentObjectId: optionalUuid(value.EntraAgentId, "EntraAgentId"),
    entraBlueprintId: optionalUuid(value.EntraBlueprintId, "EntraBlueprintId"),
    observabilityId: optionalString(value.ObservabilityId, "ObservabilityId", 512),
    publishedStatus: optionalEnum(value.PublishedStatus, "PublishedStatus", ["Draft", "Published"]),
    lifecycleStatus: optionalEnum(value.LifecycleStatus, "LifecycleStatus", ["Active", "Blocked", "Uninstalled", "Deleted"]),
    availability: optionalString(value.Availability, "Availability", 256),
    createdDateTime: optionalInstant(value.CreatedDateTime, "CreatedDateTime"),
    lastPublishedDateTime: optionalInstant(value.LastPublishedDateTime, "LastPublishedDateTime"),
    lastUpdatedDateTime: optionalInstant(value.LastUpdatedDateTime, "LastUpdatedDateTime"),
    instanceCount: optionalInteger(value.InstanceCount, "InstanceCount"),
    model: optionalString(value.Model, "Model", 512),
    ownerCount: optionalInteger(value.OwnerCount, "OwnerCount"),
    sharedWithCount: optionalInteger(value.SharedWithCount, "SharedWithCount"),
    permissionMetadataKeyCount: optionalInteger(value.PermissionMetadataKeyCount, "PermissionMetadataKeyCount"),
    authenticationMetadataKeyCount: optionalInteger(value.AuthenticationMetadataKeyCount, "AuthenticationMetadataKeyCount"),
    detailStates: {
      owners: requiredDetailState(value.OwnersState, "OwnersState"),
      sharing: requiredDetailState(value.SharedWithState, "SharedWithState"),
      permissions: requiredDetailState(value.PermissionsState, "PermissionsState"),
      authentication: requiredDetailState(value.AuthenticationState, "AuthenticationState"),
      risk: requiredEnum(value.RiskState, "RiskState", ["not_exposed"] as const),
    },
  };
}

function parseActivityRow(value: Record<string, unknown>): DefenderAgentActivityRow {
  requireProjectionValid(value.ProjectionValid);
  const actionType = requiredEnum(value.ActionType, "ActionType", defenderHuntingTemplates.agent_activity.operations.concat(defenderHuntingTemplates.agent_tools.operations));
  const operation = optionalEnum(value.Operation, "Operation", ["invoke_agent", "execute_tool", "chat", "output_messages"]);
  const creationTime = optionalInstant(value.CreationTime, "CreationTime");
  const completionTime = optionalInstant(value.CompletionTime, "CompletionTime");
  const spanId = optionalHex(value.OpId, "OpId", 16);
  const parentSpanId = optionalHex(value.ParentId, "ParentId", 16);
  const errorType = optionalString(value.ErrorType, "ErrorType", 256);
  const humanActorUserPrincipalName = optionalString(value.HumanUserId, "HumanUserId", 512);
  const agentUserPrincipalName = optionalString(value.AgentUserId, "AgentUserId", 512);
  if (!defenderHuntingFieldAvailable(actionType, "humanActorUserObjectId") && humanActorUserPrincipalName !== null) throw schemaError("HumanUserId");
  if (!defenderHuntingFieldAvailable(actionType, "agentUserObjectId") && agentUserPrincipalName !== null) throw schemaError("AgentUserId");
  const rootSpanObserved = actionType === "InvokeAgent" && operation === "invoke_agent" && spanId !== null && parentSpanId === null;
  const fieldState = (field: keyof DefenderAgentActivityRow["fieldStates"], column: string, stateColumn = column) =>
    requiredProjectedFieldState(value[`${stateColumn}State`], `${stateColumn}State`, value[column], defenderHuntingFieldAvailable(actionType, field));
  return {
    projectionVersion: 3,
    sourceTable: "CloudAppEvents",
    timestamp: requiredInstant(value.Timestamp, "Timestamp"),
    actionType,
    cloudApplication: optionalString(value.Application, "Application", 256),
    cloudApplicationId: optionalInteger(value.ApplicationId, "ApplicationId"),
    cloudAppInstanceId: optionalInteger(value.AppInstanceId, "AppInstanceId"),
    actorAccountObjectId: optionalUuid(value.AccountObjectId, "AccountObjectId"),
    actorProviderAccountId: optionalString(value.AccountId, "AccountId", 512),
    objectId: optionalString(value.ObjectId, "ObjectId", 512),
    reportId: optionalString(value.ReportId, "ReportId", 512),
    oauthAppId: optionalUuid(value.OAuthAppId, "OAuthAppId"),
    operation,
    organizationId: optionalUuid(value.OrganizationId, "OrganizationId"),
    targetAgentId: optionalString(value.TargetAgentId, "TargetAgentId", 512),
    targetAgentName: optionalString(value.TargetAgentName, "TargetAgentName", 512),
    targetAgentBlueprintId: optionalUuid(value.TargetAgentBlueprintId, "TargetAgentBlueprintId"),
    agentId: optionalString(value.AgentId, "AgentId", 512),
    agentName: optionalString(value.AgentName, "AgentName", 512),
    agentBlueprintId: optionalUuid(value.AgentBlueprintId, "AgentBlueprintId"),
    alternatePlatformAgentId: optionalString(value.PlatformTargetAgentId, "PlatformTargetAgentId", 512),
    platformAgentType: optionalString(value.PlatformAgentType, "PlatformAgentType", 128),
    conversationId: optionalString(value.ConversationId, "ConversationId", 512),
    conversationThreadId: optionalString(value.ThreadId, "ThreadId", 512),
    sessionIdentity: optionalString(value.SessionIdentity, "SessionIdentity", 512),
    channelName: optionalString(value.ChannelName, "ChannelName", 128),
    humanActorUserObjectId: optionalUuid(value.HumanUserKey, "HumanUserKey"),
    humanActorUserPrincipalName,
    agentUserObjectId: optionalUuid(value.AgentUserKey, "AgentUserKey"),
    agentUserPrincipalName,
    targetAgentUserObjectId: optionalUuid(value.TargetAgentUserKey, "TargetAgentUserKey"),
    spanId,
    parentSpanId,
    creationTime,
    completionTime,
    errorType,
    toolName: optionalString(value.ToolName, "ToolName", 512),
    toolType: optionalString(value.ToolType, "ToolType", 128),
    toolCallId: optionalString(value.ToolId, "ToolId", 512),
    invokeSource: optionalString(value.InvokeSource, "InvokeSource", 256),
    durationMilliseconds: durationMilliseconds(creationTime, completionTime),
    outcome: errorType ? "error" : "unknown",
    spanRole: rootSpanObserved ? "root_invoke_agent" : parentSpanId ? "child" : "unresolved",
    rootSpanObserved,
    fieldStates: {
      conversationId: fieldState("conversationId", "ConversationId"),
      conversationThreadId: fieldState("conversationThreadId", "ThreadId"),
      channelName: fieldState("channelName", "ChannelName"),
      humanActorUserObjectId: fieldState("humanActorUserObjectId", "HumanUserKey"),
      agentUserObjectId: fieldState("agentUserObjectId", "AgentUserKey"),
      targetAgentUserObjectId: fieldState("targetAgentUserObjectId", "TargetAgentUserKey"),
      completionTime: fieldState("completionTime", "CompletionTime"),
      errorType: fieldState("errorType", "ErrorType"),
      platformAgentId: fieldState("platformAgentId", "PlatformTargetAgentId", "PlatformAgentId"),
      platformAgentType: fieldState("platformAgentType", "PlatformAgentType"),
    },
    contentAvailable: false,
  };
}

function validateReturnedRow(row: DefenderHuntingRow, filters: DefenderHuntingFilters, tenantId?: string) {
  const timestamp = Date.parse(row.sourceTable === "AgentsInfo" ? row.observationTime : row.timestamp);
  const selectedBlueprintIds = filters.blueprintIds.map(value => value.toLowerCase());
  if (timestamp < Date.parse(filters.startDateTime) || timestamp > Date.parse(filters.endDateTime)) throw scopeMismatch();
  if (row.sourceTable === "AgentsInfo") {
    if (filters.templateId !== "agents_inventory"
      || filters.agentIds.length && !filters.agentIds.includes(row.agentId)
      || filters.entraAgentIds?.length && (!row.entraAgentObjectId || !filters.entraAgentIds.includes(row.entraAgentObjectId))
      || selectedBlueprintIds.length && (!row.entraBlueprintId || !selectedBlueprintIds.includes(row.entraBlueprintId))) throw scopeMismatch();
    return;
  }
  const expectedOperations = row.actionType === "InvokeAgent" ? ["invoke_agent"]
    : row.actionType === "InferenceCall" ? ["chat", "output_messages"] : ["execute_tool"];
  const agentIds = [row.targetAgentId, row.agentId, row.alternatePlatformAgentId].filter((value): value is string => value !== null);
  const blueprintIds = [row.targetAgentBlueprintId, row.agentBlueprintId].filter((value): value is string => value !== null);
  if (filters.templateId === "agents_inventory"
    || !filters.operations.includes(row.actionType)
    || !row.operation || !expectedOperations.includes(row.operation)
    || tenantId && row.organizationId && row.organizationId !== tenantId.toLowerCase()
    || filters.agentIds.length && !agentIds.some(value => filters.agentIds.includes(value))
    || filters.entraAgentApplicationIds?.length && ![row.targetAgentId, row.agentId].some(value => value && filters.entraAgentApplicationIds!.includes(value.toLowerCase()))
    || selectedBlueprintIds.length && !blueprintIds.some(value => selectedBlueprintIds.includes(value))
    || filters.actorObjectIds.length && !filters.actorObjectIds.some(value => value.toLowerCase() === row.actorAccountObjectId)
    || filters.userObjectId && (row.actionType !== "InvokeAgent" || row.humanActorUserObjectId !== filters.userObjectId)) throw scopeMismatch();
}

function scopeMismatch() {
  return new AppError(502, "provider_scope_mismatch", "Microsoft Graph returned a hunting row outside the exact requested scope.");
}

function inPredicate(field: string, values: string[], caseInsensitive = false) {
  return values.length ? `${field} in${caseInsensitive ? "~" : ""} (${values.map(kqlString).join(",")})` : "";
}

function anyInPredicate(fields: string[], values: string[], caseInsensitive = false) {
  return values.length ? `(${fields.map(field => inPredicate(field, values, caseInsensitive)).join(" or ")})` : "";
}

function timePredicate(filters: DefenderHuntingFilters) {
  return `Timestamp between (datetime(${filters.startDateTime}) .. datetime(${filters.endDateTime}))`;
}

function kqlString(value: string) {
  return `@'${value.replaceAll("'", "''")}'`;
}

function stringList(value: unknown, name: string, validate: (value: string) => boolean, maximumLength = 512) {
  if (!Array.isArray(value) || value.length > 20) throw new AppError(400, "invalid_hunting_filters", `${name} must be an array with at most 20 values.`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maximumLength || /[\r\n\0]/.test(item) || !validate(item)) {
      throw new AppError(400, "invalid_hunting_filters", `${name} contains an invalid value.`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result.sort(ordinal);
}

function requiredString(value: unknown, name: string, maximumLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || /[\0]/.test(value)) throw schemaError(name);
  return value;
}

function optionalString(value: unknown, name: string, maximumLength: number) {
  if (value === "" || value === null) return null;
  return requiredString(value, name, maximumLength);
}

function requiredEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]) {
  const text = requiredString(value, name, 256);
  if (!allowed.includes(text as T)) throw schemaError(name);
  return text as T;
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]) {
  if (value === "" || value === null) return null;
  return requiredEnum(value, name, allowed);
}

function requiredInstant(value: unknown, name: string) {
  const text = requiredString(value, name, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString() !== text) throw schemaError(name);
  return text;
}

function optionalInstant(value: unknown, name: string) {
  if (value === "" || value === null) return null;
  return requiredInstant(value, name);
}

function optionalUuid(value: unknown, name: string) {
  if (value === "" || value === null) return null;
  const text = requiredString(value, name, 128);
  if (!isDirectoryObjectId(text)) throw schemaError(name);
  return text.toLowerCase();
}

function optionalHex(value: unknown, name: string, length: number) {
  if (value === "" || value === null) return null;
  const text = requiredString(value, name, length);
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(text)) throw schemaError(name);
  return text.toLowerCase();
}

function optionalInteger(value: unknown, name: string) {
  if (value === "" || value === null) return null;
  const text = requiredString(value, name, 32);
  if (!/^\d+$/.test(text)) throw schemaError(name);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw schemaError(name);
  return parsed;
}

function requiredDetailState(value: unknown, name: string) {
  return requiredEnum(value, name, ["not_supplied", "empty", "present_unqualified_shape"] as const);
}

function requireProjectionValid(value: unknown) {
  if (value !== "true") throw schemaError("ProjectionValid");
}

function requiredProjectedFieldState(value: unknown, name: string, projectedValue: unknown, available: boolean) {
  const state = requiredEnum(value, name, ["value", "null", "empty", "unavailable"] as const);
  if ((state !== "unavailable") !== available
    || state === "value" && (projectedValue === null || projectedValue === "")
    || state === "null" && projectedValue !== null && projectedValue !== "" || state === "empty" && projectedValue !== ""
    || state === "unavailable" && projectedValue !== null && projectedValue !== "") throw schemaError(name);
  return state;
}

function durationMilliseconds(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > 7 * 24 * 60 * 60 * 1000) throw schemaError("CompletionTime");
  return duration;
}

function utcInstant(value: unknown, name: string) {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AppError(400, "invalid_hunting_range", `${name} must be a valid UTC instant.`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) {
    throw new AppError(400, "invalid_hunting_range", `${name} must be a valid UTC instant.`);
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, templateId: DefenderHuntingTemplateId): unknown {
  try {
    return parseProviderContractJson(text, {
      root: { fields: ["@odata.context", "schema", "results"], arrays: { schema: "column", results: "row" } },
      column: { fields: ["name", "type"] },
      row: { fields: templateId === "agents_inventory" ? inventoryColumns : activityColumns },
    }, 3);
  }
  catch { throw new AppError(502, "provider_schema", "Microsoft Graph returned invalid hunting JSON."); }
}

function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (signal.aborted) { promise.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => {
      signal.removeEventListener("abort", onAbort); reject(error);
    });
  });
}

async function awaitCurrent<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal, assertCurrent?: () => void): Promise<T> {
  signal.throwIfAborted();
  assertCurrent?.();
  try {
    const value = await abortable(Promise.resolve(operation()), signal);
    signal.throwIfAborted();
    assertCurrent?.();
    return value;
  } catch (error) {
    assertCurrent?.();
    signal.throwIfAborted();
    throw error;
  }
}

function schemaError(name: string) {
  return new AppError(502, "provider_schema", `Microsoft Graph returned an invalid hunting ${name} field.`);
}

function providerRequestId(response: Response) {
  const value = response.headers.get("request-id");
  return isDefenderHuntingRequestId(value) ? value : null;
}

function providerFailure(response: Response, now: number) {
  const details = responseDetails(response, now);
  const status = response.status >= 400 ? response.status : 502;
  const code = response.status === 429 ? "provider_throttled"
    : response.status === 401 || response.status === 403 ? "hunting_access_denied" : "provider_error";
  const message = response.status === 429 ? "Microsoft Graph hunting is temporarily throttled."
    : response.status === 401 || response.status === 403 ? "Microsoft Graph hunting did not authorize this bounded request; permission, Defender role, data scope, license, and rollout must be checked separately."
      : "Microsoft Graph hunting failed.";
  const error = new AppError(status, code, message, details);
  if (details.retryAfterMs !== undefined && details.retryAfterMs > 0) error.retryAfterSeconds = Math.ceil(details.retryAfterMs / 1000);
  return error;
}

function responseDetails(response: Response, now: number) {
  const correlationId = providerRequestId(response);
  const retryAfterMs = retryAfterMilliseconds(response, now);
  return { httpStatus: response.status, ...(correlationId ? { correlationId } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function retryAfterMilliseconds(response: Response, now: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, Number.MAX_SAFE_INTEGER);
  const retryAt = httpDate(retryAfter);
  if (retryAt === undefined) return undefined;
  return Math.max(0, retryAt - (httpDate(response.headers.get("date")) ?? now));
}

function httpDate(value: string | null) {
  if (value === null || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value ? date : undefined;
}

function retryDelay(response: Response, attempt: number, random: number, now: number) {
  return retryAfterMilliseconds(response, now) ?? Math.min(1_000 * (2 ** (attempt - 1)) + Math.floor(random * 250), 5_000);
}

function disposeResponse(response: Response) {
  try { void response.body?.cancel().catch(() => undefined); }
  catch { /* response disposal is best effort */ }
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}