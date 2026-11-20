import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { getAppSettings } from "@/lib/settings-store";
import { accentCss } from "@/lib/theme";
import { DARK_STYLE_COOKIE, DEFAULT_DARK_STYLE, darkStyleForPage, workspaceOnlyPath } from "@/lib/dark-style";
import { SESSION_COOKIE, requestDarkStylePref } from "@/lib/auth";
// Self-host the brand font (Aileron) so it renders offline / on-prem without
// reaching out to a font CDN. Weights: regular, semibold, bold.
import "@fontsource/aileron/400.css";
import "@fontsource/aileron/600.css";
import "@fontsource/aileron/700.css";
import "./globals.css";
import { TooltipPlacer } from "@/components/TooltipPlacer";

export async function generateMetadata(): Promise<Metadata> {
  // The title reflects the configured company name, but metadata is also
  // evaluated at build time (e.g. prerendering /_not-found) when no database is
  // available — fall back to the default name rather than failing the build.
  let companyName = "CompassDocs";
  try {
    companyName = (await getAppSettings()).company_name;
  } catch {
    // No DB reachable (build time / cold start) — keep the default.
  }
  const isDefault = companyName === "CompassDocs";
  return {
    // Page-specific text first, workspace last: "Users & roles — Acme". Every
    // page exports its own title (or generateMetadata); the default below is
    // only for a page that forgot (STYLEGUIDE §Page skeleton, "Document title").
    title: {
      default: isDefault ? "CompassDocs — Team Knowledge Platform" : `${companyName} — Knowledge Base`,
      template: `%s — ${companyName}`,
    },
    description:
      "Create, organize, and search SOPs, technical docs, policies, and internal knowledge with AI-powered search.",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: companyName, statusBarStyle: "default" },
  };
}

// Installable-app chrome: brand theme color and a sane mobile viewport.
export const viewport: Viewport = {
  themeColor: "#2e75bd",
  width: "device-width",
  initialScale: 1,
};

// Resolve the saved theme preference and stamp data-theme on <html> *before*
// first paint, so there's no light/dark flash on load. `system` follows the OS.
// The interface-scale preference is stamped the same way (data-ui-scale) so a
// Large/Larger page never flashes at the default size. The dark style
// (data-dark-style) needs no script: the server renders it on <html>.
const THEME_INIT = `
(function(){try{
  var p = localStorage.getItem('compass-theme') || 'system';
  var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var s = localStorage.getItem('compass-ui-scale');
  if (s && s !== 'default') document.documentElement.setAttribute('data-ui-scale', s);
}catch(e){}})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The dark style (1.20.35, lib/dark-style) is decided here, on the server,
  // and stamped on <html> with the theme script's data-theme beside it, so
  // the first paint is already in it: the signed-in account's own choice
  // (one read, whatever cookie the browser holds: a single sign-on, a shared
  // browser), else this browser's compass-dark-style cookie, else the
  // workspace default; the portal, the help centre, the public site and
  // sign-in pages take the workspace default whoever looks. Request data is
  // read before the settings (outside their try): it marks the page dynamic.
  const path = (await headers()).get("x-compass-path") ?? "";
  const jar = await cookies();
  const cookiePref = jar.get(DARK_STYLE_COOKIE)?.value;
  const sessionToken = jar.get(SESSION_COOKIE)?.value;
  // Custom workspace accent: derive the palette override server-side. Like
  // generateMetadata above, tolerate a missing database (build time).
  let accent = "";
  let darkStyle = DEFAULT_DARK_STYLE;
  try {
    const settings = await getAppSettings();
    accent = accentCss(settings.accent_color);
    const personPref = workspaceOnlyPath(path) ? undefined : await requestDarkStylePref(sessionToken, cookiePref);
    darkStyle = darkStyleForPage(path, personPref, settings.dark_style);
  } catch {
    /* no DB (build/prerender) — default palette from globals.css applies */
    darkStyle = darkStyleForPage(path, cookiePref, DEFAULT_DARK_STYLE);
  }
  return (
    <html lang="en" data-dark-style={darkStyle} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {accent && <style id="workspace-accent">{accent}</style>}
      </head>
      <body>
        {children}
        {/* Keeps every data-tt tooltip inside the viewport and its pane (1.20.2; STYLEGUIDE §Tooltips). */}
        <TooltipPlacer />
      </body>
    </html>
  );
}
