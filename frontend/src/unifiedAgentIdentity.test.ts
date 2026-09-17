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

  it("never uses names, manifest IDs, or a list environment to retarget a source-qualified link", () => {
    const manifest = { ...record, packages: record.packages.map(item => ({ ...item, manifestId: "manifest-id" })) };
    expect(findUnifiedAgentRecord([manifest], "Shared name")).toBeUndefined();
    expect(findUnifiedAgentRecord([manifest], "manifest-id")).toBeUndefined();
    expect(findUnifiedAgentRecord([record], unifiedAgentRecordId({
      source: "power_platform", nativeId: "native/id", environmentId: "environment-b",
    }), "environment-a")).toBeUndefined();
  });
});
