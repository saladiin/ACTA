import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shipModelsRouter from "./shipModels";
import playersRouter from "./players";
import fleetsRouter from "./fleets";
import gamesRouter from "./games";
import lobbyRouter from "./lobby";
import adminRouter from "./admin";
import campaignsRouter from "./campaigns";
import presenceRouter from "./presence";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shipModelsRouter);
router.use(playersRouter);
router.use(fleetsRouter);
router.use(gamesRouter);
router.use(lobbyRouter);
if (process.env.NODE_ENV !== "production") {
  router.use(campaignsRouter);
}
router.use(presenceRouter);
router.use(adminRouter);

export default router;
