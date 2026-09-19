import { describe, expect, it } from "vitest";
import { extractConnectedServices, getAgentDescription, getSanitizedDescriptionHtml } from "./agentDetails";

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

  it("counts all detected references rather than silently capping the total at twenty", () => {
    const services = extractConnectedServices([{
      elementType: "AgentMetadatas",
      elements: [{ id: "metadata", definition: JSON.stringify({ connections: Array.from({ length: 35 }, (_, index) => ({ connectorId: `Service ${index}` })) }) }],
    }]);
    expect(services).toHaveLength(35);
    expect(services[34]).toEqual({ source: "Agent Metadatas metadata", value: "Service 34" });
  });

  it("retains provenance and distinguishes references repeated in different definitions", () => {
    expect(extractConnectedServices([{
      elementType: "AgentMetadatas",
      elements: [
        { id: "one", definition: '{"connectorId":"Shared service","serviceName":"Shared service"}' },
        { id: "two", definition: '{"connectorId":"Shared service"}' },
      ],
    }])).toEqual([
      { source: "Agent Metadatas one", value: "Shared service" },
      { source: "Agent Metadatas two", value: "Shared service" },
    ]);
  });

  it("tolerates non-JSON metadata and deeply nested definitions without recursive stack overflow", () => {
    const definition = '{"child":'.repeat(5000) + '{"connectorId":"Deep service"}' + "}".repeat(5000);
    const services = extractConnectedServices([{
      elementType: "AgentMetadatas",
      elements: [
        { id: "", definition: '{not JSON https://api.example.invalid/v1' },
        { id: "nested", definition },
      ],
    }]);
    expect(services.map(service => service.value)).toEqual(["api.example.invalid", "Deep service"]);
    expect(extractConnectedServices()).toEqual([]);
  });
});
