import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { usageInsightsPublished } from "../test/usageInsightsFixture";
import { reportHistoryFixture } from "./reportHistoryFixture";
import { OfficialUsageReportSelector } from "./OfficialUsageReportSelector";

const first = {
  ...usageInsightsPublished.activeSet!, id: "11111111-1111-4111-8111-111111111111",
  reportingPeriod: { ...usageInsightsPublished.activeSet!.reportingPeriod, provenance: "activity_range" as const },
};
const second = {
  ...first, id: "22222222-2222-4222-8222-222222222222",
  reportingPeriod: { startDate: "2026-07-01", endDate: "2026-07-30", provenance: "operator_asserted" as const },
};
let activeSetId: string | null;
let activeRevision: number;

function admin(): api.OfficialUsageAdminState {
  return { activeSetId, activeRevision, sets: [first, second], staging: [] };
}
function confirmation(setId = second.id): api.OfficialUsageConfirmation {
  return {
    id: "confirmation", operation: "select", setId, activeSetId, expectedRevision: activeRevision,
    confirmationHash: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z",
  };
}
beforeEach(() => {
  activeSetId = first.id;
  activeRevision = 3;
  vi.spyOn(api, "getOfficialUsageAdminState").mockImplementation(async () => admin());
  vi.spyOn(api, "getOfficialUsageHistory").mockImplementation(async () => reportHistoryFixture([first, second], activeSetId));
  vi.spyOn(api, "previewOfficialUsageSetOperation").mockImplementation(async setId => confirmation(setId));
  vi.spyOn(api, "confirmOfficialUsageSetOperation").mockImplementation(async preview => {
    activeSetId = preview.setId;
    activeRevision += 1;
    return { activeSetId, activeRevision };
  });
});
afterEach(() => vi.restoreAllMocks());

async function ready() {
  const select = await screen.findByRole("combobox", { name: "Report set" });
  await waitFor(() => expect(select).toBeEnabled());
  return select;
}

async function choose() {
  const select = await ready();
  await userEvent.selectOptions(select, second.id);
  return select;
}

