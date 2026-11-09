import type pg from "pg";
import { AppError } from "../errors.js";
import { dataLimitError, digest, exactCount } from "../db/dataBounds.js";
import { lockDataScope } from "../db/dataGenerations.js";
import { reportIdentityRelationsSql, selectedReportRowsSql } from "../db/officialReportQueries.js";
import { officeSavedMetrics } from "../db/officeAppAdoption.js";
import { userSourceFactsSql } from "../db/userSources.js";
import type { InventoryQueries } from "../db/inventoryQueries.js";
import type { OpportunityCohort, OpportunityContext, OpportunityPage, OpportunityPeoplePage, OpportunityQuery } from "../types/departmentOpportunity.js";
import type { OfficeContext } from "../types/officeAppAdoption.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "./dataSelections.js";
import { officeQuery } from "./officeAppAdoption.js";
import { officeGroupRelations, type OfficeAppAdoptionReads } from "./officeAppAdoptionReads.js";
import { reportQuery, reportQueryFields, reportSearchSql, type LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";

const definitions: OpportunityPage["definitions"] = {
  officePaid: "paid_active entitlement captured in the selected Office observation",
  officeActive: "Office-paid people with recent participation in at least one of the seven Office apps in the inclusive D28 window",
  currentDirectory: "saved directory people in the exact company and department in the independent report context",
  currentAgentPaid: "paid_active entitlement in that independent saved directory, not historical Office eligibility",
  positive: "exact frozen identity with positive Users responses/agents-used or positive Users & agents responses",
  noReported: "no positive evidence in complete selected reports with no unresolved whole-observation identity evidence; not never used",
  unknown: "agent evidence cannot establish positive or no-reported evidence for this Office-active identity",
};

export function boundedOpportunity<T>(value: T, maximum = 131072): T {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > maximum) throw dataLimitError("opportunity_response_bytes", maximum, bytes);
  return value;
}

// The complete frozen observation is the identity basis, even for one filtered group.
export function opportunityRelations(office: OfficeContext, report: ReportReadContext) {
  const directory = `SELECT identity,payload->>'userPrincipalName' AS upn,
    lower(btrim(payload->>'userPrincipalName') COLLATE "default") COLLATE "C" AS upn_key,
    payload->>'displayName' AS display_name,payload->>'company' AS company,payload->>'department' AS department,
    payload->>'entitlement' AS entitlement,payload->>'serviceState' AS service_state,payload
    FROM office_person_facts WHERE generation_id=$1 AND ${office.observation?.kind === "current"}
      AND $3::timestamptz IS NOT NULL`;
  const complete = report.report.setId !== null && ["users", "userAgents"].every(kind =>
    report.report.lineages.some(lineage => lineage.kind === kind));
  const groups = officeGroupRelations(office);
  const relations = reportIdentityRelationsSql(directory, selectedReportRowsSql);
  const sql = `${relations}, office_audience AS MATERIALIZED (
    SELECT c.*,payload->>'groupId' AS group_id,
      CASE WHEN coalesce(responses,0)>0 OR coalesce(agents_used,0)>0 OR coalesce(bridge_responses,0)>0 THEN 'positive'
        WHEN ${complete} AND NOT unresolved THEN 'no_reported' ELSE 'unknown' END AS agent_evidence
    FROM combined c WHERE payload->>'entitlement'='paid_active' AND jsonb_array_length(payload->'recentApps')>0
  ), ${groups.sql.replace(/^WITH /, "")}, group_counts AS (
    SELECT group_id,count(*)::text AS office_active,
      count(*) FILTER(WHERE agent_evidence='positive')::text AS positive,
      count(*) FILTER(WHERE agent_evidence='no_reported')::text AS no_reported,
      count(*) FILTER(WHERE agent_evidence='unknown')::text AS unknown
    FROM office_audience GROUP BY group_id
  ), evidence AS (
    SELECT g.*,coalesce(c.office_active,'0') AS office_active,coalesce(c.positive,'0') AS positive,
      coalesce(c.no_reported,'0') AS no_reported,coalesce(c.unknown,'0') AS unknown,
      (SELECT count(*)::text FROM matches m WHERE match_count<>1 OR user_rows>1 OR alias_ambiguous
        OR EXISTS(SELECT 1 FROM resolved r WHERE r.username=m.username AND identity_count>1))
        AS unresolved_reports,
      (SELECT count(*)::text FROM (
        SELECT identity FROM ambiguous_directory_identities UNION SELECT identity FROM resolved WHERE identity_count>1
      ) ambiguous) AS ambiguous_people,
      row_number() OVER(ORDER BY coalesce(c.no_reported,'0')::bigint DESC,
        (g.metrics->>'reportedActiveUsers')::bigint DESC,g.id COLLATE "C")::int AS rank
    FROM matching_groups g LEFT JOIN group_counts c ON c.group_id=g.id
  )`;
  // Group predicates refer to $2; the other reserved parameters retain the report SQL contract.
  return { sql, complete, values: [office.observation?.id ?? null,
    JSON.stringify(office.query), report.evaluatedAt, report.identity.tenantId, report.report.setId, report.query.lowResponseThreshold] };
}

