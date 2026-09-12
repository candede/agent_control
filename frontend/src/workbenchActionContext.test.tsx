import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../backend/src/services/workbenchMetadata";
import { CapabilityContext } from "./capabilityContext";
import { WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";

const capabilityContext = {
  views: [],
  user: {
    displayName: "Viewer",
    username: "reader@example.invalid",
    homeAccountId: "reader",
    tenantId: "tenant",
    roles: ["AgentControl.Viewer"],
  },
  loading: false,
  now: Date.now(),
  reload: vi.fn(),
  openPermissions: vi.fn(),
} as never;

describe("WorkbenchActionGate", () => {
  it("blocks clicks until exact signed-in action metadata is available", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const action = workbenchActions.find(candidate => candidate.id === "packages.inspect")!;
    const gate = (actions: typeof workbenchActions | undefined) => (
      <CapabilityContext value={capabilityContext}>
        <WorkbenchActionProvider value={actions}>
          <WorkbenchActionGate actionId="packages.inspect">
            <button type="button" onClick={onClick}>Inspect</button>
          </WorkbenchActionGate>
        </WorkbenchActionProvider>
      </CapabilityContext>
    );
    const view = render(gate(undefined));

    expect(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
    expect(screen.getByText(/remain disabled until the signed-in workbench finishes loading/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).not.toHaveBeenCalled();

    view.rerender(gate([]));
    expect(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
    expect(screen.getByText(/not defined by the current signed-in workbench metadata/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).not.toHaveBeenCalled();

    view.rerender(gate([action]));
    expect(screen.getByRole("button", { name: "Inspect" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
