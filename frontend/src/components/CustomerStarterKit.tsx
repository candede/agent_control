import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { loadCustomerKitFile, type CustomerKitFile } from "./customerKit";
import { McpCopyText } from "./McpCopyText";
import "./customerStarterKit.css";

type Asset = { label: string; description?: string };
const base = "/customer-kit/";
const staffFiles: Record<string, Asset> = {
  "server-description.md": { label: "MCP server description", description: "Paste this into Server description in the Copilot Studio Add MCP server wizard. This is setup text, not live server metadata." },
  "general.md": { label: "General agent system instructions", description: "Paste these base instructions into your AI agent's instruction field. In Copilot Studio, use Overview > Instructions > Edit. Add staff or employee guidance for a focused agent." },
  "staff.md": { label: "Staff adoption instructions", description: "Add these to the general instructions for an authorized staff adoption agent." },
  "employee.md": { label: "Employee discovery instructions", description: "Add these to the general instructions for an employee discovery agent using each employee's own connection." },
  "SKILL.md": { label: "Optional adoption skill" },
  "evidence.md": { label: "Evidence definitions" },
  "recipes.json": { label: "Tool recipes" },
  "templates.json": { label: "Output and save templates" },
  "prompts.json": { label: "Example prompts and conversations" },
  "setup.md": { label: "Client setup guide" },
  "handoff.md": { label: "Analysis handoff template" },
};
const employeeFiles: Record<string, Asset> = {
  "employee.md": { label: "employee.md" },
  "employee-prompts.json": { label: "employee-prompts.json" },
};

export function CustomerStarterKit({ audience, resourceUrl }: { audience: "staff" | "employee"; resourceUrl?: string }) {
  return <Kit key={audience} audience={audience} resourceUrl={resourceUrl} />;
}

function Kit({ audience, resourceUrl }: { audience: "staff" | "employee"; resourceUrl?: string }) {
  const files = audience === "staff" ? staffFiles : employeeFiles;
  const [path, setPath] = useState(Object.keys(files)[0]);
  const asset = files[path];
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<CustomerKitFile>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const text = useRef<HTMLTextAreaElement>(null);
  const copyAttempt = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const file = await loadCustomerKitFile(path, controller.signal);
        if (!controller.signal.aborted) setResult(file);
      } catch {
        if (!controller.signal.aborted) setError("Setup content could not be verified. Retry the current packaged file.");
      }
    }
    void load();
    return () => controller.abort();
  }, [path, revision]);
  async function copy() {
    if (!result) return;
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(result.text);
      if (attempt === copyAttempt.current) setFeedback(`${asset.label} copied.`);
    }
    catch {
      if (attempt !== copyAttempt.current) return;
      setFeedback("Copy unavailable. The exact text is selected for manual copy.");
      text.current?.closest("details")?.setAttribute("open", "");
      text.current?.focus(); text.current?.select();
    }
  }
  function retry() { copyAttempt.current += 1; setResult(undefined); setError(undefined); setFeedback(undefined); setRevision(value => value + 1); }
  function choosePath(next: string) {
    if (next === path) return;
    copyAttempt.current += 1;
    setResult(undefined); setError(undefined); setFeedback(undefined); setPath(next);
  }
  const Heading = audience === "staff" ? "h3" : "h2";
  const document = <div className="customer-kit-document">
    <label className="customer-kit-picker">{audience === "staff" ? "Setup content" : "Customer asset"} <select value={path}
      onChange={event => choosePath(event.target.value)}>
      {Object.entries(files).map(([file, info]) => <option key={file} value={file}>{info.label}</option>)}</select></label>
    {asset.description ? <p className="customer-kit-description">{asset.description}</p> : null}
    {!result && !error ? <p role="status">Loading setup content…</p> : null}
    {error ? <p className="customer-kit-error" role="alert">{error} <button type="button" className="secondary" onClick={retry}>Retry setup content</button></p> : null}
    {result ? <>
      <div className="customer-kit-actions">
        <button type="button" onClick={() => void copy()}>Copy {asset.label}</button>
        <a href={`${base}adoption-intelligence/${path}`} download={path}><Download size={15} aria-hidden="true" />Download {asset.label}</a>
      </div>
      <details className="customer-kit-preview" key={path}><summary>Exact setup text<ChevronDown size={16} aria-hidden="true" /></summary>
        <textarea ref={text} aria-label={`Exact ${path}`} readOnly value={result.text} rows={8} />
      </details>
      <details className="customer-kit-package"><summary>Package details<ChevronDown size={16} aria-hidden="true" /></summary>
        <p>Source: adoption-intelligence/{path}</p>
        <p>Kit SHA-256: <code data-testid="customer-kit-version">{result.version}</code></p>
      </details>
    </> : null}
    {feedback ? <p role="status">{feedback}</p> : null}
  </div>;
  return <section id={audience === "staff" ? "mcp-setup" : undefined} className="mcp-card customer-starter-kit" aria-labelledby="customer-kit-title">
    <header className="mcp-card-heading"><div>{audience === "staff" ? <p className="mcp-eyebrow">02 / Connect</p> : null}
      <Heading id="customer-kit-title">{audience === "staff" ? "MCP Server Setup" : "Employee connection instructions"}</Heading></div></header>
    <p className="customer-kit-intro">Use your own work-account connection. These setup resources do not grant access or generate AI answers.</p>
    {audience === "staff" ? <>
      <div className="mcp-endpoint customer-kit-endpoint">
        <div className="mcp-field-heading"><span>Resource URL</span>{resourceUrl ? <McpCopyText key={resourceUrl} value={resourceUrl} label="resource URL" /> : null}</div>
        <code>{resourceUrl ?? "The Resource URL will appear when configured server settings are available."}</code>
      </div>
      <div className="customer-setup-layout">
        <ol className="customer-setup-steps" role="list">
          <li><span>1</span><div><h4>Add the MCP server</h4><p>In Copilot Studio, choose OAuth 2.0 &gt; Dynamic discovery.
            Use the Resource URL above, not the server&apos;s Entra client ID or secret.</p></div></li>
          <li><span>2</span><div><h4>Describe the connection</h4><p>Paste the server description into the Add MCP server wizard.</p>
            <button type="button" className="customer-kit-text-button" onClick={() => choosePath("server-description.md")}>Show server description</button></div></li>
          <li><span>3</span><div><h4>Give your agent instructions</h4><p>Use the general instructions as your starting point, then add staff or employee guidance if needed.</p>
            <button type="button" className="customer-kit-text-button" onClick={() => choosePath("general.md")}>Show agent instructions</button></div></li>
        </ol>
        {document}
      </div>
      <div className="customer-kit-footer"><a href={`${base}adoption-intelligence.zip`} download><Download size={15} aria-hidden="true" />Download installable skill ZIP</a>
        <p>Optional for clients that support skills. Not required to connect.</p></div>
    </> : document}
  </section>;
}
