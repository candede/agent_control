import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import App from "./App";
import { getAgents, type CopilotPackage, type PackagePage, type PackageRefreshJob, type SessionUser } from "./api/client";
import { storePackageSelection } from "./packageSelectionSession";

const viewer: SessionUser = {
  displayName: "Current viewer",
  username: "viewer@example.invalid",
  homeAccountId: "viewer-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Viewer"],
};

const agent: CopilotPackage = {
  id: "package-private",
  displayName: "Sensitive cached agent",
  isBlocked: false,
  sourceSystem: "graph_packages",
  authoringTool: null,
  creatorType: "unknown",
  agentKind: "copilot_package",
  lifecycle: "unknown",
  identityConfidence: "exact_native",
  provenance: {},
};

const packagePage: PackagePage = {
  value: [agent],
  count: 1,
  snapshot: {
    id: "snapshot-private",
    tokenMode: "delegated",
    requestedIds: [],
    observedCount: 1,
    totalRecords: 1,
    pageCount: 1,
    observedAt: "2026-09-10T08:00:00.000Z",
    expiresAt: "2026-09-10T09:00:00.000Z",
    scopeKind: "broad",
  },
  summary: { total: 1, allowed: 1, blocked: 0 },
  filteredSummary: { total: 1, allowed: 1, blocked: 0 },
  facets: { publishers: [], availability: [], hosts: [], platforms: [] },
};

