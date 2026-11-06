import type pg from "pg";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { dataLimits, digest } from "../db/dataBounds.js";
import { inventoryAssociationRevision, inventorySelectionRoots } from "../db/inventorySelections.js";
import { lockInventorySelection } from "../db/inventoryAuthority.js";
import { discoveryCatalogQuery, discoveryEligibilityQuery, discoveryPopularitySql, discoveryQuerySettingsSql, discoverySearchSql, discoveryWorkplaceSql } from "../db/agentDiscoveryQueries.js";
import { userSourceSearch } from "../db/userSources.js";
import { hasAppRole } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { DiscoveryCard, DiscoveryContact, DiscoveryContext, DiscoveryPage, DiscoveryPrivacy, DiscoveryProfile, DiscoveryRequest, DiscoveryResult,
  DiscoverySelection, DiscoveryText, DiscoveryWorkplace } from "../types/agentDiscovery.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { canonicalQuery, SelectionError, type DependencyRoot, type SelectionIdentity } from "./dataSelections.js";
import { reportIdentity } from "./reportIdentity.js";
import { currentAuthority } from "../auth/authorityContext.js";
import type { UserSourceMetadata } from "../types/userSources.js";

const endpoint = "agent_discovery";
const fields = ["mode", "subject", "profile", "directory", "report", "association"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid = () => new AppError(400, "invalid_discovery_request", "Use only the supported bounded discovery options.");
export function discoveryTextInput(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || !empty && !value.trim() || /[\p{Cc}\p{Cs}]/u.test(value)) throw invalid();
  return value.trim();
}
export function discoveryRequest(value: unknown): DiscoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const common = ["operation", "selectionId"];
  const extras: Record<string, string[]> = { profile: [], search: ["goal", "terms", "limit", "cursor"],
    detail: ["agentId", "cursor"], workplace: ["scope", "limit"] };
  if (typeof input.operation !== "string" || !Object.hasOwn(extras, input.operation)
    || Object.keys(input).some(key => ![...common, ...extras[input.operation as string]].includes(key))) throw invalid();
  if (input.selectionId !== undefined && (typeof input.selectionId !== "string" || !uuid.test(input.selectionId))) throw invalid();
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || Buffer.byteLength(input.cursor) > 4096 || !input.cursor || !input.selectionId)) throw invalid();
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 20)) throw invalid();
  if (input.goal !== undefined) userSourceSearch(discoveryTextInput(input.goal, 512, true), 512);
  if (input.terms !== undefined && (!Array.isArray(input.terms) || input.terms.length > 8
    || input.terms.some(term => typeof term !== "string" || !term.trim() || term.length > 128 || /[\p{Cc}\p{Cs}]/u.test(term))
    || new Set(input.terms.map(term => userSourceSearch(term, 128))).size !== input.terms.length)) throw invalid();
  if (input.operation === "detail" && (typeof input.agentId !== "string" || !uuid.test(input.agentId))) throw invalid();
  if (input.scope !== undefined && (typeof input.scope !== "string" || !["department", "company", "both"].includes(input.scope))) throw invalid();
  const request = structuredClone(input) as DiscoveryRequest;
  if (request.operation === "detail") request.agentId = request.agentId.toLowerCase();
  return request;
}

type Profile = { identity: string; display_name: string | null; upn: string | null; company: string | null; department: string | null;
  account_enabled: boolean | null; user_type: string | null };
type Binding = { mode: "self" | "preview"; subject: string; profile: string; directory: string | null; report: string | null; association: string };
type CatalogRow = { identity: string; title: string | null; description: string | null; had_title: boolean; had_description: boolean;
  lifecycle: DiscoveryCard["lifecycle"]; people: { id: string; name: string | null; contact: string | null; company: string | null; department: string | null }[];
  affiliations: DiscoveryCard["affiliations"]; evidence_complete: boolean;
  sources: DiscoveryCard["sources"]; evidence?: DiscoveryCard["evidence"]; rank?: number };
