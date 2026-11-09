import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, CircleCheck, CircleHelp, Code2, FileText, Info, LoaderCircle, Network, RefreshCw, Search, Server, Shield } from "lucide-react";
import type { McpSettings as Settings, McpTool } from "../../../backend/src/types/mcpSettings";
import { getMcpSettings, type SessionUser } from "../api/client";
import { hasRole } from "../authorization";
import { formatSyncInstant } from "./syncPresentation";
import "./mcpSettings.css";
import { CustomerStarterKit } from "./CustomerStarterKit";
import { McpSuggestedPrompts } from "./McpSuggestedPrompts";
import { McpCopyText } from "./McpCopyText";

export function McpSettings({ user }: { user: SessionUser }) {
  const owner = JSON.stringify([user.tenantId, user.homeAccountId, [...user.roles].sort()]);
  return <PrincipalMcpSettings key={owner} user={user} owner={owner} />;
}

function PrincipalMcpSettings({ user, owner }: { user: SessionUser; owner: string }) {
  const [result, setResult] = useState<{ owner: string; settings?: Settings; error?: string }>();
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const allowed = hasRole(user, "AgentControl.Viewer");
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    getMcpSettings({ signal: controller.signal }).then(settings => {
      if (!controller.signal.aborted) setResult({ owner, settings });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ owner, error: "MCP metadata could not be read. Retry to read metadata only." });
    });
    return () => controller.abort();
  }, [owner, revision, allowed]);
  const current = result?.owner === owner ? result : undefined;
  const settings = current?.settings;
  const runtime = settings?.state === "available" ? settings.runtime : undefined;
  const indexed = useMemo(() => runtime?.tools.map(tool => ({
    tool, search: `${tool.name}\n${tool.title ?? ""}\n${tool.description ?? ""}\n${JSON.stringify({
      input: tool.inputSchema, output: tool.outputSchema,
    })}`.toLowerCase(),
  })) ?? [], [runtime]);
  const tools = indexed.filter(item => (!readOnly || item.tool.annotations?.readOnlyHint === true)
    && (!query || item.search.includes(query.toLowerCase()))).map(item => item.tool);
  function refresh() { setResult(undefined); setRevision(value => value + 1); }
  return <section className="mcp-settings" aria-labelledby="mcp-settings-title">
    <header className="mcp-page-heading">
      <div className="mcp-page-icon"><Network size={24} aria-hidden="true" /></div>
      <div className="mcp-heading-copy">
        <p className="mcp-eyebrow">Connections &amp; integrations</p>
        <h2 id="mcp-settings-title" ref={heading} tabIndex={-1}>MCP settings</h2>
        <p>Bring Agent Control into your AI tools. Find a useful prompt, connect your agent, and explore what your connection can do.</p>
      </div>
    </header>
    {!allowed ? <div className="mcp-notice" role="alert"><AlertCircle size={20} aria-hidden="true" /><p>Viewer access is required.</p></div> : <>
      <nav className="mcp-jump-links" aria-label="On this page">
        <a href="#mcp-prompts">Suggested prompts</a><a href="#mcp-setup">MCP server setup</a><a href="#mcp-server-details">Server details</a>
      </nav>
      <McpSuggestedPrompts />
      <CustomerStarterKit audience="staff" resourceUrl={settings && settings.state !== "not_configured" ? settings.configured.resourceUrl : undefined} />
      <section id="mcp-server-details" className="mcp-server-section" aria-labelledby="mcp-server-title">
        <header className="mcp-card-heading">
          <div><p className="mcp-eyebrow">03 / Inspect</p><h3 id="mcp-server-title">Server details</h3>
            <p className="mcp-section-intro">Read-only information for your current connection. Configuration is managed through deployment tooling.</p></div>
          <button type="button" className="secondary mcp-refresh" onClick={refresh} disabled={!current}>
            <RefreshCw size={16} aria-hidden="true" className={!current ? "mcp-spinner" : undefined} />Refresh metadata
          </button>
        </header>
      {!current ? <div className="mcp-loading" role="status"><LoaderCircle className="mcp-spinner" size={22} aria-hidden="true" /><p>Loading MCP metadata…</p></div> : null}
      {current?.error ? <MetadataError message={current.error} onRetry={refresh} /> : null}
      {settings?.state === "not_configured" ? <div className="mcp-empty">
        <Network size={28} aria-hidden="true" /><h4>No server configured</h4>
        <p>No MCP server is configured for this organization.</p>
        <p>Connection settings are managed through the deployment tooling.</p>
      </div> : null}
      {settings && settings.state !== "not_configured" ? <>
        {settings.state !== "available" ? <MetadataError
          message={settings.state === "binding_mismatch" ? "The MCP identity does not match this organization's configured binding."
            : "The server is configured, but validated runtime metadata is unavailable."}
          code={settings.code} onRetry={refresh} /> : null}
        <div className="mcp-overview">
          <section className="mcp-card" aria-labelledby="mcp-connection-title">
            <header className="mcp-card-heading"><h4 id="mcp-connection-title">Connection details</h4><span className="mcp-badge">View only</span></header>
            <p className="mcp-card-intro">Server callbacks and transport details. The client Resource URL is in setup above.</p>
            {runtime ? <div className="mcp-callback">
              <span className="mcp-field-label">Server Entra callback</span>
              <code>{new URL("/auth/callback", runtime.binding.resourceUrl).href}</code>
              <p>Completes server sign-in; not a downstream client redirect.</p>
            </div> : null}
            <dl className="mcp-connection-facts">
              <div><dt>Transport</dt><dd>{runtime?.transport ?? "Not observed"}</dd></div>
              <div><dt>Local host port</dt><dd>{settings.configured.localHostPort ?? "Not applicable"}</dd></div>
            </dl>
            {runtime ? <details className="mcp-redirects">
              <summary><span>Allowed client redirects</span><span className="mcp-count">{runtime.redirectUris.length}</span><ChevronDown size={16} aria-hidden="true" /></summary>
              <p>These return authorization to connected clients, not to the server.</p>
              <ul>{runtime.redirectUris.map(uri => <li key={uri}><code>{uri}</code></li>)}</ul>
            </details> : null}
          </section>
          <section className="mcp-card mcp-runtime" aria-labelledby="mcp-runtime-title">
            <header className="mcp-card-heading"><h4 id="mcp-runtime-title">Runtime status</h4>
              <span className="mcp-badge" data-tone={runtime ? "success" : "warning"}>{runtime ? "Metadata available" : "Unavailable"}</span>
            </header>
            {runtime ? <>
              <div className="mcp-server-identity"><Server size={20} aria-hidden="true" /><strong>{runtime.serverInfo.name}</strong><span>v{runtime.serverInfo.version}</span></div>
              <dl className="mcp-status-list">
                <div><dt>Internal service reachability</dt><dd><CircleCheck size={15} aria-hidden="true" />Reachable from the web API</dd></div>
                <div><dt>OAuth storage readiness</dt><dd data-tone={runtime.storageReady ? "success" : "warning"}>
                  {runtime.storageReady ? <CircleCheck size={15} aria-hidden="true" /> : <AlertCircle size={15} aria-hidden="true" />}
                  {runtime.storageReady ? "Ready" : "Not ready"}</dd></div>
                <div><dt>Public endpoint / tunnel</dt><dd><CircleHelp size={15} aria-hidden="true" />Unverified</dd></div>
                <div><dt>Authenticated MCP client</dt><dd><CircleHelp size={15} aria-hidden="true" />Unverified</dd></div>
              </dl>
              <p className="mcp-observed">Observed <time dateTime={settings.state === "available" ? settings.observedAt : undefined}>
                {settings.state === "available" ? formatSyncInstant(settings.observedAt) : ""}</time></p>
            </> : <p className="mcp-card-intro">Runtime status will appear when validated metadata is available.</p>}
            <p className="mcp-runtime-note"><Info size={15} aria-hidden="true" /><span>Internal reachability does not verify a public connection or an authenticated client.</span></p>
          </section>
        </div>
        {runtime ? <>
          <details className="mcp-card mcp-instructions">
            <summary><FileText size={20} aria-hidden="true" /><div><h4>Server instructions</h4><p>Exact guidance sent to clients during initialization.</p></div>
              <span className="mcp-count">{runtime.instructions.trim().split(/\s+/).length} words</span><ChevronDown size={18} aria-hidden="true" /></summary>
            <div className="mcp-instructions-body">
              <div className="mcp-instructions-toolbar"><span>Advertised by the running server</span><McpCopyText key={runtime.instructions} value={runtime.instructions} label="server instructions" /></div>
              <pre className="mcp-prose" data-testid="mcp-instructions">{runtime.instructions}</pre>
            </div>
          </details>
          <details className="mcp-card mcp-catalog">
            <summary className="mcp-catalog-heading"><Code2 size={20} aria-hidden="true" /><div>
              <h4>Tool catalog</h4><p>Explore your caller&apos;s advertised tools and contracts. No tools run here.</p></div>
              <span className="mcp-count">{runtime.tools.length} tools</span><ChevronDown size={18} aria-hidden="true" /></summary>
            <div className="mcp-catalog-toolbar">
              <label className="mcp-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search tools, descriptions and schemas</span>
                <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tools, descriptions, or schemas" /></label>
              <label className="mcp-read-filter"><input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />Read-only tools</label>
            </div>
            <div className="mcp-catalog-meta"><p role="status">{tools.length} shown / {runtime.tools.length} advertised tools</p>
              <p>Safety hints are not authorization. Roles, permissions, and confirmations still apply.</p></div>
            <div className="mcp-tool-list">{tools.map(tool => <Tool key={tool.name} tool={tool} />)}</div>
            {!tools.length ? <div className="mcp-empty mcp-no-results"><Search size={24} aria-hidden="true" /><h4>No matching tools</h4>
              <p>Try a different search or include all tool types.</p>
              <button type="button" className="secondary" onClick={() => { setQuery(""); setReadOnly(false); }}>Clear filters</button>
            </div> : null}
          </details>
        </> : null}
      </> : null}
      {settings ? <details className="mcp-card mcp-privacy">
          <summary><Shield size={20} aria-hidden="true" /><div><h4>Employee discovery privacy</h4>
            <p>Effective deployment policy for employee discovery and staff previews.</p></div>
            <span className="mcp-badge">View only</span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="mcp-privacy-body"><p>These independent API-owned values remain available when MCP metadata is unreachable. Ordinary authorized staff reads are unchanged.</p>
            <dl className="mcp-status-list">
              <div><dt>hide_employee_details</dt><dd>{String(settings.privacy.hide_employee_details)}</dd></div>
              <div><dt>hide_champion_employee</dt><dd>{String(settings.privacy.hide_champion_employee)}</dd></div>
            </dl>
          </div>
        </details> : null}
      </section>
    </>}
  </section>;
}

