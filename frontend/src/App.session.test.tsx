import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import App from "./App";
import { getAgents, type CopilotPackage, type PackagePage, type SessionUser } from "./api/client";
import { storePackageSelection } from "./packageSelectionSession";

const reader: SessionUser = {
  displayName: "Current reader",
  username: "reader@example.invalid",
  homeAccountId: "reader-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Reader"],
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

  it("requires the independent SecurityReader role for bulk-reference filters but not text search", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({ revalidatedRoles: reader.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findByText(/Bulk-reference filters require the independent AgentControl.SecurityReader role/)).toBeInTheDocument();
    expect(agentListRequests(transport.fetchMock)).toHaveLength(0);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Research assistant" } });
    await waitFor(() => expect(agentListRequests(transport.fetchMock).some(([path]) =>
      String(path).includes("search=Research+assistant"),
    )).toBe(true));
    expect(await screen.findByText("Sensitive cached agent")).toBeInTheDocument();
  });

  it("uses authorized bulk references for both package lists and exports", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Reader", "AgentControl.SecurityReader"],
      revalidatedRoles: ["AgentControl.Reader", "AgentControl.SecurityReader"],
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

  it("purges bulk-reference rows when the backend reports internal role loss", async () => {
    window.history.replaceState({}, "", "/agents?q=ref+a5331a93");
    const transport = appTransport({
      initialRoles: ["AgentControl.Reader", "AgentControl.SecurityReader"],
      revalidatedRoles: ["AgentControl.Reader"],
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
    expect(await screen.findByText(/Bulk-reference filters require the independent AgentControl.SecurityReader role/)).toBeInTheDocument();
  });

  it("restores all 5000 selected packages from bounded principal-scoped session routing", async () => {
    const selectedIds = Array.from({ length: 5_000 }, (_, index) => `package-${index}`);
    expect(storePackageSelection(reader, selectedIds)).toBe(true);
    window.history.replaceState({}, "", "/agents?selectionState=session&selectionCount=5000");
    const transport = appTransport({ revalidatedRoles: reader.roles });
    vi.stubGlobal("fetch", transport.fetchMock);
    render(<App />);

    expect(await screen.findAllByText("5000 selected")).not.toHaveLength(0);
    expect(await screen.findByText(/5,000 selected packages are preserved only for this signed-in browser session/)).toBeInTheDocument();
    expect(window.location.href.length).toBeLessThan(4_096);
    expect(window.location.search).toContain("selectionState=session");
    expect(window.location.search).not.toContain("selected=");
  });
});

function appTransport({
  revalidatedRoles,
  deferRevalidation = false,
  initialRoles = reader.roles,
}: {
  revalidatedRoles: SessionUser["roles"];
  deferRevalidation?: boolean;
  initialRoles?: SessionUser["roles"];
}) {
  let currentUserCalls = 0;
  let resolveRevalidation!: (response: Response) => void;
  const revalidation = new Promise<Response>(resolve => {
    resolveRevalidation = resolve;
  });
  const revalidatedResponse = () => Response.json({
    user: { ...reader, roles: revalidatedRoles },
    csrfToken: "csrf-2",
    roleAssignmentRequired: revalidatedRoles.length === 0,
  });
  const transport: {
    failProtectedReadsWith?: 401 | 403;
    protectedFailureCode?: "forbidden" | "missing_internal_role";
    fetchMock: ReturnType<typeof vi.fn>;
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
      if (currentUserCalls === 1) return Response.json({ user: { ...reader, roles: initialRoles }, csrfToken: "csrf-1", roleAssignmentRequired: false });
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
