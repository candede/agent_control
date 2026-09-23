import { describe, expect, it } from "vitest";
import { getAgentDescription, getSanitizedDescriptionHtml } from "./agentDetails";

describe("agent detail presentation", () => {
  it("prefers rich descriptions and falls back through available agent metadata", () => {
    expect(getAgentDescription({ longDescription: "Full description", shortDescription: "Summary" }, "Native description")).toBe("Full description");
    expect(getAgentDescription({ longDescription: " ", shortDescription: "Summary" }, "Native description")).toBe("Native description");
    expect(getAgentDescription({ shortDescription: "Summary" })).toBe("Summary");
    expect(getAgentDescription({}, "Native description")).toBe("Native description");
    expect(getAgentDescription({})).toBe("No description provided.");
  });

  it("preserves useful markup without allowing active content", () => {
    const html = getSanitizedDescriptionHtml('<p>Useful <strong>agent description</strong></p><script>alert("test")</script><a href="javascript:alert(1)">Unsafe link</a><img src="x" onerror="alert(1)">');
    expect(html).toContain("<strong>agent description</strong>");
    expect(html).not.toMatch(/<script|javascript:|onerror/i);
    expect(getSanitizedDescriptionHtml("A plain description")).toBeUndefined();
  });

});
