import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import {
  AgentUsageRepository, agentUsageSourceKey, agentUsageTarget, parseRecordId, usageChanged,
  type AgentUsageScope, type AgentUsageSnapshot, type AuthorizedAgentUsageSource,
} from "../db/agentUsage.js";
import { pool } from "../db/pool.js";
import { readUnifiedInventoryRevision } from "../db/unifiedInventoryRevision.js";
import { AppError } from "../errors.js";
import type {
  AgentUsageAssociation, AgentUsageAssociationInput, AgentUsageAssociationRemoval, AgentUsageCandidatePage,
  AgentUsageContext, AgentUsageSummary,
} from "../types/agentUsage.js";
import type { AuditActor, AgentUsageAuditAction } from "../types/audit.js";
import type { AgentUsageRow, OfficialUsageAvailability, PublishedOfficialUsage } from "../types/officialUsage.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { AuditLog } from "./auditLog.js";
import {
  agentUsageAssociationInput, agentUsageAssociationRemoval, type AgentUsageCandidateQuery,
} from "./agentUsageValidation.js";
import { requireAdmissions } from "./maintenance.js";
import { normalizeNativeIdentity } from "./inventoryIdentity.js";

type AuditInput = { actor: AuditActor; requestPath: string };

export class AgentUsageService {
  private readonly repository: AgentUsageRepository;

  constructor(private readonly database: pg.Pool = pool) {
    this.repository = new AgentUsageRepository(database);
  }

  async project(scope: AgentUsageScope, records: readonly UnifiedAgentRecord[], database?: pg.PoolClient) {
    return this.repository.withSnapshot(scope, async client => {
      const sources = await this.repository.readSources(scope, client);
      const snapshot = await this.repository.read(scope, client);
      const result = buildAgentUsageProjection(scope, records, sources, snapshot);
      assertNotExpired(snapshot, sources);
      return result;
    }, database);
  }

  async revision(scope: AgentUsageScope, database?: pg.PoolClient): Promise<string> {
    return this.repository.withSnapshot(scope, async client => {
      const snapshot = await this.repository.read(scope, client);
      const context = buildAgentUsageContext(scope, snapshot);
      assertNotExpired(snapshot);
      return context.revision;
    }, database);
  }

  async candidates(scope: AgentUsageScope, recordId: string, query: AgentUsageCandidateQuery): Promise<AgentUsageCandidatePage> {
    parseRecordId(recordId);
    return this.repository.withSnapshot(scope, async client => {
      const record = await this.repository.resolveRecord(scope, recordId, client);
      const snapshot = await this.repository.read(scope, client);
      const context = buildAgentUsageContext(scope, snapshot);
      const associated = new Set(snapshot.associations.map(value => value.report_agent_id));
      const search = query.search?.toLowerCase();
      const rows = (snapshot.published.reports.agents?.rows ?? [])
        .filter(value => !search || value.agentId.toLowerCase().includes(search) || value.agentName.toLowerCase().includes(search))
        .sort((left, right) => ordinal(left.agentName, right.agentName) || ordinal(left.agentId, right.agentId));
      const value = rows.slice(query.offset, query.offset + query.limit).map(row => ({
        agentId: row.agentId, agentName: row.agentName, creatorType: row.creatorType,
        activeUsersLicensed: row.activeUsersLicensed, activeUsersUnlicensed: row.activeUsersUnlicensed,
        responsesSentToUsers: row.responsesSentToUsers,
        ...(row.lastActivityDateUtc ? { lastActivityDateUtc: row.lastActivityDateUtc } : {}),
        associated: associated.has(row.agentId),
      }));
      assertNotExpired(snapshot, record.sources);
      return { context, value, count: rows.length, offset: query.offset, limit: query.limit };
    });
  }

  async attach(scope: AgentUsageScope, recordId: string, value: AgentUsageAssociationInput, audit: AuditInput) {
    return this.mutate(scope, recordId, agentUsageAssociationInput(value), "associate-agent-usage", audit);
  }

