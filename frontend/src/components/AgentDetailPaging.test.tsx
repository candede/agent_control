import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { deferred } from "../test/deferred";
import { AgentPublishedVersions } from "./AgentPublishedVersions";
import { SavedAgentChannels, SavedAgentConnectors } from "./SavedAgentConfiguration";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getInventoryChildren: vi.fn(), getInventoryMembers: vi.fn(),
}));
const source = { scopeId: "source-scope", identity: "native-agent" };
const props = { selectionId: "selected", recordId: "agent:canonical", source };
type Children = Awaited<ReturnType<typeof api.getInventoryChildren>>;
const connector = (value: string, name: string): Children["value"][number] => ({
  ordinal: Number(value), kind: "detail:connectors", value, payload: { connectorId: name, operations: [] },
});
const member = (id: string): api.InventoryMember => ({ source_scope_id: "package-scope", source_identity: id,
  source_generation_id: "generation", domain: "packages", native_id: id, environment_id: null,
  display_name: "Published agent", observed_at: "2026-09-01", expires_at: "2026-10-01" });
const record: api.UnifiedAgentRecord = {
  id: props.recordId, displayName: "Agent", presence: "graph_packages", environmentId: null, packages: [],
  packageCount: 2000, packagesComplete: false, powerPlatformResource: null,
  identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
};
beforeEach(() => {
  vi.mocked(api.getInventoryChildren).mockImplementation(async (_selection, _record, _source, kind, cursor) => kind === "detail:connectors"
    ? { value: [connector(cursor ? "10" : "0", cursor ? "Later connector" : "Excel connector")], total: 400, nextCursor: cursor ? null : "next-connectors" }
    : kind === "detail:channels" ? { value: [{ ordinal: 1, kind, value: "microsoftTeams", payload: {} }], total: 1, nextCursor: null }
      : { value: [{ ordinal: 2, kind, value: "0", payload: { operationId: "RunScript", isEnabled: false, requiresEndUserConsent: false } }], total: 1, nextCursor: null });
  vi.mocked(api.getInventoryMembers).mockImplementation(async (_selection, _record, cursor) => ({
    value: [member(cursor ? "later-package" : "first-package")], total: 2000, nextCursor: cursor ? null : "next-versions",
  }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("restored agent detail sections over paged storage", () => {
  it("renders connector operation properties in the original layout, paging only on demand", async () => {
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByText("RunScript")).toBeVisible();
    expect(screen.getByText("Enabled").nextElementSibling).toHaveTextContent("No");
    expect(screen.getByText("End-user consent required").nextElementSibling).toHaveTextContent("No");
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(2);
    expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", props.recordId,
      { source_scope_id: source.scopeId, source_identity: source.identity }, "connectorOperation", undefined,
      { value: "0", limit: 10, signal: expect.any(AbortSignal) });
    expect(screen.queryByText(/Source members|Detail section|payload/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next connectors" }));
    await screen.findByText("Later connector");
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledTimes(4));
    expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", props.recordId, expect.anything(), "connectorOperation", undefined,
      { value: "10", limit: 10, signal: expect.any(AbortSignal) });
    fireEvent.click(screen.getByRole("button", { name: "Previous connectors" }));
    expect(await screen.findByText("Excel connector")).toBeVisible();
  });
  it("surfaces configuration errors and retries without falling back to raw JSON", async () => {
    vi.mocked(api.getInventoryChildren).mockRejectedValueOnce(new Error("Selected configuration expired"));
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Selected configuration expired");
    fireEvent.click(screen.getByRole("button", { name: "Retry configuration" }));
    expect(await screen.findByText("Excel connector")).toBeVisible();
  });
  it("rejects invalid operation shapes instead of rendering partial success", async () => {
    vi.mocked(api.getInventoryChildren).mockImplementation(async (_s, _r, _m, kind) => ({
      value: kind === "detail:connectors" ? [connector("0", "Excel")]
        : [{ ordinal: 2, kind, value: "0", payload: { operationId: "RunScript", isEnabled: "false" } }],
      total: 1, nextCursor: null,
    }));
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved agent configuration is invalid");
    expect(screen.queryByText("RunScript")).not.toBeInTheDocument();
  });
  it("loads channels from the same pinned source without exposing storage field names", async () => {
    render(<SavedAgentChannels {...props} />);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledOnce());
    expect(await screen.findByText("microsoft Teams")).toBeVisible();
  });
  it("pages published versions in the original selector without draining source membership", async () => {
    const onSelect = vi.fn();
    render(<AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Published version details" });
    await within(select).findByRole("option", { name: "Published agent" });
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    fireEvent.change(select, { target: { value: "first-package" } });
    expect(onSelect).toHaveBeenCalledWith("first-package");
    fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
    await waitFor(() => expect(api.getInventoryMembers).toHaveBeenLastCalledWith("selected", record.id, "next-versions", expect.anything()));
    await waitFor(() => expect(within(select).getByRole("option", { name: "Published agent" })).toHaveValue("later-package"));
    fireEvent.change(select, { target: { value: "later-package" } });
    expect(onSelect).toHaveBeenLastCalledWith("later-package");
    expect(screen.queryByText("Source members")).not.toBeInTheDocument();
  });
  it("aborts obsolete configuration reads when the pinned selection changes", async () => {
    const pending = deferred<Children>();
    vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    const view = render(<SavedAgentConnectors {...props} />);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.getInventoryChildren).mock.calls[0][5]?.signal;
    view.rerender(<SavedAgentConnectors {...props} selectionId="next-selection" />);
    expect(await screen.findByText("Excel connector")).toBeVisible(); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ value: [connector("0", "Obsolete")], total: 1, nextCursor: null }));
    expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
  });
});
