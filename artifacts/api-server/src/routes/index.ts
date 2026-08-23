import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import testerRouter from "./tester";
import browserAutoRouter from "./browser-auto";
import browserAgentRouter from "./browser-agent";
import keysRouter from "./keys";
import billingRouter from "./billing";
import couponsRouter from "./coupons";
import stagehandAgentRouter from "./stagehand-agent";
import queryfirstRouter from "./queryfirst";
import fieldserveRouter from "./fieldserve";
import fieldserveDashboardRouter from "./fieldserve-dashboard";
import fieldserveAiRouter from "./fieldserve-ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/tester", testerRouter);
router.use("/browser-auto", browserAutoRouter);
router.use("/browser-agent", browserAgentRouter);
router.use("/stagehand-agent", stagehandAgentRouter);
router.use("/keys", keysRouter);
router.use("/billing", billingRouter);
router.use("/tester/coupons", couponsRouter);
router.use("/queryfirst", queryfirstRouter);
router.use("/fieldserve", fieldserveRouter);
router.use("/fieldserve", fieldserveDashboardRouter);
router.use("/fieldserve/ai", fieldserveAiRouter);

export default router;
