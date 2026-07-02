import type { RequestHandler } from "express";
import { AppError } from "../errors.js";

export const requireSession: RequestHandler = (request, _response, next) => {
  if (!request.session.accountId || !request.session.user) {
    next(AppError.unauthorized());
    return;
  }

  next();
};
