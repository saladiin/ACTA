import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { db, gameUnitsTable, shipModelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// Resolve the OBJ/GLB models directory robustly. Using `process.cwd()` alone is
// wrong because the working dir differs between environments: in development the
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

export const MODELS_DIR = resolveModelsDir();

// Supported 3D model extensions, in preference order. Used to recover when a
// ship_models row points at a file whose extension no longer matches the asset
// on disk (e.g. a model re-exported from .obj to .glb).
const MODEL_EXTS = [".glb", ".gltf", ".obj"] as const;

/**
 * Self-heal ship_models.filename rows whose recorded file is missing on disk.
 *
 * Why this exists: the production database is separate from development and its
 * rows are NOT copied on publish — only the schema is. When a model was
 * re-exported to a new format (e.g. omega.obj → omega.glb), dev was updated but
 * the production row kept the stale filename, so the live board requested a file
 * that 404'd and fell back to a placeholder box. The agent cannot write to the
 * production DB directly (it is read-only to tooling), so the running app repairs
 * its own reference catalog at startup.
 *
 * Safe + idempotent: it ONLY touches a row when the currently recorded file is
 * absent AND a file with the same base name but a different supported extension
 * exists. Once corrected the file exists, so subsequent runs are no-ops. It never
 * deletes rows or invents files, and a failure here must never crash startup.
 */
export async function reconcileModelFilenames(): Promise<void> {
  try {
    const replacementFor = (current: string): string | undefined => {
      if (!current) return undefined;
      if (fs.existsSync(path.join(MODELS_DIR, path.basename(current)))) return undefined;

      const base = path.basename(current, path.extname(current));
      return MODEL_EXTS.map((ext) => `${base}${ext}`).find((name) =>
        fs.existsSync(path.join(MODELS_DIR, name)),
      );
    };

    const models = await db.select().from(shipModelsTable);
    for (const model of models) {
      const current = model.filename;
      const replacement = replacementFor(current);
      if (!replacement || replacement === current) continue;

      await db
        .update(shipModelsTable)
        .set({ filename: replacement })
        .where(eq(shipModelsTable.id, model.id));
      logger.info(
        { shipModelId: model.id, from: current, to: replacement },
        "Repaired stale ship model filename",
      );
    }

    const units = await db.select().from(gameUnitsTable);
    for (const unit of units) {
      const current = unit.modelFilename;
      const replacement = replacementFor(current);
      if (!replacement || replacement === current) continue;

      await db
        .update(gameUnitsTable)
        .set({ modelFilename: replacement })
        .where(eq(gameUnitsTable.id, unit.id));
      logger.info(
        { gameUnitId: unit.id, gameId: unit.gameId, from: current, to: replacement },
        "Repaired stale game unit model filename",
      );
    }
  } catch (err) {
    logger.error({ err }, "reconcileModelFilenames failed (non-fatal)");
  }
}
