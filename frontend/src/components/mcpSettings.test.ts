import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const mcpSettingsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "mcpSettings.css"), "utf8");

it("allows unbroken advertised tool names and titles to wrap", () => {
  const style = document.createElement("style");
  style.textContent = mcpSettingsCss;
  document.head.append(style);
  const settings = document.createElement("section");
  settings.className = "mcp-settings";
  const toolName = document.createElement("div");
  toolName.className = "mcp-tool-name";
  const heading = document.createElement("h5");
  heading.textContent = "unbroken_advertised_tool_name_".repeat(100);
  toolName.append(heading);
  settings.append(toolName);
  document.body.append(settings);

  expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
});
