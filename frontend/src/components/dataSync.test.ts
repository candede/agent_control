import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dataSyncCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dataSync.css"), "utf8");

function motionRules() {
  const style = document.createElement("style");
  style.textContent = dataSyncCss;
  document.head.append(style);
  if (!style.sheet) throw new Error("Sync stylesheet did not parse.");
  const rules = [...style.sheet.cssRules];
  const reducedMotion = rules.filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE)
    .find(rule => rule.conditionText === "(prefers-reduced-motion: reduce)");
  if (!reducedMotion) throw new Error("Sync stylesheet has no reduced-motion rules.");
  return {
    normal: rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE),
    reduced: [...reducedMotion.cssRules].filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE),
  };
}

function declaration(rules: CSSStyleRule[], selector: string, property: string) {
  const rule = rules.find(rule => rule.selectorText.split(",").some(value => value.trim() === selector));
  expect(rule, `Missing motion rule for ${selector}`).toBeDefined();
  return rule!.style.getPropertyValue(property);
}

describe("data sync motion styles", () => {
  it("disables progress width transitions even when waiting or stale details are not is-running", () => {
    const rules = motionRules();
    const progress = ".data-sync-progress progress::-webkit-progress-value";
    expect(declaration(rules.normal, progress, "transition")).toBe("width 300ms ease");
    expect(declaration(rules.reduced, progress, "transition")).toBe("none");
  });

  it.each([
    [".data-sync-spinning", "data-sync-spin 1s linear infinite"],
    [".data-sync-progress.is-running progress::-webkit-progress-value", "data-sync-working 1.5s linear infinite"],
  ])("disables %s animation without removing normal-preference feedback", (selector, animation) => {
    const rules = motionRules();
    expect(declaration(rules.normal, selector, "animation")).toBe(animation);
    expect(declaration(rules.reduced, selector, "animation")).toBe("none");
  });
});
