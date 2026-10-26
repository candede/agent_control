import { afterEach, describe, expect, it, vi } from "vitest";
import { setupAuditOriginHttp as sharedHttpSetup, closeAuditOriginHttp } from "./auditOriginHttpTestSupport.js";
import { deleteUsageSet, saveUsageInventory, usageIdentity } from "../db/agentUsageTestSupport.js";
import { generationInput } from "../../scripts/largeTenantFixtures.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { AgentAboutPage, SavedRelationshipPage, ChampionAgentPage, UserResolution } from "../types/savedReadContracts.js";
import type { CandidateAgentUsageHistory } from "../types/officialReportApi.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { config } from "../config.js";
import type pg from "pg";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { observeQueryWork, observeTransactionStart, checkpointQueries } from "../services/peakMemory.js";
import { SavedReadContracts } from "../services/savedReadContracts.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { account, guest, guestHome, guestTenant, tenant } from "../auth/authFoundationTestSupport.js";
import type { UnifiedAgentInventoryPage } from "../types/unifiedAgents.js";
import { DataGenerations } from "../db/dataGenerations.js";
import type { AdoptionPage } from "../types/adoption.js";
import type { ReportPage, ReportAgent } from "../types/officialReportData.js";
import { sdkJourney, type SdkCall } from "./mcpSdkJourneyTestSupport.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{ tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic-only", domains: ["example.invalid"],
    integration: { clientId: "33333333-3333-3333-3333-333333333333", audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" } }]);
});
const corpus = JSON.parse(readFileSync(new URL("../../scripts/fixtures/mcp-workflows.json", import.meta.url), "utf8"));
const alex: string = corpus.ids.nativePerson;
const canonical = (n: number) => `${corpus.ids.canonicalPrefix}${String(n).padStart(12, "0")}`;
const person = (n: number) => `${corpus.ids.personPrefix}${String(n).padStart(12, "0")}`;
const reportSet = (n: number) => `${corpus.ids.reportPrefix}${String(n).padStart(12, "0")}`;
const setupAuditOriginHttp = (transport: "webapp" | "mcp", selected = account()) =>
  sharedHttpSetup(transport, selected, "44444444-4444-4444-4444-444444444444");
