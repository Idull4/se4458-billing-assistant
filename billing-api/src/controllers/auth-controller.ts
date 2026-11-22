// Controller: HTTP <-> AuthService.
import type { Request, Response } from "express";
import type { AuthService } from "../services/auth-service.ts";
import { loginRequest } from "../validation/validators.ts";

export class AuthController {
  private auth: AuthService;

  constructor(auth: AuthService) {
    this.auth = auth;
  }

  /** POST /api/v1/auth/login */
  login = async (req: Request, res: Response) => {
    const { subscriberNo, password } = loginRequest(req.body ?? {});
    res.json(await this.auth.login(subscriberNo, password));
  };
}
