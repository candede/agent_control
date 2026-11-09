import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDiscovery, discoveryCard, discoveryRequest } from "./agentDiscovery.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "./dataSelections.js";
import * as identities from "./reportIdentity.js";
import type { DiscoveryProfile } from "../types/agentDiscovery.js";
import { digest } from "../db/dataBounds.js";
import type { UserSourceMetadata } from "../types/userSources.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("bounded positive discovery contracts", () => {
  it.each([
    null, [], {}, { operation: "unknown" }, { operation: "profile", subject: "other" },
    { operation: "search", owner: "hidden" }, { operation: "search", includeIdentity: true },
    { operation: "search", goal: "x".repeat(513) }, { operation: "search", terms: Array(9).fill("a") },
    { operation: "search", terms: ["x".repeat(129)] }, { operation: "search", terms: ["a", "A"] },
    { operation: "search", terms: [""] }, { operation: "search", limit: 21 }, { operation: "search", limit: 0 },
    { operation: "search", cursor: "forged" }, { operation: "detail", agentId: "native-id" },
    { operation: "workplace", company: "override" }, { operation: "workplace", scope: "tenant" },
    { operation: "profile", hide_employee_details: false }, { operation: "profile", selectionId: [] },
    { operation: "search", goal: "unsafe\ncontrol" }, { operation: "search", terms: [null] },
    { operation: "search", limit: 1.5 }, { operation: "search", limit: "5" },
    { operation: "detail", agentId: "90000000-0000-4000-8000-000000000001",
      selectionId: "90000000-0000-4000-8000-000000000002", cursor: "x".repeat(4097) },
    { operation: "workplace", scope: ["department"] }, { operation: "workplace", scope: ["company"] },
    { operation: "workplace", scope: ["both"] }, { operation: "workplace", scope: [["company"]] },
    { operation: "workplace", scope: { toString: null } },
  ])("rejects malformed, unsupported or forged input %j", input => {
    expect(() => discoveryRequest(input)).toThrow("supported bounded");
  });
  it("accepts exact goal/term/card boundaries", () => {
    expect(discoveryRequest({ operation: "search", goal: "g".repeat(512),
      terms: Array.from({ length: 8 }, (_, i) => `${i}${"t".repeat(127)}`), limit: 20 })).toMatchObject({ limit: 20 });
  });
  it.each(["department", "company", "both"] as const)("accepts the exact workplace scope %s", scope => {
    expect(discoveryRequest({ operation: "workplace", scope })).toEqual({ operation: "workplace", scope });
  });
  it("accepts workplace reads with the default scope omitted", () => {
    expect(discoveryRequest({ operation: "workplace" })).toEqual({ operation: "workplace" });
  });
  it("normalizes accepted UUID detail identities without changing the caller's request", () => {
    const input = { operation: "detail", agentId: "ABCDEF01-2345-6789-ABCD-0123456789AB" };
    expect(discoveryRequest(input)).toEqual({ ...input, agentId: input.agentId.toLowerCase() });
    expect(input.agentId).toBe("ABCDEF01-2345-6789-ABCD-0123456789AB");
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("allowlists nested fields under privacy %s/%s", (employee, champion) => {
    const row = { identity: "canonical", title: "Task", description: "Business requirements document review",
      description_state: "available" as const,
      origin: "organization_created" as const, origin_evidence: [],
      had_title: true, had_description: true, lifecycle: "draft" as const, evidence_complete: true,
      people: [{ id: "object-id", name: "Allowed owner", contact: "owner@example.invalid", company: "A", department: "R",
        responses: 999, license: "secret" }],
      affiliations: [{ company: "A", department: "R", objectId: "object-id" }],
      sources: [{ source: "graph_packages" as const, observedAt: "2026-11-06T00:00:00Z", descriptionField: "longDescription" as const,
        generationId: "source-generation", sourceIdentity: "source-record", revision: "revision",
        descriptionState: "available" as const, secret: "raw-report" }],
      evidence: [{ source: "power_platform" as const, field: "description" as const,
        generationId: "native-generation", sourceIdentity: "native-record", revision: "revision",
        excerpt: "Business requirements document review", responses: 123 }],
      responses: 123, controls: { token: "secret" } };
    const card = discoveryCard(row, { hide_employee_details: employee, hide_champion_employee: champion });
    const raw = JSON.stringify(card);
    expect(raw).not.toMatch(/responses|license|object-id|raw-report|controls|token/);
    expect(card.evidence).toHaveLength(1);
    expect(card.evidence[0].source).toBe("power_platform");
    expect(card.people.value).toHaveLength(employee ? 0 : 1);
    expect(card.people.state).toBe(employee ? "privacy_withheld" : "available");
  });
});

