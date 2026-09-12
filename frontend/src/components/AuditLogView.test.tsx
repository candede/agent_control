import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAdministrativeAuditCsv, getAuditEvents } from "../api/client";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AuditLogView } from "./AuditLogView";

vi.mock("./CapabilityGate", () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getAuditEvents: vi.fn(),
  downloadAdministrativeAuditCsv: vi.fn(),
}));

vi.mock("./PurviewAuditView", () => ({
  PurviewAuditView: ({
    initialJobId,
    onSelectedJobChange,
  }: {
    initialJobId?: string;
    onSelectedJobChange?: (jobId: string) => void;
  }) => (
    <section aria-label="Mock Purview">
      <span>{initialJobId ?? "No selected Purview job"}</span>
      <button type="button" onClick={() => onSelectedJobChange?.("older-job")}>Select older job</button>
    </section>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/audit?q=saved+actor&action=block&status=failed");
  vi.mocked(getAuditEvents).mockResolvedValue({ value: [], count: 0 });
});

describe("AuditLogView routing", () => {
  it("exports exact displayed event IDs through the authorized server rather than serializing cached rows", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      id: "event-1", operationId: "operation-1", action: "block", targetBlockedState: true, scope: "single",
      agentId: "package-1", actor: { homeAccountId: "fixture", username: "fixture@example.invalid", displayName: "Fixture", roles: ["AgentControl.Viewer"] },
      startedAt: "2026-09-10T10:00:00.000Z", status: "failed", requestPath: "/fixture",
    }] });
    vi.mocked(downloadAdministrativeAuditCsv).mockRejectedValue(new Error("Download not authorized"));
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    const button = await screen.findByRole("button", { name: "Export current audit page CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(downloadAdministrativeAuditCsv).toHaveBeenCalledWith(["event-1"], expect.any(AbortSignal));
    expect(await screen.findByText("Download not authorized")).toBeVisible();
  });

  it("restores saved local filters and preserves exact source selection through browser back and forward", async () => {
    const user = userEvent.setup();
    render(<AuditLogView agents={[]} />);

    expect(await screen.findByLabelText("Search")).toHaveValue("saved actor");
    expect(screen.getByLabelText("Action")).toHaveValue("block");
    expect(screen.getByLabelText("Result")).toHaveValue("failed");

    await user.click(screen.getByRole("tab", { name: "Purview Audit Search" }));
    await user.click(screen.getByRole("button", { name: "Select older job" }));
    expect(window.location.search).toContain("job=older-job");
    expect(screen.getByText("older-job")).toBeVisible();

    window.history.back();
    await waitFor(() => expect(window.location.search).not.toContain("job=older-job"));
    expect(screen.getByText("No selected Purview job")).toBeVisible();

    window.history.forward();
    await waitFor(() => expect(window.location.search).toContain("job=older-job"));
    expect(screen.getByText("older-job")).toBeVisible();
  });
});
