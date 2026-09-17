import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CopilotPackageDetail } from "../api/client";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { AgentDetailModal } from "./AgentDetailModal";

describe("AgentDetailModal metadata contract", () => {
  it.each(["metadata-one", ""])("retains complete definition details with outer element label %j without rendering raw JSON", elementId => {
    const definition = JSON.stringify({
      notes: "x".repeat(32_768),
      SourceIds: { EnvironmentId: "11111111-1111-4111-8111-111111111111", SchemaName: "native-schema" },
      connectorId: "Exact connector",
      endpoint: "https://api.example.invalid/v1",
    });
    const agent: CopilotPackageDetail = {
      id: "package-one", displayName: "Saved package", isBlocked: false,
      sourceSystem: "graph_packages", authoringTool: "Copilot Studio", creatorType: "unknown",
      agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: elementId, definition }] }],
    };
    render(<WorkbenchActionProvider value={[]}>
      <AgentDetailModal
        agent={agent} activeTab="package" roles={["AgentControl.Viewer"]}
        onClose={vi.fn()} onUpdateAccess={vi.fn().mockResolvedValue(undefined)}
      />
    </WorkbenchActionProvider>);

    expect(definition.length).toBeGreaterThan(32_768);
    expect(screen.getByRole("heading", { name: "Connected services" })).toBeVisible();
    expect(screen.getByText("Exact connector")).toBeVisible();
    expect(screen.getByText("Exact connector").parentElement).toHaveTextContent(elementId || "Agent Metadatas");
    expect(screen.getByText("api.example.invalid")).toBeVisible();
    expect(screen.getByText("native-schema")).toBeVisible();
    expect(screen.queryByText(definition)).not.toBeInTheDocument();
  });

  it("does not discard id-only custom-engine definitions with empty outer labels", () => {
    const applicationId = "55555555-5555-4555-8555-555555555555";
    const agent: CopilotPackageDetail = {
      id: "opaque/engine%package", displayName: "Custom engine package", isBlocked: false,
      sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown",
      agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
      elementDetails: [
        { elementType: "Bots", elements: [{ id: "", definition: JSON.stringify({ botId: applicationId, endpoint: "https://bot.example.invalid" }) }] },
        { elementType: "CustomEngineCopilots", elements: [{ id: "", definition: JSON.stringify({ type: "bot", id: applicationId, connectorId: "Engine connector" }) }] },
      ],
    };
    render(<WorkbenchActionProvider value={[]}>
      <AgentDetailModal
        agent={agent} activeTab="package" roles={["AgentControl.Viewer"]}
        onClose={vi.fn()} onUpdateAccess={vi.fn().mockResolvedValue(undefined)}
      />
    </WorkbenchActionProvider>);
    expect(screen.getByText("2 groups, 2 elements")).toBeVisible();
    expect(screen.getByText("bot.example.invalid")).toBeVisible();
    expect(screen.getByText("Engine connector")).toBeVisible();
  });
});
