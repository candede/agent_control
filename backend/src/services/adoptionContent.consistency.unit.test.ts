import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdoptionContent } from "./adoptionContent.js";
import { manualDraft } from "./adoptionContentTestSupport.js";
import * as identities from "./reportIdentity.js";
import { emptyOfficeCoverage } from "./officeAppAdoption.js";
import type { ContentBaseline, ContentRecord } from "../types/adoptionContent.js";
import type { DiscoveryDetail } from "../types/agentDiscovery.js";
import type { OpportunityPage } from "../types/departmentOpportunity.js";
import type { AuthenticatedUser } from "../types/session.js";

afterEach(() => vi.restoreAllMocks());

const user: AuthenticatedUser = {
  tenantId: "content-consistency-tenant", homeAccountId: "content-author", localAccountId: "content-author",
  username: "author@example.invalid", displayName: "Synthetic author", roles: ["AgentControl.Viewer"],
};
const identity = { tenantId: user.tenantId!, principalId: user.homeAccountId, sessionEpoch: "0", authorizationHash: "a".repeat(64) };
const id = "10000000-0000-4000-8000-000000000001";
const source: DiscoveryDetail["agent"]["sources"][number] = {
  source: "graph_packages", generationId: "10000000-0000-4000-8000-000000000002",
  sourceIdentity: "synthetic-package", revision: "10000000-0000-4000-8000-000000000003",
  observedAt: "2026-11-01T00:00:00Z", descriptionField: "longDescription", descriptionState: "absent",
};
const detail: DiscoveryDetail = {
  context: { mode: "self", subject: "current_account", company: null, department: null, profileState: "unavailable" },
  selection: { id, revision: "1", expiresAt: "2030-01-01T00:00:00Z" },
  privacy: { hide_employee_details: false, hide_champion_employee: false },
  agent: { id, origin: { kind: "organization_created", evidence: [] }, title: { state: "available", text: "Synthetic agent" },
    description: { state: "absent", text: null, clipped: false }, lifecycle: "published",
    people: { state: "absent", value: [] }, affiliations: [], useLink: { state: "absent", text: null }, evidence: [],
    sources: [source] },
  description: { state: "absent", text: null, clipped: false }, nextCursor: null,
};
function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}
function fixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(identities, "reportIdentity").mockResolvedValue(identity);
  const service = new AdoptionContent(database);
  const draft = manualDraft();
  const record: ContentRecord = {
    ...draft, id, revision: 1, creatorId: user.homeAccountId,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    baseline: null, agents: [], links: [], evidence: { state: "unmeasured", reason: null, freshQuery: null },
    permissions: { core: true, progress: false },
  };
  vi.spyOn(service, "detail").mockResolvedValue(record);
  vi.spyOn(service.discovery, "execute").mockResolvedValue(detail);
  const state = { sources: [source], current: true, cutoff: 0 };
  const query = vi.fn(async (statement: unknown) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.includes("SELECT GREATEST(bearer_issued_after,adoption_request_cutoff)")) return result([{ cutoff: String(state.cutoff) }]);
    if (statement.startsWith("SELECT * FROM adoption_content_receipts")) return result();
    if (statement.startsWith("SELECT * FROM adoption_content WHERE")) return result([{
      id, revision: 1, creator_id: user.homeAccountId, kind: "brief", payload: draft, agent_references: [], linked_references: [],
    }]);
    if (statement.includes("FROM adoption_content content JOIN unnest")) return result([{ count: state.current ? 1 : 0 }]);
    if (statement.startsWith("SELECT * FROM inventory_live_sources")) return result(state.sources.map(item => ({
      source_generation_id: item.generationId, source_identity: item.sourceIdentity, control_revision: item.revision,
    })));
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: identity.sessionEpoch }]);
    if (statement.startsWith("WITH inventory AS")) return result();
    if (statement.includes("FROM adoption_content_storage")) return result([{ records: "0", bytes: "0" }]);
    if (statement.startsWith("SELECT sum(octet_length")) return result([{ bytes: "1024" }]);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) || statement.includes("pg_advisory_xact_lock")
      || statement.startsWith("INSERT INTO data_principal_epochs")
      || statement.startsWith("INSERT INTO adoption_content")
      || statement.startsWith("UPDATE adoption_content SET")) return result();
    throw new Error(`Unexpected mocked content query: ${statement}`);
  });
  vi.spyOn(database, "query").mockImplementation(query);
  vi.spyOn(client, "query").mockImplementation(query);
  return { service, state, query, record, client };
}