describe("canonical discovery subject identities", () => {
  it.each([
    ["self", false], ["self", true], ["preview", false], ["preview", true],
  ] as const)("resolves an uppercase %s object ID with a pinned selection: %s", async (mode, pinned) => {
    const database = new pg.Pool({ max: 4 });
    try {
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
      const discovery = new AgentDiscovery(database, "synthetic-discovery-identity-regression-secret");
      const identity: SelectionIdentity = { tenantId: "discovery-identity-tenant", principalId: "discovery-identity-principal",
        authorizationHash: "viewer", sessionEpoch: "1" };
      vi.spyOn(identities, "reportIdentity").mockResolvedValue(identity);
      const subject = "ABCDEF01-2345-6789-ABCD-0123456789AB";
      const generation = "22222222-2222-4222-8222-222222222222";
      const now = new Date("2026-11-06T00:00:00Z");
      const expiresAt = new Date(now.getTime() + 600_000);
      const profile = { identity: subject.toLowerCase(), display_name: "Saved member", upn: "member@example.invalid",
        company: "Saved company", department: "Saved department", account_enabled: true, user_type: "Member" };
      const binding = { mode, subject: profile.identity, profile: digest(JSON.stringify([generation, profile])),
        directory: generation, report: null, association: "0" };
      const selection = { id: "11111111-1111-4111-8111-111111111111", revision: "1", evaluatedAt: now,
        validatedAt: now, expiresAt, endpoint: "agent_discovery", queryHash: "a".repeat(64) };
      const source = (kind: UserSourceMetadata["source"]): UserSourceMetadata => ({
        source: kind, generationId: kind === "directory" ? generation : null, scopeId: "directory-scope", revision: "1",
        expiresAt: expiresAt.toISOString(), observedAt: now.toISOString(), attemptedAt: null, attemptStatus: null,
        attemptObservedCount: null, errorCode: null, message: null, rowCount: 1, state: "available",
        reportRefreshDate: null, period: null, reportVersion: null,
      });
      vi.spyOn(discovery.reports.sources, "metadataInRead").mockResolvedValue({
        directory: source("directory"), app_activity: source("app_activity"),
      });
      const report = { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
        availability: "never_imported" as const, staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
        acceptedAt: null, expiresAt: null, reportingPeriod: null, lineages: [] };
      vi.spyOn(discovery.reports, "latestDiscoveryReport").mockResolvedValue(report);
      vi.spyOn(discovery.reports, "discoveryReport").mockResolvedValue(report);
      vi.spyOn(discovery.reports, "prepareHistoryCapture").mockResolvedValue();
      vi.spyOn(discovery.reports.sources, "ensureScope").mockResolvedValue("source-scope");
      vi.spyOn(discovery.reports.history, "root").mockResolvedValue({
        kind: "tenant_history", scopeId: "history-scope", revision: "0", expiresAt,
      });
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const profileSubjects: unknown[] = [];
      const agentId = "ABCDEF02-2345-6789-ABCD-0123456789AB";
      const card = { identity: agentId.toLowerCase(), title: "Saved agent", description: "x".repeat(4097),
        description_state: "available",
        origin: "organization_created", origin_evidence: [],
        had_title: true, had_description: true, lifecycle: "unknown", people: [], affiliations: [],
        evidence_complete: true, sources: [] };
      const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async (statement, values) => {
        const sql = String(statement);
        const rows = sql.startsWith("SELECT identity,display_name,upn") ? (() => {
          profileSubjects.push(values?.[1]);
          return values?.[1] === profile.identity ? [profile] : [];
        })() : sql.includes("inventory_association_revision") ? [{ revision: "0" }]
          : sql.includes("source='user_sources'") ? [{ id: "source-scope", epoch: "1" }]
            : sql.includes("SELECT * FROM catalog") ? Array.isArray(values?.[12]) && values[12].includes(card.identity) ? [card] : []
              : sql.includes("WHERE agent_id=ANY($13::text[])") ? [{ agent_id: card.identity }]
                : sql.includes("discovery_safe_text") ? [{ company: profile.company, department: profile.department }] : [];
        return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
      });
      vi.spyOn(client, "query").mockImplementation(query);
      const capture = vi.spyOn(discovery.reports.selections, "captureWith").mockImplementation(async (_identity, _endpoint, _query, prepare) => {
        const prepared = await prepare(client, now);
        expect(prepared.queryValues).toEqual(binding);
        return selection;
      });
      vi.spyOn(discovery.reports.selections, "read").mockImplementation((_id, _identity, work) => work(client, {
        selection: { endpoint: selection.endpoint, query_json: binding,
          query_hash: canonicalQuery(binding, Object.keys(binding)),
          revision: selection.revision, evaluated_at: now, validated_at: now, expires_at: expiresAt },
        pins: [],
      }));
      const user = { displayName: "Employee", username: "member@example.invalid",
        homeAccountId: identity.principalId, localAccountId: subject, tenantId: identity.tenantId,
        roles: ["AgentControl.Viewer" as const] };
      const preview = mode === "preview" ? subject : undefined;
      const result = await discovery.execute(user,
      { operation: "profile", ...(pinned ? { selectionId: selection.id } : {}) }, mode === "preview" ? subject : undefined);
      expect(result.context).toMatchObject({ mode, profileState: "available", company: profile.company, department: profile.department });
      const detail = await discovery.execute(user, { operation: "detail", agentId, selectionId: selection.id }, preview);
      if (!("agent" in detail)) throw new Error("Expected discovery detail");
      expect(detail.agent.id).toBe(card.identity);
      expect(detail.description.text).toBe("x".repeat(4096));
      expect(detail.nextCursor).toBeTypeOf("string");
      const continuation = await discovery.execute(user, { operation: "detail", agentId: card.identity,
        selectionId: selection.id, cursor: detail.nextCursor }, preview);
      expect(continuation).toMatchObject({ description: { text: "x", clipped: false }, nextCursor: null });
      expect(profileSubjects).toEqual(Array(pinned ? 3 : 4).fill(profile.identity));
      expect(capture).toHaveBeenCalledTimes(pinned ? 0 : 1);
      expect(database.connect).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });
});

