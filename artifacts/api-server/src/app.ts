import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { allowedOrigins, attachOperator, originGuard } from "./lib/auth";
import { logger } from "./lib/logger";

const app: Express = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? "256kb";

// Behind a reverse proxy: trust the first hop so req.ip reflects the real
// client address (used by the per-client rate limits on LLM routes).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
// Restricted CORS: only origins from APP_ORIGINS may make credentialed
// browser requests. Requests without an
// Origin header (same-origin navigations, curl) pass through - cookie-bearing
// mutations are additionally checked by originGuard below.
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || allowedOrigins().includes(origin));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: "64kb", parameterLimit: 200 }));

// CSRF defense-in-depth, then session resolution, for every /api route.
app.use(originGuard);
app.use(attachOperator);

app.use("/api", router);

// Centralized error handler: log the failure and return a structured 500
// instead of leaking stack traces or hanging the request.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    logger.error({ err, url: req.url.split("?")[0] }, "Unhandled request error");
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === "object" && err !== null && "status" in err && err.status === 413 ? 413 : 500;
    res.status(status).json({
      message: status === 413 ? "Request body is too large" : "Internal server error",
    });
  },
);

export default app;