function MetadataError({ message, code, onRetry }: { message: string; code?: string; onRetry: () => void }) {
  return <div className="mcp-notice" role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>Metadata unavailable</strong>
    <p>{message}</p>{code ? <code>{code}</code> : null}</div>
    <button type="button" className="secondary" onClick={onRetry}>Retry metadata</button></div>;
}

function Tool({ tool }: { tool: McpTool }) {
  const [open, setOpen] = useState(false);
  const hints = tool.annotations;
  const title = tool.title?.trim() ? tool.title : tool.name;
  const annotations = [["Read-only", hints?.readOnlyHint], ["Destructive", hints?.destructiveHint],
    ["Idempotent", hints?.idempotentHint], ["Open world", hints?.openWorldHint]] as const;
  return <article className="mcp-tool" aria-label={tool.name}>
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary aria-label={`Inspect ${tool.name}`}><span className="mcp-tool-icon"><Code2 size={18} aria-hidden="true" /></span>
        <div className="mcp-tool-name"><h5>{title}</h5>{title !== tool.name ? <code>{tool.name}</code> : null}</div>
        <div className="mcp-tool-badges">
          {hints?.readOnlyHint === true ? <span className="mcp-badge" data-tone="success">Read-only</span> : <span className="mcp-badge">Operation</span>}
          {hints?.destructiveHint === true ? <span className="mcp-badge" data-tone="warning">Destructive</span> : null}
        </div><ChevronDown size={17} aria-hidden="true" />
      </summary>
      <div className="mcp-tool-body">
        <pre className="mcp-prose" data-testid="mcp-description">{tool.description ?? ""}</pre>
        <dl className="mcp-annotations">{annotations.map(([label, value]) => <div key={label}><dt>{label}</dt>
          <dd>{value === undefined ? "Not advertised" : value ? "Yes" : "No"}</dd></div>)}</dl>
        {open ? <div className="mcp-schemas">
          <details><summary><Code2 size={15} aria-hidden="true" />Input schema — {tool.name}<ChevronDown size={15} aria-hidden="true" /></summary>
            <pre tabIndex={0} role="region" aria-label={`Input schema for ${tool.name}`}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
          <details><summary><Code2 size={15} aria-hidden="true" />Output schema — {tool.name}<ChevronDown size={15} aria-hidden="true" /></summary>
            <pre tabIndex={0} role="region" aria-label={`Output schema for ${tool.name}`}>{tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : "Not advertised"}</pre></details>
        </div> : null}
      </div>
    </details>
  </article>;
}
