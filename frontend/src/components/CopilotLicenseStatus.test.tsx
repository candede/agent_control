import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";

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
});
