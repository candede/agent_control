import { describe, expect, it } from "vitest";
import { unifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";
import type { UnifiedAgentRecord } from "./api/client";
import { findUnifiedAgentRecord } from "./unifiedAgentIdentity";

const record: UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111",
  displayName: "Shared name",
  presence: "both",
  environmentId: "environment-a",
  packages: ["package/a", "package:b"].map(id => ({
    id, displayName: "Shared name", isBlocked: false, sourceSystem: "graph_packages",
    authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
    lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
  })),
  powerPlatformResource: {
    tenantId: "tenant-a", nativeId: "native/id", type: "microsoft.copilotstudio/agents",
    location: null, displayName: "Shared name", environmentId: "environment-a",
    createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {},
    details: {}, unknownFieldCount: 0,
  },
  identity: { state: "matched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
};

describe("findUnifiedAgentRecord", () => {
  it("resolves the canonical row and every exact package alias without choosing one package representation", () => {
    expect(findUnifiedAgentRecord([record], record.id)).toBe(record);
    for (const item of record.packages) {
      expect(findUnifiedAgentRecord([record], item.id)).toBe(record);
      expect(findUnifiedAgentRecord([record], unifiedAgentRecordId({ source: "graph_packages", packageId: item.id }))).toBe(record);
    }
  });

  it("resolves native source aliases only in their exact environment", () => {
    const other: UnifiedAgentRecord = {
      ...record, id: "agent:22222222-2222-4222-8222-222222222222", environmentId: "environment-b", packages: [],
      powerPlatformResource: { ...record.powerPlatformResource!, environmentId: "environment-b" },
    };
    expect(findUnifiedAgentRecord([other, record], unifiedAgentRecordId({
      source: "power_platform", nativeId: "native/id", environmentId: "environment-a",
    }))).toBe(record);
    expect(findUnifiedAgentRecord([record, other], "native/id", "environment-b")).toBe(other);
    expect(findUnifiedAgentRecord([record, other], "native/id")).toBeUndefined();
    expect(findUnifiedAgentRecord([record, other], unifiedAgentRecordId({
      source: "power_platform", nativeId: "native/id", environmentId: null,
    }))).toBeUndefined();
  });

  it("leaves retired canonical aliases and ambiguous source ownership for server resolution", () => {
    const ambiguous = { ...record, id: "agent:22222222-2222-4222-8222-222222222222" };
    expect(findUnifiedAgentRecord([record], ambiguous.id)).toBeUndefined();
    expect(findUnifiedAgentRecord([record, ambiguous], "package/a")).toBeUndefined();
    expect(findUnifiedAgentRecord([record, ambiguous], unifiedAgentRecordId({
      source: "power_platform", nativeId: "native/id", environmentId: "environment-a",
    }))).toBeUndefined();
  });

  it("resolves equivalent canonical GUID casing without choosing between duplicate canonical owners", () => {
    const canonical = { ...record, id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const upper = { ...canonical, id: "agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" };
    expect(findUnifiedAgentRecord([canonical], upper.id)).toBe(canonical);
    expect(findUnifiedAgentRecord([upper], canonical.id)).toBe(upper);
    expect(findUnifiedAgentRecord([canonical, upper], canonical.id)).toBeUndefined();
    expect(findUnifiedAgentRecord([canonical, upper], upper.id)).toBeUndefined();
  });

  it("matches native GUIDs and environments case-insensitively, but never opaque native or package IDs", () => {
    const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const native = { ...record, powerPlatformResource: { ...record.powerPlatformResource!, nativeId } };
    expect(findUnifiedAgentRecord([native], "power_platform:ENVIRONMENT-A:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(native);
    expect(findUnifiedAgentRecord([native], nativeId.toUpperCase(), "ENVIRONMENT-A")).toBe(native);
    expect(findUnifiedAgentRecord([record], "power_platform:ENVIRONMENT-A:native%2fid")).toBe(record);
    expect(findUnifiedAgentRecord([record], "power_platform:environment-a:NATIVE%2Fid")).toBeUndefined();
    expect(findUnifiedAgentRecord([record], "graph_packages:package%2fa")).toBe(record);
    expect(findUnifiedAgentRecord([record], "graph_packages:PACKAGE%2Fa")).toBeUndefined();
    const packages = { ...record, packages: [{ ...record.packages[0], id: nativeId.toUpperCase() }] };
    expect(findUnifiedAgentRecord([packages], `graph_packages:${nativeId}`)).toBeUndefined();
  });

  it.each(["graph_packages", "power_platform"] as const)(
    "does not let an exact %s row ID mask ambiguous source membership",
    source => {
      const id = source === "graph_packages" ? "graph_packages:package%2Fa"
        : "power_platform:environment-a:native%2Fid";
      const sourceRow = { ...record, id };
      for (const records of [[record, sourceRow], [sourceRow, record]]) {
        expect(findUnifiedAgentRecord(records, id)).toBeUndefined();
        expect(findUnifiedAgentRecord(records, id.replace("%2F", "%2f"))).toBeUndefined();
      }
    },
  );

  it("does not let GUID casing hide ambiguous native ownership or manufacture a null environment", () => {
    const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const lower = { ...record, powerPlatformResource: { ...record.powerPlatformResource!, nativeId } };
    const upper = { ...record, id: "agent:22222222-2222-4222-8222-222222222222",
      powerPlatformResource: { ...record.powerPlatformResource!, nativeId: nativeId.toUpperCase(), environmentId: "ENVIRONMENT-A" } };
    expect(findUnifiedAgentRecord([lower, upper], `power_platform:environment-a:${nativeId}`)).toBeUndefined();
    expect(findUnifiedAgentRecord([lower], `power_platform::${nativeId}`, "environment-a")).toBeUndefined();
  });

  it("decodes opaque source IDs exactly once, including source-like package values", () => {
    for (const id of ["agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "package%2Fa", "Package+with space", "公司/🌏"]) {
      const value = { ...record, packages: [{ ...record.packages[0], id }] };
      expect(findUnifiedAgentRecord([value], unifiedAgentRecordId({ source: "graph_packages", packageId: id }))).toBe(value);
    }
    expect(findUnifiedAgentRecord([record], "graph_packages:package%252Fa")).toBeUndefined();
  });

  it("never uses names, manifest IDs, or a list environment to retarget a source-qualified link", () => {
    const manifest = { ...record, packages: record.packages.map(item => ({ ...item, manifestId: "manifest-id" })) };
    expect(findUnifiedAgentRecord([manifest], "Shared name")).toBeUndefined();
    expect(findUnifiedAgentRecord([manifest], "manifest-id")).toBeUndefined();
    expect(findUnifiedAgentRecord([record], unifiedAgentRecordId({
      source: "power_platform", nativeId: "native/id", environmentId: "environment-b",
    }), "environment-a")).toBeUndefined();
  });
});
