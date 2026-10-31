import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityView } from "../api/client";
import { PermissionDetails } from "./PermissionDetails";

const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(): CapabilityView {
  return {
    enabled: true, definition: capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!,
    decision: {
      capabilityId: "graph.package.read.application", status: "missing_permission", authorized: false, fresh: true,
      checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  };
}

describe("Permission issue details", () => {
  it.each(["interaction_required", "authorization_expired"])("keeps application %s recovery in app setup rather than delegated sign-in", category => {
    const view = fixture();
    view.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    view.decision = { ...view.decision, capabilityId: view.definition.id, status: "unknown", evidence: { category } };
    render(<PermissionDetails view={view} now={now} />);
    const setup = screen.getByRole("region", { name: "Setup and documentation" });
    expect(setup).toHaveTextContent("Verify the application's credentials, then retry the application read.");
    expect(setup).toHaveTextContent("User sign-in does not repair app-only authorization.");
    expect(setup).not.toHaveTextContent("Grant admin consent");
    expect(screen.getByRole("link", { name: "Entra admin center" })).toHaveAttribute("href", "https://entra.microsoft.com/");
    expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it.each(["interaction_required", "authorization_expired"])("uses application %s operation evidence rather than a cached missing grant", category => {
    const view = fixture();
    view.operationFailure = {
      status: "unknown", checkedAt: view.decision.checkedAt!, expiresAt: view.decision.expiresAt!,
      evidence: { category }, remediation: ["Review existing application credentials and authorization."],
    };
    render(<PermissionDetails view={view} now={now} />);
    expect(screen.getByText("Ask an administrator to verify the application's credentials and authorization.")).toBeVisible();
    expect(screen.getByText(view.operationFailure.remediation[0])).toBeVisible();
    const setup = screen.getByRole("region", { name: "Setup and documentation" });
    expect(setup).toHaveTextContent("Verify the application's credentials, then retry the application read.");
    expect(setup).not.toHaveTextContent("Grant admin consent");
  });

  it("shows concise requirements without readiness or verification metadata", () => {
    render(<PermissionDetails view={fixture()} now={now} />);
    expect(screen.getByText("Microsoft denied the required API permission.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Required setup" })).toHaveTextContent("Microsoft Graph / application: CopilotPackages.Read.All");
    expect(screen.getByRole("region", { name: "Setup and documentation" })).toHaveTextContent("Grant admin consent");
    expect(screen.queryByText(/Ready to try|not verified|Microsoft checks|Not checked|Verification|Operation access|Last recorded success/)).not.toBeInTheDocument();
    expect(screen.queryByText("Microsoft roles")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entra admin center" })).toHaveAttribute("href", "https://entra.microsoft.com/");
  });

  it.each([
    "graph.package.read.application", "graph.package.access.manage",
    "powerPlatform.inventory.read", "powerPlatform.quarantine.manage",
  ] as const)("retains provider-specific missing-permission setup for %s", id => {
    const view = fixture();
    view.definition = capabilityDefinitions.find(definition => definition.id === id)!;
    view.decision.capabilityId = id;
    render(<PermissionDetails view={view} now={now} />);
    const requirements = screen.getByRole("region", { name: "Required setup" });
    expect(requirements).toHaveTextContent(`${view.definition.provider} / ${view.definition.mode}: ${view.definition.permissions.join(" and ")}`);
    if (view.definition.providerRoles.length) {
      expect(requirements).toHaveTextContent(view.definition.providerRoles.join(" or "));
    }
    expect(screen.getByRole("region", { name: "Setup and documentation" })).toHaveTextContent("Grant admin consent");
  });

  it("keeps all reported diagnostics and remediation visible without interaction", () => {
    const view = fixture();
    view.decision.evidence = { category: "missing_permission", phase: "token_acquisition", httpStatus: 403,
      providerErrorCode: "Authorization_RequestDenied", correlationId: "synthetic-request" };
    view.decision.remediation = ["Ask the tenant administrator to review API permissions."];
    const { container } = render(<PermissionDetails view={view} now={now} />);
    expect(screen.getByText("synthetic-request")).toBeVisible();
    expect(screen.getByText("403")).toBeVisible();
    expect(screen.getByText("Microsoft token acquisition")).toBeVisible();
    expect(screen.getByText(view.decision.remediation[0])).toBeVisible();
    expect(screen.getByText("https://graph.microsoft.com")).toBeVisible();
    expect(container.querySelector("details, summary, [aria-expanded]")).toBeNull();
  });

  it("omits unreported diagnostics rather than inventing values", () => {
    render(<PermissionDetails view={fixture()} now={now} />);
    for (const label of ["Provider HTTP status", "Provider error code", "Provider request / correlation ID", "Error category", "Check stage"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("does not tell users to grant consent for a provider timeout", () => {
    const view = fixture();
    view.decision = { ...view.decision, status: "provider_error", evidence: { category: "provider_timeout" } };
    render(<PermissionDetails view={view} now={now} />);
    expect(screen.getByText("Microsoft did not respond after retrying.")).toBeVisible();
    expect(screen.queryByText(/Grant admin consent/)).not.toBeInTheDocument();
  });

  it.each(["token", "on_demand", "provider"] as const)("does not expose speculative %s status if called without a failure", verification => {
    const view = fixture();
    view.decision = { ...view.decision, status: "available", authorized: true, verification };
    render(<PermissionDetails view={view} now={now} />);
    expect(screen.queryByText(/Ready to try|not verified|Microsoft checks|No proof|denied/)).not.toBeInTheDocument();
  });
});
