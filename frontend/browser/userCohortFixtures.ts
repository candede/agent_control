import { buildOfficialUsageUserView } from "../../backend/src/services/officialUsageViews";
import type { PublishedOfficialUsage } from "../../backend/src/types/officialUsage";
import { reportLicenseDirectory as savedReportLicenseDirectory, usageFixtureNow, usageInsightsPublished } from "../src/test/usageInsightsFixture";

type UserViewOptions = Parameters<typeof buildOfficialUsageUserView>[1];
type LicenseDirectory = NonNullable<UserViewOptions["licenseDirectory"]>;

export const activeWithoutPaidPublished = structuredClone(usageInsightsPublished);
for (const [username, displayName] of [["ada@example.invalid", "Emery"], ["cleo@example.invalid", "Finley"]]) {
  const report = activeWithoutPaidPublished.reports.users!;
  const original = report.rows.find(user => user.username === username)!;
  const unpaidUsername = `${displayName.toLowerCase()}@example.invalid`;
  report.rows.push({ ...original, username: unpaidUsername, displayName });
  const bridge = activeWithoutPaidPublished.reports.userAgents!;
  bridge.rows.push(...bridge.rows.filter(row => row.username === username).map(row => ({ ...row, username: unpaidUsername })));
}
for (const report of Object.values(activeWithoutPaidPublished.reports)) report.lineage.rowCount = report.rows.length;

export function reportLicenseDirectory(published = activeWithoutPaidPublished): LicenseDirectory {
  return savedReportLicenseDirectory(published, ["ada@example.invalid", "ben@example.invalid", "cleo@example.invalid"]);
}

export function activeWithoutPaidUsersFixture(
  query: UserViewOptions = { staleAfterDays: 35 },
  published: PublishedOfficialUsage = activeWithoutPaidPublished,
  directory = reportLicenseDirectory(published),
) {
  return buildOfficialUsageUserView(published, {
    now: usageFixtureNow, ...query, licenseCohort: "active_without_paid", licenseDirectory: directory,
  });
}