function profileHash(profile: Profile | null, generation: string | null) { return digest(JSON.stringify([generation, profile])); }
function directoryGeneration(source: UserSourceMetadata, now: Date) {
  return source.expiresAt && Date.parse(source.expiresAt) > now.getTime() ? source.generationId : null;
}
function context(profile: Profile | null, mode: Binding["mode"]): DiscoveryContext {
  return { mode, subject: mode === "self" ? "current_account" : "selected_member", company: profile?.company?.trim() || null,
    department: profile?.department?.trim() || null, profileState: profile ? "available" : "unavailable" };
}
function text(value: string | null, had: boolean, privacy: boolean): DiscoveryText {
  return { state: value !== null ? "available" : !had ? "absent" : privacy ? "privacy_withheld" : "unsafe_withheld", text: value };
}
function contact(person: { name: string | null; contact: string | null; company: string | null; department: string | null }, hideMetadata = false): DiscoveryContact {
  return { name: person.name, contact: person.contact, company: hideMetadata ? null : person.company,
    department: hideMetadata ? null : person.department };
}
function excerpt(value: string, start: number, end: number) {
  if (/[\uDC00-\uDFFF]/.test(value[start] ?? "")) start++;
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end--;
  return value.slice(start, end);
}
export function discoveryCard(row: CatalogRow, privacy: DiscoveryPrivacy): DiscoveryCard {
  const hidden = privacy.hide_employee_details || privacy.hide_champion_employee;
  const people = [...new Map(row.people.map(person => [person.id, person])).values()];
  const description = row.description === null ? null : excerpt(row.description, 0, 512);
  const evidence = (row.evidence ?? []).map(item =>
    ({ source: item.source, field: item.field, excerpt: item.excerpt }));
  return { id: row.identity, title: text(row.title, row.had_title, hidden),
    description: { ...text(description, row.had_description, hidden), clipped: (row.description?.length ?? 0) > 512 },
    lifecycle: row.lifecycle,
    people: { state: privacy.hide_employee_details ? "privacy_withheld" : row.people.length ? "available" : row.evidence_complete ? "absent" : "unavailable",
      value: privacy.hide_employee_details ? [] : people.map(person => contact(person, hidden)) },
    affiliations: [...new Map(row.affiliations.map(person =>
      [JSON.stringify([person.company, person.department]), { company: person.company, department: person.department }])).values()],
    useLink: { state: "absent", text: null }, evidence,
    sources: row.sources.map(source => ({ source: source.source, observedAt: source.observedAt,
      descriptionField: source.descriptionField, descriptionState: source.descriptionState })) };
}

export class AgentDiscovery {
  readonly reports: LargeTenantUsersReports;
  constructor(readonly database: pg.Pool, secret = config.sessionSecret) {
    this.reports = new LargeTenantUsersReports(database, secret, config.officialUsageStaleDays);
  }

  private async profile(client: pg.PoolClient, generation: string | null, subject: string, preview: boolean) {
    const rows = generation ? (await client.query<Profile>(`SELECT identity,display_name,upn,nullif(btrim(company),'') AS company,
      nullif(btrim(department),'') AS department,account_enabled,user_type FROM directory_user_rows
      WHERE generation_id=$1 AND (identity=$2 OR $3::boolean AND upn_key=lower(btrim($2) COLLATE "default") COLLATE "C")
      LIMIT 2`, [generation, subject, preview])).rows : [];
    if (preview && (rows.length !== 1 || rows[0].account_enabled !== true || rows[0].user_type?.toLowerCase() !== "member")) {
      throw new AppError(404, "discovery_subject_unavailable", "Select one saved active same-tenant member account.");
    }
    return rows.length === 1 && rows[0].account_enabled === true && rows[0].user_type?.toLowerCase() === "member" ? rows[0] : null;
  }

