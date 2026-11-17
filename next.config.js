const path = require("path");

/** 1.20.8: the policy of an email's original ("View original"); the same string as lib/helpdesk/email-html originalHeaders. */
function originalCsp(remoteImages) {
  return [
    "default-src 'none'",
    `img-src data:${remoteImages ? " https:" : ""}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");
}

/** 1.20.9: the print view of an original (?print=1): the same, never framed, printable (lib/helpdesk/email-html-print originalPrintCsp). */
function originalPrintCsp(remoteImages) {
  return originalCsp(remoteImages)
    .split("; ")
    .map((d) => (d.startsWith("frame-ancestors ") ? "frame-ancestors 'none'" : d.startsWith("sandbox ") ? `${d} allow-modals` : d))
    .join("; ");
}

/**
 * 1.20.11: the desk conversation's in-place variant (?inline=1): the same, its sandbox adding allow-same-origin
 * (no allow-scripts) so the desk can size the frame (lib/helpdesk/email-html originalInlineCsp says why it is safe).
 */
function originalInlineCsp(remoteImages) {
  return originalCsp(remoteImages).replace("sandbox allow-popups", "sandbox allow-same-origin allow-popups");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone) for small Docker images and
  // easy deploys on Railway / Render / Fly. Vercel ignores this and works too.
  output: "standalone",
  // 1.20.6: an image build may leave the type check to a separate step
  // (COMPASSDOCS_BUILD_SKIP_TYPECHECK=1, see the Dockerfile). The check is
  // the build's memory peak, and on a 7 GB build machine it took the machine
  // down. Whoever sets this must run `npx tsc --noEmit` themselves, as the
  // enterprise image build does. Unset, the build checks types as always.
  typescript: { ignoreBuildErrors: process.env.COMPASSDOCS_BUILD_SKIP_TYPECHECK === "1" },
  // Keep the Postgres driver out of the server bundle (it has optional native
  // deps and dynamic requires); load it from node_modules at runtime. The PDF
  // renderer likewise: it carries its own font and image decoders that do not
  // survive bundling. DOMPurify (1.20.8) is required by the email sanitiser's
  // worker from node_modules, so the build's file tracing must ship it there.
  serverExternalPackages: ["pg", "@react-pdf/renderer", "dompurify"],
  // 1.20.8: the "View original" sanitiser runs in a worker thread loaded by its path
  // (lib/helpdesk/email-html-sanitize workerFile), never bundled: ship the file to the
  // standalone folder. jsdom (external by default) and dompurify (above) come from its node_modules.
  outputFileTracingIncludes: {
    "/api/helpdesk/messages/**": ["./src/lib/helpdesk/email-html-worker.cjs"],
  },
  async headers() {
    // Baseline hardening on every response. HSTS is a no-op over plain HTTP
    // (browsers ignore it), so it's safe to send unconditionally.
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // 1.20.27 (security review, Low): at least ASVS 14.4.5's 15724800 s (182 days); a year. No
      // includeSubDomains: the workspace cannot speak for its sibling hosts.
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    // Content-Security-Policy. Two disjoint rules — /addin/* must stay frameable
    // by Outlook and load Office.js, everything else is locked to 'self'. A
    // browser enforces the INTERSECTION of duplicate CSP headers, so these are
    // kept separate rather than merged.
    //
    // script-src keeps 'unsafe-inline' because the app ships a few inline
    // scripts (pre-paint theme init) and has no nonce middleware yet; the real
    // XSS fix is escaping user content at the sink. What this policy *does* add
    // over the previous frame-ancestors-only header: default-src 'self' (no
    // external script/object loads) and connect-src 'self' (blocks XHR/fetch/
    // WebSocket exfiltration to attacker hosts) — meaningful blast-radius
    // reduction. img-src/frame-src allow https: for user-embedded images and
    // video/site embeds.
    const commonCsp =
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'";
    const mainCsp =
      "script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; " +
      "frame-src 'self' https:; " +
      "frame-ancestors 'self'; " +
      commonCsp;
    // The Outlook task pane loads Office.js from Microsoft and is framed by
    // Outlook's webviews.
    const office = "https://appsforoffice.microsoft.com https://*.office.com";
    const addinCsp =
      `script-src 'self' 'unsafe-inline' ${office}; ` +
      `connect-src 'self' ${office}; ` +
      "frame-src 'self' https:; " +
      "frame-ancestors 'self' https://outlook.office.com https://outlook.office365.com " +
      "https://outlook.live.com https://*.office.com; " +
      commonCsp;
    // The OAuth consent page's Approve form POSTs to /api/oauth/approve, which
    // answers with a redirect to the client's registered redirect_uri (Claude,
    // or a loopback address for local MCP clients). Chromium enforces
    // form-action against that redirect chain, so 'self' alone silently blocks
    // the Approve click. Registration only accepts https or loopback redirect
    // URIs, so allow exactly those here — and only on this page.
    const authorizeCsp = mainCsp.replace(
      "form-action 'self'",
      "form-action 'self' https: http://localhost:* http://127.0.0.1:*"
    );
    return [
      {
        source: "/addin/:path*",
        headers: [...base, { key: "Content-Security-Policy", value: addinCsp }],
      },
      {
        source: "/((?!addin).*)",
        headers: [...base, { key: "Content-Security-Policy", value: mainCsp }],
      },
      // 1.20.18 (the reply pop-out's security review): the desk keeps any window it opens away from other
      // sites. A desk page that opens a same-origin desk window (the reply pop-out, the print page) keeps its
      // handle on it; once such a window goes to another site, neither side can reach the other.
      {
        source: "/desk",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }],
      },
      {
        source: "/desk/:path*",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }],
      },
      // Last so its Content-Security-Policy overrides the general rule above.
      {
        source: "/oauth/authorize",
        headers: [...base, { key: "Content-Security-Policy", value: authorizeCsp }],
      },
      // 1.20.8: an inbound email's original (lib/helpdesk/email-html originalHeaders, which the
      // route also sets and test/helpdesk-email-html checks against these): a sandboxed document
      // that loads pictures only (https ones only with ?images=1), runs nothing, sends no referrer.
      // Config headers win over a route's own, so they are stated here, after the general rule.
      {
        source: "/api/helpdesk/messages/:id/original",
        headers: [
          { key: "Content-Security-Policy", value: originalCsp(false) },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/api/helpdesk/messages/:id/original",
        has: [{ type: "query", key: "images", value: "1" }],
        headers: [{ key: "Content-Security-Policy", value: originalCsp(true) }],
      },
      // 1.20.11: the desk conversation's in-place variant (?inline=1, with or without images=1); before the
      // print rules (inline beside print is refused with 400 anyway).
      {
        source: "/api/helpdesk/messages/:id/original",
        has: [{ type: "query", key: "inline", value: "1" }],
        headers: [{ key: "Content-Security-Policy", value: originalInlineCsp(false) }],
      },
      {
        source: "/api/helpdesk/messages/:id/original",
        has: [
          { type: "query", key: "inline", value: "1" },
          { type: "query", key: "images", value: "1" },
        ],
        headers: [{ key: "Content-Security-Policy", value: originalInlineCsp(true) }],
      },
      // 1.20.9: the print view (?print=1, with or without images=1) has a policy of its own; last, so it wins.
      {
        source: "/api/helpdesk/messages/:id/original",
        has: [{ type: "query", key: "print", value: "1" }],
        headers: [
          { key: "Content-Security-Policy", value: originalPrintCsp(false) },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/api/helpdesk/messages/:id/original",
        has: [
          { type: "query", key: "print", value: "1" },
          { type: "query", key: "images", value: "1" },
        ],
        headers: [{ key: "Content-Security-Policy", value: originalPrintCsp(true) }],
      },
    ];
  },
  // Open-core edition switch. `@ee` resolves to the community stub by default,
  // or to an overlaid `./ee` package when COMPASSDOCS_EE=1 (the enterprise
  // build). Core imports `@ee` only through src/lib/ee.ts. Declared for both
  // bundlers: Turbopack builds (the Next 16 default) read `turbopack`, and a
  // `next build --webpack` fallback still works via the webpack hook.
  turbopack: {
    // Turbopack aliases are project-root-relative strings (absolute paths get
    // "./" prepended and break), unlike the webpack hook's absolute paths.
    resolveAlias: {
      "@ee": process.env.COMPASSDOCS_EE === "1" ? "./ee" : "./src/ee-stub",
    },
  },
  webpack(config) {
    config.resolve.alias["@ee"] =
      process.env.COMPASSDOCS_EE === "1"
        ? path.resolve(__dirname, "ee")
        : path.resolve(__dirname, "src/ee-stub");
    return config;
  },
};

module.exports = nextConfig;
