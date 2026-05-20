import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, fleetsTable, shipsTable, shipModelsTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import {
  CreateFleetBody,
  GetFleetParams,
  DeleteFleetParams,
  ListFleetShipsParams,
  AddShipToFleetParams,
  AddShipToFleetBody,
  RemoveShipFromFleetParams,
  ListFleetsResponse,
  GetFleetResponse,
  ListFleetShipsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/fleets", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const fleets = await db.select().from(fleetsTable).where(eq(fleetsTable.ownerId, userId));

  const fleetsWithCounts = await Promise.all(
    fleets.map(async (fleet) => {
      const ships = await db.select().from(shipsTable).where(eq(shipsTable.fleetId, fleet.id));
      const models = await Promise.all(
        ships.map(async (ship) => {
          const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
          return model;
        })
      );
      const totalPoints = models.reduce((sum, m) => sum + (m?.pointCost ?? 0), 0);
      return { ...fleet, totalPoints, shipCount: ships.length };
    })
  );

  res.json(ListFleetsResponse.parse(fleetsWithCounts));
});

router.post("/fleets", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateFleetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [fleet] = await db.insert(fleetsTable).values({ ownerId: userId, name: parsed.data.name }).returning();
  const result = { ...fleet, totalPoints: 0, shipCount: 0 };
  res.status(201).json(GetFleetResponse.parse(result));
});

router.get("/fleets/:fleetId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, params.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  const ships = await db.select().from(shipsTable).where(eq(shipsTable.fleetId, fleet.id));
  const models = await Promise.all(
    ships.map(async (ship) => {
      const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
      return model;
    })
  );
  const totalPoints = models.reduce((sum, m) => sum + (m?.pointCost ?? 0), 0);
  res.json(GetFleetResponse.parse({ ...fleet, totalPoints, shipCount: ships.length }));
});

router.delete("/fleets/:fleetId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DeleteFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, params.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  await db.delete(shipsTable).where(eq(shipsTable.fleetId, params.data.fleetId));
  await db.delete(fleetsTable).where(eq(fleetsTable.id, params.data.fleetId));
  res.sendStatus(204);
});

router.get("/fleets/:fleetId/ships", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ListFleetShipsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, params.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  const ships = await db.select().from(shipsTable).where(eq(shipsTable.fleetId, params.data.fleetId));
  const result = await Promise.all(
    ships.map(async (ship) => {
      const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
      return { ...ship, shipModel: model };
    })
  );
  res.json(ListFleetShipsResponse.parse(result));
});

router.post("/fleets/:fleetId/ships", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = AddShipToFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = AddShipToFleetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, params.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, parsed.data.shipModelId));
  if (!model) {
    res.status(404).json({ error: "Ship model not found" });
    return;
  }
  const [ship] = await db.insert(shipsTable).values({ fleetId: params.data.fleetId, shipModelId: parsed.data.shipModelId, name: parsed.data.name }).returning();
  res.status(201).json({ ...ship, shipModel: model });
});

router.delete("/fleets/:fleetId/ships/:shipId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = RemoveShipFromFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, params.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  await db.delete(shipsTable).where(and(eq(shipsTable.id, params.data.shipId), eq(shipsTable.fleetId, params.data.fleetId)));
  res.sendStatus(204);
});

export default router;
