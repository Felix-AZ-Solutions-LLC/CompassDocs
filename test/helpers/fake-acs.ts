// A fake Azure Communication Services Email endpoint (1.21.5) for the tests
// of lib/mail-acs and the outbox's ACS path. Loopback only; nothing here
// contacts Azure.
//
//   POST /emails:send?api-version=2023-03-31
//        checks the credential (a Bearer token equal to `token`, or the
//        HMAC-SHA256 signature over the method, path, date, host and body
//        hash with `accessKey`, as ACS does), records the request and its
//        Operation-Id, answers 202 { id, status: "Running" } with
//        Operation-Location and retry-after.
//   GET  /emails/operations/{id}?api-version=2023-03-31
//        404 for an unknown id; else `outcome(op)` (default: Succeeded).
//
// `sendQueue` / `statusQueue`: answers to give instead, in order, one per
// request ({ status, headers, body }, or "drop": the request is read, the
// operation recorded, and the connection cut with no answer).

import http from "node:http";
import { createHash, createHmac } from "node:crypto";

export interface FakeAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface FakeOp {
  id: string;
  polls: number;
  request: FakeRequest;
}

export interface FakeAcs {
  base: string;
  requests: FakeRequest[];
  sends: () => FakeRequest[];
  ops: Map<string, FakeOp>;
  /** When set, POST and GET need `Authorization: Bearer <token>`. */
  token: string | null;
  /** When set, POST and GET need an HMAC signature with this (base64) key. */
  accessKey: string | null;
  sendQueue: (FakeAnswer | "drop")[];
  statusQueue: (FakeAnswer | "drop")[];
  outcome: (op: FakeOp) => { status: string; error?: { code: string; message: string } };
  /** The retry-after (seconds) on a 202. */
  retryAfter: string;
  reset(): void;
  close(): Promise<void>;
}

function authOk(fake: FakeAcs, req: http.IncomingMessage, body: string): boolean {
  const auth = String(req.headers.authorization ?? "");
  if (fake.token !== null) return auth === `Bearer ${fake.token}`;
  if (fake.accessKey !== null) {
    const date = String(req.headers["x-ms-date"] ?? "");
    const hash = String(req.headers["x-ms-content-sha256"] ?? "");
    if (hash !== createHash("sha256").update(body, "utf8").digest("base64")) return false;
    const toSign = `${req.method}\n${req.url}\n${date};${req.headers.host};${hash}`;
    const sig = createHmac("sha256", Buffer.from(fake.accessKey, "base64")).update(toSign, "utf8").digest("base64");
    return auth === `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}`;
  }
  return true;
}

export async function startFakeAcs(): Promise<FakeAcs> {
  const fake: FakeAcs = {
    base: "",
    requests: [],
    sends: () => fake.requests.filter((r) => r.method === "POST"),
    ops: new Map(),
    token: null,
    accessKey: null,
    sendQueue: [],
    statusQueue: [],
    outcome: () => ({ status: "Succeeded" }),
    retryAfter: "1",
    reset() {
      fake.requests.length = 0;
      fake.ops.clear();
      fake.sendQueue.length = 0;
      fake.statusQueue.length = 0;
      fake.outcome = () => ({ status: "Succeeded" });
      fake.retryAfter = "1";
    },
    close: async () => {},
  };
  const answer = (res: http.ServerResponse, a: FakeAnswer) => {
    res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) });
    res.end(a.body === undefined ? "" : JSON.stringify(a.body));
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      const rec: FakeRequest = { method: req.method ?? "", path: url.pathname, headers: req.headers, body, json };
      fake.requests.push(rec);
      if (url.searchParams.get("api-version") !== "2023-03-31") return answer(res, { status: 400, body: { error: { code: "InvalidApiVersion", message: "api-version" } } });
      if (!authOk(fake, req, body)) return answer(res, { status: 401, body: { error: { code: "Denied", message: "Denied by the resource provider." } } });
      if (req.method === "POST" && url.pathname === "/emails:send") {
        const id = String(req.headers["operation-id"] ?? "");
        const next = fake.sendQueue.shift();
        if (next === "drop") {
          fake.ops.set(id, { id, polls: 0, request: rec });
          req.socket.destroy();
          return;
        }
        if (next) return answer(res, next);
        fake.ops.set(id, { id, polls: 0, request: rec });
        return answer(res, {
          status: 202,
          headers: { "operation-location": `${fake.base}/emails/operations/${id}?api-version=2023-03-31`, "retry-after": fake.retryAfter },
          body: { id, status: "Running" },
        });
      }
      const m = url.pathname.match(/^\/emails\/operations\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const next = fake.statusQueue.shift();
        if (next === "drop") {
          req.socket.destroy();
          return;
        }
        if (next) return answer(res, next);
        const op = fake.ops.get(decodeURIComponent(m[1]));
        if (!op) return answer(res, { status: 404, body: { error: { code: "NotFound", message: "Operation not found." } } });
        op.polls++;
        const o = fake.outcome(op);
        return answer(res, { status: 200, headers: { "retry-after": "1" }, body: { id: op.id, status: o.status, ...(o.error ? { error: o.error } : {}) } });
      }
      answer(res, { status: 404, body: { error: { code: "NotFound", message: "No such route." } } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  fake.base = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return fake;
}
