import cors from "cors";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import { config, authConfigured } from "./config.js";
import { errorHandler } from "./errors.js";
import { auditRouter } from "./routes/audit.js";
import { agentsRouter } from "./routes/agents.js";
import { authRouter } from "./routes/auth.js";
import "./types/session.js";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
  }),
);
app.use(express.json());
app.use(
  session({
    name: "agent-control.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, authConfigured });
});

app.use(authRouter);
app.use("/api", auditRouter);
app.use("/api", agentsRouter);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(
    `Agent Control backend listening on http://localhost:${config.port}`,
  );
  if (!authConfigured) {
    console.warn(
      "Set TENANT_ID, CLIENT_ID, and CLIENT_SECRET in .env to enable sign-in.",
    );
  }
});
