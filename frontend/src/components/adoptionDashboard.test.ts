import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "adoptionDashboard.css"), "utf8");

function gridColumns(className: string, width: number) {
  const style = document.createElement("style");
  style.textContent = dashboardCss;
  document.head.append(style);
  if (!style.sheet) throw new Error("Dashboard stylesheet did not parse.");
  const element = document.createElement("div");
  element.className = className;
  let columns = "";
  function visit(rules: CSSRuleList) {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        const maximum = rule.conditionText.match(/^\(max-width:\s*(\d+)px\)$/);
        if (maximum && width <= Number(maximum[1])) visit(rule.cssRules);
      } else if (rule instanceof CSSStyleRule) {
        const value = rule.style.getPropertyValue("grid-template-columns");
        // These container selectors have equal specificity; the last active rule wins.
        if (value && rule.selectorText.split(",").some(selector => element.matches(selector.trim()))) columns = value;
      }
    }
  }
  visit(style.sheet.cssRules);
  return columns;
}

describe("dashboard grid cascade", () => {
  it.each([320, 500, 501, 600, 760, 761, 1150, 1440])("reflows Office participation at %spx without changing agent cards", width => {
    expect(gridColumns("dashboard-insight-cards office-overview-cards", width))
      .toBe(width <= 760 ? "minmax(0, 1fr)" : "repeat(3, minmax(0, 1fr))");
    expect(gridColumns("dashboard-insight-cards", width))
      .toBe(width <= 500 ? "minmax(0, 1fr)" : "repeat(3, minmax(0, 1fr))");
  });

  it.each([320, 500, 501, 760, 761, 1150, 1151, 1440])("preserves the overview and trend breakpoints at %spx", width => {
    expect(gridColumns("dashboard-overview-grid", width))
      .toBe(width <= 1150 ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))");
    expect(gridColumns("dashboard-trend-tiles", width))
      .toBe(width <= 500 ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))");
    expect(gridColumns("office-trend-grid", width))
      .toBe(width <= 760 ? "minmax(0, 1fr)" : width <= 1150 ? "repeat(2, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))");
  });
});
