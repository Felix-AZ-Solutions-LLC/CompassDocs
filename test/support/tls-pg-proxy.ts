// A PostgreSQL front that speaks SSL (1.21.3, test/db-entra.test.ts): it
// answers the client's SSLRequest with 'S', terminates TLS with a throwaway
// self-signed certificate for 127.0.0.1 / localhost, and passes the plain
// protocol on to the real database. The suite's Postgres (CI's service
// container, a developer's local one) has no SSL of its own; Azure's
// flexible server always does, and DATABASE_AUTH=entra refuses to sign in
// without it, so the tests go through this.
//
// A client that starts without asking for SSL is counted and cut off: the
// tests assert it never happens. GSSAPI encryption requests (libpq asks
// first when built with it) are declined with 'N', as a server without it
// does.
//
// The certificate is made with the openssl command (present on CI's runner
// and on developer machines); makeCertificate() returns null without it, and
// the tests that need it skip with a reason.

import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

export interface TestCertificate {
  /** PEM certificate (also its own CA: pass it as sslrootcert / ca). */
  cert: string;
  key: string;
  /** The certificate's file, for a URL's sslrootcert. */
  certFile: string;
  dir: string;
}

/** A self-signed EC certificate for 127.0.0.1 and localhost, valid two days; null without openssl. */
export function makeCertificate(): TestCertificate | null {
  const dir = mkdtempSync(path.join(tmpdir(), "entra-pg-tls-"));
  const certFile = path.join(dir, "server.crt");
  const keyFile = path.join(dir, "server.key");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" }
    );
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), certFile, dir };
}

export class TlsPgProxy {
  port = 0;
  /** Connections that negotiated TLS. */
  tlsSessions = 0;
  /** Connections that started without asking for SSL (cut off). */
  plaintextAttempts = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly target: { host: string; port: number },
    private readonly certificate: TestCertificate
  ) {}

  async listen(): Promise<void> {
    this.server = net.createServer((s) => this.handle(s));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  private track(s: net.Socket): void {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
    s.on("error", () => {});
  }

  private handle(client: net.Socket): void {
    this.track(client);
    const first = (chunk: Buffer) => {
      const code = chunk.length >= 8 ? chunk.readUInt32BE(4) : 0;
      if (code === GSSENC_REQUEST) {
        client.write("N");
        client.once("data", first);
        return;
      }
      if (code !== SSL_REQUEST) {
        this.plaintextAttempts++;
        client.destroy();
        return;
      }
      client.write("S");
      const secure = new tls.TLSSocket(client, { isServer: true, cert: this.certificate.cert, key: this.certificate.key });
      this.track(secure);
      secure.once("secure", () => {
        this.tlsSessions++;
        const upstream = net.connect(this.target.port, this.target.host);
        this.track(upstream);
        secure.pipe(upstream);
        upstream.pipe(secure);
        upstream.on("close", () => secure.destroy());
        secure.on("close", () => upstream.destroy());
      });
    };
    client.once("data", first);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
