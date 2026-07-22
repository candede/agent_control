import { Router, type Request } from "express";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import {
  createLoginUrl,
  createState,
  redeemAuthorizationCode,
  toAuthenticatedUser,
} from "../auth/msal.js";

export const authRouter = Router();

authRouter.get("/auth/login", async (request, response, next) => {
  try {
    const state = createState();
    request.session.authState = state;
    const loginUrl = await createLoginUrl(state);
    response.redirect(loginUrl);
  } catch (error) {
    next(error);
  }
});

authRouter.get("/auth/callback", async (request, response, next) => {
  try {
    const {
      code,
      state,
      error,
      error_description: errorDescription,
    } = request.query;

    if (typeof error === "string") {
      throw new AppError(
        401,
        "entra_sign_in_failed",
        errorDescription?.toString() ?? error,
      );
    }

    if (typeof code !== "string" || typeof state !== "string") {
      throw new AppError(
        400,
        "invalid_auth_callback",
        "The sign-in callback was missing code or state.",
      );
    }

    if (!request.session.authState || request.session.authState !== state) {
      throw new AppError(
        400,
        "invalid_auth_state",
        "The sign-in state did not match this session.",
      );
    }

    const result = await redeemAuthorizationCode(code);
    const user = toAuthenticatedUser(result);

    await regenerateSession(request);
    request.session.accountId = user.homeAccountId;
    request.session.user = user;
    delete request.session.authState;

    response.redirect(config.frontendOrigin);
  } catch (error) {
    next(error);
  }
});

authRouter.post("/auth/logout", (request, response, next) => {
  request.session.destroy((error) => {
    if (error) {
      next(error);
      return;
    }

    response.clearCookie("agent-control.sid");
    response.status(204).end();
  });
});

authRouter.get("/me", (request, response) => {
  if (!request.session.user) {
    response.status(401).json({
      error: { code: "unauthorized", message: "Sign in is required" },
    });
    return;
  }

  response.json({ user: request.session.user });
});

function regenerateSession(request: Request) {
  return new Promise<void>((resolve, reject) => {
    request.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
