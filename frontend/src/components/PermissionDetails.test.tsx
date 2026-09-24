import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityView } from "../api/client";
import { PermissionDetails } from "./PermissionDetails";

const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(): CapabilityView {
  return {
    definition: capabilityDefinitions[0],
    decision: {
      capabilityId: capabilityDefinitions[0].id, status: "missing_permission", authorized: false, fresh: true,
      checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  };
}

describe("Permission issue details", () => {
  it("shows concise requirements without readiness or verification metadata", () => {
    render(<PermissionDetails view={fixture()} now={now} />);
    expect(screen.getByText("Microsoft denied the required API permission.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Required setup" })).toHaveTextContent("Microsoft Graph / delegated: CopilotPackages.Read.All");
    expect(screen.getByRole("region", { name: "Setup and documentation" })).toHaveTextContent("Grant admin consent");
    expect(screen.queryByText(/Ready to try|not verified|Microsoft checks|Not checked|Verification|Operation access|Last recorded success/)).not.toBeInTheDocument();
    expect(screen.queryByText("Microsoft roles")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entra admin center" })).toHaveAttribute("href", "https://entra.microsoft.com/");
  });

  it("keeps technical diagnostics collapsed until requested", async () => {
    const view = fixture();
    view.decision.evidence = { category: "missing_permission", phase: "token_acquisition", httpStatus: 403,
      providerErrorCode: "Authorization_RequestDenied", correlationId: "synthetic-request" };
    view.decision.remediation = ["Ask the tenant administrator to review API permissions."];
    render(<PermissionDetails view={view} now={now} />);
    expect(screen.getByText("synthetic-request")).not.toBeVisible();
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("synthetic-request")).toBeVisible();
    expect(screen.getByText("403")).toBeVisible();
    expect(screen.getByText("Microsoft token acquisition")).toBeVisible();
    expect(screen.getByText(view.decision.remediation[0])).toBeVisible();
    expect(screen.getByText("https://graph.microsoft.com")).toBeVisible();
  });

  it("omits unreported diagnostics rather than inventing values", async () => {
    render(<PermissionDetails view={fixture()} now={now} />);
    await userEvent.click(screen.getByText("Technical details"));
    for (const label of ["Provider HTTP status", "Provider error code", "Provider request / correlation ID", "Error category", "Check stage"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it.each(["token", "on_demand", "provider"] as const)("does not expose speculative %s status if called without a failure", verification => {
    const view = fixture();
    view.decision = { ...view.decision, status: "available", authorized: true, verification };
    render(<PermissionDetails view={view} now={now} />);
    expect(screen.queryByText(/Ready to try|not verified|Microsoft checks|No proof|denied/)).not.toBeInTheDocument();
  });
});
