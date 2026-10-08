import { act, fireEvent, render, screen, waitFor, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import type { CapabilityView, DirectoryPrincipal, PackageAccessEntity, SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AccessAssignmentModal } from "./AccessAssignmentModal";

const principals: PackageAccessEntity[] = [
  { resourceType: "user", resourceId: "11111111-1111-4111-8111-111111111111" },
];
const resolved: DirectoryPrincipal[] = [
  { ...principals[0], displayName: "Assigned user", principalKind: "user" },
];
const user: SessionUser = {
  homeAccountId: "admin-1", displayName: "Admin", username: "admin@example.invalid",
  roles: ["AgentControl.Admin", "AgentControl.Viewer"],
};

afterEach(() => vi.restoreAllMocks());

function capabilities(directoryAllowed: boolean, now: number): CapabilityView[] {
  return capabilityDefinitions.filter(definition =>
    definition.id === "graph.package.access.manage"
    || directoryAllowed && definition.id === "graph.directory.read",
  ).map(definition => ({
    definition,
    decision: definition.id === "graph.directory.read" ? {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
      checkedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    } : {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    },
  }));
}

function renderAccessModal(
  directoryAllowed: boolean,
  overrides: Partial<ComponentProps<typeof AccessAssignmentModal>> = {},
  options: Pick<RenderOptions, "reactStrictMode"> = {},
) {
  let props: ComponentProps<typeof AccessAssignmentModal> = {
    context: "single", agentCount: 1, initialStatus: "some", initialPrincipals: principals,
    onCancel: vi.fn(), onSubmit: vi.fn().mockResolvedValue(undefined), ...overrides,
  };
  let allowed = directoryAllowed;
  const content = () => {
    const now = Date.now();
    return <CapabilityContext value={{
      views: capabilities(allowed, now), user, now, loading: false, pending: false,
      error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><WorkbenchActionProvider value={workbenchActions}>
      <AccessAssignmentModal {...props} />
    </WorkbenchActionProvider></CapabilityContext>;
  };
  const result = render(content(), options);
  return {
    ...result,
    props,
    setDirectoryAllowed: (nextAllowed: boolean) => {
      allowed = nextAllowed;
      result.rerender(content());
    },
    setProps: (overrides: Partial<ComponentProps<typeof AccessAssignmentModal>>) => {
      props = { ...props, ...overrides };
      result.rerender(content());
    },
  };
}

function pendingDirectoryLookup() {
  type Response = Awaited<ReturnType<typeof api.resolveDirectoryPrincipals>>;
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function pendingAccessUpdate() {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}

describe("AccessAssignmentModal scope-dependent directory resolution", () => {
  it("admits initial directory resolution once during Strict Mode effect replay", async () => {
    const request = pendingDirectoryLookup();
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockReturnValue(request.promise);
    renderAccessModal(true, {}, { reactStrictMode: true });

    await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith(principals, { signal: expect.any(AbortSignal) }));
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await act(async () => request.resolve({ value: resolved }));
    expect(screen.getByText("Assigned user")).toBeVisible();
  });

  it("does not admit directory resolution if the editor closes before admission", async () => {
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { unmount } = renderAccessModal(true);
    unmount();

    await act(async () => {});
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["availability", "installation"] as const)(
    "can confirm no users for %s without directory access",
    async target => {
      const resolve = vi.spyOn(api, "resolveDirectoryPrincipals");
      const { props } = renderAccessModal(false, { initialTarget: target });

      expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
      expect(screen.getByText("Directory capability is unavailable.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(resolve).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      expect(props.onSubmit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
      await waitFor(() => expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({
        target, mode: "replace", scope: "none", principals: [],
      }));
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("does not make no users wait for an in-flight directory lookup", async () => {
    const request = pendingDirectoryLookup();
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockReturnValue(request.promise);
    const { props } = renderAccessModal(true);

    expect(screen.getByText("Resolving current assignments...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({
      target: "availability", mode: "replace", scope: "none", principals: [],
    }));

    await act(async () => request.resolve({ value: resolved }));
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
  });

  it("blocks specific assignments if directory access is lost after resolution", async () => {
    vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { props, setDirectoryAllowed } = renderAccessModal(true);

    expect(await screen.findByText("Assigned user")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    setDirectoryAllowed(false);
    expect(screen.getByText("Directory capability is unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("resolves initial assignments when directory access becomes available", async () => {
    const request = pendingDirectoryLookup();
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockReturnValue(request.promise);
    const { props, setDirectoryAllowed } = renderAccessModal(false, { initialStatus: undefined });

    expect(resolve).not.toHaveBeenCalled();
    setDirectoryAllowed(true);
    await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith(principals, { signal: expect.any(AbortSignal) }));
    expect(screen.getByText("Resolving current assignments...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    await act(async () => request.resolve({ value: resolved }));
    expect(screen.getByText("Assigned user")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({
      target: "availability", mode: "replace", scope: "specific", principals,
    }));
  });

  it("preserves edited assignments when directory access is restored", async () => {
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { setDirectoryAllowed } = renderAccessModal(true);

    expect(await screen.findByText("Assigned user")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove Assigned user" }));
    expect(screen.getByText("0 selected")).toBeVisible();
    setDirectoryAllowed(false);
    await act(async () => setDirectoryAllowed(true));

    expect(screen.getByText("0 selected")).toBeVisible();
    expect(screen.queryByText("Assigned user")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(principals, { signal: expect.any(AbortSignal) });
  });

  it.each(["success", "failure"] as const)("ignores a cancelled lookup's %s while its replacement is pending", async outcome => {
    const first = pendingDirectoryLookup();
    const second = pendingDirectoryLookup();
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { setDirectoryAllowed } = renderAccessModal(true);

    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    setDirectoryAllowed(false);
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
    setDirectoryAllowed(true);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (outcome === "success") first.resolve({ value: resolved });
      else first.reject(new Error("Obsolete lookup failed."));
    });
    expect(screen.queryByText("Assigned user")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Resolving current assignments...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    await act(async () => second.resolve({ value: resolved }));
    expect(screen.getByText("Assigned user")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("reports lookup failures without preventing a no-users replacement", async () => {
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockRejectedValue(new Error("Directory lookup failed."));
    renderAccessModal(true);

    expect(await screen.findByText("Directory lookup failed.")).toBeVisible();
    expect(screen.queryByText("Resolving current assignments...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
    expect(screen.queryByText("Directory lookup failed.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /Specific users or groups/ }));
    expect(screen.getByText("Directory lookup failed.")).toBeVisible();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("keeps a failed no-users preview distinct from an initial directory failure", async () => {
    vi.spyOn(api, "resolveDirectoryPrincipals").mockRejectedValue(new Error("Directory lookup failed."));
    const onSubmit = vi.fn().mockRejectedValue(new Error("Package preview failed."));
    renderAccessModal(true, { onSubmit });

    expect(await screen.findByText("Directory lookup failed.")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    expect(await screen.findByText("Package preview failed.")).toBeVisible();
    expect(screen.queryByText("Directory lookup failed.")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      target: "availability", mode: "replace", scope: "none", principals: [],
    });
  });

  it("keeps no-users replacements behind the package action gate", () => {
    render(<CapabilityContext value={{
      views: [], user, now: Date.now(), loading: false, pending: false,
      error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><WorkbenchActionProvider value={workbenchActions}>
      <AccessAssignmentModal context="single" agentCount={1} initialStatus="none" onCancel={vi.fn()} onSubmit={vi.fn()} />
    </WorkbenchActionProvider></CapabilityContext>);

    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});

describe("AccessAssignmentModal draft stability", () => {
  it("does not restart a pending lookup for equivalent initial principals", async () => {
    const request = pendingDirectoryLookup();
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockReturnValue(request.promise);
    const { setProps } = renderAccessModal(true);

    setProps({ initialPrincipals: principals.map(principal => ({ ...principal })) });
    await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith(principals, { signal: expect.any(AbortSignal) }));

    await act(async () => request.resolve({ value: resolved }));
    expect(screen.getByText("Assigned user")).toBeVisible();
  });

  it("does not restore removed principals when the parent recreates the initial array", async () => {
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { setProps } = renderAccessModal(true);

    expect(await screen.findByText("Assigned user")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove Assigned user" }));
    await act(async () => setProps({
      initialPrincipals: principals.map(principal => ({ ...principal })),
    }));

    expect(screen.getByText("0 selected")).toBeVisible();
    expect(screen.queryByText("Assigned user")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(principals, { signal: expect.any(AbortSignal) });
  });

  it("keeps the confirmed draft when initial props are refreshed", async () => {
    const second = {
      resourceType: "group", resourceId: "22222222-2222-4222-8222-222222222222",
    };
    const initial = [...principals, second];
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({
      value: [...resolved, { ...second, displayName: "Assigned group", principalKind: "securityGroup" }],
    });
    const { props, setProps } = renderAccessModal(true, { initialPrincipals: initial });

    expect(await screen.findByText("Assigned user")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove Assigned user" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent("1 selected principal");

    await act(async () => setProps({
      initialPrincipals: initial.map(principal => ({ ...principal })),
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("1 selected principal");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({
      target: "availability", mode: "replace", scope: "specific", principals: [second],
    }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(initial, { signal: expect.any(AbortSignal) });
  });

  it("loads a new initial state on reopening, not during the current edit", async () => {
    vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { setProps, unmount } = renderAccessModal(false, {
      initialStatus: "none", initialPrincipals: [],
    });

    setProps({ initialStatus: "some", initialPrincipals: principals });
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getByText("Current: No users")).toBeVisible();
    unmount();

    renderAccessModal(true);
    expect(await screen.findByText("Assigned user")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
    expect(screen.getByText("Current: Specific users or groups")).toBeVisible();
  });
});

describe("AccessAssignmentModal pending submissions", () => {
  it("admits only one submission when repeated clicks share a React batch", async () => {
    const request = pendingAccessUpdate();
    const onSubmit = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(undefined);
    renderAccessModal(false, { initialStatus: "none", initialPrincipals: [], onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const confirm = screen.getByRole("button", { name: "Confirm and apply" });

    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      target: "availability", mode: "replace", scope: "none", principals: [],
    });
    await act(async () => request.reject(new Error("Preview failed.")));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it.each(["scope", "target", "mode", "principals"] as const)(
    "retires the failed preview error when the draft's %s changes",
    async change => {
      vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
      renderAccessModal(true, {
        context: "bulk", agentCount: 2,
        onSubmit: vi.fn().mockRejectedValue(new Error("Previous draft preview failed.")),
      });
      expect(await screen.findByText("Assigned user")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
      expect(await screen.findByText("Previous draft preview failed.")).toBeVisible();

      if (change === "scope") fireEvent.click(screen.getByRole("radio", { name: /No users/ }));
      else if (change === "target") fireEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
      else if (change === "mode") fireEvent.click(screen.getByRole("button", { name: "Add" }));
      else fireEvent.click(screen.getByRole("button", { name: "Remove Assigned user" }));

      expect(screen.queryByText("Previous draft preview failed.")).not.toBeInTheDocument();
    },
  );

  it("clears the previous failure when beginning replacement confirmation again", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Previous preview failed."));
    renderAccessModal(false, { initialStatus: "none", initialPrincipals: [], onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
    expect(await screen.findByText("Previous preview failed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Confirm replacement")).toBeVisible();
    expect(screen.queryByText("Previous preview failed.")).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each(["availability", "installation"] as const)(
    "locks the %s draft until a failed submission finishes, then permits a confirmed retry",
    async target => {
      const request = pendingAccessUpdate();
      vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
      const onSubmit = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(undefined);
      const { props, container } = renderAccessModal(true, {
        context: "bulk", agentCount: 2, initialTarget: target, onSubmit,
      });
      expect(await screen.findByText("Assigned user")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));

      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        target, mode: "replace", scope: "specific", principals,
      });
      for (const control of screen.getAllByRole("button")) expect(control).toBeDisabled();
      for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
      expect(screen.getByRole("searchbox")).toBeDisabled();
      expect(screen.getByRole("combobox")).toBeDisabled();
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(container.firstElementChild!);
      expect(props.onCancel).not.toHaveBeenCalled();

      await act(async () => request.reject(new Error("Preview failed.")));
      expect(screen.getByText("Preview failed.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
      expect(screen.queryByText("Confirm replacement")).not.toBeInTheDocument();
      expect(screen.getByRole("searchbox")).toBeEnabled();
      expect(screen.getByRole("combobox")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Remove Assigned user" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Confirm and apply" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      expect(onSubmit).toHaveBeenLastCalledWith({
        target, mode: "replace", scope: "specific", principals,
      });
    },
  );

  it("locks draft controls while the caller is busy and unlocks them afterward", async () => {
    vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
    const { setProps } = renderAccessModal(true, { context: "bulk", busy: true });

    expect(await screen.findByText("Assigned user")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Applying" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Please wait" })).toBeDisabled();
    for (const control of screen.getAllByRole("button")) expect(control).toBeDisabled();
    for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
    expect(screen.getByRole("searchbox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();

    setProps({ busy: false });
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /No users/ })).toBeEnabled();
    expect(screen.getByRole("searchbox")).toBeEnabled();
  });

  it.each(["availability", "installation"] as const)(
    "preserves bulk add semantics for %s and locks directory results during submission",
    async target => {
      const request = pendingAccessUpdate();
      vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: resolved });
      vi.spyOn(api, "searchDirectoryPrincipals").mockResolvedValue({
        value: [{
          resourceType: "group", resourceId: "22222222-2222-4222-8222-222222222222",
          displayName: "Directory group", principalKind: "securityGroup",
        }],
      });
      const { props } = renderAccessModal(true, {
        context: "bulk", agentCount: 2, onSubmit: vi.fn().mockReturnValue(request.promise),
      });
      expect(await screen.findByText("Assigned user")).toBeVisible();
      fireEvent.click(screen.getByRole("button", {
        name: target === "availability" ? /Available to/ : /Installed for/,
      }));
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByRole("radio", { name: /No users/ })).toBeDisabled();
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Directory" } });
      const result = await screen.findByRole("button", { name: /Directory group/ });
      expect(result).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith({
        target, mode: "add", scope: "specific", principals,
      });
      expect(screen.queryByText("Confirm replacement")).not.toBeInTheDocument();
      expect(result).toBeDisabled();
      fireEvent.click(result);
      expect(screen.getByText("1 selected")).toBeVisible();

      await act(async () => request.reject(new Error("Preview failed.")));
      expect(screen.getByText("Preview failed.")).toBeVisible();
      expect(result).toBeEnabled();
    },
  );
});

describe("AccessAssignmentModal interaction boundaries", () => {
  it("keeps all-users writes disabled and fixes the target for a single agent", () => {
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals");
    renderAccessModal(false, {
      initialTarget: "installation", initialStatus: "all", initialPrincipals: [],
    });

    expect(screen.getByRole("radio", { name: /All users/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /All users/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Available to/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Installed for/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("traps keyboard focus, handles Escape, and returns focus when closed", async () => {
    const keyboard = userEvent.setup();
    render(<button type="button">Open access editor</button>);
    const opener = screen.getByRole("button", { name: "Open access editor" });
    opener.focus();
    const { props, unmount } = renderAccessModal(false, {
      initialStatus: "none", initialPrincipals: [],
    });

    expect(screen.getByRole("dialog")).toHaveFocus();
    await keyboard.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    await keyboard.tab();
    expect(screen.getByRole("button", { name: "Close access management" })).toHaveFocus();
    await keyboard.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    await keyboard.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledOnce();
    unmount();
    expect(opener).toHaveFocus();
  });

  it("keeps keyboard focus inside the dialog when all controls are busy", async () => {
    const keyboard = userEvent.setup();
    renderAccessModal(false, { busy: true, initialStatus: "none", initialPrincipals: [] });

    await keyboard.tab();
    expect(screen.getByRole("dialog")).toHaveFocus();
    await keyboard.tab({ shift: true });
    expect(screen.getByRole("dialog")).toHaveFocus();
  });
});
