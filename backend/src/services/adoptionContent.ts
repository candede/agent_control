import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { transaction } from "../db/pool.js";
import { hasAppRole } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { currentAuthority } from "../auth/authorityContext.js";
import { reportIdentity } from "./reportIdentity.js";
import { AgentDiscovery } from "./agentDiscovery.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { OfficeAppAdoptionReads } from "./officeAppAdoptionReads.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { DepartmentOpportunities } from "./departmentOpportunity.js";
import { officeQuery } from "./officeAppAdoption.js";
import { lockDataScope } from "../db/dataGenerations.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { currentInventorySourcesSql, lockInventorySources } from "../db/inventoryAuthority.js";
import type { DiscoveryDetail } from "../types/agentDiscovery.js";
import { learningTasks, learningInputs, learningOutputs, learningPrompts, learningReviews, learningFailures,
  type ContentDraft, type ContentKind, type ContentRecord, type ContentPage, type ContentSave, type ContentFollowUp,
  type ContentBaseline, type SharedLearningPage, type SharedLearningCard, type ContentReference, type ContentAgentReference,
  type ContentNarrative, type LearningSlots } from "../types/adoptionContent.js";

const day = 86_400_000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const bad = () => new AppError(400, "invalid_adoption_content", "Use the bounded typed adoption-content fields.");
const conflict = () => new AppError(409, "adoption_revision_conflict", "This record changed. Your unsaved draft is retained; reload the record before explicitly applying it.");
const fields = ["task", "inputs", "prompt", "expectedOutput", "reviewSteps", "limitations", "example",
  "opportunity", "exercises", "successMeasure", "unknowns"] as const;
