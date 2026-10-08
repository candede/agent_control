import { StrictMode, useLayoutEffect, useState, type ButtonHTMLAttributes, type MouseEventHandler } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityView, SessionUser } from "../api/client";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { useCapabilities } from "../useCapabilities";
import { CapabilityGate } from "./CapabilityGate";

type Context = ReturnType<typeof useCapabilityContext>;
const user: SessionUser = {
  homeAccountId: "reader", tenantId: "tenant", displayName: "Reader",
  username: "reader@example.invalid", roles: ["AgentControl.Viewer"],
};

function available(id: CapabilityId = "graph.package.read.delegated", now = Date.now()): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === id)!,
    decision: {
      capabilityId: id, status: "available", authorized: true, fresh: true, verification: "provider",
      checkedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  };
}

function context(views: CapabilityView[] = [available()]): Context {
  return { user, views, now: Date.now(), loading: false, pending: false, error: undefined,
    reload: vi.fn(), openPermissions: vi.fn() };
}

function RetainedButton({ remember, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  remember: (handler: MouseEventHandler<HTMLButtonElement> | undefined) => void;
}) {
  useLayoutEffect(() => { remember(props.onClick); }, [remember, props.onClick]);
  return <button {...props} />;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CapabilityGate", () => {
  it.each(["denial", "roles", "account", "tenant", "logout", "disabled", "child", "unmount"] as const)(
    "retires the earlier child handler after %s", change => {
      const value = context();
      const onClick = vi.fn(), replacement = vi.fn(), remember = vi.fn();
      const content = (current = value, disabled = false, click = onClick) => <StrictMode>
        <CapabilityContext value={current}>
          <CapabilityGate capability="graph.package.read.delegated" roles={["AgentControl.Viewer"]}>
            <RetainedButton remember={remember} type="button" disabled={disabled} onClick={click}>Run</RetainedButton>
          </CapabilityGate>
        </CapabilityContext>
      </StrictMode>;
      const view = render(content());
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(onClick).toHaveBeenCalledOnce();
      onClick.mockClear();
      const retained: MouseEventHandler<HTMLButtonElement> = remember.mock.lastCall![0];
      if (change === "unmount") view.unmount();
      else view.rerender(content({
        ...value,
        user: change === "logout" ? undefined : {
          ...user,
          ...(change === "roles" ? { roles: [] } : {}),
          ...(change === "account" ? { homeAccountId: "other" } : {}),
          ...(change === "tenant" ? { tenantId: "other" } : {}),
        },
        views: change === "denial" ? [] : value.views,
      }, change === "disabled", change === "child" ? replacement : onClick));
      const propagated = vi.fn();
      render(<div onClick={propagated}><button type="button" onClick={retained}>Replay retained handler</button></div>);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      fireEvent(screen.getByRole("button", { name: "Replay retained handler" }), event);
      expect(event.defaultPrevented).toBe(true);
      expect(propagated).not.toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      if (["account", "tenant", "child"].includes(change)) {
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(change === "child" ? replacement : onClick).toHaveBeenCalledOnce();
      }
    },
  );

  it("respects child-disabled admission even when a child retains its click handler", () => {
    const remember = vi.fn(), onClick = vi.fn();
    render(<CapabilityContext value={context()}>
      <CapabilityGate capability="graph.package.read.delegated">
        <RetainedButton disabled remember={remember} onClick={onClick}>Run</RetainedButton>
      </CapabilityGate>
    </CapabilityContext>);
    render(<button type="button" onClick={remember.mock.lastCall![0]}>Replay disabled handler</button>);
    fireEvent.click(screen.getByRole("button", { name: "Replay disabled handler" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(["missing", "unchecked"] as const)("shows the failed %s check and navigates to recovery without retrying", state => {
    const unknown = available();
    unknown.decision = { capabilityId: unknown.definition.id, status: "unknown", authorized: false,
      fresh: false, previewQualification: "not_required", remediation: [] };
    const value = { ...context(state === "missing" ? [] : [unknown]),
      error: "Permission checks failed after retrying. Use Check status to retry." };
    render(<CapabilityContext value={value}>
      <CapabilityGate capability={unknown.definition.id}><button type="button">Run</button></CapabilityGate>
    </CapabilityContext>);
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByText(value.error)).toBeVisible();
    expect(screen.queryByText(/Not checked yet|Checking capability status|status is unavailable/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Permissions:/ }));
    expect(value.openPermissions).toHaveBeenCalledOnce();
    expect(value.reload).not.toHaveBeenCalled();
  });

  it("keeps confirmed prerequisites and the failed reload visible together", () => {
    const denied = available();
    denied.decision = { ...denied.decision, authorized: false, status: "missing_permission" };
    const value = { ...context([denied]), error: "Permission checks could not be loaded. Use Check status to retry." };
    render(<CapabilityContext value={value}>
      <CapabilityGate capability={denied.definition.id} compact>
        <button type="button" aria-describedby="target-help" title="Run exact target">Run</button>
      </CapabilityGate>
      <span id="target-help">Confirm the exact target.</span>
    </CapabilityContext>);
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toHaveAccessibleDescription(/Confirm the exact target.*Admin prerequisite:.*Permission checks could not be loaded/);
    expect(button).toHaveAttribute("title", expect.stringContaining(value.error));
    expect(screen.queryByRole("button", { name: /^Permissions:/ })).not.toBeInTheDocument();
  });

  it("distinguishes catalog loading, delegated checking, failure and an explicit successful retry", () => {
    const unknown = available();
    unknown.decision = { capabilityId: unknown.definition.id, status: "unknown", authorized: false,
      fresh: false, previewQualification: "not_required", remediation: [] };
    const value = context([]), onClick = vi.fn();
    const content = (current: Context) => <CapabilityContext value={current}>
      <CapabilityGate capability={unknown.definition.id}><button type="button" onClick={onClick}>Run</button></CapabilityGate>
    </CapabilityContext>;
    const view = render(content({ ...value, loading: true }));
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Loading capability status.")).toBeVisible();
    view.rerender(content({ ...value, views: [unknown], pending: true }));
    expect(screen.getByText("Checking capability status.")).toBeVisible();
    const error = "Permission checks failed. Use Check status to retry.";
    view.rerender(content({ ...value, views: [unknown], error }));
    expect(screen.getByText(error)).toBeVisible();
    view.rerender(content({ ...value, views: [unknown], loading: true }));
    expect(screen.getByText("Loading capability status.")).toBeVisible();
    expect(screen.queryByText(error)).not.toBeInTheDocument();
    view.rerender(content({ ...value, views: [available()] }));
    expect(screen.getByRole("button", { name: "Run" })).toBe(button);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(value.reload).not.toHaveBeenCalled();
  });

  it("does not describe application qualification as an automatic check or its retry", () => {
    const unknown = available("graph.package.read.application");
    unknown.decision = { capabilityId: unknown.definition.id, status: "unknown", authorized: false,
      fresh: false, previewQualification: "unqualified", remediation: [] };
    const value = context([unknown]);
    const content = (current: Context) => <CapabilityContext value={current}>
      <CapabilityGate capability={unknown.definition.id}><button type="button">Run</button></CapabilityGate>
    </CapabilityContext>;
    const view = render(content({ ...value, loading: true }));
    expect(screen.getByText("Loading capability status.")).toBeVisible();
    view.rerender(content({ ...value, pending: true }));
    expect(screen.queryByText("Checking capability status.")).not.toBeInTheDocument();
    expect(screen.getByText(/explicitly approved bounded application-scope/)).toBeVisible();
    view.rerender(content({ ...value, error: "Permission checks failed. Use Check status to retry." }));
    expect(screen.getByText(/explicitly approved bounded application-scope.*Permission checks failed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("keeps current role denial distinct from a capability load or check failure", () => {
    render(<CapabilityContext value={{ ...context(), loading: true, error: "Permission checks failed." }}>
      <CapabilityGate capability="graph.package.read.delegated" roles={["AgentControl.Admin"]}>
        <button type="button">Run</button>
      </CapabilityGate>
    </CapabilityContext>);
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByText("Requires AgentControl.Admin.")).toBeVisible();
    expect(screen.queryByText(/Loading capability|Checking capability|Permission checks failed/)).not.toBeInTheDocument();
  });

  it.each(["delegated", "application"] as const)("uses the wall clock when rendering expired %s evidence", mode => {
    const now = Date.now(), capability = available(`graph.package.read.${mode}`, now);
    const value = { ...context([capability]), now };
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    render(<CapabilityContext value={value}>
      <CapabilityGate capability={capability.definition.id}><button type="button">Run</button></CapabilityGate>
    </CapabilityContext>);
    if (mode === "delegated") expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    else {
      expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
      expect(screen.getByText(/stale/)).toBeVisible();
    }
  });

  it("withdraws application admission and its stale presentation when a click observes a suspended expiry timer", () => {
    const now = Date.now(), capability = available("graph.package.read.application", now);
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<CapabilityContext value={{ ...context([capability]), now }}>
      <form onSubmit={onSubmit}><CapabilityGate capability={capability.definition.id}>
        <button type="submit">Run</button>
      </CapabilityGate></form>
    </CapabilityContext>);
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeEnabled();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(screen.getByText(/stale/)).toBeVisible();
  });

  it("retains native refs, keys, titles and child descriptions as access changes", () => {
    const value = context(), ref = vi.fn(), onClick = vi.fn();
    const content = (current: Context) => <CapabilityContext value={current}>
      <CapabilityGate capability="graph.package.read.delegated" compact>
        <button key="target" ref={ref} type="button" title="Exact target" aria-describedby="target-help" onClick={onClick}>Run</button>
      </CapabilityGate>
      <span id="target-help">Exact target details.</span>
    </CapabilityContext>;
    const view = render(content(value));
    const button = screen.getByRole("button", { name: "Run" });
    expect(ref).toHaveBeenCalledExactlyOnceWith(button);
    view.rerender(content({ ...value, views: [] }));
    expect(screen.getByRole("button", { name: "Run" })).toBe(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Exact target details.*Capability status is unavailable/);
    view.rerender(content(value));
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription("Exact target details.");
    expect(button).toHaveAttribute("title", "Exact target");
    expect(ref).toHaveBeenCalledOnce();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not revoke on-demand admission because diagnostics report an operation failure", () => {
    const capability = available("graph.package.block.manage");
    capability.decision = { capabilityId: capability.definition.id, status: "available", authorized: true,
      fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] };
    capability.operationFailure = { status: "missing_permission", checkedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), remediation: [] };
    const value = { ...context([capability]), user: { ...user, roles: ["AgentControl.Admin"] as SessionUser["roles"] } };
    const onClick = vi.fn();
    render(<CapabilityContext value={value}>
      <CapabilityGate capability={capability.definition.id} roles={["AgentControl.Admin"]} write>
        <button type="button" onClick={onClick}>Run</button>
      </CapabilityGate>
    </CapabilityContext>);
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(value.reload).not.toHaveBeenCalled();
  });

  it("preserves mounted children and saved actions during diagnostic updates and failures", () => {
    function StatefulButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
      const [count, setCount] = useState(0);
      return <button {...props} onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) setCount(count + 1); }}>Saved action {count}</button>;
    }
    const value = context();
    const content = (current: Context) => <CapabilityContext value={current}>
      <CapabilityGate roles={["AgentControl.Viewer"]}><StatefulButton title="Saved data" /></CapabilityGate>
    </CapabilityContext>;
    const view = render(content(value));
    const button = screen.getByRole("button", { name: "Saved action 0" });
    fireEvent.click(button);
    view.rerender(content({ ...value, loading: true, pending: true, now: value.now + 1_000 }));
    expect(screen.getByRole("button", { name: "Saved action 1" })).toBe(button);
    expect(button).toBeEnabled();
    view.rerender(content({ ...value, views: [], error: "Permission checks failed." }));
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Saved data");
    expect(value.reload).not.toHaveBeenCalled();
  });

  it("shares the capability owner across gates and retires transport and actions at a session change", async () => {
    let release!: (response: Response) => void;
    let retiredSignal: AbortSignal | null | undefined;
    let checks = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/capabilities/check") && ++checks === 1) {
        retiredSignal = init?.signal;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json({ value: [available()] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClick = vi.fn(), remember = vi.fn(), openPermissions = vi.fn();
    function Harness({ epoch }: { epoch: number }) {
      const value = useCapabilities(user, epoch);
      return <CapabilityContext key={epoch} value={{ ...value, openPermissions }}>
        <CapabilityGate capability="graph.package.read.delegated">
          <RetainedButton remember={remember} onClick={onClick}>Run one</RetainedButton>
        </CapabilityGate>
        <CapabilityGate capability="graph.package.read.delegated"><button type="button">Run two</button></CapabilityGate>
      </CapabilityContext>;
    }
    const view = render(<Harness epoch={0} />);
    await waitFor(() => expect(checks).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retained: MouseEventHandler<HTMLButtonElement> = remember.mock.lastCall![0];
    view.rerender(<Harness epoch={1} />);
    expect(retiredSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Run one" })).toBeDisabled();
    await waitFor(() => expect(checks).toBe(2));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => release(Response.json({ code: "session_invalidated" }, { status: 401 })));
    expect(screen.getByRole("button", { name: "Run one" })).toBeEnabled();
    render(<button type="button" onClick={retained}>Replay previous session</button>);
    fireEvent.click(screen.getByRole("button", { name: "Replay previous session" }));
    expect(onClick).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    view.unmount();
  });
});
