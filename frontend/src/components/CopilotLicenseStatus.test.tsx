import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import type { CombinedUser } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import { readReportDetail, readReportPage } from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { combinedUser, reportPage, reportUser } from "../test/reportDataFixture";
import { deferred } from "../test/deferred";
import { mockNativeDialogs } from "../test/dialog";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { CopilotUsersView } from "./CopilotUsersView";
import { UserDetailModal } from "./UserDetailModal";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportDetail: vi.fn(), readReportPage: vi.fn(),
}));
mockNativeDialogs();
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

const states = [
  ["enabled", "M365 Copilot licensed", "Active", ""],
  ["warning", "M365 Copilot licensed", "Active (grace period)", ""],
  ["partially_enabled", "M365 Copilot licensed", "Partially active", ""],
  ["disabled", "No active M365 Copilot license", "Not enabled", "attention"],
  ["suspended", "No active M365 Copilot license", "Suspended", "attention"],
  ["locked_out", "No active M365 Copilot license", "Locked out", "attention"],
  ["unknown", "License not verified", "Unverified", "unknown"],
] as const;

describe("effective M365 Copilot license status", () => {
  it.each(states)("classifies %s from effective paid features, not candidate membership", (state, license, features, tone) => {
    render(<CopilotLicenseStatus user={{ copilotServiceState: state }} />);
    expect(screen.getByText(license, { exact: true })).toHaveAttribute("class", `copilot-user-badge ${tone}`);
    expect(screen.getByText(features, { exact: true })).toBeVisible();
    if (license !== "M365 Copilot licensed") {
      expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/^(Basic|Disabled|Paid license assigned)$/)).not.toBeInTheDocument();
  });

  it.each(states)("qualifies retained %s evidence as last saved, never current entitlement", (state, license, features) => {
    render(<CopilotLicenseStatus user={{ copilotServiceState: state }} current={false} />);
    expect(screen.getByText(`Last saved: ${license}`, { exact: true })).toHaveClass("unknown");
    expect(screen.getByText(`Last saved: ${features}`, { exact: true })).toHaveClass("unknown");
    expect(screen.queryByText(license, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(features, { exact: true })).not.toBeInTheDocument();
  });

  it.each([undefined, null])("does not infer a license without a matched directory user (%s)", user => {
    render(<CopilotLicenseStatus user={user} />);
    expect(screen.getByText("License not verified")).toHaveClass("unknown");
    expect(screen.queryByText(/^(M365 Copilot licensed|No active M365 Copilot license|Basic|Disabled)$/)).not.toBeInTheDocument();
  });

  describe.each(["no_paid", "paid_inactive"] as const)("server-verified %s entitlement", entitlement => {
    it.each([undefined, null])("does not require a detailed directory link (%s)", user => {
      render(<CopilotLicenseStatus user={user} entitlement={entitlement} />);
      expect(screen.getByText("No active M365 Copilot license")).toHaveClass("attention");
      expect(screen.queryByText(/License not verified|Paid features:/)).not.toBeInTheDocument();
    });
  });

  it.each(states)("keeps server-verified nonpaid membership authoritative over %s directory evidence", (state, _license, features) => {
    render(<CopilotLicenseStatus user={{ copilotServiceState: state }} entitlement="no_paid" />);
    expect(screen.getByText("No active M365 Copilot license")).toBeVisible();
    expect(screen.queryByText(/^(License not verified|M365 Copilot licensed)$/)).not.toBeInTheDocument();
    if (state === "disabled" || state === "suspended" || state === "locked_out") {
      expect(screen.getByText(features, { exact: true })).toBeVisible();
    } else {
      expect(screen.queryByText(/Paid features:/)).not.toBeInTheDocument();
    }
  });

  it("does not mislabel retained nonpaid evidence as a current license verification", () => {
    render(<CopilotLicenseStatus user={{ copilotServiceState: "disabled" }} current={false} entitlement="no_paid" />);
    expect(screen.getByText("Last saved: No active M365 Copilot license", { exact: true })).toHaveClass("unknown");
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Paid features:/)).not.toBeInTheDocument();
  });
});

function evidence<T>(value: T): OfficialReportDetail<T> {
  const { selection, sources, reports } = reportPage([]);
  return { value, selection, sources, reports };
}
function modalProps(overrides: Partial<ComponentProps<typeof UserDetailModal>> = {}): ComponentProps<typeof UserDetailModal> {
  return { kind: "directory", identity: combinedUser().directory.objectId, returnFocusTo: createRef<HTMLButtonElement>(),
    closeLabel: "Close user details", onClose: vi.fn(), ...overrides };
}

