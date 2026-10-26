// Execute current browser adapters against the same synthetic wire payloads as MCP.
// No application configuration, credentials, server or provider is loaded.
import * as web from "../../frontend/src/api/client.ts";
import * as reports from "../../frontend/src/api/reportData.ts";
import { readFileSync } from "node:fs";

const cases = JSON.parse(readFileSync(0, "utf8"));
const output = [];
for (const { name, request: r, response, status = 200 } of cases) {
  let captured;
  globalThis.fetch = async (path, init = {}) => {
    const url = new URL(path, "https://api.example.test");
    captured = {
      method: init.method ?? "GET", path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(init.body) : {},
      key: new Headers(init.headers).get("Idempotency-Key"),
    };
    return Response.json(response, { status, headers: {
      "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
      "X-Request-ID": "12345678-1234-4234-8234-123456789abc",
    } });
  };
  const access = { target: r.target, mode: r.mode, scope: r.scope, principals: r.principals };
  const { idempotencyKey, ...body } = r;
  const post = path => web.request(path, { method: "POST",
    headers: { "Content-Type": "application/json", ...idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} },
    body: JSON.stringify(body) });
  // Generic and all-matching canonical APIs have no dedicated generic UI adapter.
  const calls = {
    capture_agent_inventory: () => web.request("/api/agent-inventory/selections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: Object.fromEntries(Object.entries(r.query).map(([key, value]) => [key, String(value)])) }),
    }),
    list_agents: () => web.getUnifiedAgents(r),
    get_agent: () => web.getUnifiedAgentDetail(r.selectionId, r.recordId),
    list_agent_members: () => r.limit === 1
      ? web.request(`/api/agent-inventory/${encodeURIComponent(r.recordId)}/members?${new URLSearchParams({
        selectionId: r.selectionId, limit: "1", ...r.cursor ? { cursor: r.cursor } : {},
      })}`)
      : web.getInventoryMembers(r.selectionId, r.recordId, r.cursor),
    read_agent_about: () => web.getAgentAbout(r.selectionId, r.recordId,
      { scopeId: r.sourceScopeId, identity: r.sourceIdentity }, r.field, { cursor: r.cursor }),
    resolve_user: () => reports.readReportPage("copilot-usage/users/resolve", r),
    list_users: () => reports.reportPages.users(r),
    list_user_agent_relationships: () => {
      const { objectId, ...query } = r;
      return reports.readReportPage(`copilot-usage/users/${objectId}/agent-relationships`, query);
    },
    list_adoption_groups: () => reports.readReportPage("copilot-usage/adoption", r),
    list_champion_agents: () => reports.readReportPage("copilot-usage/adoption/champions", r),
    list_agent_usage_history: () => {
      const { recordId, ...query } = r;
      return reports.readAgentReportHistory(recordId, query);
    },
    get_agent_investigation: () => web.getAgentInvestigationContext(r.recordId),
    get_purview_catalog: () => web.getPurviewAuditCatalog(),
    start_purview_search: () => web.submitPurviewAuditSearch(r.tokenMode, r.filters, {
      agentRecordId: r.agentRecordId,
    }),
    get_purview_job: () => web.getPurviewAuditJob(r.id),
    refresh_packages: () => web.startPackageRefresh(r.mode, { idempotencyKey }),
    list_package_refresh_jobs: () => web.request(`/api/agents/refresh-jobs?${new URLSearchParams(r)}`),
    get_package_refresh_job: () => web.request(`/api/agents/refresh-jobs/${r.id}`),
    preview_agent_control: () => post("/api/agent-controls/preview"),
    execute_agent_control: () => post("/api/agent-controls/execute"),
    get_agent_control: () => web.request(`/api/agent-controls/${r.receiptId}`),
    count_package_targets: () => web.countPackageMutationSelection(r),
    preview_package_control: () => web.previewPackageMutation({
      action: r.action, selectionId: r.selectionId, ids: r.ids, recordIds: r.recordIds,
      mutationScope: r.mutationScope, ...r.target ? { accessUpdate: access } : {},
    }),
    block_packages: () => web.blockAgents(r.ids, r.confirmationHash),
    unblock_packages: () => web.unblockAgents(r.ids, r.confirmationHash),
    block_selected_packages: () => post("/api/agents/block-all"),
    unblock_selected_packages: () => post("/api/agents/unblock-all"),
    block_package: () => web.blockAgent(r.id, r.confirmationHash),
    unblock_package: () => web.unblockAgent(r.id, r.confirmationHash),
    update_packages_access: () => web.updateAgentsAccess(r.ids, access, r.confirmationHash),
    update_package_access: () => web.updateAgentAccess(r.id, access, r.confirmationHash),
    list_package_control_jobs: () => web.getBulkActionJobs(r.limit),
    get_package_control_job: () => web.getBulkActionJob(r.id),
    list_package_control_items: () => web.getBulkActionJobItems(r.id, r),
    cancel_package_control: () => web.cancelBulkActionJob(r.id),
    resume_package_control: () => web.resumeBulkActionJob(r.id),
    reconcile_package_control: () => web.reconcileBulkActionJob(r.id),
    get_studio_status: () => web.getQuarantineStatus(r.snapshotId, r.nativeId, r.force),
    preview_studio_control: () => web.previewQuarantine(r),
    execute_studio_control: () => web.submitQuarantine(body, idempotencyKey),
    list_studio_control_jobs: () => web.getQuarantineJobs(r.limit),
    get_studio_control_job: () => web.getQuarantineJob(r.id),
    cancel_studio_control: () => web.cancelQuarantineJob(r.id),
    resume_studio_control: () => web.resumeQuarantineJob(r.id),
    reconcile_studio_control: () => web.reconcileQuarantineJob(r.id),
    list_studio_control_audit: () => web.request(`/api/quarantine/audit?${new URLSearchParams(r)}`),
    search_access_principals: () => web.searchDirectoryPrincipals(r.search, r.limit),
    resolve_access_principals: () => web.resolveDirectoryPrincipals(r.principals),
    list_administrative_audit: () => web.getAuditEvents(r),
  };
  try {
    output.push({ request: await (async () => {
      const result = await calls[name]();
      return { ...captured, result };
    })() });
  } catch (error) {
    output.push({ request: captured, error: { status: error.status, code: error.code, requestId: error.requestId } });
  }
}
console.log(JSON.stringify(output));
