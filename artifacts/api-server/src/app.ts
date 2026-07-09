import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import fs from "node:fs";
import path from "node:path";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

function corsOrigin() {
  const raw = process.env.B5_ALLOWED_ORIGINS ?? "";
  const allowed = raw.split(/[\s,;]+/g).map((v) => v.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}

function findWebDist(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "artifacts", "b5acta", "dist", "public"),
    path.resolve(process.cwd(), "..", "b5acta", "dist", "public"),
    path.resolve(process.cwd(), "dist", "public"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? null;
}

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

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: corsOrigin() }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

if (process.env.B5_SERVE_WEB === "true" || process.env.NODE_ENV === "production") {
  const webDist = findWebDist();
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
    logger.info({ webDist }, "Serving built web client");
  } else {
    logger.warn("B5 web client dist not found; API-only mode");
  }
}

export default app;