  async remove(scope: AgentUsageScope, recordId: string, value: AgentUsageAssociationRemoval, audit: AuditInput) {
    return this.mutate(scope, recordId, agentUsageAssociationRemoval(value), "remove-agent-usage-association", audit);
  }

  private async mutate(scope: AgentUsageScope, recordId: string, input: AgentUsageAssociationInput | AgentUsageAssociationRemoval,
    action: AgentUsageAuditAction, auditInput: AuditInput): Promise<{ context: AgentUsageContext }> {
    parseRecordId(recordId);
    requireAdmissions();
    const audit = new AuditLog(scope, this.database);
    const metadata = {
      source: "official_usage", reportSetId: input.reportSetId, revision: input.expectedUsageRevision,
      selection: "admin_reviewed", reportAgentHash: hash(input.reportAgentId),
      inventoryRevision: input.expectedInventoryRevision,
    };
    const event = await audit.startEvent({
      operationId: `${action}:${randomUUID()}`, scope: "single", action, agentId: recordId,
      actor: auditInput.actor, requestPath: auditInput.requestPath, metadata,
    });
    try {
      return await this.repository.withSnapshot(scope, async client => {
        const record = await this.repository.resolveRecord(scope, recordId, client);
        const baseRevision = await readUnifiedInventoryRevision(scope, client);
        const snapshot = await this.repository.read(scope, client);
        const context = buildAgentUsageContext(scope, snapshot);
        if (input.reportSetId !== context.reportSet?.id || input.expectedUsageRevision !== context.revision) throw usageChanged();
        if (input.expectedInventoryRevision !== combineAgentInventoryRevision(baseRevision, context.revision)) {
          throw new AppError(409, "inventory_changed", "The authorized inventory changed. Refresh Agents before reviewing this association.");
        }
        const report = snapshot.published.reports.agents?.rows.find(row => row.agentId === input.reportAgentId);
        if (!report) throw new AppError(404, "usage_report_agent_not_found", "Select an exact agent from the active Agents export.");
        const existing = snapshot.associations.find(value => value.report_agent_id === input.reportAgentId);
        let changed = false;
        let selectedSource;
        if ("target" in input) {
          const key = await this.repository.targetKey(input.target, client);
          selectedSource = record.sources.find(source => agentUsageSourceKey(source) === key);
          if (!selectedSource) throw new AppError(403, "usage_target_mismatch", "The selected native source does not belong to this authorized current agent.");
          if (existing && agentUsageSourceKey(existing) !== key) {
            throw new AppError(409, "usage_association_conflict", "This report agent already has a reviewed target. Remove that association explicitly before reassigning it.");
          }
          if (!existing) {
            await this.repository.insert(scope, input.reportSetId, input.reportAgentId, selectedSource, client);
            changed = true;
          }
        } else {
          selectedSource = existing && record.sources.find(source => agentUsageSourceKey(source) === agentUsageSourceKey(existing));
          if (!selectedSource) throw new AppError(404, "usage_association_not_found", "This report identity is not associated with the authorized current agent.");
          await this.repository.remove(scope, input.reportSetId, input.reportAgentId, client);
          changed = true;
        }
        const updated = changed ? await this.repository.read(scope, client) : snapshot;
        // An expiry-aware reread can drop the report and its expiry while the write is in flight.
        if (updated.published.activeSet?.id !== input.reportSetId) throw usageChanged();
        const resultingContext = buildAgentUsageContext(scope, updated);
        // The success receipt and association commit together. A failed audit rolls the mutation back.
        await new AuditLog(scope, client).completeEvent(event.id, {
          status: "succeeded", metadata: {
            ...metadata, revision: resultingContext.revision, changed,
            targetSelectionHash: hash(agentUsageSourceKey(selectedSource)),
          },
        });
        assertNotExpired(updated, record.sources);
        return { context: resultingContext };
      });
    } catch (error) {
      const latest = await audit.getEvent(event.id);
      if (latest?.status !== "succeeded") {
        await audit.completeEvent(event.id, { status: "failed",
          errorCode: error instanceof AppError ? error.code : "agent_usage_association_failed" });
      }
      throw error;
    }
  }
}

