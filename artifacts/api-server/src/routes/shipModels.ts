import { Router, type IRouter } from "express";
import { db, shipModelsTable, weaponsTable } from "@workspace/db";
import { ListShipModelsResponse } from "@workspace/api-zod";
import path from "path";
import fs from "fs";
import { MODELS_DIR, TEXTURES_DIR } from "../lib/models";

const router: IRouter = Router();

router.get("/ship-models", async (req, res): Promise<void> => {
  const models = await db.select().from(shipModelsTable).orderBy(shipModelsTable.name);
  const allWeapons = await db.select().from(weaponsTable);
  const byModel: Record<number, typeof allWeapons> = {};
  for (const w of allWeapons) {
    if (!byModel[w.shipModelId]) byModel[w.shipModelId] = [];
    byModel[w.shipModelId].push(w);
  }
  const result = models.map(m => ({ ...m, weapons: byModel[m.id] ?? [] }));
  res.json(ListShipModelsResponse.parse(result));
});

router.get("/models/:filename", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const filename = path.basename(raw);
  const filePath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Model file not found" });
    return;
  }
  if (typeof req.query.v === "string" && req.query.v.length > 0) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.set("Cache-Control", "public, max-age=3600");
  }
  res.sendFile(filePath);
});

router.get("/textures/:filename", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const filename = path.basename(raw);
  const filePath = path.join(TEXTURES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Texture file not found" });
    return;
  }
  if (typeof req.query.v === "string" && req.query.v.length > 0) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.set("Cache-Control", "public, max-age=3600");
  }
  res.sendFile(filePath);
});

export default router;