describe("App session revalidation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/agents");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("explains upfront delegated consent and offers an explicit identity-only sign-in", async () => {
    const transport = appTransport({ revalidatedRoles: [], authenticated: false });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("link", { name: "Sign in with Entra ID" })).toHaveAttribute("href", "/api/auth/login");
    expect(screen.getByRole("link", { name: "Sign in without provider setup" })).toHaveAttribute("href", "/api/auth/login?setup=defer&returnTo=%2Fpermissions");
    expect(screen.getByText(/outstanding delegated permissions/)).toBeInTheDocument();
    expect(screen.getByText(/package changes, and Copilot Studio quarantine/)).toBeInTheDocument();
    expect(screen.getByText(/Consent does not run investigations/)).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/capabilities"))).toBe(false);
  });

  it("offers recovery after declined setup without automatically restarting authorization", async () => {
    window.history.replaceState({}, "", "/permissions?authorization=cancelled");
    const transport = appTransport({ revalidatedRoles: [], authenticated: false });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent("Microsoft permission setup was cancelled or denied");
    expect(screen.getByRole("link", { name: "Sign in without provider setup" })).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/auth/consent"))).toBe(false);
  });

  it("purges cached rows before accepting a role-revalidated session", async () => {
    const transport = appTransport({ revalidatedRoles: [], deferRevalidation: true });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View details for Sensitive cached agent" }));
    expect(await screen.findByRole("dialog", { name: "Sensitive cached agent" })).toBeInTheDocument();

    transport.failProtectedReadsWith = 401;
    await act(async () => {
      await expect(getAgents()).rejects.toMatchObject({ status: 401 });
    });

    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText("Sensitive cached agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
  });

  it("does not clear the current session for a provider permission 403", async () => {
    const transport = appTransport({ revalidatedRoles: [] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();

    transport.failProtectedReadsWith = 403;
    await expect(getAgents()).rejects.toMatchObject({ status: 403 });

    expect(screen.getByText("Sensitive cached agent")).toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it("does not describe a sign-out origin rejection as missing permissions", async () => {
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    const fetchMock = vi.fn(async (input: string) => input === "/api/auth/logout"
      ? Response.json({ code: "invalid_origin", detail: "A same-origin request is required. Use --origin-header unchanged." }, { status: 403 })
      : transport.fetchMock(input));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("A same-origin request is required. Use --origin-header unchanged.")).toBeInTheDocument();
    expect(screen.queryByText(/Open Permissions for the current account/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(transport.meCalls()).toBe(1);
  });

  it("does not issue protected deep-link reads for an unassigned session", async () => {
    window.history.replaceState({}, "", "/agents?detail=package-private&refreshJob=private-job&selected=package-private");
    const transport = appTransport({ initialRoles: [], revalidatedRoles: [] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jobs" })).not.toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/agents/package-private"))).toBe(false);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).includes("/api/agents/refresh-jobs/private-job"))).toBe(false);
  });

  it("allows Viewer to use read-only bulk-reference filters", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock).some(([path]) =>
      String(path).includes("operationIdPrefix=a5331a93"),
    )).toBe(true);
    expect(screen.queryByText(/Bulk-reference filters require/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage access for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Block Sensitive/ })).not.toBeInTheDocument();
  });

  it("lets Admin inherit every view while exposing supported mutation controls", async () => {
    const transport = appTransport({
      initialRoles: ["AgentControl.Admin"],
      revalidatedRoles: ["AgentControl.Admin"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    for (const name of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Permissions", "Jobs"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Manage access for Sensitive cached agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block Sensitive cached agent" })).toBeInTheDocument();
  });

  it("uses authorized bulk references for both package lists and exports", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Viewer"],
      revalidatedRoles: ["AgentControl.Viewer"],
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:package-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);

    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock).some(([path]) =>
      String(path).includes("operationIdPrefix=a5331a93"),
    )).toBe(true);

    const exportButton = screen.getByRole("button", { name: "Export filtered agents CSV" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await userEvent.click(await screen.findByRole("button", { name: /Download package inventory/ }));
    await waitFor(() => expect(transport.fetchMock).toHaveBeenCalledWith(
      "/api/agents/export.csv",
      expect.objectContaining({ method: "POST" }),
    ));
    const exportCall = transport.fetchMock.mock.calls.find(([path]) => path === "/api/agents/export.csv")!;
    expect(JSON.parse(String(exportCall[1]?.body))).toMatchObject({
      filters: { operationIdPrefix: "a5331a93" },
      snapshotId: "snapshot-private",
    });
  });

  it("purges protected rows when Viewer is removed during revalidation", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Viewer"],
      revalidatedRoles: [],
      deferRevalidation: true,
    });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();

    transport.failProtectedReadsWith = 403;
    transport.protectedFailureCode = "missing_internal_role";
    await act(async () => {
      await expect(getAgents({ operationIdPrefix: "a5331a93" })).rejects.toMatchObject({
        status: 403,
        code: "missing_internal_role",
      });
    });

    await waitFor(() => expect(transport.meCalls()).toBe(2));
    expect(screen.queryByText("Sensitive cached agent")).not.toBeInTheDocument();
    await act(async () => transport.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jobs" })).not.toBeInTheDocument();
  });

  it("restores all 5000 selected packages from bounded principal-scoped session routing", async () => {
    const selectedIds = Array.from({ length: 5_000 }, (_, index) => `package-${index}`);
    expect(storePackageSelection(viewer, selectedIds)).toBe(true);
    window.history.replaceState({}, "", "/agents?selectionState=session&selectionCount=5000");
    const transport = appTransport({ revalidatedRoles: viewer.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findAllByText("5000 selected")).not.toHaveLength(0);
    expect(await screen.findByText(/5,000 selected packages are preserved only for this signed-in browser session/)).toBeInTheDocument();
    expect(window.location.href.length).toBeLessThan(4_096);
    expect(window.location.search).toContain("selectionState=session");
    expect(window.location.search).not.toContain("selected=");
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)("automatically lists existing agents on the first authorized %s visit", async role => {
    const transport = initialCatalogTransport({ initialRoles: [role], revalidatedRoles: [role] });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    const request = refreshRequests(transport.fetchMock)[0];
    expect(request[1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }) });
    expect(JSON.parse(String(request[1]?.body))).toEqual({ mode: "delegated" });
    expect(agentListRequests(transport.fetchMock)).toHaveLength(2);
    expect(transport.fetchMock.mock.calls.filter(([path, init]) => init?.method === "POST" && !String(path).startsWith("/api/capabilities"))).toHaveLength(1);
  });

  it.each(["/permissions", "/official-usage"])("does not enumerate from %s until Agents is opened", async route => {
    window.history.replaceState({}, "", route);
    const transport = initialCatalogTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Agents" });
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
  });

  it("preserves existing snapshots, including empty catalogs and filtered-empty results", async () => {
    const transport = initialCatalogTransport();
    transport.page = { ...packagePage, value: [], count: 0 };
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Saved Graph observation/)).toBeInTheDocument());
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs"))).toBe(false);
  });

  it.each(["running", "failed", "waiting_authorization"] as const)("does not start another refresh when a %s job already exists", async status => {
    const transport = initialCatalogTransport();
    transport.jobs = [{ ...completedRefreshJob(), status, snapshotId: null }];
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs?"))).toBe(true));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Refresh agents" })).toBeEnabled();
  });

  it("waits for a successful saved catalog response before loading agents", async () => {
    const transport = initialCatalogTransport();
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    transport.catalogResponse = () => response;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    transport.catalogResponse = undefined;
    await act(async () => release(Response.json(transport.page)));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
  });

  it("does not convert a failed saved catalog request into provider enumeration", async () => {
    const transport = initialCatalogTransport();
    transport.catalogResponse = async () => Response.json({ code: "provider_error", detail: "Saved catalog unavailable" }, { status: 500 });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Saved catalog unavailable")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it.each(["unassigned", "missing-provider-permission"] as const)("does not automatically enumerate for %s sessions", async scenario => {
    const transport = initialCatalogTransport(scenario === "unassigned" ? { initialRoles: [], revalidatedRoles: [] } : {});
    if (scenario === "missing-provider-permission") transport.readAuthorized = false;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    if (scenario === "unassigned") {
      expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
      expect(agentListRequests(transport.fetchMock)).toHaveLength(0);
    } else {
      await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(1));
      expect(screen.getByRole("button", { name: "Refresh agents" })).toBeDisabled();
    }
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("attempts initial enumeration once under StrictMode and leaves failed refresh retries explicit", async () => {
    const transport = initialCatalogTransport();
    transport.failRefresh = true;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByText("Synthetic initial refresh failed")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    transport.failRefresh = false;
    await userEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(2);
  });

  it("abandons an initial-load preflight if the user leaves Agents", async () => {
    const transport = initialCatalogTransport();
    let release!: (response: Response) => void;
    transport.jobResponse = () => new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs?"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await act(async () => release(Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null })));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("does not start an initial load from a preflight completed after authentication is invalidated", async () => {
    const transport = initialCatalogTransport({ revalidatedRoles: [], deferRevalidation: true });
    let release!: (response: Response) => void;
    transport.jobResponse = () => new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/agents/refresh-jobs?"))).toBe(true));
    transport.session.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.session.meCalls()).toBe(2));
    await act(async () => release(Response.json({ value: [], lastAttemptAt: null, lastSuccessAt: null })));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
    await act(async () => transport.session.releaseRevalidation());
    expect(await screen.findByRole("heading", { name: "Permissions" })).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(0);
  });

  it("keeps initial-load attempts account-scoped and does not enumerate during session revalidation", async () => {
    const transport = initialCatalogTransport({
      revalidatedRoles: viewer.roles, deferRevalidation: true,
      revalidatedUser: { ...viewer, tenantId: "tenant-2", homeAccountId: "viewer-2" },
    });
    transport.failRefresh = true;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Synthetic initial refresh failed")).toBeInTheDocument();
    transport.session.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.session.meCalls()).toBe(2));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
    transport.session.failProtectedReadsWith = undefined;
    transport.failRefresh = false;
    await act(async () => transport.session.releaseRevalidation());
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
    expect(refreshRequests(transport.fetchMock)).toHaveLength(2);
    expect(refreshRequests(transport.fetchMock)[1][1]).toMatchObject({ headers: expect.objectContaining({ "X-CSRF-Token": "csrf-2" }) });
    expect(agentListRequests(transport.fetchMock).every(([path]) => !String(path).includes("snapshotId=snapshot-private"))).toBe(true);
  });

  it("does not retry a failed initial load when the same account is revalidated", async () => {
    const transport = initialCatalogTransport({ deferRevalidation: true });
    transport.failRefresh = true;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    expect(await screen.findByText("Synthetic initial refresh failed")).toBeInTheDocument();
    transport.session.failProtectedReadsWith = 401;
    await act(async () => { await expect(getAgents()).rejects.toMatchObject({ status: 401 }); });
    await waitFor(() => expect(transport.session.meCalls()).toBe(2));
    transport.session.failProtectedReadsWith = undefined;
    await act(async () => transport.session.releaseRevalidation());
    await waitFor(() => expect(agentListRequests(transport.fetchMock)).toHaveLength(3));
    expect(refreshRequests(transport.fetchMock)).toHaveLength(1);
  });

  it("loads fresh exact access details before opening the table access editor", async () => {
    const transport = accessEditorTransport();
    transport.exactStatus = "running";
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    expect(within(editor).getByRole("radio", { name: /No users/ })).toBeChecked();
    const calls = transport.fetchMock.mock.calls;
    const start = calls.findIndex(([path]) => path === "/api/agents/package-private/refresh-jobs");
    const poll = calls.findIndex(([path]) => String(path).startsWith("/api/agents/refresh-jobs/access-detail"));
    const detail = calls.findIndex(([path]) => path === "/api/agents/package-private");
    expect(start).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(start);
    expect(detail).toBeGreaterThan(poll);
    expect(calls[start][1]).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-1" }) });
    expect(calls.some(([path]) => String(path).includes("mutation-preview") || String(path).endsWith("/access"))).toBe(false);
  });

  it.each(["availability", "installation"] as const)("refreshes exact details only when Edit %s is requested", async target => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
    const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
    await userEvent.click(within(saved).getByRole("tab", { name: "Package" }));
    await userEvent.click(within(saved).getByRole("button", { name: `Edit ${target}` }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    expect(within(editor).getByRole("heading", { name: target === "availability" ? "Select who can use this agent" : "Select who this agent is installed for" })).toBeInTheDocument();
    expect(within(editor).getByRole("radio", { name: target === "availability" ? /No users/ : /Specific users or groups/ })).toBeChecked();
    if (target === "installation") expect(await within(editor).findByText("Installed user", { exact: true })).toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private/refresh-jobs")).toHaveLength(1);
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sensitive cached agent" })).toBeInTheDocument();
  });

  it.each(["table", "detail"] as const)("surfaces exact-read failures instead of opening the %s editor from saved data", async entry => {
    const transport = accessEditorTransport();
    transport.exactResponse = async () => Response.json({ code: "forbidden", detail: "Exact provider read denied" }, { status: 403 });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    if (entry === "table") {
      await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    } else {
      await userEvent.click(await screen.findByRole("button", { name: "View details for Sensitive cached agent" }));
      const saved = await screen.findByRole("dialog", { name: "Sensitive cached agent" });
      await userEvent.click(within(saved).getByRole("tab", { name: "Package" }));
      await userEvent.click(within(saved).getByRole("button", { name: "Edit installation" }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact provider read denied");
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.filter(([path]) => path === "/api/agents/package-private")).toHaveLength(entry === "table" ? 0 : 1);
  });

  it("preserves current capability checks before preparing access", async () => {
    const transport = accessEditorTransport();
    transport.accessAuthorized = false;
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    const manage = await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" });
    expect(manage).toBeDisabled();
    await userEvent.click(manage);
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(false);
  });

  it.each(["failed", "waiting_authorization"] as const)("surfaces a %s exact-read job without using the saved projection", async status => {
    const transport = accessEditorTransport();
    transport.exactStatus = status;
    transport.exactMessage = "Provider requires interactive read authorization.";
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(transport.exactMessage);
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(false);
  });

  it.each(["navigation", "history"] as const)("does not open an editor from an exact-read response after %s leaves Agents", async method => {
    const transport = accessEditorTransport();
    let release!: (response: Response) => void;
    transport.exactResponse = () => new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage access for Sensitive cached agent" }));
    await waitFor(() => expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private/refresh-jobs")).toBe(true));
    if (method === "navigation") await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
    else await act(async () => {
      window.history.pushState({}, "", "/permissions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => release(Response.json(completedRefreshJob())));
    expect(screen.queryByRole("dialog", { name: "Manage agent access" })).not.toBeInTheDocument();
    expect(transport.fetchMock.mock.calls.some(([path]) => path === "/api/agents/package-private")).toBe(false);
  });

  it("prepares each bulk access target before requesting the server confirmation", async () => {
    const transport = accessEditorTransport();
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Sensitive cached agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const editor = await screen.findByRole("dialog", { name: "Manage agent access" });
    await userEvent.click(within(editor).getByRole("radio", { name: /No users/ }));
    await userEvent.click(within(editor).getByRole("button", { name: "Apply" }));
    await userEvent.click(within(editor).getByRole("button", { name: "Confirm and apply" }));
    expect(await screen.findByRole("dialog", { name: /update availability package\?/i })).toBeInTheDocument();
    const calls = transport.fetchMock.mock.calls;
    const detail = calls.findIndex(([path]) => path === "/api/agents/package-private");
    const preview = calls.findIndex(([path]) => path === "/api/agents/mutation-preview");
    expect(detail).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(detail);
    expect(calls.some(([path]) => String(path).endsWith("/access"))).toBe(false);
  });
});

function appTransport({
  revalidatedRoles,
  deferRevalidation = false,
  initialRoles = viewer.roles,
  authenticated = true,
  revalidatedUser = viewer,
}: {
  revalidatedRoles: SessionUser["roles"];
  deferRevalidation?: boolean;
  initialRoles?: SessionUser["roles"];
  authenticated?: boolean;
  revalidatedUser?: SessionUser;
}) {
  let currentUserCalls = 0;
  let resolveRevalidation!: (response: Response) => void;
  const revalidation = new Promise<Response>(resolve => {
    resolveRevalidation = resolve;
  });
  const revalidatedResponse = () => Response.json({
    user: { ...revalidatedUser, roles: revalidatedRoles },
    csrfToken: "csrf-2",
    roleAssignmentRequired: revalidatedRoles.length === 0,
  });
  const transport: {
    failProtectedReadsWith?: 401 | 403;
    protectedFailureCode?: "forbidden" | "missing_internal_role";
    fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
    meCalls: () => number;
    releaseRevalidation: () => void;
  } = {
    failProtectedReadsWith: undefined,
    protectedFailureCode: undefined,
    fetchMock: vi.fn(),
    meCalls: () => currentUserCalls,
    releaseRevalidation: () => resolveRevalidation(revalidatedResponse()),
  };
  transport.fetchMock.mockImplementation(async (input: string) => {
    if (input === "/api/auth/status") return Response.json({ authConfigured: true, callback: "http://localhost/api/auth/callback" });
    if (input === "/api/me") {
      currentUserCalls += 1;
      if (!authenticated) return Response.json({ user: null });
      if (currentUserCalls === 1) return Response.json({ user: { ...viewer, roles: initialRoles }, csrfToken: "csrf-1", roleAssignmentRequired: false });
      return deferRevalidation ? revalidation : revalidatedResponse();
    }
    if (input === "/api/capabilities") return Response.json({ value: [] });
    if (input === "/api/workbench/metadata") return Response.json({ views: workbenchViews, actions: workbenchActions });
    if (input.startsWith("/api/official-usage/aggregate")) return Response.json({});
    if (input.startsWith("/api/official-usage/users")) return Response.json({});
    if (input === "/api/agents/export.csv") return new Response("Package ID,Display name\r\n", { headers: { "Content-Type": "text/csv" } });
    if (input === "/api/agents/package-private") return Response.json({
      ...agent,
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: [],
      observation: {
        observedAt: packagePage.snapshot!.observedAt,
        expiresAt: packagePage.snapshot!.expiresAt,
        scopeKind: "broad",
        source: "Microsoft Graph package catalog",
        apiMaturity: "v1.0 read; preview controls",
      },
    });
    if (input.startsWith("/api/agents")) {
      if (transport.failProtectedReadsWith) {
        const status = transport.failProtectedReadsWith;
        return Response.json({
          status,
          code: status === 401 ? "unauthorized" : transport.protectedFailureCode ?? "forbidden",
          detail: status === 401 ? "The current session has expired." : "The provider permission is insufficient.",
        }, { status });
      }
      return Response.json(packagePage);
    }
    throw new Error(`Unexpected request ${input}`);
  });
  return transport;
}

function agentListRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path]) =>
    String(path).startsWith("/api/agents?") || path === "/api/agents",
  );
}

function refreshRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([path, init]) => path === "/api/agents/refresh-jobs" && init?.method === "POST");
}

