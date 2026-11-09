import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { McpSuggestedPrompts } from "./McpSuggestedPrompts";

type Prompt = { id: string; role: string; novice: string; experienced: string };
type Conversation = { id: string; role: string; title: string; goal: string; context: string; steps: { title: string; prompt: string }[] };
const source = readFileSync(resolve(process.cwd(), "public/customer-kit/adoption-intelligence/prompts.json"), "utf8");
const library: { prompts: Prompt[]; conversations: Conversation[] } = JSON.parse(source);
const fetcher = vi.fn();
function serve(text: string) {
  const bytes = Buffer.from(text);
  const hash = createHash("sha256").update(bytes).digest("hex");
  fetcher.mockImplementation(async (path: string) => {
    if (path === "/customer-kit/manifest.json") return Response.json({
      version: hash, files: [{ path: "prompts.json", bytes: bytes.length, sha256: hash }],
    });
    if (path === "/customer-kit/adoption-intelligence/prompts.json") return new Response(new Uint8Array(bytes));
    throw new Error(`Unexpected asset ${path}`);
  });
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  serve(source);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); });
async function showIndividualPrompts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Individual prompts" }));
}

it("defaults to complete canonical conversations with every step copyable without unlocking or API calls", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<McpSuggestedPrompts />);
  await screen.findByRole("heading", { name: library.conversations[0].title });
  expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(library.conversations.length);
  expect(screen.getByText(/Send step 1 in a new chat/)).toBeVisible();
  for (const conversation of library.conversations) {
    await user.click(screen.getByRole("button", { name: `View ${conversation.title}` }));
    const article = screen.getByRole("article", { name: conversation.title });
    expect(within(article).getByText(conversation.goal, { exact: true })).toBeVisible();
    expect(within(article).getByText(conversation.context, { exact: true })).toBeVisible();
    const steps = within(article).getByRole("list", { name: "Conversation steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(conversation.steps.length);
    for (let index = conversation.steps.length - 1; index >= 0; index--) {
      expect(within(steps).getByText(conversation.steps[index].prompt, { exact: true })).toBeVisible();
      const button = within(steps).getByRole("button", { name: `Copy step ${index + 1}: ${conversation.title}` });
      expect(button).toBeEnabled();
      await user.click(button);
      expect(copy).toHaveBeenLastCalledWith(conversation.steps[index].prompt);
    }
  }
  expect(copy).toHaveBeenCalledTimes(library.conversations.reduce((sum, conversation) => sum + conversation.steps.length, 0));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([, options]) => options.credentials === "omit")).toBe(true);
});

