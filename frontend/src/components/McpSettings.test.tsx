import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { McpSettings as Settings } from "../../../backend/src/types/mcpSettings";
import { getMcpSettings, type SessionUser } from "../api/client";
import { McpSettings } from "./McpSettings";

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), getMcpSettings: vi.fn() }));
vi.mock("./CustomerStarterKit", async () => {
  const { McpCopyText } = await import("./McpCopyText");
  return { CustomerStarterKit: ({ resourceUrl }: { resourceUrl?: string }) => <div>Customer kit tested separately
    {resourceUrl ? <McpCopyText value={resourceUrl} label="resource URL" /> : null}</div> };
});
vi.mock("./McpSuggestedPrompts", () => ({ McpSuggestedPrompts: () =>
  <section aria-labelledby="suggested-prompts-test-title"><h3 id="suggested-prompts-test-title">Suggested prompts</h3></section> }));
const user: SessionUser = { tenantId: "tenant", homeAccountId: "reader", roles: ["AgentControl.Viewer"],
  displayName: "Reader", username: "reader@example.invalid" };
const description = "  Long exact\n<script>alert('inert')</script>  ";
const settings: Settings = { state: "available", configured: { resourceUrl: "https://mcp.example.invalid/mcp", localHostPort: 3003 },
  privacy: { hide_employee_details: false, hide_champion_employee: false }, privacyScope: "end_user_and_preview",
  observedAt: "2026-11-04T10:00:00.000Z", runtime: {
    binding: { tenantId: "tenant", apiClientId: "api", mcpClientId: "mcp", resourceUrl: "https://mcp.example.invalid/mcp" },
    serverInfo: { name: "Agent Control", version: "0.1.0" }, instructions: description, transport: "streamable-http",
    storageReady: true, redirectUris: ["http://localhost:53109/client"],
    tools: ["saved_read", "explicit_control"].map(name => ({ name, description, inputSchema: { description: "<img onerror=alert(1)>" },
      outputSchema: { type: "object" }, annotations: { readOnlyHint: name === "saved_read" } })),
  } };
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
async function openTools() { await userEvent.click(await screen.findByText("Tool catalog", { exact: true })); }
it("places suggested prompts before setup and metadata, including when metadata fails", async () => {
  vi.mocked(getMcpSettings).mockRejectedValue(new Error("unavailable"));
  const { container } = render(<McpSettings user={user} />);
  await screen.findByRole("button", { name: "Retry metadata" });
  expect(container.querySelector(".mcp-settings > section")).toHaveAccessibleName("Suggested prompts");
  expect(screen.getByText("Customer kit tested separately")).toBeVisible();
});
it("materializes full schemas only when the exact tool is expanded while searching their complete source", async () => {
  const inputSchema = { type: "object", description: "complete-hidden-schema-marker " + "payload ".repeat(5000) };
  vi.mocked(getMcpSettings).mockResolvedValue({ ...settings, runtime: { ...settings.runtime,
    tools: [{ ...settings.runtime.tools[0], inputSchema }] } });
  const { container } = render(<McpSettings user={user} />);
  await openTools();
  await screen.findByText("1 shown / 1 advertised tools");
  expect(container.querySelector(".mcp-schemas")).toBeNull();
  await userEvent.type(screen.getByRole("searchbox"), "complete-hidden-schema-marker");
  expect(screen.getByText("1 shown / 1 advertised tools")).toBeVisible();
  await userEvent.click(screen.getByLabelText("Inspect saved_read"));
  await userEvent.click(await screen.findByText("Input schema — saved_read"));
  expect(screen.getByRole("region", { name: "Input schema for saved_read" }).textContent).toBe(JSON.stringify(inputSchema, null, 2));
});
it.each([[false, false], [true, false], [false, true], [true, true]])("shows independent API privacy values during metadata outage (%s,%s)", async (employee, champion) => {
  vi.mocked(getMcpSettings).mockResolvedValue({ state: "unavailable", configured: settings.configured, code: "metadata_unavailable",
    privacy: { hide_employee_details: employee, hide_champion_employee: champion }, privacyScope: "end_user_and_preview" });
  render(<McpSettings user={user} />);
  await screen.findByRole("heading", { name: "Employee discovery privacy" });
  await userEvent.click(screen.getByText("Employee discovery privacy", { exact: true }));
  expect(screen.getByText("hide_employee_details")).toBeVisible();
  expect(screen.getByText("hide_employee_details").closest("div")).toHaveTextContent(String(employee));
  expect(screen.getByText("hide_champion_employee").closest("div")).toHaveTextContent(String(champion));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)("shows exact inert metadata to %s", async role => {
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  const { container } = render(<McpSettings user={{ ...user, roles: [role] }} />);
  await openTools();
  expect(await screen.findByText("2 shown / 2 advertised tools")).toBeVisible();
  expect(screen.getByTestId("mcp-instructions").textContent).toBe(description);
  expect(screen.getAllByTestId("mcp-description")[0].textContent).toBe(description);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("3003")).toBeVisible();
  expect(screen.getByText("https://mcp.example.invalid/auth/callback")).toBeVisible();
  await userEvent.click(screen.getByText("Allowed client redirects", { exact: true }));
  expect(screen.getByText("http://localhost:53109/client")).toBeVisible();
  await userEvent.type(screen.getByRole("searchbox"), "saved");
  expect(screen.getByText("1 shown / 2 advertised tools")).toBeVisible();
  await userEvent.click(screen.getByLabelText("Inspect saved_read"));
  await userEvent.click(screen.getByText("Input schema — saved_read"));
  expect(screen.getByText(/<img onerror/)).toBeVisible();
});
it.each(["not_configured", "unavailable", "binding_mismatch"] as const)("shows explicit %s state", async state => {
  vi.mocked(getMcpSettings).mockResolvedValue(state === "not_configured" ? { state, privacy: settings.privacy, privacyScope: settings.privacyScope } :
    { state, configured: { resourceUrl: "https://configured.invalid/mcp" }, code: "metadata_unavailable", privacy: settings.privacy, privacyScope: settings.privacyScope });
  render(<McpSettings user={user} />);
  if (state === "not_configured") expect(await screen.findByText(/No MCP server is configured/)).toBeVisible();
  else expect(await screen.findByRole("button", { name: "Retry metadata" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: /Tool catalog/ })).not.toBeInTheDocument();
});
it("retries metadata only after a failed request", async () => {
  vi.mocked(getMcpSettings).mockRejectedValueOnce(new Error("redacted")).mockResolvedValueOnce(settings);
  render(<McpSettings user={user} />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry metadata" }));
  await openTools();
  expect(await screen.findByText("2 shown / 2 advertised tools")).toBeVisible();
  expect(getMcpSettings).toHaveBeenCalledTimes(2);
});
it("cancels principal-bound requests and hides old data immediately across account or role changes", async () => {
  let finish!: (value: Settings) => void;
  vi.mocked(getMcpSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(settings);
  const { rerender, unmount } = render(<McpSettings user={user} />);
  const oldSignal = vi.mocked(getMcpSettings).mock.calls[0][0]!.signal;
  rerender(<McpSettings user={{ ...user, tenantId: "other", homeAccountId: "other-reader" }} />);
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish(settings));
  await openTools();
  await waitFor(() => expect(screen.getByText("2 shown / 2 advertised tools")).toBeVisible());
  rerender(<McpSettings user={{ ...user, roles: [] }} />);
  expect(screen.queryByRole("heading", { name: /Tool catalog/ })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Viewer access");
  expect(screen.queryByRole("heading", { name: "Suggested prompts" })).not.toBeInTheDocument();
  unmount();
  expect(vi.mocked(getMcpSettings).mock.calls[1][0]!.signal?.aborted).toBe(true);
});
it("never restores a previous principal's result when identities cycle while requests are pending", async () => {
  vi.mocked(getMcpSettings).mockResolvedValueOnce(settings).mockImplementation(() => new Promise(() => {}));
  const { rerender } = render(<McpSettings user={user} />);
  await screen.findByText("2 shown / 2 advertised tools");
  rerender(<McpSettings user={{ ...user, tenantId: "other", homeAccountId: "other" }} />);
  expect(screen.queryByTestId("mcp-instructions")).not.toBeInTheDocument();
  rerender(<McpSettings user={user} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  expect(screen.queryByTestId("mcp-instructions")).not.toBeInTheDocument();
  expect(getMcpSettings).toHaveBeenCalledTimes(3);
});
it("searches complete schemas without changing the displayed tool descriptions", async () => {
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  render(<McpSettings user={user} />);
  await openTools();
  await screen.findByText("2 shown / 2 advertised tools");
  await userEvent.type(screen.getByRole("searchbox"), "onerror");
  expect(screen.getByText("2 shown / 2 advertised tools")).toBeVisible();
  expect(screen.getAllByTestId("mcp-description")[0].textContent).toBe(description);
});
it.each([
  ["", "saved_read"],
  [" \t\n ", "saved_read"],
  ["Saved inventory", "Saved inventory"],
])("keeps the tool identity visible with an advertised title (%#)", async (title, displayed) => {
  vi.mocked(getMcpSettings).mockResolvedValue({
    ...settings, runtime: { ...settings.runtime, tools: [{ ...settings.runtime.tools[0], title }] },
  });
  render(<McpSettings user={user} />);
  await openTools();
  await screen.findByText("1 shown / 1 advertised tools");
  expect(screen.getByRole("heading", { level: 5, name: displayed })).toBeVisible();
  if (displayed !== "saved_read") expect(screen.getByText("saved_read", { selector: "code" })).toBeVisible();
});
it("uses the application heading hierarchy and progressively discloses complete instructions and tool details", async () => {
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  render(<McpSettings user={user} />);
  await screen.findByText("2 shown / 2 advertised tools");
  expect(screen.getByRole("heading", { name: "MCP settings", level: 2 })).toBeVisible();
  expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  expect(screen.getByTestId("mcp-instructions")).not.toBeVisible();
  expect(screen.getByText("2 shown / 2 advertised tools")).not.toBeVisible();
  expect(screen.getAllByTestId("mcp-description")[0]).not.toBeVisible();
  await userEvent.click(screen.getByText("Server instructions", { exact: true }));
  expect(screen.getByTestId("mcp-instructions")).toBeVisible();
  expect(screen.getByTestId("mcp-instructions").textContent).toBe(description);
  await openTools();
  await userEvent.click(screen.getByLabelText("Inspect saved_read"));
  expect(screen.getAllByTestId("mcp-description")[0]).toBeVisible();
  expect(screen.getAllByTestId("mcp-description")[0].textContent).toBe(description);
});
it("filters by explicit read-only hints and provides a recoverable empty search", async () => {
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  render(<McpSettings user={user} />);
  await openTools();
  await screen.findByText("2 shown / 2 advertised tools");
  await userEvent.click(screen.getByRole("checkbox", { name: "Read-only tools" }));
  expect(screen.getByText("1 shown / 2 advertised tools")).toBeVisible();
  expect(screen.queryByLabelText("Inspect explicit_control")).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox"), "does-not-exist");
  expect(screen.getByText("No matching tools")).toBeVisible();
  expect(screen.getByText("0 shown / 2 advertised tools")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(screen.getByText("2 shown / 2 advertised tools")).toBeVisible();
});
it("distinguishes storage readiness from internal metadata and unverified external connectivity", async () => {
  vi.mocked(getMcpSettings).mockResolvedValue({ ...settings, runtime: { ...settings.runtime, storageReady: false } });
  render(<McpSettings user={user} />);
  await screen.findByText("2 shown / 2 advertised tools");
  expect(screen.getByText("Metadata available")).toBeVisible();
  expect(screen.getByText("Reachable from the web API")).toBeVisible();
  expect(screen.getByText("Not ready")).toBeVisible();
  expect(screen.getAllByText("Unverified")).toHaveLength(2);
  expect(getMcpSettings).toHaveBeenCalledOnce();
});
it("copies exact endpoint and instruction text without changing configuration", async () => {
  const interaction = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  render(<McpSettings user={user} />);
  await screen.findByText("2 shown / 2 advertised tools");
  await interaction.click(screen.getByRole("button", { name: "Copy resource URL" }));
  expect(write).toHaveBeenLastCalledWith(settings.configured.resourceUrl);
  expect(screen.getByText("resource URL copied.")).toBeInTheDocument();
  await interaction.click(screen.getByText("Server instructions", { exact: true }));
  await interaction.click(screen.getByRole("button", { name: "Copy server instructions" }));
  expect(write).toHaveBeenLastCalledWith(description);
  expect(getMcpSettings).toHaveBeenCalledOnce();
});
it("reports clipboard denial instead of claiming text was copied", async () => {
  const interaction = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  vi.mocked(getMcpSettings).mockResolvedValue(settings);
  render(<McpSettings user={user} />);
  await screen.findByText("2 shown / 2 advertised tools");
  await interaction.click(screen.getByRole("button", { name: "Copy resource URL" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Copy unavailable. Select and copy the text.");
  expect(screen.queryByText("resource URL copied.")).not.toBeInTheDocument();
});
