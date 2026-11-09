import { useEffect, useState } from "react";
import { enterDiscovery, getDiscoveryConnection, type SessionUser } from "../api/client";
import { SharedLearningCards } from "./SharedLearningCards";
import { CustomerStarterKit } from "./CustomerStarterKit";
import type { McpDiscoveryConnection } from "../../../backend/src/types/mcpSettings";

export function EmployeeDiscoveryHandoff({ user, onSignOut, signingOut, error }: {
  user: SessionUser; onSignOut: () => void; signingOut: boolean; error?: string;
}) {
  return <PrincipalHandoff key={`${user.tenantId}:${user.homeAccountId}`} user={user}
    onSignOut={onSignOut} signingOut={signingOut} error={error} />;
}

function PrincipalHandoff({ user, onSignOut, signingOut, error }: {
  user: SessionUser; onSignOut: () => void; signingOut: boolean; error?: string;
}) {
  const [notice, setNotice] = useState<string>();
  const [connection, setConnection] = useState<McpDiscoveryConnection>();
  const [connectionError, setConnectionError] = useState<string>();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    getDiscoveryConnection(controller.signal).then(value => {
      if (!controller.signal.aborted) setConnection(value);
    }).catch(() => {
      if (!controller.signal.aborted) setConnectionError("Connection setup could not be read.");
    });
    return () => controller.abort();
  }, [user.tenantId, user.homeAccountId, connectionRevision]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const enter = async () => {
      try {
        const result = await enterDiscovery({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setNotice(result.admission === "retryable" ? "Automatic source collection will retry. Missing sources do not prevent discovery sign-in." : undefined);
        timer = setTimeout(() => void enter(), Math.min(300_000, Math.max(60_000, Date.parse(result.nextCheckAt) - Date.now())));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setNotice(cause instanceof Error ? cause.message : "Automatic source collection admission failed.");
        timer = setTimeout(() => void enter(), 60_000);
      }
    };
    void enter();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [user.tenantId, user.homeAccountId]);
  async function copyResource(resourceUrl: string) {
    try {
      await navigator.clipboard.writeText(resourceUrl);
      setCopied("MCP resource copied.");
    } catch {
      setCopied("Copy unavailable. Select the resource text.");
    }
  }
  return <main className="signed-out">
    <h1>Agent discovery</h1>
    <p>You are signed in as {user.displayName} ({user.username}).</p>
    <p>Use your own work account in your organization&apos;s connected MCP or Copilot Studio experience to discover agents and colleagues.
      Discover Microsoft first-party and organization-created candidates with permitted saved descriptions.
      Discovery does not grant permission to use an agent.</p>
    <p>This browser workspace is for adoption and administration. Employee discovery is available through the conversational experience, not a browser catalog.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!connection && !connectionError ? <p role="status">Loading discovery connection…</p> : null}
    {connectionError ? <p role="alert">{connectionError} <button type="button" onClick={() => {
      setConnectionError(undefined); setConnection(undefined); setConnectionRevision(value => value + 1);
    }}>Retry discovery connection</button></p> : null}
    {connection?.state === "not_configured" ? <p>No MCP resource is configured. Safe shared learning remains available.</p> : null}
    {connection?.state === "available" ? <p>Current public MCP resource: <code>{connection.resourceUrl}</code>{" "}
      <button type="button" onClick={() => void copyResource(connection.resourceUrl)}>Copy MCP resource</button>
      {" "}Streamable HTTP with your own per-user OAuth. Your host supplies its exact client callback; /auth/callback is the server callback.
      Public reachability and this host connection are not verified by this page.</p> : null}
    {copied ? <p role="status">{copied}</p> : null}
    <CustomerStarterKit audience="employee" />
    <SharedLearningCards key={`${user.tenantId}:${user.homeAccountId}`} principalKey={`${user.tenantId}:${user.homeAccountId}`} />
    <button type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? "Signing out..." : "Sign out"}</button>
  </main>;
}
