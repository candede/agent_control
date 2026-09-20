import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityView } from "../api/client";
import { PermissionDetails } from "./PermissionDetails";

const now = Date.parse("2026-09-20T12:00:00.000Z");

function fixture(id: CapabilityId): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === id)!,
    decision: {
      capabilityId: id, status: "unknown", authorized: false, fresh: false,
      previewQualification: "not_required", remediation: [],
    },
  };
}

describe("PermissionDetails check guidance", () => {
  it.each([
    "graph.package.read.application", "purview.audit.search.application", "defender.hunting.application",
  ] as const)("requires explicit application-scope checks for %s", id => {
    const view = fixture(id);
    view.enabled = true;
    view.configuration = { enabled: true, sharedDataScope: true };
    render(<PermissionDetails view={view} now={now} />);

    const setup = screen.getByRole("region", { name: "Setup and documentation" });
    expect(setup).toHaveTextContent(/explicitly approved bounded application-scope operation/);
    expect(setup).toHaveTextContent("Check status does not run application checks");
    expect(setup).not.toHaveTextContent(/use Check status|run automatically/i);
    expect(screen.queryByText(/Not checked yet\. Automatic safe checks/)).not.toBeInTheDocument();
  });

  it.each(["graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "directs %s to a dashboard read without write confirmation", id => {
      const view = fixture(id);
      view.decision = { ...view.decision, status: "available", authorized: true, fresh: true, verification: "on_demand" };
      render(<PermissionDetails view={view} now={now} />);

      const setup = screen.getByRole("region", { name: "Setup and documentation" });
      expect(setup).toHaveTextContent(/read from the dashboard/);
      expect(setup).not.toHaveTextContent(/use Check status|run automatically|confirm|exact targets/i);
      expect(within(screen.getByRole("region", { name: "Check evidence" })).getByText("Verification").nextElementSibling)
        .toHaveTextContent("Ready to try; Microsoft validates permission on the actual operation");
    },
  );

  it.each(["graph.package.read.delegated", "graph.package.block.manage", "purview.audit.search.delegated"] as const)(
    "preserves bounded delegated check guidance for %s", id => {
      const view = fixture(id);
      render(<PermissionDetails view={view} now={now} />);
      const setup = screen.getByRole("region", { name: "Setup and documentation" });
      expect(setup).toHaveTextContent(/use Check status/i);
      expect(setup).toHaveTextContent("run automatically while the signed-in UI is active");
      if (view.definition.dataClass === "package_control") {
        expect(setup).toHaveTextContent("Provider changes require review and confirmation of exact targets");
      }
    },
  );

  it("keeps local policy separate from provider checks", () => {
    const view = fixture("reports.official.import");
    view.decision = { ...view.decision, status: "available", authorized: true, verification: "local" };
    render(<PermissionDetails view={view} now={now} />);
    const evidence = within(screen.getByRole("region", { name: "Check evidence" }));
    expect(evidence.getByText("Verification").nextElementSibling).toHaveTextContent("Authorized by local policy; no provider check");
    expect(evidence.getByText("Last check").nextElementSibling).toHaveTextContent("Local policy; no provider check");
    expect(screen.getByRole("region", { name: "Setup and documentation" })).not.toHaveTextContent(/Check status|run automatically/);
  });
});
