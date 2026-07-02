import { Router } from "express";
import { acquireGraphToken } from "../auth/msal.js";
import { requireSession } from "../middleware/auth.js";
import {
  bulkSetBlockedState,
  GraphPackagesClient,
} from "../services/graphPackages.js";

export const agentsRouter = Router();
const graphPackages = new GraphPackagesClient();

agentsRouter.use(requireSession);

agentsRouter.get("/agents", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agents = await graphPackages.listCopilotAgents(accessToken);
    response.json({ value: agents });
  } catch (error) {
    next(error);
  }
});

agentsRouter.get("/agents/:id", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agent = await graphPackages.getPackageDetails(
      accessToken,
      request.params.id,
    );
    response.json(agent);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/block-all", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const result = await bulkSetBlockedState(graphPackages, accessToken, true);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/unblock-all", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const result = await bulkSetBlockedState(graphPackages, accessToken, false);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/:id/block", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    await graphPackages.blockPackage(accessToken, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/:id/unblock", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    await graphPackages.unblockPackage(accessToken, request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
