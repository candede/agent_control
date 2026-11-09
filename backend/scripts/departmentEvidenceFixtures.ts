import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SelectionIdentity } from "../src/services/dataSelections.js";
import type { CopilotDirectoryUser } from "../src/types/copilotUsage.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import { officeFixtureActivity, officeFixtureDate, officeFixturePerson, publishOfficeSource } from "./officeAppAdoptionFixtures.js";

export const departmentEvidence = JSON.parse(readFileSync(new URL("../../frontend/public/customer-kit/adoption-intelligence/recipes.json", import.meta.url), "utf8")).departmentEvidence as {
  company: string; department: string; otherCompany: string; paid: number; officeActive: number;
  positive: number; noReported: number; unknown: number; usersOnlyPositive: number;
  agents: string[]; reportWindowOffsetDays: number; audiencePageSize: number;
  ambiguous: { positive: number; noReported: number; unknown: number };
};
export function departmentEvidencePeople(): CopilotDirectoryUser[] {
  const people = Array.from({ length: departmentEvidence.paid }, (_, index) => officeFixturePerson(index + 1));
  const other = officeFixturePerson(23);
  other.identity.companyName = departmentEvidence.otherCompany;
  const unknown = officeFixturePerson(24);
  unknown.identity.department = "Unknown Office";
  return [...people, other, unknown];
}
export async function publishDepartmentEvidenceOffice(database: pg.Pool, identity: SelectionIdentity,
  people = departmentEvidencePeople()) {
  await publishOfficeSource(database, "directory", people, identity.tenantId);
  await publishOfficeSource(database, "app_activity", people.map((person, index) =>
    officeFixtureActivity(index + 1, {
      upn_key: person.identity.objectId, ...(index === 23 ? { chat_date: officeFixtureDate } : { word_date: officeFixtureDate }),
    })), identity.tenantId);
}
export async function publishDepartmentEvidenceReports(database: pg.Pool, identity: SelectionIdentity,
  options: { correctionOfSetId?: string; extraUsers?: string[]; omitUsers?: boolean; reportDate?: string | null;
    microsoftAgents?: readonly string[] } = {}) {
  const date = options.reportDate === null ? "" : options.reportDate
    ?? new Date(Date.parse(`${officeFixtureDate}T00:00:00Z`) - departmentEvidence.reportWindowOffsetDays * 86400000).toISOString().slice(0, 10);
  const rows = {
    agents: departmentEvidence.agents.map((id, index) => `${id},Agent ${index + 1},${options.microsoftAgents?.includes(id) ? "Microsoft" : "Your org"},1,0,10,${date}`),
    userAgents: Array.from({ length: departmentEvidence.positive - 1 }, (_, index) =>
      `${departmentEvidence.agents[index % 3]},Agent ${index % 3 + 1},${options.microsoftAgents?.includes(departmentEvidence.agents[index % 3]) ? "Microsoft" : "Your org"},person-${index + 1}@example.invalid,10,${date}`),
    users: options.omitUsers ? [] : Array.from({ length: departmentEvidence.paid }, (_, index) =>
      `person-${index + 1}@example.invalid,Person ${index + 1},${index < departmentEvidence.positive ? 1 : 0},${index < departmentEvidence.positive ? 10 : 0},${index < departmentEvidence.positive ? date : ""}`),
  };
  rows.users.push(...options.extraUsers ?? []);
  const imports = new OfficialReportImports(database), bundleId = randomUUID();
  for (const kind of ["agents", "userAgents", "users"] as const) {
    await imports.stage(identity, { bundleId, ...(options.correctionOfSetId ? { correctionOfSetId: options.correctionOfSetId } : {}) },
      (async function* () { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows[kind].join("\n")}\n`); })());
  }
  return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
}