type EvidenceWindows = {
  office: Pick<ContentBaseline["office"], "windowStart" | "reportRefreshDate">;
  report: { reportingPeriod: Pick<NonNullable<ContentBaseline["report"]["reportingPeriod"]>, "startDate" | "endDate"> | null };
};
export function adoptionWindowCaveats(original: EvidenceWindows, current: EvidenceWindows): string[] {
  const caveats: string[] = [];
  if (current.office.windowStart <= original.office.reportRefreshDate && original.office.windowStart <= current.office.reportRefreshDate) {
    caveats.push("The selected Office D28 windows overlap and are non-additive.");
  }
  const before = original.report.reportingPeriod, after = current.report.reportingPeriod;
  if (!before?.startDate || !before.endDate || !after?.startDate || !after.endDate) {
    caveats.push("Report activity-range overlap is unavailable; do not assume the report evidence is additive.");
  } else if (after.startDate <= before.endDate && before.startDate <= after.endDate) {
    caveats.push("The selected report activity ranges overlap and are non-additive.");
  }
  return caveats;
}
function storedContentError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "23514"
    && "constraint" in error && typeof error.constraint === "string" && [
      "adoption_content_payload_check", "adoption_content_baseline_check",
      "adoption_content_agent_references_check", "adoption_content_linked_references_check",
    ].includes(error.constraint)) {
    throw new AppError(413, "adoption_payload_limit", "The stored JSON content exceeds its bounded payload. Reduce the text or reference count; this write was not saved.");
  }
  throw error;
}
function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw bad();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 2048, empty = true) {
  if (typeof value !== "string" || value.length > max || !empty && !value.trim() || /[\p{Cc}\p{Cs}]/u.test(value.replaceAll("\n", ""))) throw bad();
  return value.trim();
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  const found = values.find(item => item === value);
  if (found === undefined) throw bad();
  return found;
}
export function contentId(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw bad();
  return value.toLowerCase();
}
function ids(value: unknown) {
  if (!Array.isArray(value) || value.length > 8) throw bad();
  const result = value.map(contentId).sort();
  if (new Set(result).size !== result.length) throw bad();
  return result;
}
function choices<T extends string>(value: unknown, values: readonly T[]) {
  if (!Array.isArray(value) || value.length > values.length) throw bad();
  const result = value.map(item => choice(item, values)).sort();
  if (new Set(result).size !== result.length) throw bad();
  return result;
}
function evidenceQuery(value: unknown) {
  const raw = object(value, ["officeSnapshot", "officeBaseline", "company", "department", "setId",
    "reportSelectionId", "officeSelectionId", "inventorySelectionId"]);
  const { setId, reportSelectionId, officeSelectionId, inventorySelectionId, ...filters } = raw;
  return { ...officeQuery(filters),
    ...(setId === undefined ? {} : { setId: contentId(setId) }),
    ...(reportSelectionId === undefined ? {} : { reportSelectionId: contentId(reportSelectionId) }),
    ...(officeSelectionId === undefined ? {} : { officeSelectionId: contentId(officeSelectionId) }),
    ...(inventorySelectionId === undefined ? {} : { inventorySelectionId: contentId(inventorySelectionId) }) };
}
export function contentDraft(value: unknown): ContentDraft {
  const input = object(value, ["kind", "title", "scope", "narrative", "learning", "evidenceKind", "visibility", "assigneeId",
    "dueDate", "status", "progress", "agentIds", "linkedIds", "baseline"]);
  const kind = choice(input.kind, ["brief", "card", "action"] as const);
  const scope = object(input.scope, ["company", "department"]);
  const narrative = object(input.narrative, fields);
  const learning = input.learning === null ? null : object(input.learning, ["task", "inputs", "output", "prompt", "reviews", "failures"]);
  const slots: LearningSlots | null = learning ? {
    task: choice(learning.task, learningTasks), inputs: choice(learning.inputs, learningInputs),
    output: choice(learning.output, learningOutputs), prompt: choice(learning.prompt, learningPrompts),
    reviews: choices(learning.reviews, learningReviews), failures: choices(learning.failures, learningFailures),
  } : null;
  const visibility = choice(input.visibility, ["staff_only", "employees"] as const);
  if (kind !== "card" && visibility !== "staff_only" || kind === "card" && !slots) throw bad();
  if (input.assigneeId !== null && (kind !== "action" || typeof input.assigneeId !== "string")) throw bad();
  const dueDate = input.dueDate === null ? null : text(input.dueDate, 10, false);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate))
    || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) throw bad();
  const draft: ContentDraft = {
    kind, title: text(input.title, 256, false),
    scope: { company: scope.company === null ? null : text(scope.company, 256, false),
      department: scope.department === null ? null : text(scope.department, 256, false) },
    narrative: Object.fromEntries(fields.map(field => [field, text(narrative[field])])) as ContentNarrative,
    learning: slots, evidenceKind: choice(input.evidenceKind, ["generated_draft", "description_suggestion", "contributor_provided", "contributor_confirmed"] as const),
    visibility, assigneeId: input.assigneeId === null ? null : text(input.assigneeId, 256, false),
    dueDate, status: choice(input.status, ["open", "in_progress", "completed", "cancelled"] as const),
    progress: text(input.progress), agentIds: ids(input.agentIds), linkedIds: ids(input.linkedIds),
  };
  if (kind !== "action" && (draft.status !== "open" || draft.progress || draft.assigneeId || draft.dueDate)) throw bad();
  if (input.baseline !== undefined) {
    if (kind === "card") throw bad();
    const baseline = object(input.baseline, ["groupId", "query"]);
    draft.baseline = { groupId: text(baseline.groupId, 128, false), query: evidenceQuery(baseline.query) };
    if (draft.baseline.query.company !== draft.scope.company || draft.baseline.query.department !== draft.scope.department
      || !draft.baseline.query.officeSelectionId || !draft.baseline.query.reportSelectionId) throw bad();
  }
  if (Buffer.byteLength(JSON.stringify(draft)) > 32768) throw bad();
  return draft;
}
export function canonicalContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContent).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContent(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function createRequestTime(value: unknown) {
  if (typeof value !== "string" || !/^\d{13}\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw bad();
  const time = Number(value.slice(0, 13));
  if (time > Date.now() + 60_000) throw bad();
  return time;
}
type Row = {
  id: string; tenant_id: string; creator_id: string; kind: ContentKind; revision: number;
  payload: Omit<ContentDraft, "baseline" | "agentIds" | "linkedIds">;
  baseline: ContentBaseline | null; agent_references: ContentAgentReference[]; linked_references: ContentReference[];
  created_at: Date; updated_at: Date;
};
function staff(user: AuthenticatedUser): asserts user is AuthenticatedUser & { tenantId: string } {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) throw new AppError(403, "adoption_staff_required", "Adoption staff access is required.");
  if (!user.tenantId) throw AppError.unauthorized();
}
export function contentPermissions(user: AuthenticatedUser, row: { creator_id: string; kind: ContentKind; payload: { assigneeId: string | null } }) {
  const authorized = hasAppRole(user.roles, "AgentControl.Viewer");
  const core = authorized && (user.homeAccountId === row.creator_id || hasAppRole(user.roles, "AgentControl.Admin"));
  return { core, progress: authorized && row.kind === "action" && (core || row.payload.assigneeId === user.homeAccountId) };
}

export class AdoptionContent {
  readonly discovery: AgentDiscovery;
  readonly opportunities: DepartmentOpportunities;
  constructor(readonly database: pg.Pool) {
    this.discovery = new AgentDiscovery(database);
    this.opportunities = new DepartmentOpportunities(new LargeTenantUsersReports(database, config.sessionSecret, 7),
      new OfficeAppAdoptionReads(database, config.sessionSecret), new InventoryQueries(database, config.sessionSecret));
  }
  private async lock(client: pg.PoolClient, tenantId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('adoption-content:'||$1,0))", [tenantId]);
  }
  private async row(client: Pick<pg.Pool, "query">, user: AuthenticatedUser, id: string) {
    const row = (await client.query<Row>("SELECT * FROM adoption_content WHERE tenant_id=$1 AND id=$2", [user.tenantId, id])).rows[0];
    if (!row) throw new AppError(404, "adoption_content_unavailable", "This exact content record is unavailable.");
    return row;
  }
  private async baseline(user: AuthenticatedUser, input: NonNullable<ContentDraft["baseline"]>): Promise<ContentBaseline> {
    const identity = await reportIdentity(this.database, user);
    const page = await this.opportunities.page(identity, input.query, { limit: 10 });
    const group = page.value.find(item => item.id === input.groupId);
    if (!group || !page.context.office.observation) throw new AppError(409, "adoption_evidence_unavailable", "The exact measured group is unavailable.");
    const { drilldowns: _drilldowns, ...aggregate } = group;
    const result = { group: aggregate, definitions: page.definitions, office: page.context.office.observation,
      report: page.context.report.reports, capturedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw bad();
    return result;
  }
  private async agents(user: AuthenticatedUser, ids: string[]) {
    const references: ContentAgentReference[] = [];
    for (const id of ids) {
      const read = await this.discovery.execute(user, { operation: "detail", agentId: id }) as DiscoveryDetail;
      references.push({ id, sources: read.agent.sources, state: "available", agent: null });
    }
    if (Buffer.byteLength(JSON.stringify(references)) > 16384) throw bad();
    return references;
  }
  private async renderAgents(user: AuthenticatedUser, references: ContentAgentReference[]) {
    const value: ContentAgentReference[] = [];
    for (const reference of references) {
      try {
        const read = await this.discovery.execute(user, { operation: "detail", agentId: reference.id }) as DiscoveryDetail;
        const exact = reference.sources.length === read.agent.sources.length && reference.sources.every(source => read.agent.sources.some(current =>
          source.source === current.source && source.generationId === current.generationId
          && source.sourceIdentity === current.sourceIdentity && source.revision === current.revision));
        value.push({ ...reference, state: exact ? "available" : "unavailable", agent: exact ? read.agent : null });
      } catch (error) {
        if (!(error instanceof AppError) || ![404, 409, 410].includes(error.status)) throw error;
        value.push({ ...reference, state: "unavailable", agent: null });
      }
    }
    return value;
  }
  private async evidence(user: AuthenticatedUser, baseline: ContentBaseline | null): Promise<ContentRecord["evidence"]> {
    if (!baseline) return { state: "unmeasured", reason: "manual_content_no_measured_baseline", freshQuery: null };
    const setId = baseline.report.setId;
    const state = (await this.database.query<{ available: boolean; superseded: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM office_observations o JOIN data_generations g ON g.id=o.generation_id
        WHERE o.tenant_id=$1 AND o.generation_id=$2 AND g.state='published' AND g.expires_at>clock_timestamp())
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM official_usage_sets s WHERE s.tenant_id=$1 AND s.id=$3
        AND s.deleted_at IS NULL AND s.complete AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp()))) AS available,
      EXISTS(SELECT 1 FROM official_usage_sets s WHERE s.tenant_id=$1 AND s.supersedes_set_id=$3 AND s.deleted_at IS NULL) AS superseded`,
    [user.tenantId, baseline.office.id, setId])).rows[0];
    if (state.superseded) return { state: "superseded", reason: "exact_report_set_corrected", freshQuery: null };
    if (!state.available) return { state: "unavailable", reason: "exact_source_deleted_cleared_or_expired", freshQuery: null };
    const query = { officeSnapshot: baseline.office.id, ...(setId ? { setId } : {}),
      company: baseline.group.company, department: baseline.group.department };
    // Fresh caller-bound selections, never the original actor's lease.
    let read;
    try { read = await this.opportunities.page(await reportIdentity(this.database, user), query, { limit: 10 }); }
    catch (error) {
      if (!(error instanceof AppError) || ![404, 409, 410].includes(error.status)) throw error;
      return { state: "unavailable", reason: "exact_source_changed_during_fresh_read", freshQuery: null };
    }
    if (read.context.office.observation?.contentHash !== baseline.office.contentHash
      || canonicalContent(read.context.report.reports.lineages) !== canonicalContent(baseline.report.lineages)) {
      return { state: "superseded", reason: "exact_source_version_changed", freshQuery: null };
    }
    return { state: "available", reason: null, freshQuery: query };
  }
  private async render(user: AuthenticatedUser, row: Row): Promise<ContentRecord> {
    const privacy = canonicalContent(config.employeePrivacy);
    const agents = await this.renderAgents(user, row.agent_references);
    const evidence = await this.evidence(user, row.baseline);
    await this.assertRowsCurrent(user, [row], false);
    if (privacy !== canonicalContent(config.employeePrivacy)) throw new AppError(409, "adoption_read_invalidated", "Privacy changed during this read; reload current evidence.");
    currentAuthority()?.assertCurrent();
    return { ...row.payload, id: row.id, creatorId: row.creator_id, revision: row.revision,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), baseline: row.baseline,
      agents, links: row.linked_references, evidence, permissions: contentPermissions(user, row) };
  }
  async detail(user: AuthenticatedUser, id: string) {
    staff(user); await reportIdentity(this.database, user);
    return this.render(user, await this.row(this.database, user, contentId(id)));
  }
  async list(user: AuthenticatedUser, input: unknown): Promise<ContentPage> {
    staff(user); await reportIdentity(this.database, user);
    const request = object(input, ["kind", "limit", "cursor"]);
    const kind = request.kind === undefined ? null : choice(request.kind, ["brief", "card", "action"] as const);
    const limit = request.limit === undefined ? 10 : request.limit;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw bad();
    const identity = await reportIdentity(this.database, user);
    const cursorScope = { identity, endpoint: "adoption_content/list", selectionId: identity.tenantId,
      revision: "1", queryHash: canonicalContent([kind, limit]) };
    const after = request.cursor === undefined ? null : this.discovery.reports.codec.decode(text(request.cursor, 4096, false), cursorScope).boundary.id;
    const rows = (await this.database.query<Row>(`SELECT * FROM adoption_content WHERE tenant_id=$1
      AND ($2::text IS NULL OR kind=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
    [user.tenantId, kind, after, Number(limit) + 1])).rows;
    const selected = rows.slice(0, Number(limit));
    const result = { value: await Promise.all(selected.map(row => this.render(user, row))),
      nextCursor: rows.length > Number(limit) ? this.discovery.reports.codec.encode({ ...cursorScope, direction: "next",
        boundary: { id: selected.at(-1)!.id, key: "id", nullRank: 0 } }) : null };
    await this.assertRowsCurrent(user, selected, false);
    if (Buffer.byteLength(JSON.stringify(result)) > 524288) throw new AppError(413, "adoption_output_limit", "Use a smaller page.");
    return result;
  }
  async create(user: AuthenticatedUser, requestId: string, value: unknown): Promise<ContentSave> {
    staff(user);
    const identity = await reportIdentity(this.database, user);
    const requestedAt = createRequestTime(requestId), draft = contentDraft(value);
    const hash = createHash("sha256").update(canonicalContent(draft)).digest("hex");
    // Resolve an existing outcome before an expired read lease is revalidated.
    const existing = await this.database.query<{ content_id: string; payload_hash: string; deleted: boolean }>(
      "SELECT * FROM adoption_content_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3",
      [identity.tenantId, identity.principalId, requestId]);
    const replay = async (receipt: { content_id: string; payload_hash: string; deleted: boolean }): Promise<ContentSave> => {
      if (receipt.payload_hash !== hash) throw new AppError(409, "adoption_request_conflict", "This create identity belongs to different content.");
      try {
        return { id: receipt.content_id, replayed: true, state: receipt.deleted ? "deleted" : "saved",
          record: receipt.deleted ? null : await this.detail(user, receipt.content_id) };
      } catch (error) {
        if (!(error instanceof AppError) || ![404, 409, 410].includes(error.status)) throw error;
        const current = (await this.database.query<{ deleted: boolean }>(
          "SELECT deleted FROM adoption_content_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3",
          [identity.tenantId, identity.principalId, requestId])).rows[0];
        if (current?.deleted) return { id: receipt.content_id, replayed: true, state: "deleted", record: null };
        throw new AppError(503, "adoption_save_outcome_unknown", "The durable outcome could not be rendered. Retain this exact create identity and payload to resolve it; do not create another record.");
      }
    };
    if (existing.rows[0]) return replay(existing.rows[0]);
    if (requestedAt < Date.now() - 7 * day) throw new AppError(409, "adoption_request_expired", "This old create identity cannot create content. Its former outcome must not be replayed as a new save.");
    const cutoff = (await this.database.query<{ cutoff: string }>(
      "SELECT GREATEST(bearer_issued_after,adoption_request_cutoff)::text AS cutoff FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
      [identity.tenantId, identity.principalId])).rows[0];
    if (requestedAt <= Number(cutoff?.cutoff ?? 0)) throw new AppError(409, "adoption_request_revoked", "This unmatched create identity predates actual principal revocation or privacy deletion.");
    const baseline = draft.baseline ? await this.baseline(user, draft.baseline) : null;
    const agents = await this.agents(user, draft.agentIds);
    const result = await transaction(this.database, async client => {
      await this.lock(client, identity.tenantId);
      const receipt = (await client.query<{ content_id: string; payload_hash: string; deleted: boolean }>(
        "SELECT * FROM adoption_content_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3",
        [identity.tenantId, identity.principalId, requestId])).rows[0];
      if (receipt) return receipt;
      const cutoff = (await client.query<{ cutoff: string }>(
        "SELECT GREATEST(bearer_issued_after,adoption_request_cutoff)::text AS cutoff FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
        [identity.tenantId, identity.principalId])).rows[0];
      if (requestedAt <= Number(cutoff?.cutoff ?? 0)) throw new AppError(409, "adoption_request_revoked", "This create identity predates principal revocation or privacy deletion.");
      await this.assertAgentSources(client, identity, agents);
      await this.assertSaveLeases(client, identity, draft);
      const capacity = (await client.query<{ records: string; bytes: string }>(
        "SELECT records::text,bytes::text FROM adoption_content_storage WHERE tenant_id=$1", [user.tenantId])).rows[0];
      if (Number(capacity?.records ?? 0) + 2 > 20000 || Number(capacity?.bytes ?? 0) >= 134217728) {
        throw new AppError(413, "adoption_storage_limit", "Tenant content/receipt capacity is full; remove unwanted content or run existing retention.");
      }
      await this.validateLinks(client, user, draft.linkedIds);
      const { baseline: _baseline, agentIds: _agentIds, linkedIds: _linkedIds, ...payload } = draft;
      const id = randomUUID();
      await client.query(`INSERT INTO adoption_content(id,tenant_id,creator_id,kind,payload,baseline,agent_references,linked_references)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, user.tenantId, user.homeAccountId, draft.kind, JSON.stringify(payload),
        baseline && JSON.stringify(baseline), JSON.stringify(agents), JSON.stringify(draft.linkedIds.map(id => ({ id, state: "available" })))]);
      await client.query(`INSERT INTO adoption_content_receipts(tenant_id,actor_id,request_id,payload_hash,content_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [user.tenantId, user.homeAccountId, requestId, hash, id, new Date(requestedAt + 8 * day)]);
      const added = (await client.query<{ bytes: string }>(`SELECT sum(octet_length(row_to_json(content)::text))::text AS bytes
        FROM (SELECT tenant_id,to_jsonb(record) AS data FROM adoption_content record WHERE id=$1
          UNION ALL SELECT tenant_id,to_jsonb(receipt) FROM adoption_content_receipts receipt WHERE content_id=$1) content`, [id])).rows[0];
      if (Number(capacity?.bytes ?? 0) + Number(added.bytes) > 134217728) {
        throw new AppError(413, "adoption_storage_limit", "This content exceeds the tenant's measured storage capacity.");
      }
      return { content_id: id, payload_hash: hash, deleted: false, fresh: true };
    }, undefined, () => currentAuthority()?.assertCurrent()).catch(storedContentError);
    const response = await replay(result);
    return { ...response, replayed: !("fresh" in result) };
  }
  private async validateLinks(client: pg.PoolClient, user: AuthenticatedUser, ids: string[]) {
    if (ids.length && (await client.query("SELECT id FROM adoption_content WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [user.tenantId, ids])).rowCount !== ids.length) throw new AppError(409, "adoption_link_unavailable", "A linked exact tenant record is unavailable.");
  }
  async update(user: AuthenticatedUser, id: string, input: unknown) {
    staff(user); await reportIdentity(this.database, user);
    const request = object(input, ["expectedRevision", "draft", "status", "progress"]);
    const expected = request.expectedRevision;
    if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw bad();
    const draft = request.draft === undefined ? null : contentDraft(request.draft);
    if (draft && (request.status !== undefined || request.progress !== undefined || draft.baseline)) throw bad();
    const previous = draft ? await this.row(this.database, user, contentId(id)) : null;
    if (previous && previous.revision !== expected) throw conflict();
    const addedAgents = draft ? await this.agents(user, draft.agentIds.filter(id =>
      !previous!.agent_references.some(reference => reference.id === id))) : [];
    const agents = draft ? [...previous!.agent_references.filter(reference => draft.agentIds.includes(reference.id)), ...addedAgents] : null;
    await transaction(this.database, async client => {
      await this.lock(client, user.tenantId);
      const row = await this.row(client, user, contentId(id)), permissions = contentPermissions(user, row);
      if (row.revision !== expected) throw conflict();
      if (draft ? !permissions.core : !permissions.progress) throw new AppError(403, "adoption_edit_denied", "This principal cannot edit those fields.");
      if (draft && draft.kind !== row.kind) throw bad();
      if (addedAgents.length) await this.assertAgentSources(client, await reportIdentity(this.database, user), addedAgents);
      if (draft && (draft.scope.company !== row.payload.scope.company || draft.scope.department !== row.payload.scope.department) && row.baseline) {
        throw new AppError(409, "adoption_baseline_scope_conflict", "A measured record keeps its exact original group. Create a new brief for another group.");
      }
      let payload = row.payload;
      let links = row.linked_references;
      if (draft) {
        const removed = row.linked_references.filter(link => link.state === "removed" && draft.linkedIds.includes(link.id));
        await this.validateLinks(client, user, draft.linkedIds.filter(id => !removed.some(link => link.id === id)));
        links = draft.linkedIds.map(id => ({ id, state: removed.some(link => link.id === id) ? "removed" : "available" }));
        const { baseline: _baseline, agentIds: _agentIds, linkedIds: _linkedIds, ...updated } = draft;
        payload = updated;
      } else {
        if (request.status === undefined || request.progress === undefined) throw bad();
        payload = { ...row.payload, status: choice(request.status, ["open", "in_progress", "completed", "cancelled"] as const),
          progress: text(request.progress) };
      }
      await client.query(`UPDATE adoption_content SET payload=$3,agent_references=$4,linked_references=$5,
        revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [user.tenantId, id, JSON.stringify(payload), JSON.stringify(agents ?? row.agent_references), JSON.stringify(links)]);
      const capacity = (await client.query<{ bytes: string }>(
        "SELECT bytes::text FROM adoption_content_storage WHERE tenant_id=$1", [user.tenantId])).rows[0];
      if (Number(capacity.bytes) > 134217728) throw new AppError(413, "adoption_storage_limit", "This edit exceeds the tenant's measured storage capacity.");
    }, undefined, () => currentAuthority()?.assertCurrent()).catch(storedContentError);
    return this.detail(user, id);
  }
  async delete(user: AuthenticatedUser, id: string, input: unknown) {
    staff(user); await reportIdentity(this.database, user);
    const request = object(input, ["expectedRevision", "confirmation"]);
    if (request.confirmation !== `delete:${contentId(id)}` || !Number.isSafeInteger(request.expectedRevision)) throw bad();
    await transaction(this.database, async client => {
      await this.lock(client, user.tenantId);
      const row = await this.row(client, user, id);
      if (!contentPermissions(user, row).core) throw new AppError(403, "adoption_delete_denied", "Only the creator or tenant Admin can delete this record.");
      if (row.revision !== request.expectedRevision) throw conflict();
      await removeAdoptionContent(client, user.tenantId, id);
    }, undefined, () => currentAuthority()?.assertCurrent());
    return { id, state: "deleted" as const };
  }
  async followUp(user: AuthenticatedUser, id: string, input: unknown): Promise<ContentFollowUp> {
    const original = await this.detail(user, id);
    if (!original.baseline) throw new AppError(409, "adoption_unmeasured", "This manual draft has no measured baseline.");
    const request = object(input, ["groupId", "query"]);
    const query = evidenceQuery(request.query);
    if (!query.officeSelectionId || !query.reportSelectionId || query.company !== original.scope.company
      || query.department !== original.scope.department) throw bad();
    const current = await this.baseline(user, { groupId: text(request.groupId, 128, false), query });
    await this.assertRowsCurrent(user, [original], false);
    currentAuthority()?.assertCurrent();
    return { baseline: original.baseline, current, sameOriginalPeople: false, caveats: [
      "Group-level comparison; membership and licensing may change. No original-participant registry is retained.",
      "Counts do not establish individual conversion, expertise, causal impact, productivity or ROI.",
      ...(original.evidence.state !== "available" ? [`Original exact source is ${original.evidence.state}: ${original.evidence.reason}. The saved baseline is dated, not a replacement source.`] : []),
      ...adoptionWindowCaveats(original.baseline, current),
      ...(canonicalContent(current.group.denominators) !== canonicalContent(original.baseline.group.denominators)
        ? ["Group denominators changed; membership/licensing drift is not attributable to this action."] : []),
      ...(current.group.coverage.state !== "complete" || original.baseline.group.coverage.state !== "complete"
        ? ["Coverage is partial; unknown evidence must not be classified as inactive."] : []),
    ] };
  }
  async shared(user: AuthenticatedUser, input: unknown, previewSubject?: string): Promise<SharedLearningPage> {
    const privacy = canonicalContent(config.employeePrivacy);
    // Reuse active-member/preview admission and current privacy context even with no directory profile.
    await this.discovery.execute(user, { operation: "profile" }, previewSubject);
    const request = object(input, ["id", "company", "department", "limit", "cursor"]);
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw bad();
    const id = request.id === undefined ? null : contentId(request.id);
    const company = request.company === undefined ? null : text(request.company, 256, false);
    const department = request.department === undefined ? null : text(request.department, 256, false);
    const identity = await reportIdentity(this.database, user);
    const scope = { identity, endpoint: "discovery/learning", selectionId: identity.tenantId, revision: "1",
      queryHash: canonicalContent([id, company, department, limit, previewSubject ?? null, config.employeePrivacy]) };
    const after = request.cursor === undefined ? null : this.discovery.reports.codec.decode(text(request.cursor, 4096, false), scope).boundary.id;
    const rows = (await this.database.query<Row>(`SELECT * FROM adoption_content WHERE tenant_id=$1 AND kind='card'
      AND payload->>'visibility'='employees' AND ($2::uuid IS NULL OR id=$2)
      AND ($3::text IS NULL OR payload->'scope'->>'company'=$3) AND ($4::text IS NULL OR payload->'scope'->>'department'=$4)
      AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6`, [user.tenantId, id, company, department, after, Number(limit) + 1])).rows;
    const selected = rows.slice(0, Number(limit));
    const value: SharedLearningCard[] = [];
    for (const row of selected) {
      // Labels are arbitrary staff prose too: incomplete identity evidence explicitly withholds them.
      const safe = (await this.database.query<{ company: string | null; department: string | null }>(
        "SELECT discovery_safe_text($1,'[]'::jsonb,$3,false) AS company,discovery_safe_text($2,'[]'::jsonb,$3,false) AS department",
        [row.payload.scope.company, row.payload.scope.department, true])).rows[0];
      const agents: SharedLearningCard["agents"] = [];
      for (const reference of row.agent_references) {
        try {
          const detail = await this.discovery.execute(user, { operation: "detail", agentId: reference.id }, previewSubject) as DiscoveryDetail;
          const exact = reference.sources.length === detail.agent.sources.length && reference.sources.every(source => detail.agent.sources.some(item => source.source === item.source
            && source.generationId === item.generationId && source.sourceIdentity === item.sourceIdentity && source.revision === item.revision));
          agents.push({ id: reference.id, state: exact ? "available" : "unavailable", agent: exact ? detail.agent : null });
        } catch (error) {
          if (!(error instanceof AppError) || ![404, 409, 410].includes(error.status)) throw error;
          agents.push({ id: reference.id, state: "unavailable", agent: null });
        }
      }
      value.push({ id: row.id, revision: row.revision, learning: row.payload.learning!, title: `Learning: ${row.payload.learning!.task}`,
        evidenceKind: row.payload.evidenceKind, visibility: "employees", agents,
        scope: { ...safe, state: "privacy_withheld" },
        narrative: { state: "privacy_withheld", reason: "arbitrary_prose_identity_evidence_unavailable" },
        attribution: { state: "privacy_withheld" } });
    }
    await this.assertRowsCurrent(user, selected, true);
    if (privacy !== canonicalContent(config.employeePrivacy)) throw new AppError(409, "adoption_read_invalidated", "Privacy changed during this read; reload current evidence.");
    currentAuthority()?.assertCurrent();
    const result = { value, nextCursor: rows.length > Number(limit) ? this.discovery.reports.codec.encode({ ...scope, direction: "next",
      boundary: { id: selected.at(-1)!.id, key: "id", nullRank: 0 } }) : null };
    if (Buffer.byteLength(JSON.stringify(result)) > 524288) throw new AppError(413, "adoption_output_limit", "Use a smaller shared-learning page.");
    return result;
  }
  private async assertRowsCurrent(user: AuthenticatedUser, rows: Pick<Row, "id" | "revision">[], employees: boolean) {
    if (!rows.length) return;
    const count = (await this.database.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM adoption_content content JOIN unnest($2::uuid[],$3::integer[]) wanted(id,revision)
      ON wanted.id=content.id AND wanted.revision=content.revision WHERE content.tenant_id=$1
      AND (NOT $4 OR (content.kind='card' AND content.payload->>'visibility'='employees'))`,
    [user.tenantId, rows.map(row => row.id), rows.map(row => row.revision), employees])).rows[0].count;
    if (count !== rows.length) throw new AppError(409, "adoption_read_invalidated", "Content changed or sharing was removed during this read; reload the current exact record.");
  }
  private async assertSaveLeases(client: pg.PoolClient, identity: SelectionIdentity, draft: ContentDraft) {
    if (!draft.baseline) return;
    const query = draft.baseline.query;
    const ids = [query.reportSelectionId!, query.officeSelectionId!, ...(query.inventorySelectionId ? [query.inventorySelectionId] : [])];
    const scopes = (await client.query<{ scope_id: string }>(
      "SELECT DISTINCT scope_id FROM data_generation_pins WHERE selection_id=ANY($1::uuid[]) ORDER BY scope_id", [ids])).rows;
    for (const scope of scopes) await lockDataScope(client, scope.scope_id, identity.tenantId);
    await this.opportunities.reports.selections.assert(client, query.reportSelectionId!, identity);
    await this.opportunities.office.selections.assert(client, query.officeSelectionId!, identity);
    if (query.inventorySelectionId) await this.opportunities.inventory.selections.assert(client, query.inventorySelectionId, identity);
  }
  private async assertAgentSources(client: pg.PoolClient, identity: SelectionIdentity, agents: ContentAgentReference[]) {
    if (!agents.length) return;
    await lockInventorySources(client, identity);
    for (const agent of agents) {
      const current = (await client.query<{ source_generation_id: string; source_identity: string; control_revision: string }>(
        currentInventorySourcesSql, [identity.tenantId, identity.principalId, agent.id, new Date()])).rows;
      if (current.length !== agent.sources.length || !agent.sources.every(source => current.some(row => row.source_generation_id === source.generationId
        && row.source_identity === source.sourceIdentity && String(row.control_revision) === source.revision))) {
        throw new AppError(409, "adoption_agent_source_changed", "The exact agent source changed before save; capture its current source explicitly.");
      }
    }
  }
}

export async function removeAdoptionContent(client: pg.PoolClient, tenantId: string, id: string) {
  await client.query(`UPDATE adoption_content SET linked_references=(
    SELECT coalesce(jsonb_agg(CASE WHEN link->>'id'=$2::text THEN jsonb_build_object('id',$2::text,'state','removed') ELSE link END),'[]'::jsonb)
    FROM jsonb_array_elements(linked_references) link),revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND linked_references @> jsonb_build_array(jsonb_build_object('id',$2::text))`, [tenantId, id]);
  await client.query("UPDATE adoption_content_receipts SET deleted=true WHERE tenant_id=$1 AND content_id=$2", [tenantId, id]);
  await client.query("DELETE FROM adoption_content WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
}
