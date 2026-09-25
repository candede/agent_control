import { describe, expect, it } from "vitest";
import type { OfficialUsageAdminState } from "../api/client";
import { acceptedBundleMessage, type ImportResult } from "./officialUsageImportPresentation";

const retainedSet: OfficialUsageAdminState["sets"][number] = {
  id: "retained-set",
  bundleId: "retained-bundle",
  reportingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31", provenance: "source_metadata" },
  supersedesSetId: null,
  complete: true,
  kinds: ["agents", "userAgents", "users"],
  acceptedAt: "2026-08-01T12:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  expiresAt: null,
};

function result(): ImportResult {
  const state: OfficialUsageAdminState = {
    activeSetId: retainedSet.id, activeRevision: 4, sets: [retainedSet], staging: [],
  };
  return {
    accepted: { setId: retainedSet.id, versionId: "retained-version", activeRevision: 4, complete: true },
    priorState: state,
    verifiedState: { ...state },
  };
}

describe("accepted report-set messages", () => {
  it("uses explicit reuse even when only refreshed metadata contains the retained set", () => {
    const value = result();
    value.accepted.reusedExistingSet = true;
    value.priorState = { ...value.priorState!, sets: [] };
    expect(acceptedBundleMessage(value)).toContain("exactly matched the current retained snapshot");
    expect(acceptedBundleMessage(value)).toContain("Original acceptance remains");
    expect(acceptedBundleMessage(value)).not.toContain("added to");
  });

  it.each(["another-current-set", retainedSet.id, null])("reports explicit reuse outside bounded metadata with selection %s", activeSetId => {
    const value = result();
    value.accepted.reusedExistingSet = true;
    value.priorState = { ...value.priorState!, activeSetId, sets: [] };
    value.verifiedState = { ...value.priorState };
    const message = acceptedBundleMessage(value);
    expect(message).toContain("exactly matched");
    expect(message).toContain("No new history entry was created");
    expect(message).not.toContain("added to");
    expect(message).not.toContain("could not confirm");
    expect(message).not.toContain("Original acceptance remains");
    if (activeSetId === retainedSet.id) {
      expect(message).toContain("Current selection and revision are unchanged");
    } else {
      expect(message).toContain(`Current selection remains ${activeSetId?.slice(0, 8) ?? "none"} and its revision is unchanged`);
    }
  });

  it("treats explicit non-reuse as authoritative instead of inferring duplication from prior metadata", () => {
    const value = result();
    value.accepted.reusedExistingSet = false;
    const message = acceptedBundleMessage(value);
    expect(message).toContain("added to retained history and is current");
    expect(message).not.toContain("exactly matched");
    expect(message).not.toContain("Original acceptance remains");
    expect(message).not.toContain("cumulative");
  });

  it("remains compatible with older responses that omit the reuse field", () => {
    expect(acceptedBundleMessage(result())).toContain("exactly matched the current retained snapshot");
    const value = result();
    value.priorState = { ...value.priorState!, sets: [] };
    expect(acceptedBundleMessage(value)).toContain("added to retained history and is current");
  });

  it.each([false, undefined])("does not infer reuse from an unavailable set without explicit confirmation (%s)", reusedExistingSet => {
    const value = result();
    value.accepted.reusedExistingSet = reusedExistingSet;
    value.verifiedState = { ...value.verifiedState!, sets: [] };
    expect(acceptedBundleMessage(value)).toContain("could not confirm an available retained snapshot");
  });

  it("distinguishes confirmed reuse from unverified selection after a refresh failure", () => {
    const value = result();
    value.accepted.reusedExistingSet = true;
    value.verifiedState = undefined;
    const message = acceptedBundleMessage(value);
    expect(message).toContain("server confirmed an exact duplicate");
    expect(message).toContain("No new history entry was created");
    expect(message).toContain("Current selection has not yet been verified");
    expect(message).toContain("Do not upload the files again; refresh the result");
    expect(message).not.toContain("selection and revision are unchanged");
  });

  it("does not claim a snapshot is available if refreshed metadata explicitly marks it deleted", () => {
    const value = result();
    value.accepted.reusedExistingSet = true;
    value.verifiedState = { ...value.verifiedState!, sets: [{ ...retainedSet, deletedAt: "2026-09-24T00:00:00.000Z" }] };
    expect(acceptedBundleMessage(value)).toContain("could not confirm an available retained snapshot");
  });

  it("describes a newly retained non-current snapshot without adding snapshot totals", () => {
    const value = result();
    value.accepted.reusedExistingSet = false;
    value.verifiedState = { ...value.verifiedState!, activeSetId: "different-current" };
    const message = acceptedBundleMessage(value);
    expect(message).toContain("added to retained history");
    expect(message).toContain("Current selection is differen; the new snapshot is not current");
    expect(message).toContain("Snapshots remain separate");
    expect(message).not.toContain("cumulative");
  });

  it("does not claim selection stayed unchanged after a concurrent selection change", () => {
    const value = result();
    value.accepted.reusedExistingSet = true;
    value.verifiedState = { ...value.verifiedState!, activeSetId: "different-current", activeRevision: 5 };
    expect(acceptedBundleMessage(value)).toContain("Current selection is differen");
    expect(acceptedBundleMessage(value)).not.toContain("unchanged");
  });
});
