import { Router, type IRouter } from "express";
import { db, shipModelsTable } from "@workspace/db";
import { ListShipModelsResponse } from "@workspace/api-zod";
import path from "path";
import fs from "fs";

const router: IRouter = Router();

router.get("/ship-models", async (req, res): Promise<void> => {
  const models = await db.select().from(shipModelsTable).orderBy(shipModelsTable.name);
  res.json(ListShipModelsResponse.parse(models));
});

router.get("/models/:filename", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const filename = path.basename(raw);
  const modelsDir = path.resolve(process.cwd(), "public", "models");
  const filePath = path.join(modelsDir, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Model file not found" });
    return;
  }
  res.sendFile(filePath);
});

export default router;