it("searches all conversation steps and preserves audience and query when switching views", async () => {
  const user = userEvent.setup();
  render(<McpSuggestedPrompts />);
  await screen.findByRole("heading", { name: library.conversations[0].title });
  await user.type(screen.getByRole("searchbox", { name: "Search prompts and conversations" }), "identical permissions");
  expect(screen.getByRole("heading", { name: "Share a workflow between departments" })).toBeVisible();
  await user.selectOptions(screen.getByLabelText("Audience"), "employee");
  expect(screen.getByRole("heading", { name: "No matching conversations" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Clear library filters" }));
  await user.selectOptions(screen.getByLabelText("Audience"), "employee");
  expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Find your first useful agent" })).toBeVisible();
  await user.type(screen.getByRole("searchbox", { name: "Search prompts and conversations" }), "hidden names");
  await showIndividualPrompts(user);
  expect(screen.getByLabelText("Audience")).toHaveValue("employee");
  expect(screen.getByRole("searchbox", { name: "Search prompts and conversations" })).toHaveValue("hidden names");
  expect(screen.getByRole("heading", { name: "Employee peer learning" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Conversations" }));
  expect(screen.getByRole("heading", { name: "Find your first useful agent" })).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("offers concise department analysis before a separate agreed-content email draft request", async () => {
  const guide = library.conversations[0];
  expect(guide.id).toBe("department-adoption-email");
  expect(guide.role).toBe("staff");
  expect(guide.steps).toHaveLength(2);
  const [analysis, draft] = guide.steps;
  expect(analysis.prompt).toContain("[Company]");
  expect(analysis.prompt).toContain("[Department]");
  expect(analysis.prompt).toMatch(/exact company and department/i);
  expect(analysis.prompt).toMatch(/complete all needed lookups and analysis yourself/i);
  expect(analysis.prompt).toMatch(/all distinct department-used agents/i);
  expect(analysis.prompt).toMatch(/agents used by non-champions/i);
  expect(analysis.prompt).toMatch(/full available agent descriptions/i);
  expect(analysis.prompt).toMatch(/observed agent use from documented capabilities/i);
  expect(analysis.prompt).toMatch(/no reported use does not mean never used/i);
  for (const name of ["Researcher", "Analyst", "Prompt Coach"]) {
    expect(analysis.prompt).toContain(name);
  }
  expect(analysis.prompt).toMatch(/additional Microsoft starter recommendations/i);
  expect(analysis.prompt).not.toContain("Explain missing evidence and continue with what is available");
  expect(analysis.prompt).toMatch(/Omit process narration, routine missing-evidence lists/i);
  expect(analysis.prompt).toMatch(/only if it materially changes a recommendation or blocks the task/i);
  expect(analysis.prompt).toMatch(/findings in this chat so we can refine them/i);
  expect(analysis.prompt).toMatch(/Do not write an email, create an Outlook draft/i);
  expect(draft.prompt).toMatch(/final findings and recommendations we agreed in this conversation/i);
  expect(draft.prompt).toMatch(/Preserve our agreed edits/i);
  expect(draft.prompt).toMatch(/full department recipient roster, not just adoption-support users/i);
  expect(draft.prompt).toMatch(/Fetch every page of Agent Control users.list/i);
  expect(draft.prompt).toMatch(/without license, activity or cohort filters/i);
  expect(draft.prompt).toMatch(/Pass the email addresses or UPNs returned by Agent Control directly/i);
  expect(draft.prompt).toMatch(/To\/recipient fields, not the email body/i);
  expect(draft.prompt).toMatch(/Do not ask Work IQ to search for people or confirm these addresses/i);
  expect(draft.prompt).toMatch(/empty people-search result must not discard known recipients/i);
  expect(draft.prompt).toMatch(/Do not create a recipient-less draft or ask me to enter known recipients manually/i);
  expect(draft.prompt).toMatch(/update that draft instead of creating a duplicate/i);
  expect(draft.prompt).toMatch(/Verify recipients are populated/i);
  expect(draft.prompt).not.toContain("resolve addresses with Work IQ rather than guessing");
  expect(draft.prompt).toMatch(/Work IQ to create an unsent Outlook draft/i);
  expect(draft.prompt).toMatch(/do not add disclaimer or appendix sections unless requested/i);
  expect(draft.prompt).toMatch(/without claiming completion/i);
  expect(draft.prompt).toMatch(/Never send the email or save an Agent Control action/i);
  render(<McpSuggestedPrompts />);
  const article = await screen.findByRole("article", { name: guide.title });
  expect(within(article).getAllByRole("button", { name: /^Copy step/ })).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("requires a departmental assessment and evidence-grounded suggested prompts", () => {
  const [analysis, draft] = library.conversations[0].steps;
  for (const requirement of [
    "returned department-level counts and valid denominators",
    "what is working well",
    "specific improvement opportunities supported by the evidence",
    "internally trace the department task",
    "actually returned department-used agent",
    "concrete supported input and output",
    "not just what the agent generally does",
    "Do not personalize a generic prompt merely by adding the department name",
    "Use actual job titles or role context only when returned or supplied",
    "do not invent them or make them a prerequisite",
    "not actual employee prompts or verified successful workflows",
    "without requiring observed departmental use or inventory presence",
  ]) {
    expect(analysis.prompt).toContain(requirement);
  }
  for (const requirement of [
    "introduce us as the Copilot Adoption Team",
    "stated reporting period",
    "short factual usage summary",
    "what is working well and where we can improve",
    "do not replace the analysis with an agent catalog",
    "why its documented capability fits that task",
    "prompt labeled Suggested example",
    "not captured employee prompts",
    "inspect the saved body through the tool result or supported read-back",
    "Correct dropped content in that same draft",
    "do not make read-back support a prerequisite to drafting",
  ]) {
    expect(draft.prompt).toContain(requirement);
  }
});

it("specifies a wide restrained enterprise brief without making styling a drafting gate", () => {
  const draft = library.conversations[0].steps[1].prompt;
  for (const requirement of [
    "enterprise Outlook HTML/rich-text email",
    "wide responsive column capped at 960px",
    "16px body text with 26px line height",
    "24px between sections",
    "white background, navy/slate headings",
    "flat, left-aligned workflow sections",
    "not a narrow centered poster, emoji, saturated banners, tinted agent cards",
    "preserve all agreed agent use cases without duplicating them",
    "presentation tables and inline styles",
    "never paste raw markup or Markdown into a plain-text body",
    "tool explicitly cannot preserve rich formatting",
    "blank lines between sections and workflows",
    "formatting limitation outside the email",
    "Do not block drafting just for styling",
  ]) {
    expect(draft.toLowerCase()).toContain(requirement.toLowerCase());
  }
  expect(draft).not.toContain("capped at 640px");
  expect(draft).not.toContain("purposeful emoji");
});

it("preserves the current selection and copy feedback when the active view is clicked again", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<McpSuggestedPrompts />);
  await user.click(await screen.findByRole("button", { name: "View Share a workflow between departments" }));
  await user.click(screen.getByRole("button", { name: "Copy step 1: Share a workflow between departments" }));
  await user.click(screen.getByRole("button", { name: "Conversations" }));
  expect(screen.getByRole("heading", { name: "Share a workflow between departments" })).toBeVisible();
  expect(screen.getByText("Step 1 copied.")).toBeVisible();
  await showIndividualPrompts(user);
  await user.selectOptions(screen.getByLabelText("Scenario"), "cross-entity-transfer");
  await user.click(screen.getByRole("button", { name: "Copy beginner prompt: Cross entity transfer" }));
  await showIndividualPrompts(user);
  expect(screen.getByRole("heading", { name: "Cross entity transfer" })).toBeVisible();
  expect(screen.getByText("Beginner prompt copied.")).toBeVisible();
});

it.each(["champion-learning", "starter-pack", "cross-entity-transfer", "task-specific-peers", "unmet-workflow",
  "employee-peer-learning", "employee-microsoft-local", "employee-missing-profile", "explicit-save", "capture-learning", "progress", "quality-recovery"])(
  "makes the standalone %s establish its own missing context", id => {
    const prompt = library.prompts.find(prompt => prompt.id === id)!;
    expect(prompt.novice).toMatch(/\b(ask|establish|clarify|obtain|identify)\b/i);
    expect(prompt.experienced).toMatch(/\b(ask|establish|clarify|obtain|identify)\b/i);
  });

it("shows every canonical scenario and copies both variants exactly without calling application APIs", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<McpSuggestedPrompts />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading suggested prompts");
  await showIndividualPrompts(user);
  await screen.findByRole("heading", { name: "Activation backlog" });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(library.prompts.length);
  expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(2);
  for (const prompt of library.prompts) {
    const title = prompt.id.charAt(0).toUpperCase() + prompt.id.slice(1).replaceAll("-", " ");
    await user.click(screen.getByRole("button", { name: `View ${title}` }));
    const article = screen.getByRole("article", { name: title });
    expect(within(article).getByText(prompt.novice, { exact: true })).toBeVisible();
    expect(within(article).getByText(prompt.experienced, { exact: true })).toBeVisible();
    for (const [variant, value] of [["beginner", prompt.novice], ["advanced", prompt.experienced]]) {
      await user.click(within(article).getByRole("button", { name: `Copy ${variant} prompt: ${title}` }));
      expect(copy).toHaveBeenLastCalledWith(value);
    }
  }
  expect(copy).toHaveBeenCalledTimes(library.prompts.length * 2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([, options]) => options.credentials === "omit")).toBe(true);
}, 15000);

it("filters all canonical wording by task and audience without fetching a second library", async () => {
  const user = userEvent.setup();
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  await screen.findByRole("heading", { name: "Activation backlog" });
  await user.selectOptions(screen.getByLabelText("Audience"), "employee");
  expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(library.prompts.filter(prompt => prompt.role === "employee").length);
  expect(screen.getByRole("button", { name: "View Employee first step" })).toHaveAttribute("aria-pressed", "true");
  await user.type(screen.getByRole("searchbox", { name: "Search prompts and conversations" }), "definitely-no-task");
  expect(screen.getByRole("heading", { name: "No matching prompts" })).toBeVisible();
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear library filters" }));
  expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(library.prompts.length);
  await user.type(screen.getByRole("searchbox", { name: "Search prompts and conversations" }), "contributor-provided");
  expect(screen.getByRole("heading", { name: "Capture learning" })).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps the compact scenario picker equivalent to the desktop navigation and resets copy feedback", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  await user.click(await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" }));
  expect(screen.getByText("Beginner prompt copied.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Conversations" }));
  expect(screen.queryByText("Beginner prompt copied.")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Conversation"), "share-workflow");
  expect(screen.getByRole("heading", { name: "Share a workflow between departments" })).toBeVisible();
  await showIndividualPrompts(user);
  await user.selectOptions(screen.getByLabelText("Scenario"), "employee-first-step");
  expect(screen.getByRole("heading", { name: "Employee first step" })).toBeVisible();
  expect(screen.getByRole("button", { name: "View Employee first step" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Beginner prompt copied.")).not.toBeInTheDocument();
});
it("selects the exact prompt for manual copy and reports clipboard denial truthfully", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  await user.click(await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" }));
  expect(screen.getByRole("alert")).toHaveTextContent("The prompt is selected for manual copy");
  expect(window.getSelection()?.toString()).toBe(library.prompts[0].novice);
  expect(screen.getByText(library.prompts[0].novice, { exact: true })).toHaveFocus();
  expect(screen.queryByText("Beginner prompt copied.")).not.toBeInTheDocument();
});

it.each(["success", "failure"])("ignores an earlier prompt-copy %s after the latest attempt finishes", async outcome => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue().mockReturnValueOnce(pending.promise);
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  const button = await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" });
  await user.click(button);
  if (outcome === "success") copy.mockRejectedValueOnce(new Error("denied"));
  await user.click(button);
  const focus = document.activeElement;
  const selection = window.getSelection()?.toString();
  await act(async () => {
    if (outcome === "success") pending.resolve();
    else pending.reject(new Error("denied"));
  });
  if (outcome === "success") {
    expect(screen.getByRole("alert")).toHaveTextContent("The prompt is selected for manual copy");
    expect(screen.queryByText("Beginner prompt copied.")).not.toBeInTheDocument();
  } else {
    expect(screen.getByText("Beginner prompt copied.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }
  expect(document.activeElement).toBe(focus);
  expect(window.getSelection()?.toString()).toBe(selection);
});

it.each(["success", "failure"])("clears previous prompt-copy %s feedback while another attempt is pending", async outcome => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  if (outcome === "failure") copy.mockRejectedValueOnce(new Error("denied"));
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  const button = await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" });
  await user.click(button);
  const pending = deferred<void>();
  copy.mockReturnValueOnce(pending.promise);
  await user.click(button);
  expect(screen.queryByText("Beginner prompt copied.")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(button).toHaveTextContent("Copy");
  await act(async () => pending.resolve());
  expect(screen.getByText("Beginner prompt copied.")).toBeVisible();
});

it("reports manual copying instructions when the browser cannot select text", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  vi.spyOn(window, "getSelection").mockReturnValue(null);
  render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  await user.click(await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Select and copy the prompt text manually");
});

it("preserves whitespace and renders source markup as inert prompt text", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const value = "  <script>alert('inert')</script>\nExact prompt text.  ";
  serve(JSON.stringify({ ...library, prompts: [{ ...library.prompts[0], novice: value }] }));
  const { container } = render(<McpSuggestedPrompts />);
  await showIndividualPrompts(user);
  await user.click(await screen.findByRole("button", { name: "Copy beginner prompt: Activation backlog" }));
  expect(container.querySelector(".mcp-prompt-text")?.textContent).toBe(value);
  expect(container.querySelector("script")).toBeNull();
  expect(copy).toHaveBeenCalledWith(value);
});

it("reports asset failures and retries without loading metadata or executing tools", async () => {
  fetcher.mockRejectedValueOnce(new Error("unavailable"));
  render(<McpSuggestedPrompts />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Suggested prompts and conversations could not be verified");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry suggested prompts" }));
  await screen.findByRole("heading", { name: library.conversations[0].title });
  expect(fetcher.mock.calls.every(([path]) => path.startsWith("/customer-kit/"))).toBe(true);
});

it("does not display or copy prompt bytes that do not match the manifest", async () => {
  fetcher.mockImplementationOnce(async () => Response.json({
    version: "a".repeat(64), files: [{ path: "prompts.json", bytes: Buffer.byteLength(source), sha256: "0".repeat(64) }],
  }));
  render(<McpSuggestedPrompts />);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Copy / })).not.toBeInTheDocument();
});

it.each([
  ["invalid JSON", "{"],
  ["missing library", "{}"],
  ["empty library", JSON.stringify({ ...library, prompts: [] })],
  ["duplicate IDs", JSON.stringify({ ...library, prompts: [library.prompts[0], library.prompts[0]] })],
  ["invalid ID", JSON.stringify({ ...library, prompts: [{ ...library.prompts[0], id: "../invalid" }] })],
  ["unknown audience", JSON.stringify({ ...library, prompts: [{ ...library.prompts[0], role: "owner" }] })],
  ["missing beginner text", JSON.stringify({ ...library, prompts: [{ ...library.prompts[0], novice: " " }] })],
  ["missing advanced text", JSON.stringify({ ...library, prompts: [{ ...library.prompts[0], experienced: null }] })],
  ["missing conversations", JSON.stringify({ prompts: library.prompts })],
  ["empty conversations", JSON.stringify({ ...library, conversations: [] })],
  ["duplicate conversation IDs", JSON.stringify({ ...library, conversations: [library.conversations[0], library.conversations[0]] })],
  ["unknown conversation audience", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], role: "owner" }] })],
  ["missing goal", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], goal: " " }] })],
  ["missing starting context", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], context: null }] })],
  ["single-step conversation", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], steps: [library.conversations[0].steps[0]] }] })],
  ["missing step text", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], steps: [{ title: "Start" }, library.conversations[0].steps[1]] }] })],
  ["blank step title", JSON.stringify({ ...library, conversations: [{ ...library.conversations[0], steps: [{ title: "", prompt: "Text" }, library.conversations[0].steps[1]] }] })],
])("rejects a verified but malformed prompt library: %s", async (_name, text) => {
  serve(text);
  render(<McpSuggestedPrompts />);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});

it("aborts pending packaged content reads when the page unmounts", async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const { unmount } = render(<McpSuggestedPrompts />);
  const signal: AbortSignal = fetcher.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({})));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
