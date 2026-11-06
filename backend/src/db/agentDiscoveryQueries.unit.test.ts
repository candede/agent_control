import { describe, expect, it } from "vitest";
import { discoveryCatalogQuery, discoverySearchSql } from "./agentDiscoveryQueries.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { parseDirectoryUser } from "../services/userSourceGraphFields.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

const objectId = "ABCDEF01-2345-6789-ABCD-0123456789AB";
const native: PowerPlatformResource = {
  tenantId: "11111111-1111-4111-8111-111111111111", nativeId: "native-agent",
  type: "microsoft.copilotstudio/agents", location: null, displayName: "Native agent", environmentId: null,
  createdAt: null, createdBy: objectId, lastPublishedAt: null, sourceSystem: "power_platform",
  authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "unknown",
  identityConfidence: "partial", identifiers: [], provenance: {}, details: { ownerId: objectId }, unknownFieldCount: 0,
};

describe("discovery saved person identity joins", () => {
  it("accounts for case-preserved inventory IDs and lowercase directory IDs", () => {
    const directory = parseDirectoryUser({
      id: objectId, userPrincipalName: "owner@example.invalid", displayName: "Saved owner",
      assignedLicenses: [], assignedPlans: [], accountEnabled: true, userType: "Member",
    }, new Map(), { kind: "reported", identities: [objectId.toLowerCase()] });
    const savedNative = powerPlatformInventoryRecord(native);
    const savedPackage = packageInventoryRecord(allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, ownerId: objectId,
    }));

    expect(directory?.identity.objectId).toBe(objectId.toLowerCase());
    expect(savedNative.residual.createdBy).toBe(objectId);
    expect(savedNative.residual.details).toMatchObject({ ownerId: objectId });
    expect(savedPackage.residual.ownerId).toBe(objectId);
    expect(discoveryCatalogQuery()).toContain("d.identity=ANY(s.people)");
  });

  it.each([
    ["catalog", discoveryCatalogQuery()],
    ["detail", discoveryCatalogQuery("$13")],
    ["search", discoverySearchSql],
    ["created here", discoveryCatalogQuery(undefined, true)],
  ])("normalizes all %s person references before deduplication and directory lookup", (_name, sql) => {
    for (const [expression, alias] of [
      ["s.residual->>'createdBy'", "creator"],
      ["s.residual->>'ownerId'", "owner_id"],
      ["s.residual->'details'->>'ownerId'", "details_owner_id"],
      ["s.residual->'details'->>'createdBy'", "details_creator"],
    ]) expect(sql).toContain(`lower(${expression}) AS ${alias}`);
    expect(sql).toContain("unnest(ARRAY[s.owner_id,s.creator,s.details_owner_id,s.details_creator])");
  });

  it("uses the same normalized creator identity for created-here evidence", () => {
    const sql = discoveryCatalogQuery(undefined, true);
    expect(sql).toContain("creator.identity=lower(s.residual->>'createdBy')");
    expect(sql).not.toContain("creator.identity=s.residual->>'createdBy'");
  });
});