describe("discovery report history preparation", () => {
  it.each([0, 1, 5, 9])("drains %i expired sets before capturing a fresh discovery selection", async expired => {
    const database = new pg.Pool({ max: 4 });
    try {
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
      const discovery = new AgentDiscovery(database, "synthetic-discovery-history-regression-secret");
      const identity: SelectionIdentity = { tenantId: "discovery-history-tenant", principalId: "discovery-history-principal",
        authorizationHash: "viewer", sessionEpoch: "1" };
      vi.spyOn(identities, "reportIdentity").mockResolvedValue(identity);
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(discovery.reports.history.connections, "run").mockImplementation(work => work(client));
      const ensure = vi.spyOn(discovery.reports.history, "ensure").mockResolvedValue("history-scope");
      const reconcile = vi.spyOn(discovery.reports.history, "reconcileHead").mockResolvedValue({ active_set_id: null, revision: "1" });
      let remaining = expired;
      const expire = vi.spyOn(discovery.reports.history, "expire").mockImplementation(async () => {
        const batch = Math.min(4, remaining);
        remaining -= batch;
        return batch;
      });
      vi.spyOn(discovery.reports.sources, "ensureScope").mockResolvedValue("source-scope");
      const selection = { id: "11111111-1111-4111-8111-111111111111", revision: "1",
        expiresAt: new Date("2026-11-06T00:10:00Z"), evaluatedAt: new Date("2026-11-06T00:00:00Z"),
        validatedAt: new Date("2026-11-06T00:00:00Z"), endpoint: "agent_discovery", queryHash: "a".repeat(64) };
      const capture = vi.spyOn(discovery.reports.selections, "captureWith").mockImplementation(async () => {
        if (remaining) throw new SelectionError("selection_invalidated");
        return selection;
      });
      const profile: DiscoveryProfile = {
        context: { mode: "self", subject: "current_account", company: null, department: null, profileState: "unavailable" },
        selection: { id: selection.id, revision: selection.revision, expiresAt: selection.expiresAt.toISOString() },
        privacy: { hide_employee_details: false, hide_champion_employee: false }, period: null, reportState: "unavailable",
        ownChampion: { state: "unavailable", reason: "saved_subject_report_link_unavailable" },
      };
      vi.spyOn(discovery.reports.selections, "read").mockResolvedValue(profile);
      await expect(discovery.execute({ displayName: "Employee", username: "employee@example.invalid",
        homeAccountId: identity.principalId, localAccountId: "employee-subject", tenantId: identity.tenantId,
        roles: ["AgentControl.Viewer"] }, { operation: "profile" })).resolves.toEqual(profile);
      expect(remaining).toBe(0);
      expect(expire).toHaveBeenCalledTimes(Math.ceil(expired / 4) + 1);
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(client, identity.tenantId);
      expect(reconcile.mock.invocationCallOrder[0]).toBeGreaterThan(ensure.mock.invocationCallOrder[0]);
      expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(expire.mock.invocationCallOrder[0]);
      expect(expire.mock.invocationCallOrder.at(-1)).toBeLessThan(capture.mock.invocationCallOrder[0]);
      expect(database.connect).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });
});
