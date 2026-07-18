import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import testerRouter from "./tester";
import keysRouter from "./keys";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/tester", testerRouter);
router.use("/keys", keysRouter);
router.use("/billing", billingRouter);

export default router;
