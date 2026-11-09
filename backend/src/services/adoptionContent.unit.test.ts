import { describe, expect, it } from "vitest";
import { adoptionWindowCaveats, canonicalContent, contentDraft, contentPermissions, createRequestTime } from "./adoptionContent.js";
import type { AuthenticatedUser } from "../types/session.js";
import { manualDraft } from "./adoptionContentTestSupport.js";
import { readFileSync } from "node:fs";

describe("bounded current adoption content contract", () => {
  it("preserves exactly the existing three Entra roles and identifiers", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../infra/entra-app-manifest.json", import.meta.url), "utf8"));
    expect(manifest.appRoles.map((role: { value: string; id: string }) => [role.value, role.id])).toEqual([
      ["AgentControl.Viewer", "8a02b7f3-bdbf-4193-8b29-4da05684fb5a"],
      ["AgentControl.UsageReportUploader", "fdc127ee-2377-4708-a5d4-0ddc4f46d83b"],
      ["AgentControl.Admin", "9feab889-b807-4a97-a504-944ab53a380b"],
    ]);
  });
  it("accepts manual drafts without reports, normalizes canonical payloads and keeps prose separate", () => {
    expect(contentDraft(manualDraft())).toEqual(manualDraft());
    const card = { ...manualDraft("card"), visibility: "employees", narrative: { ...manualDraft().narrative, task: "Alice Owner private narrative" } };
    expect(contentDraft(card)).toMatchObject({ learning: { task: "draft" }, narrative: { task: "Alice Owner private narrative" } });
    expect(canonicalContent({ b: 1, a: { y: 2, x: 3 } })).toBe(canonicalContent({ a: { x: 3, y: 2 }, b: 1 }));
  });
  it("preserves the same exact selected-evidence filters used by create and follow-up", () => {
    const query = { company: null, department: null,
      officeSelectionId: "10000000-0000-4000-8000-000000000001",
      reportSelectionId: "10000000-0000-4000-8000-000000000002",
      officeBaseline: "10000000-0000-4000-8000-000000000003",
      inventorySelectionId: "10000000-0000-4000-8000-000000000004" };
    expect(contentDraft({ ...manualDraft(), baseline: { groupId: "exact-group", query } }).baseline?.query).toEqual(query);
  });
  it.each(["officeSnapshot", "officeBaseline"] as const)("rejects non-scalar %s in selected content evidence", key => {
    const id = "10000000-0000-4000-8000-000000000003";
    const query = { company: null, department: null,
      officeSelectionId: "10000000-0000-4000-8000-000000000001",
      reportSelectionId: "10000000-0000-4000-8000-000000000002" };
    for (const value of [[id], [[id]], `${id}\n`]) {
      expect(() => contentDraft({ ...manualDraft(), baseline: { groupId: "exact-group", query: { ...query, [key]: value } } }))
        .toThrow(expect.objectContaining({ status: 400, code: "invalid_office_query" }));
    }
    expect(contentDraft({ ...manualDraft(), baseline: { groupId: "exact-group", query: { ...query, [key]: id } } })
      .baseline?.query).toEqual({ ...query, [key]: id });
  });
  it.each([
    { visibility: "employees" }, { role: "Champion" }, { title: "x".repeat(257) }, { agentIds: Array(9).fill("bad") },
    { narrative: { ...manualDraft().narrative, task: "x".repeat(2049) } }, { dueDate: "2026-02-30" }, { assigneeId: "other" },
    { participantIds: ["Alice"] }, { baseline: { groupId: "group", query: { company: null, department: null } } },
  ])("rejects malformed/oversized/unbound input %#", patch => expect(() => contentDraft({ ...manualDraft(), ...patch })).toThrow());
  it("does not accept author/model permission or privacy assertions", () => {
    expect(() => contentDraft({ ...manualDraft("card"), privacyApproved: true })).toThrow();
    expect(() => contentDraft({ ...manualDraft("card"), learning: { ...manualDraft("card").learning, task: "Alice Owner" } })).toThrow();
  });
  it("allows creator/Admin core edits and assignee progress only, without granting a role", () => {
    const user = (id: string, roles: AuthenticatedUser["roles"] = ["AgentControl.Viewer"]) =>
      ({ homeAccountId: id, roles, tenantId: "tenant", username: "staff", displayName: "Staff" });
    const row = { creator_id: "creator", kind: "action" as const, payload: { assigneeId: "assigned" } };
    expect(contentPermissions(user("creator"), row)).toEqual({ core: true, progress: true });
    expect(contentPermissions(user("assigned"), row)).toEqual({ core: false, progress: true });
    expect(contentPermissions(user("reader"), row)).toEqual({ core: false, progress: false });
    expect(contentPermissions(user("admin", ["AgentControl.Admin"]), row)).toEqual({ core: true, progress: true });
    expect(contentPermissions(user("assigned", []), row)).toEqual({ core: false, progress: false });
  });
  it("binds create identity to its timestamp so receipt GC cannot resurrect a delayed retry", () => {
    const id = `${Date.now()}.10000000-0000-4000-8000-000000000001`;
    expect(createRequestTime(id)).toBe(Number(id.slice(0, 13)));
    expect(() => createRequestTime(`${Date.now() + 120000}.10000000-0000-4000-8000-000000000001`)).toThrow();
    expect(() => createRequestTime("arbitrary-key")).toThrow();
  });
  it.each([
    ["2026-10-15", "2026-10-01", "Office D28", "report activity"],
    ["2026-11-01", "2026-09-15", "report activity", "Office D28"],
  ])("checks independent Office and report windows: %s / %s", (officeStart, reportStart, expected, absent) => {
    const original = {
      office: { windowStart: "2026-10-01", reportRefreshDate: "2026-10-28" },
      report: { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30" } },
    };
    const current = {
      office: { windowStart: officeStart, reportRefreshDate: "2026-11-28" },
      report: { reportingPeriod: { startDate: reportStart, endDate: "2026-10-31" } },
    };
    const caveats = adoptionWindowCaveats(original, current);
    expect(caveats.join(" ")).toContain(expected);
    expect(caveats.join(" ")).not.toContain(absent);
    expect(caveats.join(" ")).toContain("non-additive");
  });
  it.each([null, { startDate: null, endDate: "2026-09-30" }, { startDate: "2026-09-01", endDate: null }])(
    "keeps missing or partial report ranges unknown instead of borrowing the Office window: %s", period => {
    const original = {
      office: { windowStart: "2026-09-01", reportRefreshDate: "2026-09-28" },
      report: { reportingPeriod: period },
    };
    const current = {
      office: { windowStart: "2026-10-01", reportRefreshDate: "2026-10-28" },
      report: { reportingPeriod: { startDate: "2026-10-01", endDate: "2026-10-31" } },
    };
    expect(adoptionWindowCaveats(original, current)).toEqual([
      "Report activity-range overlap is unavailable; do not assume the report evidence is additive.",
    ]);
  });
});
