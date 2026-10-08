import { StrictMode, useLayoutEffect, useState, type ButtonHTMLAttributes, type FormEvent, type MouseEventHandler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { CapabilityContext, type useCapabilityContext } from "./capabilityContext";
import { useWorkbenchAction, WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";

const capabilityContext: ReturnType<typeof useCapabilityContext> = {
  views: [],
  user: {
    displayName: "Viewer",
    username: "reader@example.invalid",
    homeAccountId: "reader",
    tenantId: "tenant",
    roles: ["AgentControl.Viewer"],
  },
  loading: false,
  pending: false,
  error: undefined,
  now: Date.now(),
  reload: vi.fn(),
  openPermissions: vi.fn(),
};

afterEach(() => vi.restoreAllMocks());

function RetainedButton({ remember, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  remember: (handler: MouseEventHandler<HTMLButtonElement> | undefined) => void;
}) {
  useLayoutEffect(() => { remember(props.onClick); }, [remember, props.onClick]);
  return <button {...props} />;
}

describe("WorkbenchActionGate", () => {
  it.each(["allowed first", "denied first"] as const)("rejects ambiguous action metadata for gates and lookup consumers (%s)", order => {
    const action = workbenchActions.find(candidate => candidate.id === "packages.inspect")!;
    const restricted: typeof action = { ...action, roles: ["AgentControl.Admin"] };
    const actions = order === "allowed first" ? [action, restricted] : [restricted, action];
    const onClick = vi.fn();
    function Lookup() {
      const found = useWorkbenchAction(action.id);
      return <output aria-label="Action lookup">{found?.label ?? "Unavailable"}</output>;
    }
    const content = (metadata = actions) => <CapabilityContext value={capabilityContext}>
      <WorkbenchActionProvider value={metadata}>
        <WorkbenchActionGate actionId={action.id}><button type="button" onClick={onClick}>Inspect</button></WorkbenchActionGate>
        <Lookup />
      </WorkbenchActionProvider>
    </CapabilityContext>;
    const view = render(content());
    expect(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAccessibleDescription(/defined more than once/i);
    expect(screen.getByLabelText("Action lookup")).toHaveTextContent("Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).not.toHaveBeenCalled();
    view.rerender(content([action]));
    expect(screen.getByLabelText("Action lookup")).toHaveTextContent(action.label);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(capabilityContext.reload).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "missing"] as const)("prevents retained %s metadata events from bubbling or submitting after recovery", state => {
    const onClick = vi.fn(), onBubble = vi.fn(), remember = vi.fn();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const content = (actions: typeof workbenchActions | undefined) => <WorkbenchActionProvider value={actions}>
      <WorkbenchActionGate actionId="packages.inspect">
        <RetainedButton remember={remember} type="submit" onClick={onClick}>Inspect</RetainedButton>
      </WorkbenchActionGate>
    </WorkbenchActionProvider>;
    const view = render(<CapabilityContext value={capabilityContext}>
      {content(state === "unavailable" ? undefined : [])}
    </CapabilityContext>);
    const retained: MouseEventHandler<HTMLButtonElement> | undefined = remember.mock.lastCall![0];
    render(<form onClick={onBubble} onSubmit={onSubmit}>
      <button type="submit" onClick={retained}>Replay unavailable action</button>
    </form>);
    function replay() {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      fireEvent(screen.getByRole("button", { name: "Replay unavailable action" }), event);
      expect(event.defaultPrevented).toBe(true);
      expect(onClick).not.toHaveBeenCalled();
      expect(onBubble).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    }
    replay();
    view.rerender(<CapabilityContext value={capabilityContext}>{content(workbenchActions)}</CapabilityContext>);
    expect(screen.getByRole("button", { name: "Inspect" })).toBeEnabled();
    replay();
    view.unmount();
    replay();
  });

  it.each(["delegated", "application"] as const)(
    "revalidates %s evidence at click time when the diagnostics timer has not observed expiry", async mode => {
      const now = Date.now();
      const definition = capabilityDefinitions.find(item => item.id === `graph.package.read.${mode}`)!;
      const onClick = vi.fn();
      const value: typeof capabilityContext = { ...capabilityContext, now, views: [{
        definition, decision: { capabilityId: definition.id, status: "available", authorized: true, fresh: true,
          verification: "provider", previewQualification: "not_required", remediation: [],
          checkedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 1_000).toISOString() },
      }] };
      render(<CapabilityContext value={value}><WorkbenchActionProvider value={workbenchActions}>
        <WorkbenchActionGate actionId={mode === "application" ? "packages.refresh.application.resume" : "packages.refresh.resume"}>
          <button type="button" onClick={onClick}>Resume</button>
        </WorkbenchActionGate>
      </WorkbenchActionProvider></CapabilityContext>);
      expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
      vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
      await userEvent.click(screen.getByRole("button", { name: "Resume" }));
      expect(onClick).toHaveBeenCalledTimes(mode === "delegated" ? 1 : 0);
      if (mode === "application") {
        expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Resume" })).toHaveAccessibleDescription(/evidence is stale/i);
      }
      expect(value.reload).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "unchecked"] as const)("describes a pending %s capability check instead of an unavailable action", state => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.package.read.delegated")!;
    const value: typeof capabilityContext = { ...capabilityContext, pending: true,
      views: state === "missing" ? [] : [{
        definition, decision: { capabilityId: definition.id, status: "unknown", authorized: false, fresh: false,
          previewQualification: "not_required", remediation: [] },
      }],
    };
    render(<CapabilityContext value={value}><WorkbenchActionProvider value={workbenchActions}>
      <WorkbenchActionGate actionId="packages.refresh"><button type="button">Refresh</button></WorkbenchActionGate>
    </WorkbenchActionProvider></CapabilityContext>);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByText("Checking capability status.")).toBeVisible();
    expect(screen.queryByText(/unavailable|Not checked yet/)).not.toBeInTheDocument();
  });

  it("does not imply that a delegated recheck runs an unchecked application capability", () => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
    render(<CapabilityContext value={{ ...capabilityContext, pending: true, views: [{
      definition, decision: { capabilityId: definition.id, status: "unknown", authorized: false, fresh: false,
        previewQualification: "not_required", remediation: [] },
    }] }}><WorkbenchActionProvider value={workbenchActions}>
      <WorkbenchActionGate actionId="packages.refresh.application.resume"><button type="button">Resume</button></WorkbenchActionGate>
    </WorkbenchActionProvider></CapabilityContext>);
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.queryByText("Checking capability status.")).not.toBeInTheDocument();
    expect(screen.getByText(/explicitly approved bounded application-scope/)).toBeVisible();
  });

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
    expect(screen.getByText(/remain disabled without current signed-in workbench metadata/i)).toBeVisible();
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

  it.each([true, "true"] as const)("keeps aria-disabled=%s actions focusable without invoking, bubbling or submitting", async disabled => {
    const onClick = vi.fn(), onBubble = vi.fn(), onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const remember = vi.fn();
    const user = userEvent.setup();
    render(<CapabilityContext value={capabilityContext}><WorkbenchActionProvider value={workbenchActions}>
      <form onSubmit={onSubmit} onClick={onBubble}>
        <WorkbenchActionGate actionId="packages.inspect">
          <RetainedButton remember={remember} type="submit" aria-disabled={disabled} onClick={onClick}>Inspect</RetainedButton>
        </WorkbenchActionGate>
      </form>
    </WorkbenchActionProvider></CapabilityContext>);
    const button = screen.getByRole("button", { name: "Inspect" });
    expect(button).toBeEnabled();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onBubble).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    const retained: MouseEventHandler<HTMLButtonElement> = remember.mock.lastCall![0];
    render(<button type="button" onClick={retained}>Replay guarded action</button>);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("button", { name: "Replay guarded action" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(onBubble).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(capabilityContext.reload).not.toHaveBeenCalled();
  });

  it.each([undefined, false, "false"] as const)("admits actions with aria-disabled=%s without changing the child contract", async disabled => {
    const onClick = vi.fn();
    render(<CapabilityContext value={capabilityContext}><WorkbenchActionProvider value={workbenchActions}>
      <WorkbenchActionGate actionId="packages.inspect">
        <button type="button" aria-disabled={disabled} onClick={onClick}>Inspect</button>
      </WorkbenchActionGate>
    </WorkbenchActionProvider></CapabilityContext>);
    const button = screen.getByRole("button", { name: "Inspect" });
    expect(button).toBeEnabled();
    if (disabled === undefined) expect(button).not.toHaveAttribute("aria-disabled");
    else expect(button).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(["access", "disabled"] as const)("does not expose aria-enabled state while %s prevents admission", blockedBy => {
    render(<CapabilityContext value={{ ...capabilityContext, user: blockedBy === "access" ? undefined : capabilityContext.user }}>
      <WorkbenchActionProvider value={workbenchActions}><WorkbenchActionGate actionId="packages.inspect">
        <button type="button" disabled={blockedBy === "disabled"} aria-disabled={false}>Inspect</button>
      </WorkbenchActionGate></WorkbenchActionProvider>
    </CapabilityContext>);
    expect(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAttribute("aria-disabled", "true");
    if (blockedBy === "access") expect(screen.getByRole("button", { name: "Inspect" })).toHaveAccessibleDescription("Requires AgentControl.Viewer. Permissions");
    else expect(screen.queryByText(/Requires|unavailable|Checking/)).not.toBeInTheDocument();
  });

  it.each([false, true])("preserves target descriptions while metadata is unavailable or absent (compact=%s)", compact => {
    const onClick = vi.fn();
    const content = (actions: typeof workbenchActions | undefined) => <CapabilityContext value={capabilityContext}>
      <WorkbenchActionProvider value={actions}>
        <WorkbenchActionGate actionId="packages.inspect" compact={compact}>
          <button type="button" title="Inspect exact target" aria-describedby="target-description" onClick={onClick}>Inspect</button>
        </WorkbenchActionGate>
        <span id="target-description">Exact saved package.</span>
      </WorkbenchActionProvider>
    </CapabilityContext>;
    const view = render(content(undefined));
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAccessibleDescription(/Exact saved package\. Action metadata is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    view.rerender(content([]));
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAccessibleDescription(/Exact saved package\. This action is not defined/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).not.toHaveBeenCalled();
    view.rerender(content(workbenchActions));
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAccessibleDescription("Exact saved package.");
    expect(screen.getByRole("button", { name: "Inspect" })).toHaveAttribute("title", "Inspect exact target");
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "removed", "duplicated", "roles", "capability", "action", "unmount"] as const)(
    "retires retained callbacks when workbench action metadata becomes %s", change => {
      const action = workbenchActions.find(candidate => candidate.id === "packages.inspect")!;
      const onClick = vi.fn(), remember = vi.fn();
      const content = (actions: typeof workbenchActions | undefined, actionId = action.id) => <StrictMode>
        <CapabilityContext value={capabilityContext}><WorkbenchActionProvider value={actions}>
          <WorkbenchActionGate actionId={actionId}><RetainedButton remember={remember} onClick={onClick}>Inspect</RetainedButton></WorkbenchActionGate>
        </WorkbenchActionProvider></CapabilityContext>
      </StrictMode>;
      const view = render(content(workbenchActions));
      fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
      expect(onClick).toHaveBeenCalledOnce();
      onClick.mockClear();
      const retained: MouseEventHandler<HTMLButtonElement> = remember.mock.lastCall![0];
      if (change === "unmount") view.unmount();
      else view.rerender(content(change === "unavailable" ? undefined : change === "removed" ? [] : change === "duplicated" ? [action, action] : [{
        ...action,
        ...(change === "roles" ? { roles: ["AgentControl.Admin"] } : {}),
        ...(change === "capability" ? { capabilityId: "graph.package.read.delegated" } : {}),
      }], change === "action" ? "packages.block" : action.id));
      if (change !== "unmount") {
        expect(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
      }
      const propagated = vi.fn();
      render(<div onClick={propagated}><button type="button" onClick={retained}>Replay old action</button></div>);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      fireEvent(screen.getByRole("button", { name: "Replay old action" }), event);
      expect(event.defaultPrevented).toBe(true);
      expect(propagated).not.toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
      if (change !== "unmount") {
        view.rerender(content(workbenchActions));
        fireEvent.click(screen.getByRole("button", { name: "Replay old action" }));
        expect(onClick).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
        expect(onClick).toHaveBeenCalledOnce();
      }
      expect(capabilityContext.reload).not.toHaveBeenCalled();
    },
  );

  it("preserves child state across metadata and diagnostic revisions but retires it with the keyed account owner", () => {
    const onClick = vi.fn(), remember = vi.fn();
    function StatefulButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
      const [count, setCount] = useState(0);
      return <RetainedButton {...props} remember={remember} onClick={event => {
        props.onClick?.(event);
        if (!event.defaultPrevented) setCount(value => value + 1);
      }}>Inspect {count}</RetainedButton>;
    }
    const content = (owner: string, context = capabilityContext, actions = workbenchActions) => <StrictMode>
      <CapabilityContext key={owner} value={context}><WorkbenchActionProvider value={actions}>
        <WorkbenchActionGate actionId="packages.inspect"><StatefulButton onClick={onClick} /></WorkbenchActionGate>
      </WorkbenchActionProvider></CapabilityContext>
    </StrictMode>;
    const view = render(content("reader"));
    const button = screen.getByRole("button", { name: "Inspect 0" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    // Gates do not replace the consumer's synchronous single-request admission guard.
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Inspect 2" })).toBe(button);
    view.rerender(content("reader", { ...capabilityContext, pending: true, now: capabilityContext.now + 1000 },
      workbenchActions.map(action => ({ ...action, roles: [...action.roles] }))));
    expect(screen.getByRole("button", { name: "Inspect 2" })).toBe(button);
    view.rerender(content("reader", { ...capabilityContext, error: "Permission checks failed." }));
    expect(screen.getByRole("button", { name: "Inspect 2" })).toBeEnabled();
    const retained: MouseEventHandler<HTMLButtonElement> = remember.mock.lastCall![0];
    view.rerender(content("replacement", { ...capabilityContext, user: { ...capabilityContext.user!, homeAccountId: "replacement" } }));
    expect(screen.getByRole("button", { name: "Inspect 0" })).not.toBe(button);
    render(<button type="button" onClick={retained}>Replay previous account</button>);
    fireEvent.click(screen.getByRole("button", { name: "Replay previous account" }));
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Inspect 0" }));
    expect(onClick).toHaveBeenCalledTimes(3);
    view.rerender(content("reader"));
    expect(screen.getByRole("button", { name: "Inspect 0" })).not.toBe(button);
    fireEvent.click(screen.getByRole("button", { name: "Replay previous account" }));
    expect(onClick).toHaveBeenCalledTimes(3);
    expect(capabilityContext.reload).not.toHaveBeenCalled();
  });
});
