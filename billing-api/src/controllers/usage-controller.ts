// Controller: HTTP <-> BillingService (usage recording).
import type { Request, Response } from "express";
import type { BillingService } from "../services/billing-service.ts";
import { addUsageRequest } from "../validation/validators.ts";

export class UsageController {
  private billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  /** POST /api/v1/usage (admin) - Add Usage */
  addUsage = async (req: Request, res: Response) => {
    res.status(201).json(await this.billing.addUsage(addUsageRequest(req.body ?? {})));
  };
}