export class DepartmentOpportunities {
  constructor(readonly reports: LargeTenantUsersReports, readonly office: OfficeAppAdoptionReads, readonly inventory: InventoryQueries) {}

  private async selected(identity: SelectionIdentity, input: OpportunityQuery) {
    const { setId, reportSelectionId, officeSelectionId, inventorySelectionId, ...raw } = input;
    const query = officeQuery(raw);
    if (setId && reportSelectionId) throw new AppError(400, "invalid_opportunity_query", "A report selection already fixes its set.");
    const reportInput = { ...(setId ? { setId } : {}),
      ...(query.company === undefined ? {} : { company: query.company }),
      ...(query.department === undefined ? {} : { department: query.department }) };
    const reportId = reportSelectionId ?? (await this.reports.capture(identity, "adoption", reportInput, { inventoryEnrichment: false })).id;
    const officeId = officeSelectionId ?? (await this.office.capture(identity, query)).id;
    let inventoryId = inventorySelectionId;
    if (!inventoryId && !reportSelectionId && !officeSelectionId) {
      const scope = (await this.reports.database.query<{ id: string }>(`SELECT s.id FROM data_scope_epochs s
        JOIN inventory_roots r ON r.scope_id=s.id AND r.current
        WHERE s.tenant_id=$1 AND s.source='inventory_canonical' AND s.scope_kind='tenant'
          AND s.token_mode='tenant' AND s.selector='complete'
          AND EXISTS(SELECT 1 FROM inventory_live_sources live WHERE live.tenant_id=s.tenant_id
            AND live.authority_expires_at>clock_timestamp()) LIMIT 1`, [identity.tenantId])).rows[0];
      if (scope) inventoryId = (await this.inventory.capture(identity, scope.id,
        { inventoryScope: "all", ...(setId ? { setId } : {}) })).id;
    }
    return { query, reportId, officeId, inventoryId, reportInput };
  }

