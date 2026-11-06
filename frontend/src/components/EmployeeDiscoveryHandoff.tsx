import { useEffect, useState } from "react";
import { enterDiscovery, type SessionUser } from "../api/client";

export function EmployeeDiscoveryHandoff({ user, onSignOut, signingOut, error }: {
  user: SessionUser; onSignOut: () => void; signingOut: boolean; error?: string;
}) {
  const [notice, setNotice] = useState<string>();
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
  return <main className="signed-out">
    <h1>Agent discovery</h1>
    <p>You are signed in as {user.displayName} ({user.username}).</p>
    <p>Use your own work account in your organization&apos;s connected MCP or Copilot Studio experience to discover agents and colleagues.
      Discovery does not grant permission to use an agent.</p>
    <p>This browser workspace is for adoption and administration. Employee discovery is available through the conversational experience, not a browser catalog.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? "Signing out..." : "Sign out"}</button>
  </main>;
}
