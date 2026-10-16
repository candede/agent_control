export type AttributionField = Readonly<{ value: string | null; evidence: "authenticated" | "reported" | "unknown" }>;
type OriginChannel = "webapp" | "mcp" | "unknown";
export type AuditOriginV1 = Readonly<{
  version: 1;
  channel: OriginChannel;
  integrationClientId: string | null;
  client: Readonly<{ id: AttributionField; name: AttributionField; version: AttributionField }>;
  callingAgent: Readonly<{ id: AttributionField; name: AttributionField }>;
  requestId: string | null;
  mcpCallId: string | null;
}>;
export type OriginFilters = {
  originChannel?: OriginChannel;
  originIntegrationClientId?: string;
  originClientId?: string;
  originCallingAgentId?: string;
};
const unknownField: AttributionField = Object.freeze({ value: null, evidence: "unknown" });
export const unknownOrigin: AuditOriginV1 = Object.freeze({
  version: 1, channel: "unknown", integrationClientId: null,
  client: Object.freeze({ id: unknownField, name: unknownField, version: unknownField }),
  callingAgent: Object.freeze({ id: unknownField, name: unknownField }), requestId: null, mcpCallId: null,
});