export const agentUsage = new AgentUsageService();

export function combineAgentInventoryRevision(baseInventoryRevision: string, usageRevision: string): string {
  return hash(["unified-agent-inventory-with-usage-v1", baseInventoryRevision, usageRevision]);
}

export function buildAgentUsageContext(scope: AgentUsageScope, snapshot: AgentUsageSnapshot, staleAfterDays = config.officialUsageStaleDays): AgentUsageContext {
  const { published } = snapshot;
  const reportSet = published.activeSet;
  const lineages = (["agents", "userAgents", "users"] as const).flatMap(kind => published.reports[kind]?.lineage ?? []);
  const availability = usageAvailability(published, staleAfterDays, snapshot.now);
  const revision = hash(["agent-usage-v2", scope.tenantId, published.activeRevision, snapshot.associationRevision,
    reportSet, lineages, availability, snapshot.expiresAt?.toISOString() ?? null,
    snapshot.associations.map(value => [value.report_agent_id, agentUsageSourceKey(value), value.reviewed_at.toISOString()])]);
  return { reportSet, lineages, availability, revision, expiresAt: snapshot.expiresAt?.toISOString() ?? null };
}

export function buildAgentUsageProjection(scope: AgentUsageScope, records: readonly UnifiedAgentRecord[],
  sources: readonly AuthorizedAgentUsageSource[], snapshot: AgentUsageSnapshot, staleAfterDays = config.officialUsageStaleDays) {
  const context = buildAgentUsageContext(scope, snapshot, staleAfterDays);
  const reports = snapshot.published.reports;
  const available = Boolean(context.reportSet && reports.agents);
  const summaries = new Map<string, AgentUsageSummary>(records.map(record => [record.id, {
    status: available ? "unlinked" : "unavailable", reportSetId: context.reportSet?.id ?? null,
    responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [],
  }]));
  if (summaries.size !== records.length) throw new AppError(409, "agent_usage_integrity", "Usage projection requires unique authorized agent records.");
  if (!available) return { context, summaries };
  const recordsById = new Map(records.map(record => [record.id, record]));
  const packagesByRecord = new Map(records.map(record => [record.id, new Set(record.packages.map(value => value.id))]));
  const recordsBySource = new Map<string, string>();
  const recordsByPackage = new Map<string, string>();
  for (const source of sources) {
    if (source.expires_at <= snapshot.now) continue;
    const record = recordsById.get(`agent:${source.agent_id}`);
    if (!record) continue;
    const belongs = source.source === "graph_packages"
      ? packagesByRecord.get(record.id)!.has(source.native_id)
        && record.observations.packageSnapshots[source.native_id]?.snapshotId === source.package_snapshot_id
      : record.powerPlatformResource !== null
        && normalizeNativeIdentity(record.powerPlatformResource.tenantId) === normalizeNativeIdentity(scope.tenantId)
        && record.powerPlatformResource.nativeId === source.native_id
        && (record.powerPlatformResource.environmentId ?? "") === source.environment_id
        && record.observations.powerPlatform?.snapshotId === source.power_platform_snapshot_id;
    if (!belongs) continue;
    const key = agentUsageSourceKey(source);
    if (recordsBySource.has(key) && recordsBySource.get(key) !== record.id
      || source.source === "graph_packages" && recordsByPackage.has(source.native_id)
        && recordsByPackage.get(source.native_id) !== record.id) {
      throw new AppError(409, "agent_usage_integrity", "A saved source identity belongs to multiple agents. Refresh inventory before attributing usage.");
    }
    recordsBySource.set(key, record.id);
    if (source.source === "graph_packages") recordsByPackage.set(source.native_id, record.id);
  }
  const reportAgents = new Map(reports.agents!.rows.map(value => [value.agentId, value]));
  const matches: Array<{ recordId: string; association: AgentUsageAssociation }> = [];
  const reviewed = new Set<string>();
  for (const association of snapshot.associations) {
    if (reviewed.has(association.report_agent_id)) continue;
    reviewed.add(association.report_agent_id);
    const recordId = recordsBySource.get(agentUsageSourceKey(association));
    if (!recordId) continue;
    const report = reportAgents.get(association.report_agent_id);
    if (!report) throw new AppError(409, "agent_usage_integrity", "A reviewed association no longer has its immutable Agents export evidence.");
    matches.push({ recordId, association: {
      reportAgentId: report.agentId, reportAgentName: report.agentName, target: agentUsageTarget(association),
      basis: "admin_reviewed", reviewedAt: association.reviewed_at.toISOString(),
    } });
  }
  for (const report of reportAgents.values()) {
    // Explicit reviewed mappings remain overrides; automatic matches never reassign them.
    if (reviewed.has(report.agentId)) continue;
    const recordId = recordsByPackage.get(report.agentId);
    if (!recordId) continue;
    matches.push({ recordId, association: {
      reportAgentId: report.agentId, reportAgentName: report.agentName,
      target: { source: "graph_packages", packageId: report.agentId }, basis: "exact_package_id",
    } });
  }
  const bridge = new Map<string, Set<string>>();
  for (const row of reports.userAgents?.rows ?? []) {
    const users = bridge.get(row.agentId) ?? new Set<string>();
    if (row.responsesSentToUsers > 0) users.add(row.username);
    bridge.set(row.agentId, users);
  }
  const usersByRecord = new Map<string, Set<string>>();
  const unknownUsers = new Set<string>();
  for (const { recordId, association } of matches) {
    const report = reportAgents.get(association.reportAgentId)!;
    const summary = summaries.get(recordId)!;
    summary.status = "linked";
    summary.responses = addResponses(summary.responses ?? 0, report);
    const activity = report.lastActivityDateUtc ?? null;
    if (activity && (!summary.lastActivityDateUtc || activity > summary.lastActivityDateUtc)) summary.lastActivityDateUtc = activity;
    summary.associations.push(association);
    const users = usersByRecord.get(recordId) ?? new Set<string>();
    const identities = bridge.get(report.agentId);
    if (!identities) unknownUsers.add(recordId);
    else for (const identity of identities) users.add(identity);
    usersByRecord.set(recordId, users);
  }
  for (const [recordId, users] of usersByRecord) {
    summaries.get(recordId)!.activeUsers = unknownUsers.has(recordId) ? null : users.size;
  }
  return { context, summaries };
}

