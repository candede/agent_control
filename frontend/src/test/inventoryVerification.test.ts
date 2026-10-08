// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PowerPlatformResourceType } from "../api/client";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "./inventoryVerification";

describe("inventory fixture snapshots", () => {
  it("captures counts and selection inputs without sharing mutable data between responses", () => {
    const counts = { total: 3, scoped: 2, filtered: 1, packageTargets: 1 };
    const selection = { id: "account-a-selection", revision: "7", evaluatedAt: "2026-09-20T12:00:00.000Z" };
    const first = inventoryPageMetadata(counts, "2026-09-20T12:10:00.000Z", selection);
    const second = inventoryPageMetadata(counts, first.selection.expiresAt, selection);
    counts.total = 9;
    selection.id = "account-b-selection";
    selection.revision = "8";
    expect(first.counts.total).toBe(3);
    expect(first.selection.id).toBe("account-a-selection");
    expect(first.selection.revision).toBe("7");

    first.counts.filtered = 0;
    first.selection.revision = "changed";
    first.page.nextCursor = "next";
    first.freshness.sources.push({ source: "changed" });
    first.usageContext.reports.activeRevision = "changed";
    first.inventoryOverview.availableToUsers = 3;
    expect(second.counts.filtered).toBe(1);
    expect(second.selection.revision).toBe("7");
    expect(second.page.nextCursor).toBeNull();
    expect(second.freshness.sources).toEqual([]);
    expect(second.usageContext.reports.activeRevision).toBe("0");
    expect(second.inventoryOverview.availableToUsers).toBe(0);
  });

  it("binds usage and freshness to the explicit captured selection", () => {
    const fixture = inventoryPageMetadata(undefined, "2026-09-20T12:10:00.000Z",
      { id: "captured-selection", revision: "7" });
    expect(fixture.usageContext.revision).toBe("captured-selection");
    expect(fixture.usageContext.expiresAt).toBe(fixture.selection.expiresAt);
    expect(fixture.freshness.capturedRevision).toBe("7");
    expect(fixture.usageContext.reports).toMatchObject({
      availability: "never_imported", setId: null, activeSetId: null,
      activeRevision: "0", historyRevision: "0", historyEpoch: "0", expiresAt: null, lineages: [],
    });
    const replacement = inventoryPageMetadata(fixture.counts, fixture.selection.expiresAt,
      { ...fixture.selection, id: "replacement-selection" });
    expect(replacement.usageContext.revision).not.toBe(fixture.usageContext.revision);
  });

  it.each(["2026-09-20T11:59:00.000Z", "invalid"])("preserves explicit expiry %s instead of renewing or correcting it", expiresAt => {
    const fixture = inventoryPageMetadata(undefined, expiresAt);
    expect(fixture.selection.expiresAt).toBe(expiresAt);
    expect(fixture.usageContext.expiresAt).toBe(expiresAt);
  });

  it("captures the executed resource types without retaining a mutable request array", () => {
    const types: PowerPlatformResourceType[] = ["microsoft.copilotstudio/agents"];
    const first = createInventoryVerification(2, types);
    const second = createInventoryVerification(2, types);
    types.length = 0;
    expect(first.queriedTypes).toEqual(["microsoft.copilotstudio/agents"]);
    first.queriedTypes.length = 0;
    expect(second.queriedTypes).toEqual(["microsoft.copilotstudio/agents"]);
    expect(second).toMatchObject({ status: "verified", storedCount: 2, uniqueIdentityCount: 2 });
    expect(createInventoryVerification(0, [])).toMatchObject({ queriedTypes: [], storedCount: 0, uniqueIdentityCount: 0 });
  });
});

describe("inventory verification fixture contract", () => {
  it("treats failed freshness alone as pending without inventing invalid metadata", () => {
    const counts = { graphPackageCount: 2, powerPlatformAgentCount: 0, logicalAgentCount: 2 };
    expect(createUnifiedVerification(counts, { packageMetadata: false }).status).toBe("details_pending");
    expect(createUnifiedVerification(counts, { packageMetadata: false, sourceScopes: false }).status).toBe("needs_attention");
  });
});
