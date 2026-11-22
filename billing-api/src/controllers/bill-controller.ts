// Controller: HTTP <-> BillingService (bills and payments).
// Controllers only translate HTTP to validated service calls; business rules live in the service layer.
import type { Request, Response } from "express";
import { resolveSubscriber, type AuthedRequest } from "../middleware/auth.ts";
import type { BillingService } from "../services/billing-service.ts";
import { detailedRequest, payRequest, periodRequest } from "../validation/validators.ts";

export class BillController {
  private billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  /** POST /api/v1/bills/calculate (admin) - Calculate Bill */
  calculate = async (req: Request, res: Response) => {
    res.json(await this.billing.calculate(periodRequest(req.body ?? {})));
  };

  /** GET /api/v1/bills (public per specification) - Query Bill */
  query = async (req: Request, res: Response) => {
    res.json(await this.billing.queryBill(periodRequest(req.query as Record<string, unknown>)));
  };

  /** GET /api/v1/bills/detailed (authenticated, paged) - Query Bill Detailed */
  queryDetailed = async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const subscriberNo = resolveSubscriber((req as AuthedRequest).principal!, query.subscriberNo);
    res.json(await this.billing.queryBillDetailed({ subscriberNo, ...detailedRequest(query) }));
  };

  /** POST /api/v1/bills/pay (authenticated) - Pay Bill */
  pay = async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const subscriberNo = resolveSubscriber((req as AuthedRequest).principal!, body.subscriberNo);
    res.json(await this.billing.pay({ subscriberNo, ...payRequest(body) }));
  };
}