function user(id: string, username: string, name = "Same name"): CopilotDirectoryUser {
  return { serviceEvidenceVersion: 1, identity: { objectId: id, userPrincipalName: username, displayName: name,
    companyName: "Example Company", department: "Research", employeeType: null, accountEnabled: true, userType: "Member" },
    copilotServiceState: "unknown", servicePlans: [] };
}
async function directory(database: pg.Pool, identity: SelectionIdentity, users: CopilotDirectoryUser[]) {
  const stages = new UserSourceStages(database);
  await stages.execute(generationInput({ sessionEpoch: identity.sessionEpoch,
    scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }), async lease => {
    const query = await stages.query(lease, "discovery", "phase04");
    await stages.page(lease, query, "phase04", users.length, users.length);
    for (let offset = 0; offset < users.length; offset += 250) await stages.directory(lease, query, users.slice(offset, offset + 250));
    await stages.finishQuery(lease, query);
  }, { beforePublish: async () => {} });
}
async function reports(database: pg.Pool, identity: SelectionIdentity, rows: { agents: string[]; userAgents: string[]; users: string[] },
  window?: { start: string; end: string }, setId?: string) {
  const imports = new OfficialReportImports(database), bundleId = randomUUID();
  for (const kind of ["agents", "userAgents", "users"] as const) {
    await imports.stage(identity, { bundleId }, (async function* () {
      yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows[kind].join("\n")}\n`);
    })(), window ? { reportingPeriod: { startDate: window.start, endDate: window.end, provenance: "operator_asserted" } } : {});
  }
  const originals = new Map<pg.PoolClient, pg.PoolClient["query"]>();
  const stop = setId ? observeTransactionStart(async client => {
    if (originals.has(client)) return;
    const original = client.query; originals.set(client, original);
    client.query = ((...args: unknown[]) => {
      // Pin only this real acceptance INSERT's synthetic identifier; retain all SQL, receipts, grants and triggers.
      if (typeof args[0] === "string" && args[0].includes("INSERT INTO official_usage_sets(") && Array.isArray(args[1])) {
        args[1] = [setId, ...args[1].slice(1)];
      }
      return Reflect.apply(original, client, args);
    }) as typeof client.query;
  }) : undefined;
  try {
    const result = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    if (setId) expect(result.setId).toBe(setId);
    return result;
  } finally {
    stop?.(); for (const [client, original] of originals) client.query = original;
  }
}
async function json<T>(request: Awaited<ReturnType<typeof setupAuditOriginHttp>>["request"], path: string): Promise<T> {
  const response = await request(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function selections(database: pg.Pool, scope: { tenantId: string; principalId: string },
  actor: Awaited<ReturnType<typeof setupAuditOriginHttp>>["actor"], request: Awaited<ReturnType<typeof setupAuditOriginHttp>>["request"],
  endpoint: "copilot_users" | "adoption" = "copilot_users") {
  const identity = { ...await reportIdentity(database, actor) };
  const reports = new LargeTenantUsersReports(database, config.sessionSecret, 35);
  const selected = await json<{ selection: { id: string } }>(request, endpoint === "adoption"
    ? `/copilot-usage/adoption?${new URLSearchParams({ company: "~string:Example Company", department: "~string:Research", limit: "1" })}`
    : "/copilot-usage/users?limit=1");
  const source = await json<{ selection: { id: string } }>(request, "/agent-inventory?limit=1");
  const bound = (await database.query("SELECT tenant_id,principal_id,authorization_hash,session_epoch FROM data_read_selections WHERE id=$1", [selected.selection.id])).rows[0];
  expect(bound.tenant_id).toBe(scope.tenantId); expect(bound.principal_id).toBe(scope.principalId);
  identity.authorizationHash = bound.authorization_hash;
  const inventory = new InventoryQueries(database, config.sessionSecret);
  return { identity, reports, inventory, selectionId: selected.selection.id, inventorySelectionId: source.selection.id };
}
afterEach(closeAuditOriginHttp);

describe.sequential("canonical phase04 saved reads on real web/bearer handlers", () => {
  it("proves caseA exact IDs, distinct relations, report-only identities, complete pages and full Unicode About on both transports", async () => {
    const outcomes: unknown[] = [];
    for (const transport of ["webapp", "mcp"] as const) {
      const fixture = await setupAuditOriginHttp(transport), { database, scope, request } = fixture;
      const sdkCalls: SdkCall[] = [];
      const identity = await usageIdentity(database, scope);
      await directory(database, identity, [user(alex, "alex@example.invalid"), user(person(1), "duplicate@example.invalid"),
        user(person(2), "DUPLICATE@example.invalid")]);
      const fullText = corpus.caseA.longAbout.unit.repeat(corpus.caseA.longAbout.repeat) + corpus.caseA.adversarialSuffix;
      const nativeTextExpected = corpus.caseA.nativeAbout.unit.repeat(corpus.caseA.nativeAbout.repeat) + corpus.caseA.adversarialSuffix;
      await saveUsageInventory(database, scope, Array.from({ length: 103 }, (_, index) => {
        const n = index + 1;
        return { canonicalId: canonical(n), packages: [`P${n}`], packageFields: { type: "custom", displayName: "Shared name",
          ...n <= corpus.platforms.length ? { platform: corpus.platforms[n - 1] } : {},
          ...n === 101 ? { longDescription: fullText } : {} },
        ...n <= 5 || n === 102 ? { native: { nativeId: `native-${n}`, environmentId: "environment",
          ...n <= 3 ? { createdBy: alex } : {}, ...n === 4 || n === 5 ? { ownerId: alex } : {},
          ...n === 5 ? { lastModifiedBy: alex } : {}, ...n === 102 ? { description: nativeTextExpected } : {} } } : {} };
      }));
      await reports(database, identity, { agents: Array.from({ length: 103 }, (_, i) => `P${i + 1},Shared name,Your org,1,0,1,2026-01-30`),
        userAgents: [...Array.from({ length: 98 }, (_, i) => `P${i + 6},Shared name,Your org,alex@example.invalid,1,2026-01-30`),
          "P_report_only,Report only,Your org,alex@example.invalid,2,2026-01-30", "opaque-report,Opaque,Your org,concealed-identity,3,2026-01-30"],
        users: ["alex@example.invalid,Alex,99,100,2026-01-30", "concealed-identity,Anonymous,1,3,2026-01-30"] });
      const pins = await selections(database, scope, fixture.actor, request);
      const contradictory = await request(`/copilot-usage/users/resolve?${new URLSearchParams({
        username: "alex@example.invalid", selectionId: pins.selectionId, setId: reportSet(1),
      })}`);
      expect(contradictory.status).toBe(400);
      expect(await contradictory.json()).toMatchObject({ code: "invalid_usage_query" });
      const invalidRelation = await request(`/copilot-usage/users/${alex}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship: "maker",
      })}`);
      expect(invalidRelation.status).toBe(400);
      expect(await invalidRelation.json()).toMatchObject({ code: "invalid_usage_query" });
      const narrowed = await json<UnifiedAgentInventoryPage>(request, "/agent-inventory?createdWithinDays=30&limit=1");
      const incomplete = await request(`/copilot-usage/users/${alex}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: narrowed.selection.id, relationship: "created",
      })}`);
      expect(incomplete.status).toBe(400);
      expect(await incomplete.json()).toMatchObject({ code: "relationship_inventory_scope" });
      const resolved = await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({ username: "alex@example.invalid", selectionId: pins.selectionId })}`);
      expect(resolved).toMatchObject({ state: "resolved", objectId: alex, reportedUsername: "alex@example.invalid" });
      sdkCalls.push({ name: "resolve_user", request: { username: "alex@example.invalid", selectionId: pins.selectionId }, expected: resolved });
      expect(await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({ username: "duplicate@example.invalid", selectionId: pins.selectionId })}`))
        .toMatchObject({ state: "ambiguous", objectId: null, directoryMatches: 2 });
      expect(await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({ username: "Same name", selectionId: pins.selectionId })}`))
        .toMatchObject({ state: "unresolved", objectId: null });
      expect(await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({ username: "concealed-identity", selectionId: pins.selectionId })}`))
        .toMatchObject({ state: "concealed_or_unresolved", objectId: null, reportedUsername: "concealed-identity",
          reportIdentityState: "unresolved", concealment: "unknown" });
      const edges: Record<string, string[]> = {};
      for (const relationship of ["used", "created", "owned", "modified"] as const) {
        let cursor: string | undefined;
        const rows = [];
        do {
          const page = await json<SavedRelationshipPage>(request, `/copilot-usage/users/${alex}/agent-relationships?${new URLSearchParams({
            selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship, limit: "50", ...cursor ? { cursor } : {},
          })}`);
          sdkCalls.push({ name: "list_user_agent_relationships", request: { objectId: alex,
            selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship, limit: 50,
            ...cursor ? { cursor } : {} }, expected: page });
          rows.push(...page.value); cursor = page.page.nextCursor ?? undefined;
          expect(page.counts.total).toBe(corpus.caseA.counts[relationship]);
          expect(page.value.every(row => row.personId === alex && row.relationship === relationship)).toBe(true);
          for (const row of page.value) {
            if (row.identityState === "report_only") {
              expect(row.canonicalId).toBeNull(); expect(row.sourceReferences).toBeNull();
            } else {
              expect(row.sourceReferences?.selectionId).toBe(pins.inventorySelectionId);
              expect(row.sourceReferences?.path).toBe(`/api/agent-inventory/${row.id}/members`);
            }
          }
        } while (cursor);
        edges[relationship] = rows.map(row => row.id).sort();
      }
      expect(edges.created).toEqual(corpus.caseA.created.map((n: number) => `agent:${canonical(n)}`));
      expect(edges.owned).toEqual(corpus.caseA.owned.map((n: number) => `agent:${canonical(n)}`));
      expect(edges.modified).toEqual(corpus.caseA.modified.map((n: number) => `agent:${canonical(n)}`));
      expect(edges.used).toEqual([...corpus.caseA.usedCanonicalNumbers.map((n: number) => `agent:${canonical(n)}`), corpus.caseA.usedReportOnlyId].sort());
      const inventoryRows: UnifiedAgentInventoryPage["value"] = [], inventoryCursors = new Set<string>();
      let inventoryCursor: string | undefined, inventoryPages = 0;
      do {
        const page = await json<UnifiedAgentInventoryPage>(request, `/agent-inventory?${new URLSearchParams({
          selectionId: pins.inventorySelectionId, limit: "25", ...inventoryCursor ? { cursor: inventoryCursor } : {},
        })}`);
        sdkCalls.push({ name: "list_agents", request: { selectionId: pins.inventorySelectionId, limit: 25,
          ...inventoryCursor ? { cursor: inventoryCursor } : {} }, expected: page });
        inventoryRows.push(...page.value); inventoryPages++;
        expect(page.value.length).toBeLessThanOrEqual(25);
        expect(inventoryRows.length).toBeLessThanOrEqual(103);
        inventoryCursor = page.page.nextCursor ?? undefined;
        if (inventoryCursor) {
          expect(inventoryCursors.has(inventoryCursor)).toBe(false);
          inventoryCursors.add(inventoryCursor);
        }
      } while (inventoryCursor);
      expect(inventoryPages).toBe(5);
      expect(inventoryRows.map(row => row.id).sort()).toEqual(Array.from({ length: 103 }, (_, index) => `agent:${canonical(index + 1)}`).sort());
      expect(inventoryRows.flatMap(row => row.packages.map(pkg => pkg.platform)).filter(Boolean).sort())
        .toEqual([...corpus.platforms].sort());
      const members = await pins.inventory.members(pins.inventorySelectionId, pins.identity, canonical(101), { limit: 50 });
      const source = members.value[0];
      let cursor: string | undefined, staleAboutCursor: string | undefined, text = "", bytes = 0;
      do {
        const about = await json<AgentAboutPage>(request, `/agent-inventory/agent:${canonical(101)}/about?${new URLSearchParams({
          selectionId: pins.inventorySelectionId, sourceScopeId: source.source_scope_id, sourceIdentity: source.source_identity, field: "long",
          ...cursor ? { cursor } : {},
        })}`);
        sdkCalls.push({ name: "read_agent_about", request: { recordId: `agent:${canonical(101)}`,
          selectionId: pins.inventorySelectionId, sourceScopeId: source.source_scope_id, sourceIdentity: source.source_identity, field: "long",
          ...cursor ? { cursor } : {} }, expected: about });
        expect(about.totalBytes).toBe(Buffer.byteLength(fullText));
        expect(Buffer.byteLength(JSON.stringify(about))).toBeLessThan(524288);
        staleAboutCursor ??= about.nextCursor ?? undefined;
        text += about.text; bytes += about.returnedBytes; cursor = about.nextCursor ?? undefined;
      } while (cursor);
      expect(text).toBe(fullText); expect(bytes).toBe(Buffer.byteLength(fullText));
      const nativeMembers = await pins.inventory.members(pins.inventorySelectionId, pins.identity, canonical(102), { limit: 50 });
      const native = nativeMembers.value.find(member => member.domain === "power_platform")!;
      let nativeText = ""; cursor = undefined;
      do {
        const about = await json<AgentAboutPage>(request, `/agent-inventory/agent:${canonical(102)}/about?${new URLSearchParams({
          selectionId: pins.inventorySelectionId, sourceScopeId: native.source_scope_id, sourceIdentity: native.source_identity, field: "native",
          ...cursor ? { cursor } : {},
        })}`);
        sdkCalls.push({ name: "read_agent_about", request: { recordId: `agent:${canonical(102)}`,
          selectionId: pins.inventorySelectionId, sourceScopeId: native.source_scope_id, sourceIdentity: native.source_identity, field: "native",
          ...cursor ? { cursor } : {} }, expected: about });
        nativeText += about.text; cursor = about.nextCursor ?? undefined;
      } while (cursor);
      expect(nativeText).toBe(nativeTextExpected);
      const missingMembers = await pins.inventory.members(pins.inventorySelectionId, pins.identity, canonical(103), { limit: 50 });
      expect(await json<AgentAboutPage>(request, `/agent-inventory/agent:${canonical(103)}/about?${new URLSearchParams({
        selectionId: pins.inventorySelectionId, sourceScopeId: missingMembers.value[0].source_scope_id,
        sourceIdentity: missingMembers.value[0].source_identity, field: "long",
      })}`)).toMatchObject({ state: "missing", text: null, totalBytes: 0 });
      const adoptionPreview = await json<AdoptionPage>(request, "/copilot-usage/adoption?company=~string%3AExample%20Company&department=~string%3AResearch");
      expect(adoptionPreview.value.flatMap(group => group.agents).find(agent => agent.id === `agent:${canonical(101)}`)?.description)
        .toBe(Array.from(fullText).slice(0, 2048).join(""));
      expect(adoptionPreview.value.flatMap(group => group.agents).find(agent => agent.id === `agent:${canonical(102)}`)?.description)
        .toContain("Saved native About");
      const foreign = { ...pins.identity, principalId: "foreign-private-reader" };
      await expect(pins.inventory.about(pins.inventorySelectionId, foreign, canonical(101), {
        sourceScopeId: source.source_scope_id, sourceIdentity: source.source_identity, field: "long",
      })).rejects.toMatchObject({ code: "selection_invalidated" });
      outcomes.push({ edges, text, resolution: [resolved.state, resolved.objectId, resolved.reportedUsername] });
      if (process.env.AGENT_CONTROL_MCP_SQL_JOURNEY) await sdkJourney(fixture, sdkCalls);
      const continuation = await json<SavedRelationshipPage>(request, `/copilot-usage/users/${alex}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship: "used", limit: "50",
      })}`);
      expect(continuation.page.nextCursor).not.toBeNull();
      await new DataGenerations(database).invalidate(source.source_scope_id, scope.tenantId);
      const invalidated = await request(`/copilot-usage/users/${alex}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship: "used", limit: "50",
        cursor: continuation.page.nextCursor!,
      })}`);
      expect(invalidated.status).toBe(409);
      expect(await invalidated.json()).toMatchObject({ code: "selection_invalidated" });
      expect((await request(`/agent-inventory/agent:${canonical(101)}/about?${new URLSearchParams({
        selectionId: pins.inventorySelectionId, sourceScopeId: source.source_scope_id, sourceIdentity: source.source_identity,
        field: "long", cursor: staleAboutCursor!,
      })}`)).status).toBe(409);
      expect(fixture.providerWork.requests).toBe(0);
      await closeAuditOriginHttp();
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  }, 120000);

  it("keeps guest saved relationships in the verified MSAL home-account scope rather than guessed resource oid.tid", async () => {
    for (const transport of ["webapp", "mcp"] as const) {
      const { database, scope, actor, request, providerWork } = await setupAuditOriginHttp(transport, account(guest, guestHome, guestTenant));
      expect(scope.principalId).toBe(`${guestHome}.${guestTenant}`);
      expect(scope.principalId).not.toBe(`${guest}.${tenant.tenantId}`);
      expect(await json<UserResolution>(request, "/copilot-usage/users/resolve?username=alex%40example.invalid"))
        .toMatchObject({ state: "directory_missing", objectId: null, directoryMatches: 0, reportIdentityState: "missing" });
      const identity = await usageIdentity(database, scope);
      const source = user(guest, "alex@example.invalid"); source.identity.userType = "Guest";
      await directory(database, identity, [source]);
      await saveUsageInventory(database, scope, [{ canonicalId: canonical(1), packages: [],
        native: { nativeId: "Guest-native-only", environmentId: null, createdBy: guest } }]);
      const pins = await selections(database, scope, actor, request);
      const resolved = await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({
        selectionId: pins.selectionId, username: "alex@example.invalid",
      })}`);
      expect(resolved).toMatchObject({ state: "resolved", objectId: guest, reportedUsername: null, reportIdentityState: "missing" });
      const created = await json<SavedRelationshipPage>(request, `/copilot-usage/users/${guest}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship: "created",
      })}`);
      expect(created.value).toMatchObject([{ id: `agent:${canonical(1)}`, relationship: "created", source: "inventory" }]);
      expect(created.relationshipState).toBe("available");
      const used = await json<SavedRelationshipPage>(request, `/copilot-usage/users/${guest}/agent-relationships?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, relationship: "used",
      })}`);
      expect(used).toMatchObject({ value: [], relationshipState: "unavailable", counts: { total: null }, missingReasons: ["userAgents_report_missing"] });
      expect(providerWork.requests).toBe(0);
      await closeAuditOriginHttp();
    }
  }, 120000);

  it("projects only exact portal-ranked champions while retaining report-only and full authorized created/used associations", async () => {
    for (const transport of ["webapp", "mcp"] as const) {
    const { database, scope, request, actor, providerWork } = await setupAuditOriginHttp(transport), identity = await usageIdentity(database, scope);
    await directory(database, identity, Array.from({ length: 5 }, (_, i) => user(person(i + 1), `p${i + 1}@example.invalid`, `Person ${i + 1}`)));
    const additional = [{ n: 9, person: 1 }, { n: 10, person: 2 },
      ...Array.from({ length: 6 }, (_, i) => ({ n: i + 11, person: 3 }))];
    await saveUsageInventory(database, scope, [...[1, 1, 1, 2, 2, 3, 3].map((p, i) => ({
      canonicalId: canonical(i + 1), packages: [`P${i + 1}`], native: { nativeId: `native-${i}`, environmentId: "environment", createdBy: person(p) },
    })), { canonicalId: canonical(8), packages: ["P_nonchampion"], packageFields: { type: "custom" } },
      ...additional.map(row => ({ canonicalId: canonical(row.n), packages: [`P_extra_${row.n}`], packageFields: { type: "custom" } }))]);
    const imported = await reports(database, identity, { agents: ["P1,A,Your org,7,3,10,2026-01-30", "P4,B,Your org,0,0,50,2026-01-30",
      "P6,C,Your org,0,0,20,2026-01-30", "P_nonchampion,D,Your org,0,0,20,2026-01-30",
      ...additional.map(row => `P_extra_${row.n},Extra,Your org,0,0,0,2026-01-30`)],
    userAgents: ["P1,A,Your org,p1@example.invalid,10,2026-01-30", "P4,B,Your org,p2@example.invalid,50,2026-01-30",
      "P6,C,Your org,p3@example.invalid,20,2026-01-30", "P_extra,Extra,Microsoft,p2@example.invalid,0,2026-01-30",
      "P_nonchampion,D,Your org,p4@example.invalid,9,2026-01-30",
      ...additional.map(row => `P_extra_${row.n},Extra,Your org,p${row.person}@example.invalid,1,2026-01-30`)],
    users: ["p1@example.invalid,Person 1,4,10,2026-01-30", "p2@example.invalid,Person 2,3,50,2026-01-30",
      "p3@example.invalid,Person 3,8,20,2026-01-30", "p4@example.invalid,Person 4,1,100,2026-01-30"] });
    const pins = await selections(database, scope, actor, request, "adoption");
    const portal = await json<AdoptionPage>(request, `/copilot-usage/adoption?${new URLSearchParams({ selectionId: pins.selectionId })}`);
    expect(portal.value[0].people.filter(row => row.champion).map(row => row.id)).toEqual([person(1), person(2), person(3)]);
    expect(portal.value[0].agents.map(row => row.id)).toContain(`agent:${canonical(8)}`);
    const aggregate = await json<ReportPage<ReportAgent>>(request, `/official-usage/aggregate?${new URLSearchParams({ setId: imported.setId })}`);
    expect(aggregate.summary).toMatchObject({ reportedResponses: 100, bridgeResponses: 97, licensedOccurrences: 7,
      unlicensedOccurrences: 3, responseReconciliation: "mismatch", activeUsersAreNonAdditive: true });
    let cursor: string | undefined;
    const values = [];
    do {
      const page = await json<ChampionAgentPage>(request, `/copilot-usage/adoption/champions?${new URLSearchParams({
        selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId, limit: "2", ...cursor ? { cursor } : {},
      })}`);
      expect(page).toMatchObject({ company: "Example Company", department: "Research" });
      expect(page.champions.map(row => row.objectId)).toEqual(corpus.caseB.claims.championIds);
      expect(page.champions.map(({ created, responses, agents }) => ({ created, responses, agents }))).toEqual([
        { created: 3, responses: 10, agents: 4 }, { created: 2, responses: 50, agents: 3 }, { created: 2, responses: 20, agents: 8 },
      ]);
      values.push(...page.value); cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(values).toHaveLength(corpus.caseB.associationCount);
    expect(values.map(row => [row.personId, row.id, row.relationship].join("|")).sort()).toEqual([
      ...corpus.caseB.createdEdges.map(([p, n]: [number, number]) => [person(p), `agent:${canonical(n)}`, "created"].join("|")),
      ...corpus.caseB.usedEdges.map(([p, n]: [number, number]) => [person(p), `agent:${canonical(n)}`, "used"].join("|")),
      [person(corpus.caseB.reportOnlyEdge.person), corpus.caseB.reportOnlyEdge.id, "used"].join("|"),
    ].sort());
    expect(values.some(row => row.reportAgentId === "P_nonchampion")).toBe(false);
    expect(values.some(row => row.id === `agent:${canonical(8)}`)).toBe(false);
    expect(values).toContainEqual(expect.objectContaining({ id: "report:P_extra", relationship: "used" }));
    const malformed = await request("/copilot-usage/adoption?adoptionChamps=maybe");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_cursor" });
    await deleteUsageSet(database, scope, imported.setId);
    const invalidated = await request(`/copilot-usage/adoption/champions?${new URLSearchParams({
      selectionId: pins.selectionId, inventorySelectionId: pins.inventorySelectionId,
    })}`);
    expect(invalidated.status).toBe(409);
    expect(await invalidated.json()).toMatchObject({ code: "selection_invalidated" });
    expect(providerWork.requests).toBe(0);
    await closeAuditOriginHttp();
    }
  }, 120000);

  it("compares only equal nonoverlapping actual windows and measures constant selected query work on a large directory", async () => {
    for (const transport of ["webapp", "mcp"] as const) {
    const fixture = await setupAuditOriginHttp(transport);
    const { database, scope, request, actor, providerWork } = fixture, identity = await usageIdentity(database, scope);
    const sdkCalls: SdkCall[] = [];
    await directory(database, identity, [user(alex, "alex@example.invalid"),
      ...Array.from({ length: 5000 }, (_, i) => user(`80000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `large${i}@example.invalid`))]);
    await saveUsageInventory(database, scope, Array.from({ length: 103 }, (_, i) => ({
      canonicalId: canonical(i + 1), packages: [`P${i + 1}`], packageFields: { type: "custom" },
    })));
    const ids: string[] = [];
    for (const [start, end, count] of [["2026-01-01", "2026-01-30", 100], ["2026-01-16", "2026-02-14", 120],
      ["2026-03-01", "2026-03-30", 150], ["2026-04-01", "2026-04-07", 40]] as const) {
      ids.push((await reports(database, identity, { agents: Array.from({ length: 103 }, (_, i) =>
        `P${i + 1},A,Your org,7,3,${i ? 0 : count},${end}`),
        userAgents: Array.from({ length: 103 }, (_, i) => `P${i + 1},A,Your org,alex@example.invalid,${i ? 0 : count},${end}`),
        users: [`alex@example.invalid,Alex,1,${count},${end}`] }, { start, end }, reportSet(ids.length + 1))).setId);
    }
    ids.push((await reports(database, identity, { agents: Array.from({ length: 103 }, (_, i) => `P${i + 1},A,Your org,7,3,${i ? 0 : 1},2026-05-01`),
      userAgents: Array.from({ length: 103 }, (_, i) => `P${i + 1},A,Your org,alex@example.invalid,${i ? 0 : 1},2026-05-01`),
      users: ["alex@example.invalid,Alex,1,1,2026-05-01"] }, undefined, reportSet(5))).setId);
    const pins = await selections(database, scope, actor, request);
    const resolvedApi = await json<UserResolution>(request, `/copilot-usage/users/resolve?${new URLSearchParams({
      username: "alex@example.invalid", selectionId: pins.selectionId,
    })}`);
    sdkCalls.push({ name: "resolve_user", request: { username: "alex@example.invalid", selectionId: pins.selectionId }, expected: resolvedApi });
    const work: { milliseconds: number; rows: number; failed: boolean }[] = [];
    const stop = observeQueryWork(query => work.push({ milliseconds: query.milliseconds, rows: query.rows, failed: query.failed }));
    const stopTransactions = observeTransactionStart(async client => checkpointQueries(client));
    const start = performance.now();
    try {
      const resolved = await new SavedReadContracts(pins.reports, pins.inventory).resolve(pins.selectionId, pins.identity, "alex@example.invalid");
      expect(resolved.objectId).toBe(alex);
    } finally { stopTransactions(); stop(); }
    const elapsed = performance.now() - start;
    expect(work.length).toBeGreaterThan(0); expect(work.length).toBeLessThanOrEqual(32);
    expect(work.reduce((n, query) => n + query.rows, 0)).toBeLessThanOrEqual(128);
    expect(work.some(query => query.failed)).toBe(false); expect(elapsed).toBeLessThan(10000);
    console.info("phase04_query_work", JSON.stringify({ transport, users: 5001, queries: work.length,
      rows: work.reduce((n, query) => n + query.rows, 0), milliseconds: elapsed,
      sqlMilliseconds: work.reduce((n, query) => n + query.milliseconds, 0) }));
    const adoption = await selections(database, scope, actor, request, "adoption");
    work.length = 0;
    const stopChampionQueries = observeQueryWork(query => work.push({ milliseconds: query.milliseconds, rows: query.rows, failed: query.failed }));
    const stopChampionTransactions = observeTransactionStart(async client => checkpointQueries(client));
    const championStart = performance.now();
    const all = [];
    const championPages: { cursor?: string; page: ChampionAgentPage }[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await new SavedReadContracts(adoption.reports, adoption.inventory).champions(
          adoption.selectionId, adoption.identity, adoption.inventorySelectionId, { limit: 50, cursor });
        expect(page.champions.map(champion => champion.objectId)).toEqual([alex]);
        championPages.push({ cursor, page });
        all.push(...page.value); cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
    } finally { stopChampionTransactions(); stopChampionQueries(); }
    const championElapsed = performance.now() - championStart;
    expect(all.map(edge => edge.id).sort()).toEqual(Array.from({ length: 103 }, (_, i) => `agent:${canonical(i + 1)}`).sort());
    console.info("phase04_champion_query_work", JSON.stringify({ transport, users: 5001, agents: 103, pages: 3, queries: work.length,
      rows: work.reduce((n, query) => n + query.rows, 0), milliseconds: championElapsed,
      sqlMilliseconds: work.reduce((n, query) => n + query.milliseconds, 0) }));
    expect(work.length).toBeLessThanOrEqual(256);
    expect(work.reduce((n, query) => n + query.rows, 0)).toBeLessThanOrEqual(1024);
    expect(work.some(query => query.failed)).toBe(false);
    expect(championElapsed).toBeLessThan(15000);
    for (const { cursor, page } of championPages) {
      const query = { selectionId: adoption.selectionId, inventorySelectionId: adoption.inventorySelectionId,
        limit: 50, ...cursor ? { cursor } : {} };
      const actual = await json<ChampionAgentPage>(request, `/copilot-usage/adoption/champions?${new URLSearchParams({
        ...query, limit: String(query.limit),
      })}`);
      expect(actual.value).toEqual(page.value); expect(actual.champions).toEqual(page.champions);
      sdkCalls.push({ name: "list_champion_agents", request: query, expected: actual });
    }
    const get = async (to: string) => {
      const query = { selectionId: pins.inventorySelectionId, inventorySelectionId: pins.inventorySelectionId,
        compareFromSetId: ids[0], compareToSetId: to, limit: 1 };
      const actual = await json<CandidateAgentUsageHistory>(request, `/agent-inventory/agent:${canonical(1)}/usage-history?${new URLSearchParams({
        ...query, limit: String(query.limit),
      })}`);
      sdkCalls.push({ name: "list_agent_usage_history", request: { recordId: `agent:${canonical(1)}`, ...query }, expected: actual });
      return actual;
    };
    expect((await get(ids[2])).comparison).toMatchObject({ state: "comparable", responsesDelta: 50, responseGrowthPercent: 50 });
    expect((await get(ids[1])).comparison).toMatchObject({ state: "incomparable", responseGrowthPercent: null, reasons: ["overlapping_or_out_of_order_windows"] });
    expect((await get(ids[3])).comparison).toMatchObject({ state: "incomparable", responseGrowthPercent: null, reasons: ["unequal_reporting_windows"] });
    expect((await get(ids[4])).comparison).toMatchObject({ state: "unknown", responseGrowthPercent: null,
      reasons: ["unknown_reporting_window"] });
    expect((await request(`/agent-inventory/agent:${canonical(1)}/usage-history?${new URLSearchParams({
      inventorySelectionId: pins.inventorySelectionId, compareFromSetId: ids[0],
    })}`)).status).toBe(400);
    if (process.env.AGENT_CONTROL_MCP_SQL_JOURNEY) await sdkJourney(fixture, sdkCalls);
    expect(providerWork.requests).toBe(0);
    await closeAuditOriginHttp();
    }
  }, 120000);

  it("proves frozen caseC exact creation cutoff, native-only inventory and unchanged relative evaluation across 100+1 pages", async () => {
    for (const transport of ["webapp", "mcp"] as const) {
      const fixture = await setupAuditOriginHttp(transport);
      const { database, scope, request, providerWork } = fixture;
      await saveUsageInventory(database, scope, Array.from({ length: 103 }, (_, i) => ({
        canonicalId: canonical(i + 1), packages: [], native: { nativeId: `caseC-native-${i + 1}`, environmentId: null,
          createdAt: i === 100 ? corpus.caseC.cutoff : i === 101 ? corpus.caseC.beforeCutoff
            : i === 102 ? null : corpus.caseC.withinWindow },
      })));
      let clock: string = corpus.caseC.clock;
      const originals = new Map<pg.PoolClient, pg.PoolClient["query"]>();
      const stop = observeTransactionStart(async client => {
        if (originals.has(client)) return;
        const original = client.query; originals.set(client, original);
        // Only this disposable fixture's selected-read clock changes; auth uses real verified SDK/RSA primitives.
        client.query = ((...args: unknown[]) => {
          if (typeof args[0] === "string") args[0] = args[0].replaceAll("clock_timestamp()", `TIMESTAMPTZ '${clock}'`);
          return Reflect.apply(original, client, args);
        }) as typeof client.query;
      });
      try {
        const first = await json<UnifiedAgentInventoryPage>(request,
          "/agent-inventory?inventoryScope=power_platform_only&view=all&createdWithinDays=30&limit=100");
        expect(first.selection.evaluatedAt).toBe(clock);
        expect(first.counts).toMatchObject({ total: 103, filtered: 101 });
        expect(first.value.map(row => row.id)).toEqual(Array.from({ length: 100 }, (_, i) => `agent:${canonical(i + 1)}`));
        expect(first.page.nextCursor).not.toBeNull();
        clock = corpus.caseC.laterClock;
        const second = await json<UnifiedAgentInventoryPage>(request, `/agent-inventory?${new URLSearchParams({
          selectionId: first.selection.id, cursor: first.page.nextCursor!, limit: "100",
        })}`);
        expect(second.selection.evaluatedAt).toBe("2026-01-31T00:00:00.000Z");
        expect(second.value.map(row => row.id)).toEqual([`agent:${canonical(101)}`]);
        expect(second.page.nextCursor).toBeNull();
        expect(second.counts.filtered).toBe(101);
        if (process.env.AGENT_CONTROL_MCP_SQL_JOURNEY) await sdkJourney(fixture, [
          { name: "list_agents", request: { selectionId: first.selection.id, limit: 100 }, expected: first },
          { name: "list_agents", request: { selectionId: first.selection.id, cursor: first.page.nextCursor!, limit: 100 }, expected: second },
        ]);
        const all = await json<UnifiedAgentInventoryPage>(request, "/agent-inventory?inventoryScope=power_platform_only&view=all&limit=100");
        const rest = await json<UnifiedAgentInventoryPage>(request, `/agent-inventory?${new URLSearchParams({
          selectionId: all.selection.id, cursor: all.page.nextCursor!, limit: "100",
        })}`);
        expect(rest.value.map(row => row.id)).toEqual([101, 102, 103].map(n => `agent:${canonical(n)}`));
        expect(rest.value.find(row => row.id === `agent:${canonical(103)}`)?.powerPlatformResource?.createdAt).toBeNull();
        expect(providerWork.requests).toBe(0);
      } finally {
        stop(); for (const [client, original] of originals) client.query = original;
        await closeAuditOriginHttp();
      }
    }
  }, 120000);
});
