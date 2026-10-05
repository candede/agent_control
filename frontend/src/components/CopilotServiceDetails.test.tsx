import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportPage, selectionId } from "../test/reportDataFixture";
import { readReportPage } from "../api/reportData";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { resolveCopilotServicePlan } from "../../../backend/src/services/copilotServicePlans";
vi.mock("../api/reportData", () => ({ readReportPage: vi.fn() }));
const path = "copilot-usage/users/11111111-1111-4111-8111-111111111111/service-plans";
const servicePlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
beforeEach(() => vi.mocked(readReportPage).mockResolvedValue(reportPage([], { counts: { total: 0, filtered: 0 } })));

describe("paid-feature evidence details", () => {
  it("recognizes verified disabled users with no assigned paid services", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByText("No paid Copilot services are assigned.")).toBeVisible();
    expect(screen.queryByText(/unverified|evidence not reported|Run Users Sync/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
  });

  it("does not infer no paid services from unknown assignments", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="unknown" current />);
    expect(await screen.findByText("Paid-feature status is unavailable. Refresh Users in Sync.")).toBeVisible();
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });

  it("qualifies an old no-services observation without calling that evidence missing", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current={false} />);
    expect(await screen.findByText("Last saved: no paid Copilot services were assigned.")).toBeVisible();
    expect(screen.getByText("Refresh Users in Sync to verify current paid-feature status.")).toBeVisible();
    expect(screen.queryByText(/Paid-feature evidence not reported/)).not.toBeInTheDocument();
  });

  it("keeps assigned but disabled service evidence distinct from no assigned services", async () => {
    const plan = resolveCopilotServicePlan(servicePlanId, false, []);
    vi.mocked(readReportPage).mockResolvedValue(reportPage([plan]));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByRole("list", { name: "Paid feature states" })).toHaveTextContent("Not enabled");
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });

  it("renders normalized assignment evidence without changing the effective paid-feature state", async () => {
    const plan = resolveCopilotServicePlan(servicePlanId, false, [{
      servicePlanId, assignedDateTime: "2026-01-01T01:00:00+01:00", capabilityStatus: "Enabled",
    }]);
    vi.mocked(readReportPage).mockResolvedValue(reportPage([plan]));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByRole("list", { name: "Paid feature states" })).toHaveTextContent("Not enabled");
    expect(screen.queryByText(/Raw capability status:/)).not.toBeInTheDocument();
    expect(screen.getByText("Assigned Jan 1, 2026")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
  });
  it("does not turn a byte-short empty page into no assigned services", async () => {
    vi.mocked(readReportPage).mockResolvedValue(reportPage([], { counts: { total: 800, filtered: 800 }, page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next plans" })).toHaveAttribute("aria-disabled", "false"));
    expect(screen.queryByText("No paid Copilot services are assigned.")).not.toBeInTheDocument();
  });
});
