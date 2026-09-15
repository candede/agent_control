import { Router } from "express";
import type pg from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { CopilotUsageService } from "../services/copilotUsage.js";
import { policyRoute } from "./policy.js";

const maximumConcurrentSnapshots = 4;
const snapshotDeadlineMs = 45_000;
let activeSnapshots = 0;

export function createCopilotUsageRouter(database: pg.Pool = pool, service: Pick<CopilotUsageService, "users"> = new CopilotUsageService(database)) {
  const router = Router();
  policyRoute(router, "get", "/copilot-usage/users", {
    access: "authenticated",
    dataClass: "licensed_copilot_usage",
    roles: ["AgentControl.Viewer"],
  }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (Object.keys(request.query).length > 0) {
      throw new AppError(400, "invalid_copilot_usage_query", "The Copilot usage snapshot does not accept query parameters.");
    }
    if (activeSnapshots >= maximumConcurrentSnapshots) {
      throw new AppError(429, "copilot_usage_admission_full", "Too many Copilot usage snapshots are already loading; retry after one finishes.");
    }
    activeSnapshots += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new AppError(504, "copilot_usage_deadline", "The Copilot usage snapshot exceeded its deadline.")), snapshotDeadlineMs);
    timeout.unref();
    const disconnected = () => {
      if (!response.writableEnded && !controller.signal.aborted) {
        controller.abort(new AppError(499, "request_disconnected", "The Copilot usage request was disconnected."));
      }
    };
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    try {
      const result = await service.users(request.session.user!, controller.signal);
      controller.signal.throwIfAborted();
      response.json(result);
    } finally {
      clearTimeout(timeout);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      activeSnapshots -= 1;
    }
  });
  return router;
}
