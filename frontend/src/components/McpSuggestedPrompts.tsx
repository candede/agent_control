import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, MessageSquare, MessagesSquare, Search } from "lucide-react";
import { loadCustomerKitFile } from "./customerKit";

type SuggestedPrompt = { id: string; role: "staff" | "employee"; novice: string; experienced: string };
type SuggestedConversation = { id: string; role: SuggestedPrompt["role"]; title: string; goal: string; context: string;
  steps: { title: string; prompt: string }[] };
type SuggestedLibrary = { prompts: SuggestedPrompt[]; conversations: SuggestedConversation[] };
type Suggestion = SuggestedPrompt | SuggestedConversation;

function isText(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function isSuggestion(value: unknown, ids: Set<string>): value is { id: string; role: SuggestedPrompt["role"] } {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string"
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id) && !ids.has(value.id)
    && "role" in value && (value.role === "staff" || value.role === "employee"));
}
function title(item: Suggestion) {
  return "title" in item ? item.title : item.id.charAt(0).toUpperCase() + item.id.slice(1).replaceAll("-", " ");
}
function readLibrary(text: string): SuggestedLibrary {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("prompts" in data) || !Array.isArray(data.prompts) || !data.prompts.length
    || !("conversations" in data) || !Array.isArray(data.conversations) || !data.conversations.length) {
    throw new Error("The suggested prompt library is invalid.");
  }
  const ids = new Set<string>();
  const prompts = data.prompts.map((prompt: unknown) => {
    if (!isSuggestion(prompt, ids) || !("novice" in prompt) || !isText(prompt.novice)
      || !("experienced" in prompt) || !isText(prompt.experienced)) {
      throw new Error("A suggested prompt is invalid.");
    }
    ids.add(prompt.id);
    return { id: prompt.id, role: prompt.role, novice: prompt.novice, experienced: prompt.experienced };
  });
  const conversations = data.conversations.map((conversation: unknown) => {
    if (!isSuggestion(conversation, ids) || !("title" in conversation) || !isText(conversation.title)
      || !("goal" in conversation) || !isText(conversation.goal) || !("context" in conversation) || !isText(conversation.context)
      || !("steps" in conversation) || !Array.isArray(conversation.steps) || conversation.steps.length < 2) {
      throw new Error("A suggested conversation is invalid.");
    }
    ids.add(conversation.id);
    const steps = conversation.steps.map((step: unknown) => {
      if (!step || typeof step !== "object" || !("title" in step) || !isText(step.title)
        || !("prompt" in step) || !isText(step.prompt)) throw new Error("A conversation step is invalid.");
      return { title: step.title, prompt: step.prompt };
    });
    return { id: conversation.id, role: conversation.role, title: conversation.title,
      goal: conversation.goal, context: conversation.context, steps };
  });
  return { prompts, conversations };
}