function usageAvailability(published: PublishedOfficialUsage, staleAfterDays: number, now: Date): OfficialUsageAvailability {
  if (published.activeSelectionIncomplete) return "incomplete";
  if (!published.activeSet) return published.retainedIncompleteSets > 0 ? "incomplete"
    : published.retainedCompleteSets > 0 ? "not_selected" : published.hasImportHistory ? "deleted" : "never_imported";
  const endDate = published.activeSet.reportingPeriod.endDate;
  const end = endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : Number.NaN;
  const accepted = published.activeSet.acceptedAt ? Date.parse(published.activeSet.acceptedAt) : Number.NaN;
  return [end, accepted].some(value => Number.isFinite(value)
    && Math.floor((now.getTime() - value) / 86_400_000) > staleAfterDays) ? "stale" : "active";
}

function assertNotExpired(snapshot: AgentUsageSnapshot, sources: readonly AuthorizedAgentUsageSource[] = []) {
  const now = Math.max(Date.now(), snapshot.now.getTime());
  if (snapshot.expiresAt && snapshot.expiresAt.getTime() <= now
    || sources.some(source => source.expires_at.getTime() <= now)) throw usageChanged();
}

function addResponses(current: number, report: AgentUsageRow) {
  const sum = current + report.responsesSentToUsers;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new AppError(409, "agent_usage_total_limit", "The associated response total exceeds the exact numeric range.");
  return sum;
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
