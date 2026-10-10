import { describe, expect, it } from "vitest";
import { getAdoptionDescriptionPreview, getAgentDescription, getSanitizedDescriptionHtml } from "./agentDetails";

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

  it("converts About markup to readable plain text without active content", () => {
    expect(getAdoptionDescriptionPreview('<p>Finds <strong>HR policies</strong> &amp; guidance.</p><p>Helps colleagues.<br>Answers questions.</p><script>alert(1)</script>'))
      .toBe("Finds HR policies & guidance. Helps colleagues. Answers questions.");
    expect(getAdoptionDescriptionPreview(null)).toBe("");
    expect(getAdoptionDescriptionPreview(" \n ")).toBe("");
    expect(getAdoptionDescriptionPreview("<img src=x onerror=alert(1)>")).toBe("");
  });

  it("keeps short and exactly 300-character descriptions without an ellipsis", () => {
    expect(getAdoptionDescriptionPreview("Helps HR colleagues.")).toBe("Helps HR colleagues.");
    expect(getAdoptionDescriptionPreview("a".repeat(300))).toBe("a".repeat(300));
  });

  it("caps previews at 300 characters including the ellipsis and ends at a word boundary", () => {
    const preview = getAdoptionDescriptionPreview("Useful guidance ".repeat(30));
    expect(Array.from(preview).length).toBeLessThanOrEqual(300);
    expect(preview).toBe(`${"Useful guidance ".repeat(18)}Useful…`);
    expect(getAdoptionDescriptionPreview(`${"a".repeat(299)} more details`)).toBe(`${"a".repeat(299)}…`);
  });

  it("caps unbroken text without splitting Unicode characters", () => {
    const preview = getAdoptionDescriptionPreview("😀".repeat(301));
    expect(Array.from(preview)).toHaveLength(300);
    expect(preview).toBe(`${"😀".repeat(299)}…`);
  });

});