export function McpSuggestedPrompts() {
  const [library, setLibrary] = useState<SuggestedLibrary>();
  const [mode, setMode] = useState<"conversations" | "prompts">("conversations");
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [audience, setAudience] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const file = await loadCustomerKitFile("prompts.json", controller.signal);
        const items = readLibrary(file.text);
        if (!controller.signal.aborted) setLibrary(items);
      } catch {
        if (!controller.signal.aborted) setError("Suggested prompts and conversations could not be verified. Retry the current packaged library.");
      }
    }
    void load();
    return () => controller.abort();
  }, [revision]);
  function retry() { setLibrary(undefined); setError(undefined); setRevision(value => value + 1); }
  function chooseMode(value: typeof mode) {
    if (value === mode) return;
    setMode(value);
    setSelectedId(undefined);
  }
  const items: Suggestion[] = library?.[mode] ?? [];
  const filtered = items.filter(item => {
    const text = "steps" in item ? `${item.goal} ${item.context} ${item.steps.map(step => `${step.title} ${step.prompt}`).join(" ")}`
      : `${item.novice} ${item.experienced}`;
    return (audience === "all" || item.role === audience)
      && `${title(item)} ${text}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const selected = filtered.find(prompt => prompt.id === selectedId) ?? filtered[0];
  const conversations = mode === "conversations";
  const itemLabel = conversations ? "conversations" : "prompts";
  return <section id="mcp-prompts" className="mcp-card mcp-prompts" aria-labelledby="mcp-prompts-title">
    <header className="mcp-card-heading">
      <div><p className="mcp-eyebrow">01 / Explore</p><h3 id="mcp-prompts-title">Suggested prompts</h3></div>
      {library ? <span className="mcp-count">{items.length} {itemLabel}</span> : null}
    </header>
    <p className="mcp-section-intro">Follow a complete conversation or pick a single prompt. Find a useful task, then take the wording into your connected AI agent.</p>
    {!library && !error ? <p role="status">Loading suggested prompts and conversations...</p> : null}
    {error ? <p role="alert">{error} <button type="button" className="secondary" onClick={retry}>Retry suggested prompts</button></p> : null}
    {library ? <>
      <div className="mcp-library-modes" role="group" aria-label="Library view">
        <button type="button" aria-pressed={conversations} onClick={() => chooseMode("conversations")}>
          <MessagesSquare size={16} aria-hidden="true" />Conversations</button>
        <button type="button" aria-pressed={!conversations} onClick={() => chooseMode("prompts")}>
          <MessageSquare size={16} aria-hidden="true" />Individual prompts</button>
      </div>
      <div className="mcp-prompt-toolbar">
        <label className="mcp-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search prompts and conversations</span>
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${itemLabel} or tasks`} /></label>
        <label className="mcp-prompt-audience">Audience<select value={audience} onChange={event => setAudience(event.target.value)}>
          <option value="all">All audiences</option><option value="staff">Adoption team</option><option value="employee">Employee discovery</option>
        </select></label>
      </div>
      <div className="mcp-prompt-browser">
        <div className="mcp-prompt-navigation">
          <p className="mcp-prompt-results" role="status">{filtered.length} of {items.length} {itemLabel}</p>
          <label className="mcp-prompt-mobile-picker">{conversations ? "Conversation" : "Scenario"}<select value={selected?.id ?? ""} disabled={!filtered.length}
            onChange={event => setSelectedId(event.target.value)}>
            {!filtered.length ? <option value="">No matching {itemLabel}</option> : null}
            {filtered.map(item => <option key={item.id} value={item.id}>{title(item)}</option>)}
          </select></label>
          <ul className="mcp-prompt-list" aria-label={conversations ? "Suggested conversations" : "Prompt scenarios"}>{filtered.map(item => <li key={item.id}>
            <button type="button" aria-label={`View ${title(item)}`} aria-pressed={selected?.id === item.id}
              onClick={() => setSelectedId(item.id)}>
              <span><strong>{title(item)}</strong><small>{item.role === "staff" ? "Adoption team" : "Employee discovery"}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>)}</ul>
        </div>
        {selected ? <article key={`${mode}-${selected.id}`} className="mcp-prompt" aria-labelledby={`mcp-prompt-${selected.id}`}>
          <header className="mcp-prompt-heading"><span className="mcp-badge">{selected.role === "staff" ? "Adoption team" : "Employee discovery"}</span>
            <h4 id={`mcp-prompt-${selected.id}`}>{title(selected)}</h4>
            <p>{selected.role === "staff" ? "Use your authorized staff connection." : "Use the employee's own work-account connection."}</p></header>
          {"steps" in selected ? <>
            <p className="mcp-conversation-goal">{selected.goal}</p>
            <div className="mcp-conversation-context"><span>Before you start</span><p>{selected.context}</p></div>
            <p className="mcp-conversation-guidance">Send step 1 in a new chat. After reading each answer, copy the next step into the same chat and adapt it to the response.</p>
            <ol className="mcp-conversation-steps" role="list" aria-label="Conversation steps">{selected.steps.map((step, index) =>
              <li key={index}><PromptText title={selected.title} label={step.title} stepNumber={index + 1} value={step.prompt} /></li>)}</ol>
          </> : <>
            <PromptText title={title(selected)} label="Beginner" value={selected.novice} />
            <PromptText title={title(selected)} label="Advanced" value={selected.experienced} />
          </>}
        </article> : <div className="mcp-prompt-empty"><Search size={24} aria-hidden="true" /><h4>No matching {itemLabel}</h4>
          <p>Try a different task or audience.</p><button type="button" className="secondary"
            onClick={() => { setQuery(""); setAudience("all"); }}>Clear library filters</button></div>}
      </div>
      <p className="mcp-section-note">Copying does not run tools or save changes. Review the prompt in your connected AI agent before sending.</p>
    </> : null}
  </section>;
}

function PromptText({ title, label, value, stepNumber }: { title: string; label: string; value: string; stepNumber?: number }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [state, setState] = useState<"copied" | "selected" | "failed">();
  const copyAttempt = useRef(0);
  const copyLabel = stepNumber ? `step ${stepNumber}` : `${label.toLowerCase()} prompt`;
  async function copy() {
    const attempt = ++copyAttempt.current;
    setState(undefined);
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === copyAttempt.current) setState("copied");
    }
    catch {
      if (attempt !== copyAttempt.current) return;
      const selection = window.getSelection();
      if (text.current && selection) {
        text.current.focus();
        const range = document.createRange();
        range.selectNodeContents(text.current);
        selection.removeAllRanges();
        selection.addRange(range);
        setState("selected");
      } else setState("failed");
    }
  }
  return <div className="mcp-prompt-variant">
    <header><h5>{stepNumber ? <span className="mcp-step-number" aria-hidden="true">{stepNumber}</span> : null}{label}</h5><button type="button" className="secondary"
      aria-label={`Copy ${copyLabel}: ${title}`} onClick={() => void copy()}>
      {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {state === "copied" ? "Copied" : "Copy"}</button></header>
    <p ref={text} className="mcp-prompt-text" tabIndex={-1}>{value}</p>
    {state ? <p className="mcp-prompt-feedback" role={state === "copied" ? "status" : "alert"}>
      {state === "copied" ? `${stepNumber ? `Step ${stepNumber}` : `${label} prompt`} copied.` : state === "selected"
        ? "Copy unavailable. The prompt is selected for manual copy."
        : "Copy unavailable. Select and copy the prompt text manually."}
    </p> : null}
  </div>;
}
