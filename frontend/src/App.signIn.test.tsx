import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function loginTransport({
  authConfigured = true,
  login = async () => Response.json({ code: "tenant_not_configured", detail: "Your organization is not configured for sign-in." }, { status: 400 }),
}: {
  authConfigured?: boolean;
  login?: (init?: RequestInit) => Promise<Response>;
} = {}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/auth/status") return Response.json({
      authConfigured,
      callback: "http://localhost/api/auth/callback",
      ...(!authConfigured ? { setup: "Ask your administrator to configure Microsoft sign-in." } : {}),
    });
    if (input === "/api/me") return Response.json({ code: "unauthorized", detail: "Sign-in required." }, { status: 401 });
    if (input === "/api/auth/login") return login(init);
    throw new Error(`Unexpected sign-in request: ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("username-first sign-in", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/agents");
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers one accessible username form without an organization selector or automatic login", async () => {
    const fetchMock = loginTransport();
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Work or school username" });
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toBeRequired();
    expect(screen.getByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
    expect(screen.getByRole("form", { name: "Sign in" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sign in/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/auth/status", "/api/me"]);
  });

  it.each(["", "username", "name@", "name@@example.com", "name@organization."])(
    "validates the organization username before submitting: %j",
    async username => {
      const fetchMock = loginTransport();
      render(<App />);
      const input = await screen.findByRole("textbox", { name: "Work or school username" });
      fireEvent.change(input, { target: { value: username } });
      await userEvent.click(screen.getByRole("button", { name: "Sign in with Entra ID" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Enter your work or school username, such as name@organization.com.");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveFocus();
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/login")).toBe(false);
    },
  );

  it("posts a trimmed username and safe return path once while announcing pending sign-in", async () => {
    window.history.replaceState({}, "", "/permissions?authorization=failed&returnTo=https%3A%2F%2Fexternal.example");
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const fetchMock = loginTransport({ login: () => pending });
    const app = render(<App />);
    const input = await screen.findByRole("textbox", { name: "Work or school username" });
    fireEvent.change(input, { target: { value: "  Admin+ops@Example.com  " } });
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Entra ID" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ username: "Admin+ops@Example.com", returnTo: "/permissions" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
    }));
    expect(screen.getByRole("button", { name: "Preparing sign-in..." })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(screen.getByRole("form", { name: "Sign in" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Preparing Microsoft sign-in...")).toHaveAttribute("role", "status");
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/login")).toHaveLength(1);
    const signal = fetchMock.mock.calls.find(([path]) => path === "/api/auth/login")![1]?.signal;
    app.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => release(Response.json({ authorizationUrl: "https://login.microsoftonline.com/example/oauth2/v2.0/authorize" })));
  });

  it.each([
    { status: 400, code: "tenant_not_configured", detail: "Your organization is not configured for sign-in." },
    { status: 403, code: "invalid_origin", detail: "Sign-in must be started from this application." },
    { status: 401, code: "unauthorized", detail: "Sign-in could not be started. Please try again." },
    { status: 503, code: "authentication_unavailable", detail: "Microsoft sign-in is temporarily unavailable." },
  ])("keeps the form usable after $code without revalidating an anonymous session", async problem => {
    const fetchMock = loginTransport({ login: async () => Response.json(problem, { status: problem.status }) });
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Work or school username" });
    await userEvent.type(input, "user@unknown.example{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(problem.detail);
    expect(screen.getByRole("alert").textContent).toBe(problem.detail);
    expect(input).toHaveValue("user@unknown.example");
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign in with Entra ID" })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/me")).toHaveLength(1);
    await userEvent.clear(input);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows retry after a network failure without revealing implementation details", async () => {
    const login = vi.fn().mockRejectedValueOnce(new TypeError("internal network diagnostic"))
      .mockResolvedValueOnce(Response.json({ code: "tenant_not_configured", detail: "Contact your administrator to enable sign-in." }, { status: 400 }));
    loginTransport({ login });
    render(<App />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Work or school username" }), "user@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Entra ID" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached.");
    expect(screen.queryByText(/internal network diagnostic/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Entra ID" }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Contact your administrator to enable sign-in.");
  });

  it("disables username sign-in when the deployment is not configured", async () => {
    const fetchMock = loginTransport({ authConfigured: false });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in with Entra ID" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Work or school username" })).toBeDisabled();
    expect(screen.getByText("Sign-in is not configured.")).toBeVisible();
    expect(screen.getByText("Ask your administrator to configure Microsoft sign-in.")).toBeVisible();
    expect(screen.getByText("http://localhost/api/auth/callback")).toBeVisible();
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/login")).toBe(false);
  });

  it.each([
    ["cancelled", "Microsoft permission setup was cancelled or denied."],
    ["interaction_required", "Microsoft requires additional sign-in, consent, or Conditional Access steps."],
    ["failed", "Microsoft did not complete sign-in or permission setup."],
  ])("preserves the %s authorization notice without automatically restarting authorization", async (outcome, notice) => {
    window.history.replaceState({}, "", `/agents?authorization=${outcome}`);
    const fetchMock = loginTransport();
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent(notice);
    expect(screen.getByRole("textbox", { name: "Work or school username" })).toBeVisible();
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/login")).toBe(false);
  });
});
