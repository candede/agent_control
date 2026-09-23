import { describe, expect, it } from "vitest";
import type { WorkbenchJobSummary } from "../api/client";
import {
  compareJobDates, formatJobInstant, jobActionAvailable, jobActionId, jobDuration, jobOutcome,
  jobPhase, jobRecordDate, jobResultLabel, jobSourceHref, jobSourceLinkLabel, jobStatusLabel,
} from "./jobPresentation";

const base: WorkbenchJobSummary = {
  id: "job-1", source: "data-sync", label: "Sync", target: "3 sources",
  status: "completed", total: 3, completed: 3, partial: false,
  canResume: false, canCancel: false, canReconcile: false,
  createdAt: "2026-09-10T09:00:00.000Z", startedAt: "2026-09-10T09:01:00.000Z",
  completedAt: "2026-09-10T09:02:05.000Z", updatedAt: "2026-09-20T09:00:00.000Z", href: "/sync",
};

describe("job presentation", () => {
  it.each(["partial", "inconclusive", "failed", "cancelled", "succeeded", "completed", "accepted", "discarded", "expired", "unknown"])(
    "keeps %s historical even when recovery is available", status => {
      expect(jobPhase({ ...base, status, canResume: true, canCancel: true, canReconcile: true })).toBe("history");
    },
  );
  it.each(["queued", "running", "reconciling_create"])("keeps %s in current work", status => {
    expect(jobPhase({ ...base, status })).toBe("progress");
  });
  it.each(["waiting", "waiting_authorization", "permission_required", "awaiting_upload"])("keeps %s waiting, not finished", status => {
    expect(jobPhase({ ...base, status })).toBe("waiting");
  });
  it("separates active CSV drafts from accepted snapshots", () => {
    expect(jobPhase({ ...base, source: "official-usage", status: "active" })).toBe("waiting");
    expect(jobStatusLabel({ ...base, source: "official-usage", status: "active" })).toBe("Ready for review");
    expect(jobPhase({ ...base, source: "official-usage", status: "accepted" })).toBe("history");
  });
  it.each([
    ["provider_pending", "provider pending"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["__proto__", "  proto  "],
  ])("renders unknown status %s as text, not an inherited property", (status, expected) => {
    const job = { ...base, status };
    expect(jobStatusLabel(job)).toBe(expected);
    expect(jobPhase(job)).toBe("history");
    expect(jobOutcome(job)).toBe("other");
  });
  it.each([
    ["data-sync", "completed", 3, 4, "3 of 4 sources complete"],
    ["package-refresh", "succeeded", 1039, 1039, "1,039 packages saved"],
    ["package-refresh", "succeeded", 1, 1, "1 package saved"],
    ["power-platform", "failed", 4173, 4173, "4,173 of 4,173 resources observed"],
    ["package-refresh", "failed", 144, 1010, "144 of 1,010 packages observed"],
    ["package-controls", "partial", 2, 2, "2 of 2 targets processed"],
    ["quarantine", "inconclusive", 1, 2, "1 of 2 targets processed"],
    ["purview", "partial", 50, 200, "50 rows retained"],
    ["defender", "inconclusive", 0, null, "0 rows retained"],
    ["official-usage", "active", 306, 306, "306 rows validated"],
    ["official-usage", "accepted", 306, 306, "306 rows accepted"],
    ["official-usage", "discarded", 0, 0, "0 rows validated"],
    ["official-usage", "accepted", 1, 1, "1 row accepted"],
    ["package-refresh", "running", null, null, "Count not reported"],
    ["data-sync", "running", 0, null, "0 sources complete"],
  ] satisfies Array<[WorkbenchJobSummary["source"], string, number | null, number | null, string]>)(
    "describes %s / %s with the source's actual count unit", (source, status, completed, total, expected) => {
      expect(jobResultLabel({ ...base, source, status, completed, total })).toBe(expected);
    },
  );
  it("does not classify full progress or partial success as an entirely successful outcome", () => {
    expect(jobOutcome({ ...base, status: "failed", completed: 3, total: 3 })).toBe("failed");
    expect(jobOutcome({ ...base, partial: true })).toBe("incomplete");
    expect(jobStatusLabel({ ...base, partial: true })).toBe("Complete with partial results");
    expect(jobResultLabel({ ...base, source: "package-refresh", status: "succeeded", partial: true })).toBe("3 of 3 packages observed");
  });
  it("sorts by original creation rather than a later retry or reconciliation", () => {
    const recent = { ...base, id: "recent", createdAt: "2026-09-11T09:00:00.000Z", updatedAt: "2026-09-11T09:00:00.000Z" };
    expect([base, recent].sort(compareJobDates).map(job => job.id)).toEqual(["recent", "job-1"]);
    expect([recent, base].sort((left, right) => compareJobDates(left, right, false)).map(job => job.id)).toEqual(["job-1", "recent"]);
  });
  it("labels legacy start/update fallbacks and invalid dates instead of inventing creation or completion", () => {
    expect(jobRecordDate(base).label).toBe("Created");
    expect(jobRecordDate({ ...base, createdAt: undefined }).label).toBe("Started");
    expect(jobRecordDate({ ...base, createdAt: undefined, startedAt: undefined }).label).toBe("Updated");
    const invalid = { ...base, createdAt: "invalid", startedAt: "invalid", updatedAt: "invalid" };
    expect(jobRecordDate(invalid).value).toBeUndefined();
    expect(formatJobInstant("invalid")).toBe("Not recorded");
    expect(compareJobDates(invalid, base)).toBeGreaterThan(0);
    expect(compareJobDates(invalid, base, false)).toBeGreaterThan(0);
    expect(jobDuration(base)).toBe("1m 5s");
    expect(jobDuration({ ...base, startedAt: undefined })).toBe("Not recorded");
    expect(jobDuration({ ...base, completedAt: undefined })).toBe("Not recorded");
    expect(jobDuration({ ...base, completedAt: "2026-09-10T08:00:00.000Z" })).toBe("Not recorded");
  });
  it("keeps snapshot links read-only and only active imports linked to draft review", () => {
    const draft = { ...base, source: "official-usage" as const, status: "active", href: "/official-usage?staging=draft-1" as const };
    expect(jobSourceHref(draft)).toBe("/sync?reports=import&staging=draft-1");
    expect(jobSourceLinkLabel(draft)).toBe("Review CSV import");
    expect(jobSourceHref({ ...draft, status: "accepted" })).toBe("/sync?reports=manage");
    expect(jobSourceHref({ ...draft, status: "accepted", href: "/official-usage?view=history&snapshot=set-1" })).toBe("/sync?reports=snapshot&snapshot=set-1");
    expect(jobSourceLinkLabel({ ...draft, status: "accepted" })).toBe("Manage reports");
    expect(jobSourceLinkLabel({ ...draft, status: "accepted", href: "/sync?reports=snapshot&snapshot=set-1" })).toBe("View snapshot");
    expect(jobSourceHref({ ...base, href: "/agents?syncRun=job-1" })).toBe("/sync?syncRun=job-1");
  });
  it("uses cancel metadata, not provider-read resume metadata, for read refresh cancellation", () => {
    expect(jobActionId({ ...base, source: "package-refresh" }, "cancel")).toBe("packages.refresh.cancel");
    expect(jobActionId({ ...base, source: "power-platform" }, "cancel")).toBe("power-platform.cancel");
    expect(jobActionAvailable({ ...base, source: "purview", canReconcile: true }, "reconcile")).toBe(false);
    expect(jobActionAvailable({ ...base, source: "official-usage", canResume: true }, "resume")).toBe(false);
    expect(jobActionAvailable({ ...base, source: "quarantine", canReconcile: true }, "reconcile")).toBe(true);
  });
  it("selects application refresh authorization from the persisted mode, not its target label", () => {
    for (const target of ["Application Graph package catalog", "1 exact Graph package target"]) {
      const job = { ...base, source: "package-refresh" as const, tokenMode: "application" as const, target };
      expect(jobActionId(job, "resume")).toBe("packages.refresh.application.resume");
      expect(jobActionId(job, "cancel")).toBe("packages.refresh.cancel");
    }
    expect(jobActionId({ ...base, source: "package-refresh", target: "Current principal Graph package catalog" }, "resume")).toBe("packages.refresh.resume");
    expect(jobActionId({ ...base, source: "package-refresh", target: "1 exact Graph package target" }, "resume")).toBe("packages.refresh.exact.resume");
  });
});