function completedRefreshJob(): PackageRefreshJob {
  return {
    id: "refresh-first-load", authorizationPrincipalId: viewer.homeAccountId, tokenMode: "delegated", scopeKind: "broad", requestedIds: [],
    status: "succeeded", pageCount: 1, observedCount: 1, totalRecords: 1, snapshotId: packagePage.snapshot!.id,
    createdAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

function initialCatalogTransport(options: Partial<Parameters<typeof appTransport>[0]> = {}) {
  const session = appTransport({ revalidatedRoles: viewer.roles, ...options });
  const transport = {
    session,
    page: { ...packagePage, snapshot: null, value: [], count: 0 } as PackagePage,
    jobs: [] as PackageRefreshJob[],
    failRefresh: false,
    readAuthorized: true,
    catalogResponse: undefined as (() => Promise<Response>) | undefined,
    jobResponse: undefined as (() => Promise<Response>) | undefined,
    fetchMock: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
  transport.fetchMock.mockImplementation(async (input, init) => {
    if (input.startsWith("/api/official-usage/aggregate")) return Response.json(null);
    if (input === "/api/capabilities" || input === "/api/capabilities/check") {
      const definition = capabilityDefinitions.find(item => item.id === "graph.package.read.delegated")!;
      return Response.json({ value: [{
        definition,
        decision: { capabilityId: definition.id, status: transport.readAuthorized ? "available" : "missing_permission", authorized: transport.readAuthorized, fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), previewQualification: "not_required", remediation: [] },
      }] });
    }
    if (input.startsWith("/api/agents/refresh-jobs?")) return transport.jobResponse
      ? transport.jobResponse() : Response.json({ value: transport.jobs, lastAttemptAt: null, lastSuccessAt: null });
    if (input === "/api/agents/refresh-jobs" && init?.method === "POST") {
      if (transport.failRefresh) return Response.json({ code: "provider_error", detail: "Synthetic initial refresh failed" }, { status: 500 });
      transport.page = packagePage;
      return Response.json(completedRefreshJob());
    }
    const response = await session.fetchMock(input, init);
    if (response.ok && (input === "/api/agents" || input.startsWith("/api/agents?"))) {
      return transport.catalogResponse ? transport.catalogResponse() : Response.json(transport.page);
    }
    return response;
  });
  return transport;
}

function accessEditorTransport() {
  const base = initialCatalogTransport({ initialRoles: ["AgentControl.Admin"], revalidatedRoles: ["AgentControl.Admin"] });
  base.page = packagePage;
  const transport = {
    accessAuthorized: true,
    exactStatus: "succeeded" as PackageRefreshJob["status"],
    exactMessage: undefined as string | undefined,
    exactResponse: undefined as (() => Promise<Response>) | undefined,
    exactCompleted: false,
    fetchMock: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
  const exactJob = () => ({ ...completedRefreshJob(), id: "access-detail", scopeKind: "exact", requestedIds: [agent.id], status: transport.exactStatus, message: transport.exactMessage });
  transport.fetchMock.mockImplementation(async (input, init) => {
    if (input === "/api/agents/package-private/refresh-jobs") {
      if (transport.exactResponse) return transport.exactResponse();
      transport.exactCompleted = transport.exactStatus === "succeeded";
      return Response.json(exactJob());
    }
    if (input.startsWith("/api/agents/refresh-jobs/access-detail")) {
      transport.exactStatus = "succeeded";
      transport.exactCompleted = true;
      return Response.json(exactJob());
    }
    if (input === "/api/agents/package-private") return Response.json(transport.exactCompleted ? {
      ...agent, availableTo: "none", deployedTo: "some", allowedUsersAndGroups: [],
      acquireUsersAndGroups: [{ resourceType: "user", resourceId: "installed-user" }],
      observation: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), scopeKind: "exact" },
    } : agent);
    if (input === "/api/directory/principals/resolve") return Response.json({
      value: [{ resourceType: "user", resourceId: "installed-user", displayName: "Installed user", principalKind: "user" }],
    });
    if (input === "/api/agents/mutation-preview") return Response.json({
      confirmationHash: "a".repeat(64),
      summary: {
        risk: true, operation: "update-availability", provider: "Microsoft Graph", endpoint: "PATCH /beta/copilot/admin/catalog/packages/{id}/access",
        apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All", actor: { id: viewer.homeAccountId, displayName: "Admin", username: viewer.username },
        scope: "bulk", targetCount: 1, affectedPrincipalCount: 0, rollback: "Confirm a separate inverse change.", targetSelectionHash: "b".repeat(64),
        targets: [{ id: agent.id, displayName: agent.displayName, currentState: {}, requestedState: {} }], additionalTargetCount: 0,
      },
    });
    const response = await base.fetchMock(input, init);
    if (input === "/api/capabilities" || input === "/api/capabilities/check") {
      const body = await response.json();
      const definition = capabilityDefinitions.find(item => item.id === "graph.package.access.manage")!;
      return Response.json({ value: [
        ...body.value,
        { definition, decision: { capabilityId: definition.id, status: transport.accessAuthorized ? "available" : "missing_permission", authorized: transport.accessAuthorized, fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] } },
        { definition: capabilityDefinitions.find(item => item.id === "graph.directory.read")!, decision: { ...body.value[0].decision, capabilityId: "graph.directory.read" } },
      ] });
    }
    return response;
  });
  return transport;
}
