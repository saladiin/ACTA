import { Router, type IRouter } from "express";
import { db, shipModelsTable, weaponsTable } from "@workspace/db";
import { ListShipModelsResponse } from "@workspace/api-zod";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();

// Resolve the OBJ/GLB models directory robustly. The previous implementation
// used `process.cwd()`, which differs between environments: in development the
// process runs from the package dir (artifacts/api-server) so `public/models`
// resolved, but in production the app launches as `node
// artifacts/api-server/dist/index.mjs` from the REPO ROOT, so `public/models`
// pointed at <root>/public/models — which doesn't exist, and every model 404'd
// (the board fell back to placeholder boxes). Resolving relative to the bundle
// location (import.meta.url → dist/) makes it correct regardless of cwd; we
// also keep cwd-based fallbacks so it works whether running bundled or not.
function resolveModelsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "public", "models"),
    path.resolve(process.cwd(), "public", "models"),
    path.resolve(process.cwd(), "artifacts", "api-server", "public", "models"),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}
const MODELS_DIR = resolveModelsDir();

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
  res.sendFile(filePath);
});

export default router;
