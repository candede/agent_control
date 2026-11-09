import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(join(directory, "App.css"), "utf8");
const themeCss = readFileSync(join(directory, "index.css"), "utf8");

function stylesheetRules(css: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  if (!style.sheet) throw new Error("App stylesheet did not parse.");
  return [...style.sheet.cssRules].filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
}

function declaration(rules: CSSStyleRule[], selector: string, property: string) {
  const rule = rules.find(rule => rule.selectorText === selector
    || rule.selectorText.split(",").some(value => value.trim() === selector));
  if (!rule) throw new Error(`Missing style rule for ${selector}`);
  return rule.style.getPropertyValue(property);
}

function luminance(color: string) {
  const parsed = document.createElement("span").style;
  parsed.color = color;
  const components = parsed.color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!components) throw new Error(`Unsupported contrast color: ${color}`);
  const channels = components.slice(1).map(value => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe("app keyboard focus contrast", () => {
  it.each([
    ".signed-out :is(button, a):focus-visible",
    "input:focus-visible",
    "select:focus-visible",
    "textarea:focus-visible",
    "button.audit-result-button:focus-visible",
  ])("keeps the %s outline distinguishable from surrounding surfaces", selector => {
    const app = stylesheetRules(appCss);
    const theme = stylesheetRules(themeCss);
    const outline = declaration(app, selector, "outline");
    expect(outline).toMatch(/^3px solid /);
    const token = outline.slice("3px solid ".length);
    const variable = token.match(/^var\((--[\w-]+)\)$/)?.[1];
    const foreground = luminance(variable ? declaration(theme, ":root", variable) : token);
    const backgrounds = [
      declaration(theme, ":root", "--surface"),
      declaration(theme, ":root", "--bg"),
      declaration(app, ".selected-row td", "background"),
    ];
    for (const background of backgrounds) {
      const adjacent = luminance(background);
      const contrast = (Math.max(foreground, adjacent) + 0.05) / (Math.min(foreground, adjacent) + 0.05);
      expect(contrast, `${selector} against ${background}`).toBeGreaterThanOrEqual(3);
    }
  });
});
