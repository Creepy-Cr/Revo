import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { allowedOrigins, attachOperator, originGuard } from "./lib/auth";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    logger.error({ err, url: req.url }, "Unhandled request error");
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ message: "Internal server error" });
  },
);

export default app;
