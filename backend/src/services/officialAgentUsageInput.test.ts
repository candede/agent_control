import { afterEach, describe, expect, it, vi } from "vitest";
import { officialAgentUsageMutation } from "./officialAgentUsageInput.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { AuditLog } from "./auditLog.js";
import pg from "pg";
import { digest } from "../db/dataBounds.js";
import * as inventoryAuthority from "../db/inventoryAuthority.js";
import type { AgentUsageTarget } from "../types/agentUsageTarget.js";
import type { ReportReadContext } from "./largeTenantUsersReports.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";

const removal = {
  selectionId: "abcdefab-1234-4567-89ab-abcdefabcdef",
  reportSetId: "fedcbafe-1234-4567-89ab-fedcbafedcba",
  usageRevision: "a".repeat(64), inventoryRevision: "b".repeat(64),
  reportAgentId: "Exact-Report-ID", confirmed: true as const,
};
const graph = { source: "graph_packages" as const, packageId: "Exact-Package-ID" };
const platform = { source: "power_platform" as const, nativeId: "Exact-Native-ID", environmentId: null };

function sourceMetadata(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}

afterEach(() => vi.restoreAllMocks());

describe("exact usage mutation input", () => {
  it("accepts removal and both source-qualified associations, including null-prototype data", () => {
    for (const input of [removal, { ...removal, target: graph }, { ...removal, target: platform }]) {
      expect(officialAgentUsageMutation(input)).toEqual(input);
      expect(officialAgentUsageMutation(Object.assign(Object.create(null), input))).toEqual(input);
    }
    for (const target of [graph, platform]) {
      expect(officialAgentUsageMutation({ ...removal, target: Object.assign(Object.create(null), target) }))
        .toEqual({ ...removal, target });
    }
  });

  it("normalizes only selection/set UUIDs, preserving typed source and report identities", () => {
    const id = removal.selectionId.toUpperCase();
    for (const target of [graph, { ...graph, packageId: id },
      { ...platform, nativeId: id, environmentId: `Default-${id}` },
      { ...platform, nativeId: "Opaque/Élan%2F-ID", environmentId: "ENV-A" }]) {
      expect(officialAgentUsageMutation({ ...removal, selectionId: id, reportSetId: removal.reportSetId.toUpperCase(),
        reportAgentId: id, target })).toEqual({ ...removal, reportAgentId: id, target });
    }
  });

  it.each(["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const)(
    "rejects trailing line terminators and out-of-bound %s", field => {
      for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", "a"]) {
        expect(() => officialAgentUsageMutation({ ...removal, [field]: removal[field] + suffix })).toThrow();
      }
      for (const value of [null, undefined, 1, "", removal[field].slice(1), ` ${removal[field]}`]) {
        expect(() => officialAgentUsageMutation({ ...removal, [field]: value })).toThrow();
      }
    },
  );

  it("requires bounded lowercase hex revisions rather than alternate spellings or coercion", () => {
    for (const field of ["usageRevision", "inventoryRevision"]) {
      for (const value of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), ["a".repeat(64)]]) {
        expect(() => officialAgentUsageMutation({ ...removal, [field]: value })).toThrow();
      }
    }
  });

  it("requires every mutation field as an own data property", () => {
    for (const key of Object.keys(removal) as Array<keyof typeof removal>) {
      const input: Record<string, unknown> = { ...removal };
      delete input[key];
      expect(() => officialAgentUsageMutation(input)).toThrow();
      Object.setPrototypeOf(input, { [key]: removal[key] });
      expect(() => officialAgentUsageMutation(input)).toThrow();
    }
    expect(() => officialAgentUsageMutation(Object.create(removal))).toThrow();
    for (const value of [removal, graph, platform]) {
      for (const key of Object.keys(value)) {
        const getter = vi.fn(() => Reflect.get(value, key));
        const input = { ...value };
        Object.defineProperty(input, key, { get: getter });
        expect(() => officialAgentUsageMutation(value === removal ? input : { ...removal, target: input })).toThrow();
        expect(getter).not.toHaveBeenCalled();
      }
    }
    const getter = vi.fn(() => graph);
    const input = { ...removal };
    Object.defineProperty(input, "target", { get: getter });
    expect(() => officialAgentUsageMutation(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  describe("validated usage mutation persistence", () => {
    const guid = removal.selectionId.toUpperCase();
    const cases: Array<{ name: string; target: AgentUsageTarget; native: string; environment: string; rawNative?: string; rawEnvironment?: string }> = [
      { name: "exact GUID-shaped package", target: { ...graph, packageId: guid }, native: guid, environment: "" },
      { name: "typed Power Platform GUIDs", target: { ...platform, nativeId: guid, environmentId: `Default-${guid}` },
        native: guid.toLowerCase(), environment: `default-${guid.toLowerCase()}`, rawNative: guid, rawEnvironment: `Default-${guid.toLowerCase()}` },
      { name: "exact opaque Power Platform IDs", target: { ...platform, nativeId: "Opaque/Native%2FID", environmentId: "ENV-A" },
        native: "Opaque/Native%2FID", environment: "ENV-A" },
      { name: "exact malformed GUIDs", target: { ...platform, nativeId: `${guid}X`, environmentId: `Default-${guid}X` },
        native: `${guid}X`, environment: `Default-${guid}X` },
      { name: "explicit absent environment", target: platform, native: platform.nativeId, environment: "" },
    ];

    it.each(cases)("uses $name for lookup while retaining source-owned raw persistence", async ({ target, native, environment, rawNative, rawEnvironment }) => {
      const database = { options: { max: 4 }, connect: vi.fn().mockRejectedValue(new Error("Unexpected connection")),
        query: vi.fn().mockRejectedValue(new Error("Unexpected database query")) };
      const reports = new LargeTenantUsersReports(database as unknown as pg.Pool, "synthetic-usage-input-validation-secret", 35);
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const identity = { tenantId: "tenant", principalId: "principal", authorizationHash: "admin", sessionEpoch: "1" };
      const actor = { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "admin@example.invalid", displayName: "Admin" };
      const now = new Date("2026-10-01T00:00:00Z"), agentId = removal.selectionId, control = "current-control-revision";
      const metadata: ReportReadContext["report"] = {
        setId: removal.reportSetId, activeSetId: removal.reportSetId, activeRevision: "1", historyRevision: "1", historyEpoch: "0",
        availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0, reportingPeriod: null,
        acceptedAt: now.toISOString(), expiresAt: null, lineages: [],
      };
      const context: ReportReadContext = {
        identity, tokenMode: "delegated", endpoint: "official_agents", query: {}, queryHash: "a".repeat(64), evaluatedAt: now,
        selection: { id: removal.selectionId, revision: "1", evaluatedAt: now.toISOString(), expiresAt: "2026-10-01T00:10:00Z" },
        metadata: { directory: sourceMetadata("directory"), app_activity: sourceMetadata("app_activity") }, report: metadata,
      };
      const found = { source: target.source, native_id: rawNative ?? native, environment_id: rawEnvironment ?? environment,
        normalized_native_id: native, normalized_environment_id: environment };
      let revision = "0";
      const query = vi.spyOn(client, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
        let rows: pg.QueryResultRow[] = [];
        if (sql === "SELECT clock_timestamp() AS now") rows = [{ now }];
        else if (sql.includes("SELECT active_set_id")) rows = [{ active_set_id: removal.reportSetId }];
        else if (sql.includes("SELECT revision::text")) rows = [{ revision }];
        else if (sql.includes("SELECT DISTINCT agent_id,control_revision") || sql.includes("SELECT source,native_id")) {
          if (values?.[4] === target.source && values[5] === native && values[6] === environment) {
            rows = sql.includes("SELECT DISTINCT") ? [{ agent_id: agentId, control_revision: control }] : [found];
          }
        } else if (sql.includes("SELECT identity FROM official_agents")) rows = [{ identity: guid }];
        else if (sql.includes("SELECT * FROM agent_usage_associations")) rows = [];
        else if (sql.startsWith("INSERT INTO agent_usage_associations")) revision = "1";
        else throw new Error("Unexpected usage mutation query");
        return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
      });
      const lock = vi.spyOn(inventoryAuthority, "lockInventorySelection").mockResolvedValue(undefined);
      vi.spyOn(reports.selections, "assert").mockResolvedValue({ selection: {}, pins: [] });
      vi.spyOn(reports, "contextInRead").mockResolvedValue(context);
      vi.spyOn(reports.history.connections, "run").mockImplementation(work => work(client));
      const start = vi.spyOn(AuditLog.prototype, "startEvent").mockImplementation(async intent =>
        ({ ...intent, id: "review-event", startedAt: now.toISOString(), status: "started" }));
      vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async (id, update) => ({
        id, ...update, actor, operationId: "review-operation", action: "associate-agent-usage", scope: "single",
        agentId, requestPath: "/usage-associations", startedAt: now.toISOString(),
      }));
      const input = { ...removal, selectionId: removal.selectionId.toUpperCase(), reportSetId: removal.reportSetId.toUpperCase(), reportAgentId: guid,
        usageRevision: digest(JSON.stringify([metadata, revision])),
        inventoryRevision: digest(JSON.stringify(["inventory-control-v1", identity.tenantId, identity.principalId, agentId, control])), target };
      const result = await new OfficialAgentUsage(reports).mutate(identity, unifiedAgentRecordId(target), input, actor);
      expect(result.reportSetId).toBe(removal.reportSetId);
      expect(result.usageRevision).not.toBe(input.usageRevision);
      expect(lock).toHaveBeenCalledWith(client, identity, removal.selectionId);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO agent_usage_associations"),
        [identity.tenantId, removal.reportSetId, guid, found.source, found.native_id, found.environment_id, identity.principalId]);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT identity FROM official_agents"),
        expect.arrayContaining([guid]));
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ action: "associate-agent-usage" }));
      expect(database.connect).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    });
  });

  it("ignores a polluted optional target on Object.prototype, but never accepts inherited confirmation", () => {
    const confirmed = Object.getOwnPropertyDescriptor(Object.prototype, "confirmed");
    const target = Object.getOwnPropertyDescriptor(Object.prototype, "target");
    try {
      Object.defineProperty(Object.prototype, "confirmed", { configurable: true, value: true });
      Object.defineProperty(Object.prototype, "target", { configurable: true, value: graph });
      const { confirmed: _confirmed, ...missing } = removal;
      expect(() => officialAgentUsageMutation(missing)).toThrow();
      const validated = officialAgentUsageMutation(removal);
      expect(validated).toEqual(removal);
      expect(Object.hasOwn(validated, "target")).toBe(false);
      expect(validated.target).toBeUndefined();
    } finally {
      if (confirmed) Object.defineProperty(Object.prototype, "confirmed", confirmed);
      else delete (Object.prototype as { confirmed?: unknown }).confirmed;
      if (target) Object.defineProperty(Object.prototype, "target", target);
      else delete (Object.prototype as { target?: unknown }).target;
    }
  });

  it("rejects non-objects, extensions and hidden or symbol keys at both object levels", () => {
    for (const value of [null, undefined, [], true, 1, "mutation", new Date(), new String("mutation"),
      { ...removal, extra: true }, JSON.parse(JSON.stringify(removal).replace(/}$/, ',"__proto__":{}}'))]) {
      expect(() => officialAgentUsageMutation(value)).toThrow();
    }
    for (const key of ["extra", "__proto__", "constructor", Symbol("extra")]) {
      for (const nested of [false, true]) {
        const value = nested ? { ...graph } : { ...removal };
        Object.defineProperty(value, key, { value: "smuggled", enumerable: false });
        expect(() => officialAgentUsageMutation(nested ? { ...removal, target: value } : value)).toThrow();
      }
    }
  });

  it("requires literal confirmation, exact source enums and mutually exclusive target fields", () => {
    for (const confirmed of [false, null, undefined, "true", 1, [], {}]) {
      expect(() => officialAgentUsageMutation({ ...removal, confirmed })).toThrow();
    }
    for (const target of [null, undefined, [], {}, Object.create(graph),
      { source: "canonical", agentId: removal.selectionId }, { ...graph, source: "GRAPH_PACKAGES" },
      { ...graph, source: ["graph_packages"] }, { ...graph, nativeId: undefined },
      { ...graph, environmentId: null }, { ...platform, packageId: undefined },
      { ...platform, environmentId: undefined }, { source: "power_platform", nativeId: platform.nativeId }]) {
      expect(() => officialAgentUsageMutation({ ...removal, target })).toThrow();
    }
    for (const target of [graph, platform]) {
      for (const key of Object.keys(target)) {
        const inherited: Record<string, unknown> = { ...target };
        delete inherited[key];
        Object.setPrototypeOf(inherited, { [key]: Reflect.get(target, key) });
        expect(() => officialAgentUsageMutation({ ...removal, target: inherited })).toThrow();
      }
    }
  });

  it("enforces exact Unicode identifier bounds without trimming or compatibility folding", () => {
    for (const text of ["A".repeat(512), "Élan-代理", "Agent-\u{1f916}", "\uff21", "a\u030a"]) {
      for (const target of [{ ...graph, packageId: text }, { ...platform, nativeId: text, environmentId: text }]) {
        expect(officialAgentUsageMutation({ ...removal, reportAgentId: text, target }))
          .toEqual({ ...removal, reportAgentId: text, target });
      }
    }
    for (const text of [null, undefined, [], 1, "", "a".repeat(513), " padded", "padded ", " \t",
      "A\0B", "A\nB", "A\u0085B", "A\ud800B", "A\udfffB"]) {
      for (const input of [{ ...removal, reportAgentId: text }, { ...removal, target: { ...graph, packageId: text } },
        { ...removal, target: { ...platform, nativeId: text } }, { ...removal, target: { ...platform, environmentId: text } }]) {
        if (text === null && "target" in input && input.target.source === "power_platform"
          && input.target.nativeId === platform.nativeId) continue;
        expect(() => officialAgentUsageMutation(input)).toThrow();
      }
    }
  });

  it("rejects invalid direct service input before auditing or acquiring a writer connection", async () => {
    const database = { options: { max: 4 }, connect: vi.fn(), query: vi.fn() };
    const reports = new LargeTenantUsersReports(database as unknown as pg.Pool, "synthetic-usage-input-validation-secret", 35);
    const usage = new OfficialAgentUsage(reports);
    const start = vi.spyOn(AuditLog.prototype, "startEvent").mockRejectedValue(new Error("Unexpected audit"));
    const identity = { tenantId: "tenant", principalId: "principal", authorizationHash: "admin", sessionEpoch: "1" };
    const actor = { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "admin@example.invalid", displayName: "Admin" };
    const { confirmed: _confirmed, ...missing } = removal;
    const inherited = Object.assign(Object.create({ confirmed: true }), missing);
    await expect(usage.mutate(identity, `agent:${removal.selectionId}`, inherited, actor)).rejects.toMatchObject({ status: 400 });
    expect(start).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });
});
