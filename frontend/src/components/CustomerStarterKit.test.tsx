import { createHash, webcrypto } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CustomerStarterKit } from "./CustomerStarterKit";

const directory = resolve(process.cwd(), "public/customer-kit/adoption-intelligence");
const files = readdirSync(directory).sort().map(path => ({ path, bytes: readFileSync(resolve(directory, path)) }));
const digest = createHash("sha256");
for (const file of files) digest.update(file.path).update("\0").update(file.bytes).update("\0");
const version = digest.digest("hex");
const prompts = JSON.parse(readFileSync(resolve(directory, "prompts.json"), "utf8"));
const projected = JSON.stringify({ contract: { role: prompts.contract.employeeRole, evidenceChecklist: prompts.contract.evidenceChecklist,
  outputChecklist: prompts.contract.outputChecklist, failureThreshold: prompts.contract.failureThreshold },
prompts: prompts.prompts.filter((prompt: { role: string }) => prompt.role === "employee"),
conversations: prompts.conversations.filter((conversation: { role: string }) => conversation.role === "employee") });
files.push({ path: "employee-prompts.json", bytes: Buffer.from(projected) });
const manifest = { version, files: files.map(file => ({
  path: file.path, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"),
})) };
const fetcher = vi.fn();
function response(path: string) {
  if (path === "/customer-kit/manifest.json") return Response.json(manifest);
  const file = files.find(file => path === `/customer-kit/adoption-intelligence/${file.path}`);
  if (!file) throw new Error(`Unexpected asset ${path}`);
  return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": "text/plain" } });
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fetcher.mockReset().mockImplementation(async path => response(path));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("offers the wizard description and general system instructions with canonical copy/download bytes", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<CustomerStarterKit audience="staff" />);
  expect(screen.getByRole("heading", { name: "MCP Server Setup" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Customer starter kit" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await screen.findByRole("button", { name: "Copy MCP server description" });
  expect(screen.getByText(/OAuth 2.0 > Dynamic discovery/)).toBeVisible();
  expect(screen.getByText(/Paste this into Server description/)).toBeVisible();
  expect(screen.getByLabelText("Exact server-description.md")).not.toBeVisible();
  await user.click(screen.getByText("Exact setup text", { exact: true }));
  expect(screen.getByRole("textbox", { name: "Exact server-description.md" })).toBeVisible();
  expect(screen.getByTestId("customer-kit-version")).toHaveTextContent(version);
  expect(screen.getByRole("link", { name: "Download MCP server description" })).toHaveAttribute("download", "server-description.md");
  expect(screen.getByRole("link", { name: "Download installable skill ZIP" })).toHaveAttribute("href", "/customer-kit/adoption-intelligence.zip");
  await user.click(screen.getByRole("button", { name: "Copy MCP server description" }));
  expect(copy).toHaveBeenLastCalledWith(readFileSync(resolve(directory, "server-description.md"), "utf8"));
  expect(screen.getByRole("status")).toHaveTextContent("MCP server description copied.");
  await user.click(screen.getByRole("button", { name: "Show agent instructions" }));
  await screen.findByRole("button", { name: "Copy General agent system instructions" });
  expect(screen.getByText(/Overview > Instructions > Edit/)).toBeVisible();
  expect(screen.getByLabelText("Exact general.md")).not.toBeVisible();
  await user.click(screen.getByText("Exact setup text", { exact: true }));
  expect(screen.getByRole("textbox", { name: "Exact general.md" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy General agent system instructions" }));
  expect(copy).toHaveBeenCalledWith(files.find(file => file.path === "general.md")!.bytes.toString());
  expect(screen.getByRole("status")).toHaveTextContent("General agent system instructions copied.");
  expect(screen.getByRole("button", { name: "Copy General agent system instructions" })).toHaveFocus();
  await user.selectOptions(screen.getByLabelText("Setup content"), "SKILL.md");
  await screen.findByRole("button", { name: "Copy Optional adoption skill" });
  await user.click(screen.getByRole("button", { name: "Copy Optional adoption skill" }));
  expect(copy).toHaveBeenLastCalledWith(readFileSync(resolve(directory, "SKILL.md"), "utf8"));
  expect(screen.getByRole("link", { name: "Download Optional adoption skill" })).toHaveAttribute("download", "SKILL.md");
});

it("preserves explicit list semantics for the markerless setup steps", async () => {
  render(<CustomerStarterKit audience="staff" />);
  const steps = screen.getByRole("list");
  expect(steps).toHaveClass("customer-setup-steps");
  expect(steps).toHaveAttribute("role", "list");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  await screen.findByRole("button", { name: "Copy MCP server description" });
});

it("employee delivery fetches only safe projected instructions/prompts, not staff metadata or kit catalog", async () => {
  const user = userEvent.setup();
  render(<CustomerStarterKit audience="employee" />);
  await screen.findByRole("button", { name: "Copy employee.md" });
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["employee.md", "employee-prompts.json"]);
  expect(screen.queryByRole("link", { name: /ZIP/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Customer asset"), "employee-prompts.json");
  await screen.findByRole("button", { name: "Copy employee-prompts.json" });
  expect(screen.getByLabelText("Exact employee-prompts.json")).toHaveValue(projected);
  expect(fetcher.mock.calls.every(([path]) => [
    "/customer-kit/manifest.json", "/customer-kit/adoption-intelligence/employee.md",
    "/customer-kit/adoption-intelligence/employee-prompts.json",
  ].includes(path))).toBe(true);
  expect(fetcher.mock.calls.every(([, init]) => init.credentials === "omit")).toBe(true);
});

it("keeps verified text available when the current setup item is selected again", async () => {
  const user = userEvent.setup();
  render(<CustomerStarterKit audience="staff" />);
  await screen.findByRole("button", { name: "Copy MCP server description" });
  await user.click(screen.getByText("Exact setup text", { exact: true }));
  const reads = fetcher.mock.calls.length;
  await user.selectOptions(screen.getByLabelText("Setup content"), "server-description.md");
  expect(screen.getByRole("textbox", { name: "Exact server-description.md" })).toHaveValue(
    readFileSync(resolve(directory, "server-description.md"), "utf8"),
  );
  expect(screen.getByRole("button", { name: "Copy MCP server description" })).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(reads);
});

it("rejects mismatched bytes, reports error and recovers without substituting an asset", async () => {
  fetcher.mockImplementationOnce(async () => Response.json({ ...manifest, files: manifest.files.map(file => ({ ...file, sha256: "a".repeat(64) })) }));
  render(<CustomerStarterKit audience="staff" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  expect(screen.queryByRole("button", { name: "Copy MCP server description" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry setup content" }));
  await screen.findByRole("button", { name: "Copy MCP server description" });
});

it("selects exact inert text for keyboard/manual recovery when clipboard access fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  render(<CustomerStarterKit audience="staff" />);
  await screen.findByRole("button", { name: "Copy MCP server description" });
  expect(screen.getByLabelText("Exact server-description.md")).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy MCP server description" }));
  expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable");
  const field = screen.getByRole("textbox", { name: "Exact server-description.md" }) as HTMLTextAreaElement;
  expect(field).toHaveFocus();
  expect(field.selectionEnd - field.selectionStart).toBe(field.value.length);
});

it.each(["success", "failure"])("ignores delayed clipboard %s after choosing another setup document", async outcome => {
  const user = userEvent.setup();
  let succeed!: () => void;
  let fail!: (cause: Error) => void;
  const pending = new Promise<void>((resolve, reject) => { succeed = resolve; fail = reject; });
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue().mockImplementationOnce(() => pending);
  render(<CustomerStarterKit audience="staff" />);
  await user.click(await screen.findByRole("button", { name: "Copy MCP server description" }));
  await user.click(screen.getByRole("button", { name: "Show agent instructions" }));
  const currentCopy = await screen.findByRole("button", { name: "Copy General agent system instructions" });
  const focus = document.activeElement;
  await act(async () => {
    if (outcome === "success") succeed();
    else fail(new Error("denied"));
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Exact general.md")).not.toBeVisible();
  expect(document.activeElement).toBe(focus);
  await user.click(currentCopy);
  expect(copy).toHaveBeenLastCalledWith(readFileSync(resolve(directory, "general.md"), "utf8"));
  expect(screen.getByRole("status")).toHaveTextContent("General agent system instructions copied.");
});

it.each(["success", "failure"])("keeps the latest copy outcome when an earlier clipboard %s arrives late", async outcome => {
  const user = userEvent.setup();
  let succeed!: () => void;
  let fail!: (cause: Error) => void;
  const pending = new Promise<void>((resolve, reject) => { succeed = resolve; fail = reject; });
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue().mockImplementationOnce(() => pending);
  render(<CustomerStarterKit audience="staff" />);
  const button = await screen.findByRole("button", { name: "Copy MCP server description" });
  await user.click(button);
  copy.mockRejectedValueOnce(new Error("denied"));
  await user.click(button);
  expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable");
  await user.click(button);
  expect(screen.getByRole("status")).toHaveTextContent("MCP server description copied.");
  await act(async () => {
    if (outcome === "success") succeed();
    else fail(new Error("denied"));
  });
  expect(screen.getByRole("status")).toHaveTextContent("MCP server description copied.");
  expect(button).toHaveFocus();
});

it("loads every staff setup document with exact packaged bytes and download targets", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<CustomerStarterKit audience="staff" />);
  await screen.findByRole("button", { name: "Copy MCP server description" });
  const options = screen.getAllByRole<HTMLOptionElement>("option");
  expect(options.map(option => option.value).sort()).toEqual(files.filter(file => file.path !== "employee-prompts.json").map(file => file.path));
  for (const option of options) {
    await user.selectOptions(screen.getByLabelText("Setup content"), option.value);
    await user.click(await screen.findByRole("button", { name: `Copy ${option.textContent}` }));
    const bytes = readFileSync(resolve(directory, option.value), "utf8");
    expect(copy).toHaveBeenLastCalledWith(bytes);
    expect(screen.getByLabelText(`Exact ${option.value}`)).toHaveValue(bytes);
    expect(screen.getByRole("link", { name: `Download ${option.textContent}` }))
      .toHaveAttribute("href", `/customer-kit/adoption-intelligence/${option.value}`);
  }
});

it("puts the configured Resource URL in guided setup and copies only that exact value", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const url = "https://mcp.example.invalid/mcp";
  render(<CustomerStarterKit audience="staff" resourceUrl={url} />);
  await screen.findByRole("button", { name: "Copy MCP server description" });
  expect(screen.getByText(url, { exact: true })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy resource URL" }));
  expect(copy).toHaveBeenLastCalledWith(url);
});

it("aborts old audience loads and never reveals staff text after audience change", async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  fetcher.mockImplementationOnce(() => pending);
  const { rerender } = render(<CustomerStarterKit audience="staff" />);
  const signal = fetcher.mock.calls[0][1].signal;
  rerender(<CustomerStarterKit audience="employee" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json(manifest)));
  await screen.findByRole("button", { name: "Copy employee.md" });
  expect(screen.queryByRole("button", { name: "Copy MCP server description" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Exact employee.md")).toHaveValue(readFileSync(resolve(directory, "employee.md"), "utf8")));
});
