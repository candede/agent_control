import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const permissionsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "permissions.css"), "utf8");

function stylesheetRules(condition?: string) {
  const style = document.createElement("style");
  style.textContent = permissionsCss;
  document.head.append(style);
  if (!style.sheet) throw new Error("Permissions stylesheet did not parse.");
  let rules = [...style.sheet.cssRules];
  if (condition) {
    const media = rules.find((rule): rule is CSSMediaRule =>
      rule instanceof CSSMediaRule && rule.conditionText === condition);
    if (!media) throw new Error(`Permissions stylesheet has no ${condition} rules.`);
    rules = [...media.cssRules];
  }
  return rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
}

function declaration(rules: CSSStyleRule[], selector: string, property: string) {
  const matches = rules.filter(rule => rule.selectorText.split(",").some(value => value.trim() === selector));
  const value = matches.map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1);
  if (value === undefined) throw new Error(`Missing ${property} for ${selector}`);
  return value;
}

describe("permission check progress styles", () => {
  it.each(["webkit", "moz"])("keeps the %s indeterminate fill transparent so it cannot cover the busy track", engine => {
    const selector = engine === "webkit"
      ? ".permission-progress progress:indeterminate::-webkit-progress-bar"
      : ".permission-progress progress:indeterminate::-moz-progress-bar";
    expect(declaration(stylesheetRules(), selector, "background")).toBe("transparent");
  });

  it("uses contrasting system colors for the forced-colors track, fill and pending dots", () => {
    const rules = stylesheetRules("(forced-colors: active)");
    for (const selector of [".permission-progress progress", ".permission-progress-dot"]) {
      expect(declaration(rules, selector, "forced-color-adjust")).toBe("none");
    }
    expect(declaration(rules, ".permission-progress progress", "border").toLowerCase()).toBe("1px solid canvastext");
    expect(declaration(rules, ".permission-progress progress", "color").toLowerCase()).toBe("canvastext");
    expect(declaration(rules, ".permission-progress progress", "background").toLowerCase()).toBe("canvas");
    expect(declaration(rules, ".permission-progress progress::-webkit-progress-bar", "background").toLowerCase()).toBe("canvas");
    for (const selector of [
      ".permission-progress progress::-webkit-progress-value",
      ".permission-progress progress::-moz-progress-bar",
      ".permission-progress-dot",
    ]) expect(declaration(rules, selector, "background").toLowerCase()).toBe("canvastext");
    expect(declaration(rules, ".permission-progress progress:indeterminate", "background-color").toLowerCase()).toBe("canvas");
    expect(declaration(rules, ".permission-progress progress:indeterminate", "background-image").toLowerCase())
      .toBe("linear-gradient(90deg, transparent 20%, currentcolor 50%, transparent 80%)");
    expect(declaration(rules, ".permission-progress progress:indeterminate", "background-size")).toBe("200% 100%");
  });

  it("keeps vendor-specific pseudo-elements in separate rules so an unsupported selector cannot discard both", () => {
    for (const rules of [stylesheetRules(), stylesheetRules("(forced-colors: active)")]) {
      for (const rule of rules) {
        expect(rule.selectorText.includes("::-webkit-") && rule.selectorText.includes("::-moz-")).toBe(false);
      }
    }
  });

  it("retains normal feedback and disables motion without hiding progress", () => {
    const normal = stylesheetRules();
    const reduced = stylesheetRules("(prefers-reduced-motion: reduce)");
    for (const [selector, animation] of [
      [".permission-spinner", "permission-spin 900ms linear infinite"],
      [".permission-progress-dot", "permission-pulse 1.4s ease-in-out infinite"],
      [".permission-progress progress:indeterminate", "permission-sweep 1.6s linear infinite"],
    ]) {
      expect(declaration(normal, selector, "animation")).toBe(animation);
      expect(declaration(reduced, selector, "animation")).toBe("none");
    }
    const fill = ".permission-progress progress::-webkit-progress-value";
    expect(declaration(normal, fill, "transition")).toBe("width 200ms ease");
    expect(declaration(reduced, fill, "transition")).toBe("none");
    expect(declaration(normal, ".permission-progress progress", "display")).toBe("block");
  });
});
