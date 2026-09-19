import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView, CopilotPackageDetail, PackageAccessUpdate, PackageRefreshJob } from "../src/api/client";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("edits access and installation and reviews blocking inside one agent modal", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const agent = unifiedAgents.value[0].packages[0];
  const principal = {
    resourceType: "group", resourceId: "11111111-2222-4333-8444-555555555555",
    displayName: "Support team", principalKind: "securityGroup",
  };
  let detail: CopilotPackageDetail = {
    ...agent, availableTo: "all", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
  };
  const views: CapabilityView[] = capabilityDefinitions.filter(definition =>
    ["graph.package.access.manage", "graph.package.block.manage", "graph.directory.read"].includes(definition.id),
  ).map(definition => ({
    definition,
    decision: {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: definition.probe.kind === "on_demand" ? "on_demand" : "provider",
      previewQualification: "not_required", remediation: [],
      ...(definition.probe.kind === "on_demand" ? {} : {
        checkedAt: layoutTime, expiresAt: "2026-10-12T10:00:00.000Z",
      }),
    },
  }));
  await page.route(/\/api\/capabilities(?:\/check)?$/, route => route.fulfill({ json: { value: views } }));
  await page.route(`**/api/agents/${agent.id}`, route => route.fulfill({ json: detail }));
  await page.route("**/api/directory/principals?*", route => route.fulfill({ json: { value: [principal] } }));
  await page.route("**/api/directory/principals/resolve", route => route.fulfill({ json: { value: [principal] } }));
  let freshReads = 0;
  const refresh: PackageRefreshJob = {
    id: "inline-exact-read", authorizationPrincipalId: "layout-principal", tokenMode: "delegated",
    scopeKind: "exact", requestedIds: [agent.id], status: "succeeded", pageCount: 1,
    observedCount: 1, totalRecords: 1, snapshotId: unifiedAgents.value[0].observations.graphPackages!.snapshotId,
    createdAt: layoutTime, attemptedAt: layoutTime, updatedAt: layoutTime, finishedAt: layoutTime,
  };
  await page.route(`**/api/agents/${agent.id}/refresh-jobs`, route => {
    expect(route.request().method()).toBe("POST");
    freshReads += 1;
    return route.fulfill({ json: refresh });
  });
  const previews: ({ action: string; ids: string[] } & Partial<PackageAccessUpdate>)[] = [];
  await page.route("**/api/agents/mutation-preview", route => {
    const request: typeof previews[number] = route.request().postDataJSON();
    previews.push(request);
    expect(request.ids).toEqual([agent.id]);
    return route.fulfill({ json: {
      confirmationHash: "a".repeat(64),
      summary: {
        risk: true, operation: request.action, provider: "Microsoft Graph", endpoint: "/copilot/admin/catalog/packages/{id}",
        apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All",
        actor: { id: "layout-principal", displayName: "Synthetic layout administrator", username: "layout.administrator@example.invalid" },
        scope: "single", targetCount: 1, affectedPrincipalCount: request.principals?.length ?? 0,
        rollback: "A separate confirmed change is required.", targetSelectionHash: "b".repeat(64),
        targets: [{
          id: agent.id, displayName: agent.displayName,
          currentState: { availableTo: detail.availableTo, deployedTo: detail.deployedTo, isBlocked: detail.isBlocked },
          requestedState: request.target ? { target: request.target, mode: request.mode, scope: request.scope, principals: request.principals } : { isBlocked: request.action === "block" },
        }],
        additionalTargetCount: 0,
      },
    } });
  });
  const writes: PackageAccessUpdate[] = [];
  await page.route(`**/api/agents/${agent.id}/access`, route => {
    expect(route.request().method()).toBe("PATCH");
    const update: PackageAccessUpdate & { confirmationHash: string } = route.request().postDataJSON();
    expect(update.confirmationHash).toBe("a".repeat(64));
    writes.push(update);
    detail = update.target === "availability"
      ? { ...detail, availableTo: update.scope === "none" ? "none" : "some", allowedUsersAndGroups: update.principals }
      : { ...detail, deployedTo: update.scope === "none" ? "none" : "some", acquireUsersAndGroups: update.principals };
    const result = {
      total: 1, succeeded: 1, failed: 0, skipped: 0, accessUpdate: update,
      results: [{ id: agent.id, displayName: agent.displayName, status: "succeeded" }],
    };
    return route.fulfill({ json: {
      id: `inline-update-${writes.length}`, action: `update-${update.target}`, accessUpdate: update,
      status: "succeeded", canResume: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0,
      results: result.results, result, createdAt: layoutTime, updatedAt: layoutTime, completedAt: layoutTime,
    } });
  });

  await page.goto("/agents");
  await page.getByRole("button", { name: `View details for ${agent.displayName}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: agent.displayName });
  await dialog.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /All users/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /All users/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /Manage access for|Manage installation for/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(freshReads).toBe(0);
  expect(writes).toEqual([]);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("inline-manage-availability.png") });

  for (const target of ["availability", "installation"] as const) {
    await dialog.getByRole("button", { name: target === "availability" ? /^Available to/ : /^Installed for/ }).click();
    const editor = dialog.getByRole("region", { name: target === "availability" ? "Availability settings" : "Installation settings" });
    await editor.getByRole("radio", { name: /Specific users or groups/ }).check();
    await editor.getByRole("searchbox").fill("Support");
    await editor.getByRole("button", { name: /Support team/ }).click();
    if (target === "availability") {
      await dialog.getByRole("button", { name: `Block ${agent.displayName} (${agent.id})` }).click();
      await expect(dialog.getByRole("region", { name: /block package/i })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(editor.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
      await expect(editor.getByText("Support team", { exact: true })).toBeVisible();
      expect(writes).toHaveLength(0);
    }
    const previousWrites = writes.length;
    await editor.getByRole("button", { name: "Apply", exact: true }).click();
    const confirmation = dialog.getByRole("region", { name: new RegExp(`update ${target} package`, "i") });
    await expect(confirmation).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(writes).toHaveLength(previousWrites);
    expect(previews.at(-1)).toMatchObject({
      action: `update-${target}`, ids: [agent.id],
      target, mode: "replace", scope: "specific", principals: [{ resourceType: "group", resourceId: principal.resourceId }],
    });
    expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath(`inline-${target}-confirmation.png`) });
    await confirmation.getByRole("button", { name: `Confirm update ${target}` }).click();
    await expect(editor.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
    await expect(editor.getByText("Support team", { exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    expect(writes).toHaveLength(previousWrites + 1);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: info.outputPath(`inline-${target}-saved.png`) });
  }
  expect(freshReads).toBe(2);
  expect(writes.map(update => update.target)).toEqual(["availability", "installation"]);
  expect(unexpected).toEqual([]);
});
