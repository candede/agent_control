import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dataSyncCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dataSync.css"), "utf8");

function stylesheetRules() {
  const style = document.createElement("style");
  style.textContent = dataSyncCss;
  document.head.append(style);
  if (!style.sheet) throw new Error("Sync stylesheet did not parse.");
  return [...style.sheet.cssRules];
}

function mediaRules(rules: CSSRule[], condition: string) {
  const media = rules.filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE)
    .find(rule => rule.conditionText === condition);
  if (!media) throw new Error(`Sync stylesheet has no ${condition} rules.`);
  return [...media.cssRules].filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
}

function motionRules() {
  const rules = stylesheetRules();
  return {
    normal: rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE),
    reduced: mediaRules(rules, "(prefers-reduced-motion: reduce)"),
  };
}

function declaration(rules: CSSStyleRule[], selector: string, property: string) {
  const rule = rules.find(rule => rule.selectorText.split(",").some(value => value.trim() === selector));
  expect(rule, `Missing style rule for ${selector}`).toBeDefined();
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

describe("sync history responsive styles", () => {
  it("fits the outcome filter in a narrow header instead of retaining its nowrap intrinsic width", () => {
    const rules = mediaRules(stylesheetRules(), "(max-width: 600px)");
    expect(declaration(rules, ".sync-history-controls", "width")).toBe("100%");
    expect(declaration(rules, ".sync-history-controls", "justify-content")).toBe("flex-start");
    expect(declaration(rules, ".sync-history-filter", "display")).toBe("grid");
    expect(declaration(rules, ".sync-history-filter", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(declaration(rules, ".sync-history-filter", "width")).toBe("100%");
    expect(declaration(rules, ".sync-history-filter", "white-space")).toBe("normal");
    expect(declaration(rules, ".sync-history-filter select", "width")).toBe("100%");
  });

  it("lets the history refresh label wrap when inherited text is enlarged on a narrow screen", () => {
    const rules = mediaRules(stylesheetRules(), "(max-width: 600px)");
    expect(declaration(rules, ".sync-history-controls > button", "white-space")).toBe("normal");
  });

  it("preserves desktop inline controls and confines wide history rows to the table scroller", () => {
    const rules = stylesheetRules().filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    expect(declaration(rules, ".sync-history-controls", "display")).toBe("flex");
    expect(declaration(rules, ".sync-history-controls", "flex-wrap")).toBe("wrap");
    expect(declaration(rules, ".sync-history-controls > button", "white-space")).toBe("nowrap");
    expect(declaration(rules, ".sync-history-filter", "display")).toBe("flex");
    expect(declaration(rules, ".sync-history-filter", "white-space")).toBe("nowrap");
    expect(declaration(rules, ".sync-history-filter select", "width")).toBe("auto");
    expect(declaration(rules, ".sync-table-scroll", "overflow-x")).toBe("auto");
    expect(declaration(rules, ".sync-history-table", "min-width")).toBe("760px");
  });
});
