import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { APP_BUILD_SHA } from "../lib/build-version";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/version", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ buildSha: APP_BUILD_SHA });
});

export default router;