  private async read<T>(identity: SelectionIdentity, input: OpportunityQuery,
    work: (client: pg.PoolClient, office: OfficeContext, report: ReportReadContext, context: OpportunityContext) => Promise<T>) {
    const chosen = await this.selected(identity, input);
    const ids = [chosen.reportId, chosen.officeId, ...(chosen.inventoryId ? [chosen.inventoryId] : [])];
    return this.reports.selections.read(chosen.reportId, identity, async client => {
      const report = await this.reports.contextInRead(client, identity, chosen.reportId);
      const expected = reportQuery("adoption", chosen.reportInput);
      const { setId: selectedSet, ...selectedFilters } = report.query;
      const { setId: requestedSet, ...requestedFilters } = expected;
      if (report.endpoint !== "adoption" || requestedSet && selectedSet !== requestedSet
        || canonicalQuery(selectedFilters, reportQueryFields) !== canonicalQuery(requestedFilters, reportQueryFields)) throw new SelectionError("invalid_cursor");
      const selectedOffice = await this.office.selections.assert(client, chosen.officeId, identity);
      const { context: office } = await this.office.contextInRead(client, identity, chosen.query, selectedOffice);
      let inventory: OpportunityContext["inventory"] = null;
      if (chosen.inventoryId) {
        const { context: saved, selection } = await this.inventory.contextInRead(client, chosen.inventoryId, identity);
        if (saved.source !== "inventory_canonical" || Object.entries(saved.query).some(([key, value]) =>
          !["setId", "sortBy", "sortDirection"].includes(key) && !(["inventoryScope", "view", "source"].includes(key) && value === "all"))
          || saved.data.report.setId !== report.report.setId || saved.data.report.historyRevision !== report.report.historyRevision
          || saved.data.report.historyEpoch !== report.report.historyEpoch
          || saved.data.metadata.directory.generationId !== report.metadata.directory.generationId) throw new SelectionError("invalid_cursor");
        inventory = { id: chosen.inventoryId, revision: selection.revision, evaluatedAt: selection.evaluated_at.toISOString(),
          validatedAt: selection.validated_at.toISOString(), expiresAt: selection.expires_at.toISOString(),
          publicationRevisions: saved.data.publicationRevisions };
      }
      const context: OpportunityContext = { office, report: { selection: report.selection, query: report.query,
        reports: report.report, directory: report.metadata.directory }, inventory, inventoryState: inventory ? "available" : "unavailable" };
      const value = await work(client, office, report, context);
      // Expiry is current-clock, including sources that expired during awaited work.
      await this.office.selections.assert(client, chosen.officeId, identity);
      if (chosen.inventoryId) await this.inventory.contextInRead(client, chosen.inventoryId, identity);
      await this.reports.selections.assert(client, chosen.reportId, identity);
      return value;
    }, { beforeRead: async client => {
      // One selected transaction and globally ordered shared scopes fence all independent owners.
      await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [identity.tenantId, identity.principalId]);
      await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE",
        [identity.tenantId, identity.principalId]);
      const scopes = (await client.query<{ scope_id: string }>(`SELECT DISTINCT p.scope_id FROM data_generation_pins p
        JOIN data_read_selections s ON s.id=p.selection_id WHERE s.id=ANY($1::uuid[])
          AND s.tenant_id=$2 AND s.principal_id=$3 AND s.authorization_hash=$4 AND s.session_epoch=$5 ORDER BY p.scope_id`,
      [ids, identity.tenantId, identity.principalId, identity.authorizationHash, identity.sessionEpoch])).rows;
      for (const scope of scopes) await lockDataScope(client, scope.scope_id, identity.tenantId, "share");
    } });
  }

  page(identity: SelectionIdentity, input: OpportunityQuery, options: { limit?: number; cursor?: string } = {}): Promise<OpportunityPage> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new AppError(400, "invalid_opportunity_limit", "Use 1..10 groups.");
    if (options.cursor && (!input.officeSelectionId || !input.reportSelectionId)) throw new SelectionError("invalid_cursor");
    return this.read(identity, input, async (client, office, report, context) => {
      const { sql, values, complete } = opportunityRelations(office, report);
      const measured = office.observation?.kind === "current";
      const binding = { identity, endpoint: "department-opportunities", selectionId: office.selection.id,
        revision: digest(JSON.stringify([office.selection.revision, report.selection.id, report.selection.revision,
          context.inventory?.id, context.inventory?.revision, context.inventory?.publicationRevisions])),
        queryHash: digest(JSON.stringify([office.query, report.queryHash, limit])) };
      const cursor = options.cursor ? this.reports.codec.decode(options.cursor, binding) : null;
      if (cursor && (cursor.direction !== "next" || cursor.boundary.key !== "" || cursor.boundary.nullRank !== 0
        || !/^[1-9]\d*$/.test(cursor.boundary.id) || !Number.isSafeInteger(Number(cursor.boundary.id)))) throw new SelectionError("invalid_cursor");
      const offset = cursor ? Number(cursor.boundary.id) : 0;
      const totals = (await client.query(`${sql} SELECT (SELECT count(*)::text FROM groups) AS total,
        count(*)::text AS filtered,coalesce(sum(office_active::bigint),0)::text AS office_active,
        coalesce(sum(positive::bigint),0)::text AS positive,coalesce(sum(no_reported::bigint),0)::text AS no_reported,
        coalesce(sum(unknown::bigint),0)::text AS unknown FROM evidence`, values)).rows[0];
      const rows = (await client.query(`${sql} SELECT * FROM evidence ORDER BY rank LIMIT $7 OFFSET $8`,
        [...values, limit, offset])).rows;
      const counts = { total: exactCount(totals.total), filtered: exactCount(totals.filtered) };
      const boundQuery: OpportunityQuery = { ...office.query, reportSelectionId: report.selection.id, officeSelectionId: office.selection.id,
        ...(context.inventory ? { inventorySelectionId: context.inventory.id } : {}) };
      const directory = report.metadata.directory.generationId;
      const currentRows = directory && rows.length ? (await client.query(`WITH current_directory AS (${userSourceFactsSql()}), current_group_counts AS (
        SELECT encode(sha256(convert_to(jsonb_build_array(${reportSearchSql("nullif(btrim(company),'')")},
          ${reportSearchSql("nullif(btrim(department),'')")})::text,'UTF8')),'hex') AS group_id,
          count(*)::text AS people,count(*) FILTER(WHERE entitlement='paid_active')::text AS paid
        FROM current_directory GROUP BY ${reportSearchSql("nullif(btrim(company),'')")},
          ${reportSearchSql("nullif(btrim(department),'')")}
      ) SELECT * FROM current_group_counts WHERE group_id=ANY($4::text[])`,
      [...this.reports.parameters(report).slice(0, 3), rows.map(row => row.id)])).rows : [];
      const currentCounts = new Map(currentRows.map(row => [row.group_id, row]));
      const value: OpportunityPage["value"] = [];
      for (const row of rows) {
        const current = currentCounts.get(row.id);
        const metrics = officeSavedMetrics(row.metrics);
        const positive = exactCount(row.positive), noReported = exactCount(row.no_reported), unknown = exactCount(row.unknown);
        if (measured && (positive + noReported + unknown !== metrics.reportedActiveUsers)) throw new AppError(500, "opportunity_reconciliation", "Office audience categories did not reconcile.");
        const unresolved = exactCount(row.unresolved_reports), ambiguous = exactCount(row.ambiguous_people);
        const reasons = [...(!measured ? ["office_people_unavailable"] : []), ...(!complete ? ["complete_user_reports_missing"] : []),
          ...(unresolved ? ["unresolved_report_identities"] : []), ...(ambiguous ? ["ambiguous_office_identities"] : []),
          ...(context.inventory ? [] : ["optional_inventory_unavailable"])];
        const exactGroup = Object.hasOwn(office.query, "company") && Object.hasOwn(office.query, "department");
        const groupQuery = { ...(report.report.setId ? { setId: report.report.setId } : {}), company: row.company, department: row.department };
        value.push({ id: row.id, rank: row.rank, company: row.company, department: row.department, office: metrics,
          denominators: { officePaid: metrics.savedLicensedPeople, officeActive: metrics.reportedActiveUsers,
            currentDirectory: directory ? current ? exactCount(current.people) : 0 : null,
            currentAgentPaid: directory ? current ? exactCount(current.paid) : 0 : null },
          agentEvidence: { positive: measured ? positive : null, noReported: measured ? noReported : null, unknown: measured ? unknown : null },
          coverage: { state: !measured ? "unavailable" : unknown || !complete || unresolved || ambiguous ? "partial" : "complete",
            reasons, unresolvedReportIdentities: unresolved, ambiguousOfficePeople: ambiguous },
          drilldowns: {
            audience: { path: `/api/copilot-usage/adoption/opportunities/${row.id}/people`, query: boundQuery },
            officePeople: { path: `/api/office-app-adoption/groups/${row.id}/people`, query: { ...office.query, selectionId: office.selection.id } },
            peers: { path: exactGroup && context.inventory ? "/api/copilot-usage/adoption/champions" : "/api/copilot-usage/adoption",
              query: exactGroup && context.inventory ? { selectionId: report.selection.id, inventorySelectionId: context.inventory.id } : groupQuery,
              requiresExactGroupCapture: !exactGroup || !context.inventory },
            agents: { path: "/api/copilot-usage/adoption", query: groupQuery },
          } });
      }
      return boundedOpportunity({ value, counts, summary: { officeActive: office.observation
          ? measured ? exactCount(totals.office_active)
            : exactCount((await client.query(`${sql} SELECT coalesce(sum((metrics->>'reportedActiveUsers')::bigint),0)::text AS count FROM matching_groups`, values)).rows[0].count)
          : null,
        positive: measured ? exactCount(totals.positive) : null, noReported: measured ? exactCount(totals.no_reported) : null,
        unknown: measured ? exactCount(totals.unknown) : null }, context, definitions,
        page: { limit, nextCursor: offset + rows.length < counts.filtered ? this.reports.codec.encode({ ...binding,
          direction: "next", boundary: { id: String(offset + rows.length), key: "", nullRank: 0 } }) : null } });
    });
  }

  people(identity: SelectionIdentity, input: OpportunityQuery, groupId: string, cohort: OpportunityCohort,
    options: { limit?: number; cursor?: string } = {}): Promise<OpportunityPeoplePage> {
    const limit = options.limit ?? 50;
    if (!/^[a-f0-9]{64}$/.test(groupId) || !["positive", "no_reported", "unknown"].includes(cohort)
      || !Number.isInteger(limit) || limit < 1 || limit > 100 || !input.officeSelectionId || !input.reportSelectionId) throw new SelectionError("invalid_cursor");
    return this.read(identity, input, async (client, office, report, context) => {
      if (office.observation?.kind === "weekly") throw new AppError(409, "office_history_aggregate_only", "Weekly Office history contains aggregates only.");
      const { sql, values } = opportunityRelations(office, report);
      const binding = { identity, endpoint: "department-opportunity-people", selectionId: office.selection.id,
        revision: digest(JSON.stringify([office.selection.revision, report.selection.id, report.selection.revision,
          context.inventory?.id, context.inventory?.revision, context.inventory?.publicationRevisions])),
        queryHash: digest(JSON.stringify([office.query, groupId, cohort, limit])) };
      const cursor = options.cursor ? this.reports.codec.decode(options.cursor, binding) : null;
      if (cursor && (cursor.direction !== "next" || cursor.boundary.key !== "" || cursor.boundary.nullRank !== 0)) throw new SelectionError("invalid_cursor");
      const where = `FROM office_audience a JOIN matching_groups g ON g.id=a.group_id WHERE a.group_id=$7 AND agent_evidence=$8`;
      const total = exactCount((await client.query(`${sql} SELECT count(*)::text AS total ${where}`, [...values, groupId, cohort])).rows[0].total);
      const rows = (await client.query(`${sql} SELECT a.* ${where} AND identity COLLATE "C">$9 ORDER BY identity COLLATE "C" LIMIT $10`,
        [...values, groupId, cohort, cursor?.boundary.id ?? "", limit + 1])).rows;
      const page = rows.slice(0, limit);
      return boundedOpportunity({ value: page.map(row => ({ person: row.payload, agentEvidence: row.agent_evidence,
        reportedUsername: row.reported_username })), counts: { total, returned: page.length }, context,
        page: { limit, nextCursor: rows.length > limit ? this.reports.codec.encode({ ...binding, direction: "next",
          boundary: { id: page.at(-1)!.identity, key: "", nullRank: 0 } }) : null } }, 524288);
    });
  }
}
