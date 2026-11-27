import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { actorFrom, ipFrom } from "@/lib/audit";
import { ExportError, listWorkspaceExports, MAX_PER_DAY, startWorkspaceExport, workspaceExportAvailable, EXPORT_TTL_MS } from "@/lib/workspace-export";
import { requireJson, supportJson } from "@/lib/support-http";

export const dynamic = "force-dynamic";

// 1.21.4: workspace exports (lib/workspace-export), CompassDocs Cloud only.
// Who may export the workspace (system.export: Administrators) lists and
// starts them; a support session never reaches this route
// (lib/support-policy).

async function gate() {
  if (!workspaceExportAvailable()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const g = await apiGuard("admin", "system.export");
  if (g instanceof NextResponse) return g;
  if (g.support) return supportJson({ error: "Not available in a support session.", code: "support_not_allowed" }, 403);
  return g;
}

export async function GET() {
  const g = await gate();
  if (g instanceof NextResponse) return g;
  return supportJson({ exports: await listWorkspaceExports(), limits: { per_day: MAX_PER_DAY, keep_days: EXPORT_TTL_MS / 86_400_000 } });
}

export async function POST(req: Request) {
  const g = await gate();
  if (g instanceof NextResponse) return g;
  const body = await requireJson(req);
  if (body instanceof NextResponse) return body;
  try {
    const row = await startWorkspaceExport(actorFrom(g), ipFrom(req));
    return supportJson({ export: row }, 202);
  } catch (e) {
    if (e instanceof ExportError) return supportJson({ error: e.message, code: e.code }, e.status);
    throw e;
  }
}
