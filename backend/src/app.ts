import express from "express";
import session from "express-session";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { config, authConfigured } from "./config.js";
import { pool } from "./db/pool.js";
import { createSessionStore } from "./db/sessions.js";
import { migrations, verifySchema } from "./db/schema.js";
import { AppError, errorHandler } from "./errors.js";
import { apiAdmission } from "./middleware/admission.js";
import { agentsRouter } from "./routes/agents.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { capabilitiesRouter } from "./routes/capabilities.js";
import { copilotStudioQuarantineRouter } from "./routes/copilotStudioQuarantine.js";
import { defenderHuntingRouter } from "./routes/defenderHunting.js";
import { inventoryRouter } from "./routes/inventory.js";
import { createOfficialUsageRouter } from "./routes/officialUsage.js";
import { purviewAuditRouter } from "./routes/purviewAudit.js";
import { workbenchRouter } from "./routes/workbench.js";
import { policyRoute } from "./routes/policy.js";
import { maintenanceActive } from "./services/maintenance.js";
import { providerWorkEnabled, readOperationalState } from "./services/operationalState.js";
import { httpTelemetry } from "./services/telemetry.js";
import "./types/session.js";

export function createApp(database: pg.Pool = pool, staticDirectory = fileURLToPath(new URL("../../frontend/dist/", import.meta.url))) {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.setHeader("X-Request-ID", response.locals.requestId);
    next();
  });
  if (config.nodeEnv !== "test") app.use(httpTelemetry);
  app.use(helmet({
    strictTransportSecurity: config.frontendOrigin.startsWith("https://") ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], connectSrc: ["'self'"], fontSrc: ["'self'"],
      formAction: ["'self'"], frameAncestors: ["'none'"], imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      "upgrade-insecure-requests": config.frontendOrigin.startsWith("https://") ? [] : null,
    } },
  }));
  app.use((_request, response, next) => {
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
  });
  app.use((request, _response, next) => {
    try {
      const pathname = decodeURIComponent(request.originalUrl.split("?")[0]);
      if (pathname.includes("\\") || pathname.split("/").includes("..") || pathname.includes("\0")) throw new AppError(400,"invalid_path","Invalid request path.");
      next();
    } catch { next(new AppError(400,"invalid_path","Invalid request path.")); }
  });
  policyRoute(app, "get", "/api/health", { access: "public", dataClass: "public" }, (_request, response) => response.json({ ok: true }));
  policyRoute(app, "get", "/api/ready", { access: "public", dataClass: "public" }, async (_request, response) => {
    try {
      await verifySchema(database);
      const state = await readOperationalState(database);
      if (maintenanceActive() || state.mode !== "normal") throw new Error("Maintenance is active.");
      response.json({ ok: true });
    }
    catch { response.status(503).json({ ok: false }); }
  });
  policyRoute(app, "get", "/api/auth/status", { access: "public", dataClass: "identity" }, (_request, response) => response.json({ authConfigured, callback: config.redirectUri,
    setup: authConfigured ? undefined : "Configure tenant/client IDs and the client secret, and register the displayed callback in Entra." }));
  app.use(express.json({ limit: "512kb" }));
  const store = createSessionStore(database, config.tenantId ?? "unconfigured");
  app.use(session({ name: "agent-control.sid", store, secret: config.sessionSecret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: config.frontendOrigin.startsWith("https://"), maxAge: 8*60*60*1000 } }));
  app.use("/api", apiAdmission);
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    if (!["GET","HEAD","OPTIONS"].includes(request.method) && request.get("Origin") !== config.frontendOrigin) return next(new AppError(403,"invalid_origin","A same-origin request is required. Open the configured public URL and ensure the tunnel/reverse proxy preserves the browser Origin header. For an existing Dev Tunnel port, use devtunnel port update with --origin-header unchanged; host flags alone may not update the port. This is a connection configuration issue, not a missing permission.", {
      expectedOrigin: config.frontendOrigin,
      receivedOrigin: request.get("Origin") ?? null,
    }));
    next();
  });
  policyRoute(app, "get", "/api/diagnostics", { access: "authenticated", dataClass: "operational_metadata", roles: ["AgentControl.Admin"] }, async (_request, response) => {
    const state = await readOperationalState(database);
    response.json({
      authConfigured,
      maintenance: maintenanceActive() || state.mode !== "normal",
      providerWorkEnabled: providerWorkEnabled() && state.providerWorkEnabled,
      schemaVersion: migrations.length,
      limits: { databasePool: 4, requestBodyBytes: 524_288, exportDeadlineSeconds: 15 },
    });
  });
  app.use("/api", authRouter, capabilitiesRouter, workbenchRouter, inventoryRouter, copilotStudioQuarantineRouter, createOfficialUsageRouter(database), purviewAuditRouter, defenderHuntingRouter, auditRouter, agentsRouter);
  app.use("/api", (_request, _response, next) => next(new AppError(404, "not_found", "API route not found.")));
  app.use("/assets", express.static(`${staticDirectory}/assets`, { immutable: true, maxAge: "1y", fallthrough: false, dotfiles: "deny" }));
  app.use(express.static(staticDirectory, { index: false, maxAge: 0, dotfiles: "deny", setHeaders: response => response.setHeader("Cache-Control", "no-store") }));
  policyRoute(app, "get", "/{*path}", { access: "public", dataClass: "public" }, (request, response, next) => {
    if (request.path.split("/").some(part => part.startsWith(".")) || /\.[^/]+$/.test(request.path)) return next(new AppError(404, "not_found", "Asset not found."));
    response.setHeader("Cache-Control","no-store");
    response.sendFile(`${staticDirectory}/index.html`, error => { if (error) next(error); });
  });
  app.use(errorHandler);
  return { app, store };
}