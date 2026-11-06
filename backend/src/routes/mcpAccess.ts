import { Router } from "express";
import { AppError, errorTelemetry } from "../errors.js";
import { requestAuthenticatedAt, requestUser } from "../middleware/requestAuthentication.js";
import { mcpAccessProfile } from "../services/mcpAccess.js";
import { dataSync, type DataSyncService } from "../services/dataSync.js";
import { operationalLog } from "../services/telemetry.js";
import { policyRoute } from "./policy.js";

export function createMcpAccessRouter(sync: Pick<DataSyncService, "authenticatedEntry"> = dataSync) {
  const router = Router();
  policyRoute(router, "get", "/mcp/access-profile", { access: "authenticated", dataClass: "access_profile" }, (request, response) => {
    if (Object.keys(request.query).length) throw new AppError(400, "invalid_request", "Access profiles do not accept options or subjects.");
    response.setHeader("Cache-Control", "no-store");
    response.json(mcpAccessProfile());
  });
  policyRoute(router, "post", "/mcp/authenticated-entry", { access: "authenticated", dataClass: "identity", csrf: true }, async (request, response) => {
    if (Object.keys(request.query).length || request.body !== undefined && (!request.body || typeof request.body !== "object"
      || Array.isArray(request.body) || Object.keys(request.body).length)) {
      throw new AppError(400, "invalid_request", "Authenticated entry does not accept collection options or subjects.");
    }
    response.setHeader("Cache-Control", "no-store");
    try {
      const admitted = await sync.authenticatedEntry(requestUser(request), requestAuthenticatedAt(request));
      response.status(202).json({ admission: admitted ? "scheduled" : "current", nextCheckAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    } catch (error) {
      if (!(error instanceof AppError) || ![429, 502, 503, 504].includes(error.status)) throw error;
      operationalLog("warn", "authenticated_entry_admission_failed", errorTelemetry(error));
      response.status(202).json({ admission: "retryable", errorCode: error.code, nextCheckAt: new Date(Date.now() + 60_000).toISOString() });
    }
  });
  return router;
}
