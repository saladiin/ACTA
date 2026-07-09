import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shipModelsRouter from "./shipModels";
import playersRouter from "./players";
import fleetsRouter from "./fleets";
import gamesRouter from "./games";
import lobbyRouter from "./lobby";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shipModelsRouter);
router.use(playersRouter);
router.use(fleetsRouter);
router.use(gamesRouter);
router.use(lobbyRouter);

export default router;
