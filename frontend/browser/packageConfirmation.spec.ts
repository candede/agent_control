import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { PackageMutationPreview } from "../src/api/client";
import { capabilityViews, layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { isPackageMutationRequest } from "./permissionFixtures";

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

for (const action of ["block", "unblock"] as const) {
  for (const scope of ["single", "inline", "bulk"] as const) {
    test(`${scope} ${action} confirmation is compact, accessible and cancels without a write`, async ({ page }, info) => {
      const unexpected = await mockLayoutApi(page);
      await page.clock.setFixedTime(new Date(layoutTime));
      const label = action === "block" ? "Block" : "Unblock";
      const selected = unifiedAgents.value[action === "block" ? 0 : 1];
      const packages = unifiedAgents.value.flatMap(record => record.packages);
      let previews = 0;
      let writes = 0;
      await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), route => route.fulfill({ json: {
        value: capabilityViews.map(view => view.definition.id === "graph.package.block.manage" ? {
          ...view,
          decision: { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
            verification: "on_demand", previewQualification: "not_required", remediation: [] },
        } : view),
      } }));
      await page.route(url => url.pathname.startsWith("/api/agents/"), route => {
        if (!isPackageMutationRequest(route.request().method(), new URL(route.request().url()).pathname)) return route.fallback();
        writes += 1;
        return route.fulfill({ status: 500 });
      });
      await page.route("**/api/agents/mutation-preview", route => {
        previews += 1;
        const input: { action: string; ids: string[]; mutationScope: string } = route.request().postDataJSON();
        expect(input.action).toBe(action);
        expect(input.mutationScope).toBe(scope === "bulk" ? "bulk" : "single");
        const targets = packages.filter(item => input.ids.includes(item.id));
        expect(targets).toHaveLength(scope === "bulk" ? 3 : 1);
        const preview: PackageMutationPreview = {
          confirmationHash: "a".repeat(64),
          summary: {
            risk: true, operation: action, provider: "Microsoft Graph",
            endpoint: `POST /beta/copilot/admin/catalog/packages/{id}/${action}`,
            apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All",
            actor: { id: "layout-principal", displayName: "Synthetic administrator", username: "admin@example.invalid" },
            scope: scope === "bulk" ? "bulk" : "single", targetCount: targets.length, affectedPrincipalCount: targets.length,
            rollback: "Possible through a separately confirmed inverse operation after provider readback.",
            targetSelectionHash: "b".repeat(64),
            targets: targets.map(item => ({
              id: item.id,
              displayName: scope === "bulk" && item.id === packages[2].id ? "LongPackageNameWithoutSpaces".repeat(5) : item.displayName,
              currentState: { kind: "block", isBlocked: item.isBlocked },
              requestedState: { kind: "block", isBlocked: action === "block" },
            })),
            additionalTargetCount: 0,
          },
        };
        return route.fulfill({ json: preview });
      });
      await page.goto("/agents");
      if (scope === "bulk") {
        for (const record of unifiedAgents.value) await page.getByRole("checkbox", { name: `Select ${record.displayName}`, exact: true }).check();
        await page.getByRole("button", { name: `${label} selected packages`, exact: true }).click();
      } else if (scope === "inline") {
        await page.getByRole("button", { name: `View details for ${selected.displayName}`, exact: true }).click();
        const detail = page.getByRole("dialog", { name: selected.displayName, exact: true });
        await detail.getByRole("tab", { name: "Manage", exact: true }).click();
        await detail.getByRole("button", { name: `${label} ${selected.displayName} (${selected.packages[0].id})`, exact: true }).click();
      } else {
        await page.getByRole("button", { name: `${label} ${selected.displayName}`, exact: true }).click();
      }

      const targetLabel = scope === "bulk" ? "3 packages" : "package";
      const dialog = page.getByRole(scope === "inline" ? "region" : "dialog", { name: `${label} ${targetLabel}?`, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: `${label} ${targetLabel}`, exact: true })).toBeEnabled();
      await expect(dialog.getByText("Uses a Microsoft Graph preview API.", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Delegated CopilotPackages.ReadWrite.All", { exact: true })).not.toBeVisible();
      await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
      await expect(dialog.getByRole("list", { name: "Package changes" }).getByRole("listitem")).toHaveCount(scope === "bulk" ? 3 : 1);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await dialog.locator(".block-confirm-targets").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (scope !== "inline") {
        const bounds = await dialog.boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(520);
        expect(bounds!.height).toBeLessThanOrEqual(scope === "bulk" ? 620 : 520);
      }
      expect((await new AxeBuilder({ page }).include(".block-confirmation").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await dialog.screenshot({ path: info.outputPath(`${scope}-${action}-confirmation.png`) });

      const details = dialog.getByText("Technical details", { exact: true });
      await details.click();
      await expect(dialog.getByText("Delegated CopilotPackages.ReadWrite.All", { exact: true })).toBeVisible();
      await expect(dialog.getByText("b".repeat(64), { exact: true })).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await details.click();
      if (scope === "single") {
        await details.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(dialog.getByRole("button", { name: `${label} package`, exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(details).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: `${label} ${selected.displayName}`, exact: true })).toBeFocused();
      } else {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await expect(dialog).not.toBeVisible();
      if (scope === "inline") await expect(page.getByRole("dialog", { name: selected.displayName, exact: true })).toBeVisible();
      expect(previews).toBe(1);
      expect(writes).toBe(0);
      expect(unexpected).toEqual([]);
    });
  }
}