describe("license evidence read ownership", () => {
  beforeEach(() => {
    vi.mocked(readReportDetail).mockResolvedValue(evidence(combinedUser()));
    vi.mocked(readReportPage).mockResolvedValue(reportPage([]));
  });

  it("withdraws license evidence and cancels feature reads when the saved source revision changes", async () => {
    const plans = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockReturnValue(plans.promise);
    const props = modalProps();
    const view = render(<UserDetailModal {...props} />);
    await screen.findByText("M365 Copilot licensed", { exact: true });
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    const refreshed = deferred<OfficialReportDetail<CombinedUser>>();
    vi.mocked(readReportDetail).mockReturnValue(refreshed.promise);
    view.rerender(<UserDetailModal {...props} dataRevision={1} />);
    expect(screen.getByText("Loading exact user details...")).toBeVisible();
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    const inactive = { ...combinedUser(), copilotServiceState: "disabled" as const, entitlement: "no_paid" as const };
    await act(async () => refreshed.resolve(evidence(inactive)));
    expect(await screen.findByText("No active M365 Copilot license", { exact: true })).toBeVisible();
    await act(async () => plans.resolve(reportPage([])));
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
  });

  it("waits for replacement report evidence before requesting its directory link and ignores an obsolete completion", async () => {
    const report = evidence(reportUser());
    const oldDirectory = deferred<OfficialReportDetail<CombinedUser>>();
    vi.mocked(readReportDetail).mockResolvedValueOnce(report).mockReturnValueOnce(oldDirectory.promise);
    const props = modalProps({ kind: "report", identity: report.value.username, selectionId: report.selection.id });
    const view = render(<UserDetailModal {...props} />);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(2));
    const oldSignal = vi.mocked(readReportDetail).mock.calls[1][2];
    const replacement = deferred<typeof report>();
    vi.mocked(readReportDetail).mockReturnValueOnce(replacement.promise).mockResolvedValue(evidence({
      ...combinedUser(), copilotServiceState: "disabled", entitlement: "no_paid",
    }));
    view.rerender(<UserDetailModal {...props} dataRevision={1} />);
    expect(screen.getByText("Loading exact user details...")).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);
    expect(readReportDetail).toHaveBeenCalledTimes(3);
    await act(async () => replacement.resolve(report));
    expect(await screen.findByText("Not enabled", { exact: true })).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(4);
    await act(async () => oldDirectory.resolve(evidence(combinedUser())));
    expect(screen.queryByText("Active", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
  });

  it("distinguishes a pending directory link from missing license and organization details", async () => {
    const report = evidence(reportUser());
    const pending = deferred<OfficialReportDetail<CombinedUser>>();
    vi.mocked(readReportDetail).mockResolvedValueOnce(report).mockReturnValueOnce(pending.promise);
    render(<UserDetailModal {...modalProps({ kind: "report", identity: report.value.username, selectionId: report.selection.id })} />);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(2));
    expect(screen.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
    expect(screen.getByText("Loading directory details...")).toBeVisible();
    expect(screen.queryByText("Organization details are unavailable for this report identity.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    expect(screen.queryByText("Detailed license assignments are unavailable for this report identity.")).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error("Directory read failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory read failed");
    expect(screen.getByRole("button", { name: "Retry directory details" })).toBeVisible();
    expect(screen.queryByText("Loading directory details...")).not.toBeInTheDocument();
  });

  it("withdraws a verified nonpaid badge when linked evidence rejects its selection", async () => {
    const report = evidence(reportUser());
    vi.mocked(readReportDetail).mockResolvedValueOnce(report)
      .mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Selected directory evidence changed."));
    render(<UserDetailModal {...modalProps({ kind: "report", identity: report.value.username,
      selectionId: report.selection.id, onRestartSelection: vi.fn() })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Selected directory evidence changed.");
    expect(screen.queryByRole("group", { name: "User summary" })).not.toBeInTheDocument();
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart selection" })).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it.each(["Licenses", "Usage & agents"])("retires license evidence across tabs when %s paging invalidates its selection", async invalidatedTab => {
    const sibling = deferred<ReturnType<typeof reportPage>>();
    const invalidatedPath = invalidatedTab === "Licenses" ? "/service-plans" : "/agents";
    vi.mocked(readReportPage).mockImplementation(path => path.endsWith(invalidatedPath)
      ? Promise.reject(new ApiError(409, "selection_invalidated", "User selection changed."))
      : sibling.promise);
    render(<UserDetailModal {...modalProps()} />);
    await screen.findByText("M365 Copilot licensed", { exact: true });
    fireEvent.click(screen.getByRole("tab", { name: invalidatedTab === "Licenses" ? "Usage & agents" : "Licenses" }));
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    fireEvent.click(screen.getByRole("tab", { name: invalidatedTab }));
    await screen.findByRole("button", { name: "Restart selection" });
    await waitFor(() => expect(signal?.aborted).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart selection" })).toBeVisible();
    await act(async () => sibling.resolve(reportPage([])));
    expect(screen.queryByRole("group", { name: "User summary" })).not.toBeInTheDocument();
    fireEvent.focus(window);
    expect(readReportDetail).toHaveBeenCalledOnce();
    expect(readReportPage).toHaveBeenCalledTimes(2);
  });

  it.each(["licenses", "activity"] as const)("retires the shared %s cohort when license detail rejects its selection", async cohort => {
    const client = createSavedQueryClient();
    vi.mocked(readReportPage).mockImplementation(async path => {
      if (path.endsWith("/service-plans")) throw new ApiError(409, "selection_invalidated", "Paid-feature selection changed.");
      return cohort === "licenses" ? reportPage([combinedUser()]) : reportPage([reportUser()]);
    });
    vi.mocked(readReportDetail).mockImplementation(async path => path.startsWith("official-usage") && !path.endsWith("/directory")
      ? evidence(reportUser()) : evidence(combinedUser()));
    const route = { view: cohort, search: "", page: 0 };
    render(<QueryClientProvider client={client}><CopilotUsersView route={route} /><CopilotUsersView route={route} /></QueryClientProvider>);
    const pages = screen.getAllByRole("region", { name: "Users and adoption" }).map(element => within(element));
    fireEvent.click(await pages[0].findByRole("button", { name: "User 1" }));
    await screen.findByText("Contoso", { selector: "dd" });
    expect(readReportPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    for (const page of pages) {
      expect(await page.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
      expect(page.queryByRole("button", { name: "User 1" })).not.toBeInTheDocument();
      expect(page.getByRole("button", { name: "Export users CSV" })).toBeDisabled();
      expect(page.getByRole("button", { name: "Restart selection" })).toBeVisible();
    }
    fireEvent.focus(window);
    expect(readReportPage).toHaveBeenCalledTimes(2);
  });

  it("ignores a cancelled child invalidation after replacement license evidence loads", async () => {
    const oldPlans = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockReturnValueOnce(oldPlans.promise).mockResolvedValue(reportPage([]));
    const props = modalProps();
    const view = render(<UserDetailModal {...props} />);
    await screen.findByText("M365 Copilot licensed", { exact: true });
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    view.rerender(<UserDetailModal {...props} dataRevision={1} />);
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(2));
    await act(async () => oldPlans.reject(new ApiError(409, "selection_invalidated", "Obsolete selection.")));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(await screen.findByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it.each(["user", "directory"] as const)("shares overlapping %s retries and hides the prior error while retrying", async target => {
    const client = createSavedQueryClient(), report = evidence(reportUser()), directory = evidence(combinedUser());
    const props = modalProps(target === "directory"
      ? { kind: "report", identity: report.value.username, selectionId: report.selection.id } : {});
    vi.mocked(readReportDetail).mockImplementation(async path => target === "directory" && !path.endsWith("/directory") ? report : directory);
    render(<QueryClientProvider client={client}><UserDetailModal {...props} /></QueryClientProvider>);
    await screen.findByText("Contoso");
    vi.mocked(readReportDetail).mockRejectedValue(new Error("Saved evidence unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", target === "user" ? "report-detail" : "report-directory-detail"] }); });
    const retry = await screen.findByRole("button", { name: `Retry ${target} details` });
    const pending = deferred<typeof directory>();
    vi.mocked(readReportDetail).mockClear().mockReturnValue(pending.promise);
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(readReportDetail).toHaveBeenCalledOnce();
    expect(vi.mocked(readReportDetail).mock.calls[0][2]?.aborted).toBe(false);
    expect(await screen.findByText(target === "user" ? "Loading exact user details..." : "Loading directory details...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve(directory));
    expect(await screen.findByText("Contoso")).toBeVisible();
  });

  it.each(["2000-01-01T00:00:00.000Z", "not-a-date"])("rejects expired or invalid returned license selection expiry %s", async expiresAt => {
    const saved = evidence(combinedUser());
    saved.selection.expiresAt = expiresAt;
    vi.mocked(readReportDetail).mockResolvedValue(saved);
    render(<UserDetailModal {...modalProps()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/);
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart selection" })).toBeVisible();
  });

  it("retires an expiring direct-user selection without a reload loop and explicitly captures fresh evidence", async () => {
    vi.useFakeTimers();
    const saved = evidence(combinedUser());
    saved.selection.expiresAt = new Date(Date.now() + 5000).toISOString();
    vi.mocked(readReportDetail).mockResolvedValue(saved);
    await act(async () => { render(<UserDetailModal {...modalProps()} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/expired/);
    expect(readReportDetail).toHaveBeenCalledOnce();
    vi.mocked(readReportDetail).mockResolvedValue(evidence({ ...combinedUser(), copilotServiceState: "disabled", entitlement: "no_paid" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart selection" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
    expect(readReportDetail).toHaveBeenLastCalledWith(expect.any(String), undefined, expect.any(AbortSignal));
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it("accepts equivalent UUID casing without recapturing license evidence", async () => {
    const saved = evidence(combinedUser());
    saved.value.directory.objectId = "abcdefab-1234-4567-8901-abcdefabcdef";
    saved.selection.id = "fedcbafe-1234-4567-8901-abcdefabcdef";
    vi.mocked(readReportDetail).mockResolvedValue(saved);
    const props = modalProps({ identity: saved.value.directory.objectId.toUpperCase(), selectionId: saved.selection.id.toUpperCase() });
    const view = render(<UserDetailModal {...props} />);
    expect(await screen.findByText("M365 Copilot licensed", { exact: true })).toBeVisible();
    view.rerender(<UserDetailModal {...props} identity={saved.value.directory.objectId} selectionId={saved.selection.id} />);
    expect(readReportDetail).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps report usernames case-sensitive when validating exact license evidence", async () => {
    const report = evidence(reportUser(1, { username: "CaseSensitive@example.invalid" }));
    vi.mocked(readReportDetail).mockResolvedValue(report);
    render(<UserDetailModal {...modalProps({ kind: "report", identity: report.value.username.toLowerCase(), selectionId: report.selection.id })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact user evidence does not match");
    expect(readReportDetail).toHaveBeenCalledOnce();
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
  });

  it("expires linked license evidence on focus even when the capability clock has not advanced", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const report = evidence(reportUser()), pending = deferred<OfficialReportDetail<CombinedUser>>();
    report.selection.expiresAt = new Date(Date.now() + 5000).toISOString();
    const capability: ReturnType<typeof useCapabilityContext> = {
      user: { tenantId: "tenant", homeAccountId: "account", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
      now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
    };
    vi.mocked(readReportDetail).mockResolvedValueOnce(report).mockReturnValueOnce(pending.promise);
    render(<CapabilityContext value={capability}><UserDetailModal {...modalProps({
      kind: "report", identity: report.value.username, selectionId: report.selection.id, onRestartSelection: vi.fn(),
    })} /></CapabilityContext>);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(readReportDetail).mock.calls[1][2];
    expect(screen.getByText("No active M365 Copilot license", { exact: true })).toBeVisible();
    vi.setSystemTime(Date.now() + 6000);
    fireEvent.focus(window);
    expect(screen.getByRole("alert")).toHaveTextContent(/expired/);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(evidence(combinedUser())));
    expect(screen.queryByText("No active M365 Copilot license", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("M365 Copilot licensed", { exact: true })).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it.each(["licenses", "activity"] as const)("preserves the %s license dialog without reloading when equivalent roles are reordered", async cohort => {
    const capability: ReturnType<typeof useCapabilityContext> = {
      user: { tenantId: "tenant", homeAccountId: "account", username: "viewer@example.invalid", displayName: "Viewer",
        roles: ["AgentControl.Viewer", "AgentControl.Admin"] },
      now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
    };
    vi.mocked(readReportPage).mockResolvedValue(cohort === "licenses" ? reportPage([combinedUser()]) : reportPage([reportUser()]));
    vi.mocked(readReportDetail).mockImplementation(async path => path.startsWith("official-usage") && !path.endsWith("/directory")
      ? evidence(reportUser()) : evidence(combinedUser()));
    const props = { route: { view: cohort, search: "", page: 0 } };
    const view = render(<CapabilityContext value={capability}><CopilotUsersView {...props} /></CapabilityContext>);
    fireEvent.click(await screen.findByRole("button", { name: "User 1" }));
    const dialog = await screen.findByRole("dialog", { name: "User 1" });
    await within(dialog).findByText("Contoso");
    const pageReads = vi.mocked(readReportPage).mock.calls.length, detailReads = vi.mocked(readReportDetail).mock.calls.length;
    view.rerender(<CapabilityContext value={{ ...capability, user: { ...capability.user!, roles: [...capability.user!.roles].reverse() } }}>
      <CopilotUsersView {...props} />
    </CapabilityContext>);
    expect(screen.getByRole("dialog", { name: "User 1" })).toBe(dialog);
    expect(readReportPage).toHaveBeenCalledTimes(pageReads);
    expect(readReportDetail).toHaveBeenCalledTimes(detailReads);
  });
});
