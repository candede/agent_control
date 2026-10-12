import { describe, expect, it } from "vitest";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { UnifiedAgentPackageRecordObservation } from "../types/unifiedAgents.js";
import { dataLimits } from "../db/dataBounds.js";
import { buildRecords } from "./inventoryComponent.js";
import { allowlistedPackage } from "./packageObservation.js";
import type { PackageAgentLinkEvidence, PackageAgentLinkResolution } from "./packageAgentIdentity.js";

const resource: PowerPlatformResource = {
  tenantId: "tenant", nativeId: "Native:/A", environmentId: "environment",
  type: "microsoft.copilotstudio/agents", displayName: "Agent", location: null,
  createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
  authoringTool: null, creatorType: "unknown", agentKind: "agent", lifecycle: "unknown",
  identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
};
const packageValue = (id: string) => allowlistedPackage({ id, displayName: id, isBlocked: false, supportedHosts: [] });
const evidence = (elementIds: string[]): PackageAgentLinkEvidence => ({
  kind: "environment_cds_bot_id", basis: "source_declared_metadata", elementIds,
  packagePath: "SourceIds.CdsBotId", resourcePath: "identifiers.cds_bot_id",
});
const unmatched = (packageId: string): Exclude<PackageAgentLinkResolution, { status: "matched" }> =>
  ({ packageId, status: "unmatched", reason: packageId });
const matched = (packageId: string, proof = evidence([packageId])): Extract<PackageAgentLinkResolution, { status: "matched" }> => ({
  packageId, status: "matched", resource: { nativeId: resource.nativeId, environmentId: resource.environmentId! }, evidence: [proof],
});