describe("adoption content consistency across awaited work", () => {
  it.each(["create", "update"] as const)("rejects an added agent source before %s commits", async operation => {
    const { service, state, query, client } = fixture();
    state.sources.push({ ...source, source: "power_platform", sourceIdentity: "synthetic-studio-agent" });
    const draft = { ...manualDraft(), agentIds: [id] };
    const pending = operation === "create"
      ? service.create(user, `${Date.now()}.${id}`, draft)
      : service.update(user, id, { expectedRevision: 1, draft });
    await expect(pending).rejects.toMatchObject({ status: 409, code: "adoption_agent_source_changed" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(query.mock.calls.some(([sql]) => typeof sql === "string" && /^(INSERT INTO|UPDATE) adoption_content\b/.test(sql))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it.each(["create", "update"] as const)("preserves an unchanged exact agent source on %s", async operation => {
    const { service, query } = fixture();
    const draft = { ...manualDraft(), agentIds: [id] };
    const response = operation === "create"
      ? await service.create(user, `${Date.now()}.${id}`, draft)
      : await service.update(user, id, { expectedRevision: 1, draft });
    expect(response.id).toBeTruthy();
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
  });
  it("preserves the independent adoption-request retry cutoff", async () => {
    const { service, state } = fixture();
    state.cutoff = Date.now() + 30_000;
    await expect(service.create(user, `${state.cutoff}.${id}`, manualDraft()))
      .rejects.toMatchObject({ status: 409, code: "adoption_request_revoked" });
  });
  it.each([false, true])("rechecks the original record after follow-up evidence work (current=%s)", async current => {
    const { service, state, record, query } = fixture();
    const baseline: ContentBaseline = {
      capturedAt: "2026-11-01T00:00:00Z",
      group: {
        id: "exact-group", rank: 1, company: null, department: null,
        office: { savedLicensedPeople: 1, reportedActiveUsers: 1, activeUserAppPairs: 1, appsUsed: 1,
          noRecentEvidencePeople: 0, unknownEvidencePeople: 0,
          perApp: { word: 1, excel: 0, powerpoint: 0, outlook: 0, onenote: 0, loop: 0, teams: 0 } },
        denominators: { officePaid: 1, officeActive: 1, currentDirectory: 1, currentAgentPaid: 1 },
        agentEvidence: { positive: 0, noReported: 1, unknown: 0 },
        coverage: { state: "complete", reasons: [], unresolvedReportIdentities: 0, ambiguousOfficePeople: 0 },
      },
      definitions: { officePaid: "", officeActive: "", currentDirectory: "", currentAgentPaid: "", positive: "", noReported: "", unknown: "" },
      office: { id, kind: "current", period: "D28", reportVersion: "v2", windowStart: "2026-10-05",
        reportRefreshDate: "2026-11-01", capturedAt: "2026-11-01T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z",
        contentHash: "a".repeat(64), directoryGenerationId: id, appGenerationId: id,
        directoryObservedAt: "2026-11-01T00:00:00Z", appObservedAt: "2026-11-01T00:00:00Z", coverage: emptyOfficeCoverage() },
      report: { setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
        availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
        reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] },
    };
    record.baseline = baseline;
    const selection = { id, revision: "1", evaluatedAt: baseline.capturedAt, validatedAt: baseline.capturedAt, expiresAt: baseline.office.expiresAt,
      publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) } };
    const page: OpportunityPage = {
      value: [{ ...baseline.group, drilldowns: {
        audience: { path: "", query: {} }, officePeople: { path: "", query: { selectionId: id } },
        peers: { path: "", query: {}, requiresExactGroupCapture: true }, agents: { path: "", query: {} },
      } }],
      context: { office: { observation: baseline.office, baseline: null, query: {}, selection,
        status: { state: "available", errorCode: null, message: null } },
      report: { selection, query: {}, reports: baseline.report,
        directory: { source: "directory", generationId: null, scopeId: null, revision: null, state: "unavailable",
          observedAt: null, expiresAt: null, attemptedAt: null, attemptStatus: null, attemptObservedCount: null,
          errorCode: null, message: null, rowCount: null, reportRefreshDate: null, period: null, reportVersion: null } },
      inventory: null, inventoryState: "unavailable" },
      definitions: baseline.definitions, counts: { total: 1, filtered: 1 },
      summary: { officeActive: 1, positive: 0, noReported: 1, unknown: 0 }, page: { limit: 10, nextCursor: null },
    };
    vi.spyOn(service.opportunities, "page").mockImplementation(async () => {
      state.current = current;
      return page;
    });
    const pending = service.followUp(user, id, { groupId: baseline.group.id,
      query: { company: null, department: null, officeSelectionId: id, reportSelectionId: id } });
    if (current) {
      await expect(pending).resolves.toMatchObject({ baseline, sameOriginalPeople: false });
    } else {
      await expect(pending).rejects.toMatchObject({ status: 409, code: "adoption_read_invalidated" });
    }
    expect(query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("FROM adoption_content content JOIN unnest"))).toBe(true);
  });
});