  async execute(user: AuthenticatedUser, value: unknown, subject?: string): Promise<DiscoveryResult> {
    const request = discoveryRequest(value);
    const mode = subject === undefined ? "self" : "preview";
    if (mode === "preview" && !hasAppRole(currentAuthority()?.principal.roles ?? user.roles, "AgentControl.Viewer")) throw new AppError(403, "role_required", "Staff preview requires Viewer authority.");
    const suppliedSubject = subject === undefined ? user.localAccountId : discoveryTextInput(subject, 512);
    if (!suppliedSubject) throw AppError.unauthorized();
    const requestedSubject = uuid.test(suppliedSubject) ? suppliedSubject.toLowerCase() : suppliedSubject;
    currentAuthority()?.assertCurrent();
    const identity = await reportIdentity(this.database, user);
    const id = request.selectionId ?? (await this.capture(identity, requestedSubject, mode)).id;
    const result = await this.reports.selections.read(id, identity, async (client, selected) => {
      await client.query(discoveryQuerySettingsSql);
      if (selected.selection.endpoint !== endpoint) throw new SelectionError("selection_invalidated");
      const binding = selected.selection.query_json as Binding;
      if (binding.mode !== mode || selected.selection.query_hash !== canonicalQuery(binding, fields)) throw new SelectionError("selection_invalidated");
      const metadata = await this.reports.sources.metadataInRead(client, identity, selected.selection.evaluated_at);
      const directory = directoryGeneration(metadata.directory, selected.selection.validated_at);
      const profile = await this.profile(client, directory, requestedSubject, mode === "preview");
      if ((profile?.identity ?? requestedSubject) !== binding.subject || profileHash(profile, directory) !== binding.profile
        || directory !== binding.directory
        || await inventoryAssociationRevision(client, identity.tenantId) !== binding.association) throw new SelectionError("selection_invalidated", "changed");
      const privacy = { ...config.employeePrivacy };
      const scope = context(profile, mode);
      const hidden = privacy.hide_employee_details || privacy.hide_champion_employee;
      const selection: DiscoverySelection = { id, revision: selected.selection.revision, expiresAt: selected.selection.expires_at.toISOString() };
      const report = await this.reports.discoveryReport(client, identity.tenantId, binding.report, selected.selection.evaluated_at);
      const reportState = report.availability === "active" ? "available" as const : report.availability === "stale" ? "stale" as const : "unavailable" as const;
      const values: unknown[] = [binding.directory, null, selected.selection.evaluated_at, identity.tenantId, binding.report, 5,
        id, identity.principalId, hidden, scope.company, scope.department, "[]"];
      const championData = binding.report && scope.company && scope.department
        && (request.operation === "workplace" || request.operation === "profile" || privacy.hide_champion_employee)
        ? (await client.query<{ value: (Profile & { name: string; contact: string })[]; own_match: string | null }>(`${discoveryWorkplaceSql}
          SELECT coalesce((SELECT jsonb_agg(c ORDER BY c.rank) FROM champions c),'[]'::jsonb) AS value,
            (SELECT report_match FROM person_metrics WHERE identity=$13) AS own_match`,
          [...values, profile?.identity ?? null])).rows[0] : null;
      const champions = championData?.value ?? [];
      const linked = championData?.own_match;
      if (privacy.hide_champion_employee) values[11] = JSON.stringify(champions.map(person =>
        ({ id: person.identity, name: person.name, contact: person.contact })));
      const safeScope = hidden && profile ? (await client.query<{ company: string | null; department: string | null }>(
        `SELECT discovery_safe_text($1,$3::jsonb,true,true) AS company,discovery_safe_text($2,$3::jsonb,true,true) AS department`,
        [scope.company, scope.department, JSON.stringify([
          { id: profile.identity, name: profile.display_name, contact: profile.upn },
          ...(privacy.hide_champion_employee ? champions.map(person => ({ id: person.identity, name: person.name, contact: person.contact })) : []),
        ])])).rows[0] : scope;
      const ctx = { ...scope, company: safeScope.company, department: safeScope.department };
      const expected = (operation: string, query: unknown) => ({ identity, endpoint: `${endpoint}/${operation}`, selectionId: id,
        revision: selection.revision, queryHash: digest(JSON.stringify([binding, privacy, query])) });
      const answer = await (async (): Promise<DiscoveryResult> => {
      if (request.operation === "profile") {
        return { context: ctx, selection, privacy, reportState, period: report.reportingPeriod ? {
          startDate: report.reportingPeriod.startDate, endDate: report.reportingPeriod.endDate } : null,
        ownChampion: { state: linked !== "matched" ? "unavailable" : champions.some(person => person.identity === profile?.identity) ? "suggested" : "not_suggested",
          reason: linked !== "matched" ? "saved_subject_report_link_unavailable" : null } } satisfies DiscoveryProfile;
      }
      if (request.operation === "workplace") {
        const limit = request.limit ?? 3, requestedScope = request.scope ?? "both";
        const rows = binding.report && scope.company
          ? (await client.query<{ identity: string; company_users: string; department_users: string }>(
            discoveryPopularitySql,
          [...values, limit])).rows : [];
        const catalog = async (ids: string[]) => ids.length ? (await client.query<CatalogRow>(
          `${discoveryCatalogQuery("$13")} SELECT * FROM catalog`, [...values, ids])).rows : [];
        const ranked = (key: "department_users" | "company_users") => rows.filter(row => Number(row[key]) > 0)
          .sort((a, b) => Number(b[key]) - Number(a[key]) || a.identity.localeCompare(b.identity));
        // Rank only current eligible agents; never fill a scope with another workplace's data.
        const eligible = await catalog([...new Set(rows.map(row => row.identity))]);
        const byId = new Map(eligible.map(row => [row.identity, row]));
        const top = (key: "department_users" | "company_users") => ranked(key).filter(row => byId.has(row.identity)).slice(0, limit)
          .map(row => discoveryCard(byId.get(row.identity)!, privacy));
        const created = scope.company && scope.department ? (await client.query<CatalogRow>(`${discoveryCatalogQuery(undefined, true)}
          SELECT * FROM catalog ORDER BY identity LIMIT $13`, [...values, limit])).rows : [];
        const department = requestedScope !== "company" && scope.department ? top("department_users") : [];
        const company = requestedScope !== "department" ? top("company_users") : [];
        const useCases = new Map<string, { agent: DiscoveryCard; relationships: ("created_here" | "used_here")[] }>();
        for (const row of created) useCases.set(row.identity, { agent: discoveryCard(row, privacy), relationships: ["created_here"] });
        for (const agent of department) {
          const item = useCases.get(agent.id) ?? { agent, relationships: [] };
          item.relationships.push("used_here"); useCases.set(agent.id, item);
        }
        const hasRelations = report.lineages.some(lineage => lineage.kind === "userAgents");
        const response: DiscoveryWorkplace = { context: ctx, selection, privacy, reportState,
          period: report.reportingPeriod ? { startDate: report.reportingPeriod.startDate, endDate: report.reportingPeriod.endDate } : null,
          champions: { state: !binding.report || !scope.department || !scope.company || !champions.length ? "unavailable"
            : privacy.hide_champion_employee ? "privacy_withheld" : "available", value: privacy.hide_champion_employee ? [] : champions.map(person => contact(person, hidden)) },
          ownChampion: { state: linked !== "matched" ? "unavailable" : champions.some(person => person.identity === profile?.identity) ? "suggested" : "not_suggested",
            reason: linked !== "matched" ? "saved_subject_report_link_unavailable" : null },
          department: { state: scope.company && scope.department && hasRelations && rows.some(row => Number(row.department_users) > 0) ? "available" : "unavailable", value: department },
          company: { state: scope.company && hasRelations && rows.length ? "available" : "unavailable", value: company },
          useCases: { state: useCases.size ? "available" : "unavailable", value: [...useCases.values()].slice(0, 20) } };
        return response;
      }
      if (request.operation === "detail") {
        const cursorScope = expected("detail", request.agentId);
        const offset = request.cursor ? Number(this.reports.codec.decode(request.cursor, cursorScope).boundary.id) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > dataLimits.agentDefinitionWorkBytes) throw invalid();
        const row = (await client.query<CatalogRow>(`${discoveryCatalogQuery("$13")} SELECT * FROM catalog`, [...values, [request.agentId]])).rows[0];
        if (!row) throw new AppError(404, "discovery_agent_unavailable", "This saved organization-created agent is no longer available.");
        const full = row.description;
        if (offset > (full?.length ?? 0)) throw invalid();
        let end = offset + 4096;
        if (full && /[\uD800-\uDBFF]/.test(full[end - 1] ?? "")) end--;
        const nextCursor = full && end < full.length ? this.reports.codec.encode({ ...cursorScope, direction: "next",
          boundary: { key: "description", id: String(end), nullRank: 0 } }) : null;
        return { context: ctx, selection, privacy, agent: discoveryCard(row, privacy),
          description: { ...text(full?.slice(offset, end) ?? null, row.had_description, Boolean(values[8])), clipped: nextCursor !== null },
          nextCursor };
      }
      const terms = [...new Set([request.goal?.trim() ?? "", ...(request.terms ?? [])].filter(Boolean).map(term => userSourceSearch(term, 512)))];
      const limit = request.limit ?? 5, cursorScope = expected("search", { terms, limit });
      const boundary = request.cursor ? this.reports.codec.decode(request.cursor, cursorScope).boundary : undefined;
      if (boundary && (!/^\d+$/.test(boundary.key ?? "") || !uuid.test(boundary.id))) throw invalid();
      const rows = (await client.query<CatalogRow>(discoverySearchSql,
      [...values, JSON.stringify(terms), boundary ? Number(boundary.key) : null, boundary?.id ?? null, limit + 1])).rows;
      const page = rows.slice(0, limit), last = page.at(-1);
      const result: DiscoveryPage = { context: ctx, selection, privacy,
        state: page.length ? "candidate" : "no_matching_saved_evidence", value: page.map(row => discoveryCard(row, privacy)),
        nextCursor: rows.length > limit && last ? this.reports.codec.encode({ ...cursorScope, direction: "next",
          boundary: { key: String(last.rank), id: last.identity, nullRank: 0 } }) : null };
      const coverage = await client.query("SELECT DISTINCT source FROM inventory_live_sources WHERE tenant_id=$1 AND authority_expires_at>clock_timestamp()", [identity.tenantId]);
      if (coverage.rowCount !== 2) result.state = "coverage_incomplete";
      return result;
      })();
      const ids = "value" in answer ? answer.value.map(card => card.id) : "agent" in answer ? [answer.agent.id]
        : "department" in answer ? [...answer.department.value, ...answer.company.value, ...answer.useCases.value.map(item => item.agent)].map(card => card.id) : [];
      if (ids.length) {
        const current = (await client.query(`SELECT agent_id FROM (${discoveryEligibilityQuery}) eligible WHERE agent_id=ANY($13::text[])`,
          [...values, [...new Set(ids)]])).rows;
        if (current.length !== new Set(ids).size) throw new SelectionError("selection_invalidated", "changed");
      }
      return answer;
    }, { beforeRead: client => lockInventorySelection(client, identity, id) });
    currentAuthority()?.assertCurrent();
    if (Buffer.byteLength(JSON.stringify(result)) > 1_048_000) throw new AppError(413, "discovery_response_too_large", "Narrow this discovery request.");
    return result;
  }

  private async capture(identity: SelectionIdentity, subject: string, mode: Binding["mode"]) {
    await this.reports.prepareHistoryCapture(identity.tenantId);
    await this.reports.sources.ensureScope(identity);
    return this.reports.selections.captureWith(identity, endpoint, { values: {}, allowed: fields }, async (client, now) => {
      const metadata = await this.reports.sources.metadataInRead(client, identity, now);
      const directory = directoryGeneration(metadata.directory, now);
      const profile = await this.profile(client, directory, subject, mode === "preview");
      const report = await this.reports.latestDiscoveryReport(client, identity.tenantId, now);
      const roots: DependencyRoot[] = [await this.reports.history.root(client, identity.tenantId, now)];
      const userScope = (await client.query(`SELECT id,epoch::text FROM data_scope_epochs WHERE tenant_id=$1 AND source='user_sources'
        AND scope_kind='tenant' AND token_mode='tenant' AND selector='complete'`, [identity.tenantId])).rows[0];
      roots.push({ kind: "user_sources", scopeId: userScope.id, revision: userScope.epoch, expiresAt: new Date(now.getTime() + 600_000) });
      if (directory) roots.push({ kind: "generation", scopeId: metadata.directory.scopeId!,
        generationId: directory, revision: metadata.directory.revision!, expiresAt: new Date(metadata.directory.expiresAt!) });
      const scope = (await client.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND source='inventory_canonical'
        AND scope_kind='tenant' AND token_mode='tenant' AND selector='complete'`, [identity.tenantId])).rows[0];
      if (scope) roots.push(...await inventorySelectionRoots(client, { id: scope.id, tenantId: identity.tenantId }, new Date(now.getTime() + 600_000)));
      const binding: Binding = { mode, subject: profile?.identity ?? subject, profile: profileHash(profile, directory),
        directory, report: report.setId, association: await inventoryAssociationRevision(client, identity.tenantId) };
      return { roots, queryValues: binding };
    });
  }
}