describe("bounded exact inventory components", () => {
  it("orders records, package representations, reasons and evidence independently of input order", () => {
    const packages = ["b", "a", "z", "Z"].map(packageValue);
    const links: PackageAgentLinkResolution[] = [
      { ...unmatched("b"), grouping: { key: "source-group", environmentId: "environment" } },
      { ...unmatched("a"), grouping: { key: "source-group", environmentId: "environment" } },
      matched("z", evidence(["second", "first"])), matched("Z", evidence(["fourth", "third"])),
    ];
    const other = { ...resource, nativeId: "Native:/a" };
    const snapshots = Object.fromEntries(packages.map(value => [value.id, {
      id: value.id, snapshotId: value.id, observedAt: "2026-10-01T00:00:00Z", expiresAt: "2030-10-01T00:00:00Z",
      current: true, scopeKind: "exact" as const, identityDetails: null,
    }]));
    const forward = buildRecords(packages, [resource, other], links, null, null, snapshots);
    const reverse = buildRecords([...packages].reverse(), [other, resource], [...links].reverse(), null, null, snapshots);
    expect(reverse).toEqual(forward);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward.map(value => value.id)).toEqual([...forward.map(value => value.id)].sort());
    expect(forward.find(value => value.presence === "graph_packages")).toMatchObject({
      id: "graph_packages:a", displayName: "a", identity: { reason: "a" }, packages: [{ id: "a" }, { id: "b" }],
    });
    expect(forward.find(value => value.presence === "both")?.packages.map(value => value.id)).toEqual(["Z", "z"]);
  });

  it("retains only own exact snapshot keys, including prototype-like package IDs", () => {
    const observation: UnifiedAgentPackageRecordObservation = {
      id: "snapshot", snapshotId: "snapshot", observedAt: "2026-10-01T00:00:00Z",
      expiresAt: "2030-10-01T00:00:00Z", current: true, scopeKind: "exact", identityDetails: null,
    };
    const ids = ["constructor", "toString", "__proto__", "Exact", "exact"];
    const packages = ids.map(packageValue);
    const inherited = Object.create({ constructor: observation, Exact: observation });
    const empty = buildRecords(packages, [], ids.map(unmatched), null, null, inherited);
    expect(empty.every(value => Object.keys(value.observations.packageSnapshots).length === 0)).toBe(true);
    const snapshots = Object.fromEntries([["__proto__", observation], ["Exact", observation]]);
    const records = buildRecords(packages, [], ids.map(unmatched), null, null, snapshots);
    expect(records.find(value => value.packages[0].id === "__proto__")?.observations.packageSnapshots.__proto__).toEqual(observation);
    expect(records.find(value => value.packages[0].id === "exact")?.observations.packageSnapshots).toEqual({});
    records.find(value => value.packages[0].id === "__proto__")!.observations.packageSnapshots.__proto__.snapshotId = "mutated";
    expect(records.find(value => value.packages[0].id === "Exact")!.observations.packageSnapshots.Exact.snapshotId).toBe("snapshot");
    expect(observation.snapshotId).toBe("snapshot");
  });

  it("does not expose unknown package fields or alias nested source, observation or resolver values", () => {
    const value = { ...packageValue("a"), providerPrivateBody: { token: "synthetic-private" },
      detailFreshness: { state: "missing" as const, observedAt: null, expiresAt: null } };
    const proof = evidence(["element"]);
    const link = matched(value.id, proof);
    const native = { ...resource, details: { channels: ["Teams"] } };
    const snapshot: UnifiedAgentPackageRecordObservation = {
      id: "catalog", snapshotId: "catalog", observedAt: "2026-10-01T00:00:00Z",
      expiresAt: "2030-10-01T00:00:00Z", current: true, scopeKind: "broad", identityDetails: null,
    };
    const [record] = buildRecords([value], [native], [link], null, null, { a: snapshot });
    expect(record.packages[0]).not.toHaveProperty("providerPrivateBody");
    record.packages[0].supportedHosts!.push("mutated");
    record.packages[0].detailFreshness!.state = "invalidated";
    record.powerPlatformResource!.details.channels!.push("mutated");
    record.identity.packageEvidence[0].evidence[0].elementIds.push("mutated");
    record.observations.packageSnapshots.a.snapshotId = "mutated";
    expect(value.supportedHosts).toEqual([]);
    expect(value.detailFreshness.state).toBe("missing");
    expect(native.details.channels).toEqual(["Teams"]);
    expect(proof.elementIds).toEqual(["element"]);
    expect(snapshot.snapshotId).toBe("catalog");
    expect(record.identity.evidence[0].elementIds).toEqual(["element"]);
  });

  it("rejects duplicate source identities, invalid resolutions and oversized component output", () => {
    const value = packageValue("a");
    expect(() => buildRecords([value, value], [], [unmatched("a"), unmatched("a")], null, null))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    expect(() => buildRecords([], [resource, resource], [], null, null))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    expect(() => buildRecords([value], [], [], null, null))
      .toThrow(expect.objectContaining({ code: "link_resolution_invalid" }));
    expect(() => buildRecords([value], [resource], [matched("unknown")], null, null))
      .toThrow(expect.objectContaining({ code: "link_resolution_invalid" }));
    expect(() => buildRecords([value], [], [matched("a")], null, null))
      .toThrow(expect.objectContaining({ code: "link_resolution_invalid" }));
    const wide = Array.from({ length: dataLimits.batchRows }, (_, index) =>
      ({ ...packageValue(String(index)), publisher: "界".repeat(4096) }));
    expect(() => buildRecords(wide, [], wide.map(value => unmatched(value.id)), null, null))
      .toThrow(expect.objectContaining({ code: "inventory_component_bytes" }));
  });

  it("retains separate opaque environment memberships but rejects duplicate validated environment identities", () => {
    const upper = { ...resource, environmentId: "Environment-A" };
    const lower = { ...resource, environmentId: "environment-a" };
    const packages = ["Upper", "lower"].map(packageValue);
    const links: PackageAgentLinkResolution[] = [
      { ...matched("Upper"), resource: { nativeId: resource.nativeId, environmentId: upper.environmentId } },
      { ...matched("lower"), resource: { nativeId: resource.nativeId, environmentId: lower.environmentId } },
    ];
    const forward = buildRecords(packages, [upper, lower], links, null, null);
    expect(forward).toHaveLength(2);
    expect(buildRecords([...packages].reverse(), [lower, upper], [...links].reverse(), null, null)).toEqual(forward);
    expect(forward.find(record => record.environmentId === upper.environmentId)?.packages.map(value => value.id)).toEqual(["Upper"]);
    expect(forward.find(record => record.environmentId === lower.environmentId)?.packages.map(value => value.id)).toEqual(["lower"]);
    const environmentId = "Default-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(() => buildRecords([], [{ ...resource, environmentId }, { ...resource, environmentId: environmentId.toLowerCase() }], [], null, null))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });
});
