import { createRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { officeAdoption } from "../api/officeAppAdoption";
import { readReportDetail } from "../api/reportData";
import { mockNativeDialogs } from "../test/dialog";
import { officeContext, officePerson } from "../test/officeAdoptionFixture";
import { useOfficeAdoption } from "../useOfficeAdoption";
import { useReportPrincipalScope } from "../useReportPage";
import { usageDate } from "../usageInsights";
import type { OfficePerson } from "../../../backend/src/types/officeAppAdoption";
import { OfficePersonDialog } from "./OfficePersonDialog";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/officeAppAdoption", async original => ({
  ...await original<typeof import("../api/officeAppAdoption")>(),
  officeAdoption: { context: vi.fn(), people: vi.fn() },
}));
vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(),
  readReportDetail: vi.fn(),
}));
vi.mock("../useReportPage", async original => ({
  ...await original<typeof import("../useReportPage")>(),
  useReportPrincipalScope: vi.fn(),
}));

mockNativeDialogs();

const openProfileLabel = "Open separate current profile, licenses and agent evidence";

beforeEach(() => {
  vi.mocked(useReportPrincipalScope).mockReturnValue("first-principal");
  vi.mocked(officeAdoption.context).mockResolvedValue(officeContext());
  vi.mocked(readReportDetail).mockRejectedValue(new ApiError(404, "data_record_not_found", "No current profile."));
  vi.stubGlobal("fetch", vi.fn());
});

function Harness({ person = officePerson(), revision = 0 }: { person?: OfficePerson; revision?: number }) {
  const owner = useOfficeAdoption({}, revision, vi.fn());
  const returnFocusTo = createRef<HTMLElement>();
  return <>
    <output>{owner.principal}:{owner.isCurrent() ? "ready" : "pending"}</output>
    <OfficePersonDialog owner={owner} identity={person.identity} groupId={person.groupId} revision={revision}
      onClose={vi.fn()} returnFocusTo={returnFocusTo} accepted={{
        person, observationId: officeContext().observation!.id, principal: owner.principal, query: {},
      }} />
  </>;
}

function content(person = officePerson(), revision = 0) {
  return <SavedQueryProvider><Harness person={person} revision={revision} /></SavedQueryProvider>;
}

describe("OfficePersonDialog", () => {
  it("distinguishes the selected refresh from the original retained app report refresh", async () => {
    const person = officePerson(1, {
      appReportRefreshDate: "2026-09-23", recentApps: [], latestRecentDate: null, unknownReasons: ["retained_row", "wrong_window"],
    });
    render(content(person));
    const frozen = within(await screen.findByRole("region", { name: "Frozen Office person evidence" }));
    expect(frozen.getByText("Selected provider refresh").nextElementSibling)
      .toHaveTextContent(usageDate(officeContext().observation!.reportRefreshDate));
    expect(frozen.getByText("App evidence provider refresh").nextElementSibling)
      .toHaveTextContent(usageDate(person.appReportRefreshDate));
    expect(frozen.getByText("0 of 7")).toBeVisible();
    expect(frozen.getByText("retained row, wrong window")).toBeVisible();
    expect(readReportDetail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing app refresh as unknown rather than substituting the selected refresh", async () => {
    render(content(officePerson(1, {
      appReportRefreshDate: null, appObservedAt: null, unknownReasons: ["missing_row"], recentApps: [], latestRecentDate: null,
      dates: { word: null, excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null },
    })));
    const frozen = within(await screen.findByRole("region", { name: "Frozen Office person evidence" }));
    expect(frozen.getByText("App evidence provider refresh").nextElementSibling).toHaveTextContent("Unknown");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["button", "Escape", "cancel"] as const)(
    "keeps frozen facts independent of a missing optional current profile and closes it with %s", async method => {
      render(content());
      const frozen = await screen.findByRole("region", { name: "Frozen Office person evidence" });
      const trigger = screen.getByRole("button", { name: openProfileLabel });
      expect(readReportDetail).not.toHaveBeenCalled();
      trigger.focus();
      fireEvent.click(trigger);
      await screen.findByText(/This user is not in the saved Users directory/);
      expect(readReportDetail).toHaveBeenCalledExactlyOnceWith(`copilot-usage/users/${officePerson().identity}`, undefined, expect.any(AbortSignal));
      const profile = screen.getByRole("dialog", { name: officePerson().identity });
      if (method === "button") fireEvent.click(within(profile).getByRole("button", { name: "Close current profile" }));
      else if (method === "Escape") fireEvent.keyDown(profile, { key: "Escape" });
      else fireEvent(profile, new Event("cancel", { cancelable: true, bubbles: true }));
      expect(screen.queryByRole("dialog", { name: officePerson().identity })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: officePerson().displayName! })).toHaveAttribute("open");
      expect(screen.getByRole("region", { name: "Frozen Office person evidence" })).toBe(frozen);
      expect(within(frozen).getByText("2 of 7")).toBeVisible();
      expect(trigger).toHaveFocus();
      expect(document.body.style.overflow).toBe("hidden");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not transfer an open current profile to another person or reopen it on returning", async () => {
    const first = officePerson(1), second = officePerson(2);
    const { rerender } = render(content(first));
    fireEvent.click(await screen.findByRole("button", { name: openProfileLabel }));
    await screen.findByText(/This user is not in the saved Users directory/);
    rerender(content(second));
    await screen.findByRole("dialog", { name: second.displayName! });
    expect(screen.queryByRole("button", { name: "Close current profile" })).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledOnce();
    rerender(content(first));
    await screen.findByRole("dialog", { name: first.displayName! });
    expect(screen.queryByRole("button", { name: "Close current profile" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: openProfileLabel }));
    await screen.findByText(/This user is not in the saved Users directory/);
    expect(readReportDetail).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retires the optional profile when the signed-in principal changes", async () => {
    const { rerender } = render(content());
    fireEvent.click(await screen.findByRole("button", { name: openProfileLabel }));
    await screen.findByText(/This user is not in the saved Users directory/);
    vi.mocked(useReportPrincipalScope).mockReturnValue("second-principal");
    rerender(content());
    await screen.findByText("second-principal:ready");
    await screen.findByRole("region", { name: "Frozen Office person evidence" });
    expect(screen.queryByRole("button", { name: "Close current profile" })).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an explicitly opened current profile through same-person evidence revalidation", async () => {
    const { rerender } = render(content());
    fireEvent.click(await screen.findByRole("button", { name: openProfileLabel }));
    await screen.findByText(/This user is not in the saved Users directory/);
    rerender(content(officePerson(), 1));
    await waitFor(() => expect(officeAdoption.context).toHaveBeenCalledTimes(2));
    await screen.findByText(/This user is not in the saved Users directory/);
    expect(screen.getByRole("button", { name: "Close current profile" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Frozen Office person evidence" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
