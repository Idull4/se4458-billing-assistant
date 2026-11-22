// HTTP client for the Billing REST API. Every call goes through the API Gateway (GATEWAY_URL).

export interface ApiResult {
  ok: boolean;
  status: number;
  body: any;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GatewayClient {
  baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  private async request(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. gateway HTML) */ }
    return { ok: res.ok, status: res.status, body };
  }

  login(subscriberNo: string, password: string) {
    return this.request("POST", "/api/v1/auth/login", { body: { subscriberNo, password } });
  }

  queryBill(subscriberNo: string, month: number, year: number) {
    const q = new URLSearchParams({ subscriberNo, month: String(month), year: String(year) });
    return this.request("GET", `/api/v1/bills?${q}`);
  }

  queryBillDetailed(token: string, month: number, year: number, page = 1, pageSize = 10) {
    const q = new URLSearchParams({ month: String(month), year: String(year), page: String(page), pageSize: String(pageSize) });
    return this.request("GET", `/api/v1/bills/detailed?${q}`, { token });
  }

  payBill(token: string, body: { month: number; year: number; amount: number; transactionId: string }) {
    return this.request("POST", "/api/v1/bills/pay", { token, body });
  }
}