describe("shared report-set selector", () => {
  it("applies a dropdown selection immediately without action buttons or explanatory text", async () => {
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    const select = await ready();
    expect(within(select).getByRole("option", { name: /Observed activity/ })).toHaveTextContent(first.id.slice(0, 8));
    expect(within(select).getByRole("option", { name: "Reporting window: 2026-07-01 to 2026-07-30 | 22222222" })).toBeVisible();
    expect(select).not.toHaveTextContent("Imported");
    expect(select).toHaveAttribute("title", `Observed activity: ${first.reportingPeriod.startDate} to ${first.reportingPeriod.endDate} | 11111111`);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select one saved three-file/)).not.toBeInTheDocument();
    expect(api.previewOfficialUsageSetOperation).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, second.id);
    await waitFor(() => expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce());
    expect(api.previewOfficialUsageSetOperation).toHaveBeenCalledWith(second.id, "select");
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(second.id);
    expect(select).toHaveAttribute("title", "Reporting window: 2026-07-01 to 2026-07-30 | 22222222");
    expect(screen.queryByText(/Report set selected/)).not.toBeInTheDocument();
    await userEvent.selectOptions(select, second.id);
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce();
  });

  it("can select an older page while displaying a current selection outside both metadata pages", async () => {
    const older = { ...second, id: "33333333-3333-4333-8333-333333333333" };
    activeSetId = "44444444-4444-4444-8444-444444444444";
    vi.mocked(api.getOfficialUsageHistory).mockImplementation(async query => {
      const page = reportHistoryFixture(query?.offset ? [older] : [first, second], activeSetId);
      return { ...page, bundles: { ...page.bundles, offset: query?.offset ?? 0, limit: 100, count: 101 } };
    });
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    expect(await screen.findByRole("option", { name: /Current report 44444444 \(outside this page\)/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Older report sets" }));
    expect(await screen.findByRole("option", { name: /33333333/ })).toBeVisible();
    expect(api.getOfficialUsageHistory).toHaveBeenLastCalledWith({ limit: 100, offset: 100 }, { signal: expect.any(AbortSignal) });
    expect(screen.getByRole("button", { name: "Older report sets" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox"), older.id);
    await waitFor(() => expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledWith(expect.objectContaining({ setId: older.id })));
  });

  it("requires a successful refresh after the shared revision changes before preview", async () => {
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    activeRevision += 1;
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("shared report selection changed");
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveValue(first.id);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await choose();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce());
  });

  it("verifies uncertain selection through reads rather than retrying a consumed confirmation", async () => {
    vi.mocked(api.confirmOfficialUsageSetOperation).mockImplementationOnce(async preview => {
      activeSetId = preview.setId;
      activeRevision += 1;
      throw new api.ApiError(0, "network_error", "Connection lost.");
    });
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("may have been saved");
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(second.id));
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps a saved selection successful when its metadata reload fails", async () => {
    const onChanged = vi.fn();
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await ready();
    vi.mocked(api.getOfficialUsageAdminState).mockRejectedValueOnce(new Error("Metadata unavailable."));
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Metadata unavailable");
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("combobox")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(second.id));
    expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("hides report options after a %s refresh failure", async status => {
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    vi.mocked(api.getOfficialUsageHistory).mockRejectedValueOnce(new api.ApiError(status, "forbidden", "Report access denied."));
    view.rerender(<OfficialUsageReportSelector principalKey="admin" revision={1} onChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report access denied");
    expect(screen.queryByRole("option", { name: /2026-07-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("does not confirm a preview that completes after unmount", async () => {
    let resolve!: (value: api.OfficialUsageConfirmation) => void;
    vi.mocked(api.previewOfficialUsageSetOperation).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const onChanged = vi.fn();
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Selecting report set");
    view.unmount();
    await act(async () => resolve(confirmation()));
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("clears cached options when selection permission is revoked", async () => {
    vi.mocked(api.previewOfficialUsageSetOperation).mockRejectedValueOnce(new api.ApiError(403, "forbidden", "Admin role required."));
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Admin role required");
    expect(screen.queryByRole("option", { name: /2026-07-01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
  });

  it("can return from an older page after retained reports are deleted", async () => {
    let shrunk = false;
    vi.mocked(api.getOfficialUsageHistory).mockImplementation(async query => {
      const page = reportHistoryFixture(query?.offset && shrunk ? [] : [first, second], activeSetId);
      return { ...page, bundles: { ...page.bundles, offset: query?.offset ?? 0, limit: 100, count: shrunk ? 2 : 102 } };
    });
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    await ready();
    shrunk = true;
    await userEvent.click(screen.getByRole("button", { name: "Older report sets" }));
    expect(await screen.findByText(/No report sets remain on this page/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Newer report sets" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /2026-07-01/ })).toBeVisible());
    expect(screen.queryByRole("button", { name: "Older report sets" })).not.toBeInTheDocument();
  });

  it("does not notify a replacement screen when a confirmation completes after unmount", async () => {
    let resolve!: (value: { activeSetId: string; activeRevision: number }) => void;
    vi.mocked(api.confirmOfficialUsageSetOperation).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const onChanged = vi.fn();
    const view = render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={onChanged} />);
    await choose();
    await waitFor(() => expect(api.confirmOfficialUsageSetOperation).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => resolve({ activeSetId: second.id, activeRevision: 4 }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shows empty history within the dropdown without adding extra UI", async () => {
    activeSetId = null;
    vi.mocked(api.getOfficialUsageHistory).mockResolvedValue(reportHistoryFixture([]));
    render(<OfficialUsageReportSelector principalKey="admin" revision={0} onChanged={vi.fn()} />);
    expect(await screen.findByRole("option", { name: "No report sets available" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(api.confirmOfficialUsageSetOperation).not.toHaveBeenCalled();
  });
});
