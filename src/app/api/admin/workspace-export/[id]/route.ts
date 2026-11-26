import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { apiGuard } from "@/lib/api-auth";
import { actorFrom, ipFrom } from "@/lib/audit";
import { deleteWorkspaceExport, ExportError, getWorkspaceExport, openWorkspaceExport, parseRange, workspaceExportAvailable } from "@/lib/workspace-export";
import { NO_STORE, supportJson } from "@/lib/support-http";

export const dynamic = "force-dynamic";

// 1.21.4: download a workspace export (lib/workspace-export), or delete it.
// The archive is only ever served from here, to someone holding
// system.export, never by a public or signed URL. A single byte range is
// honoured so a large download can resume.

async function gate() {
  if (!workspaceExportAvailable()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const g = await apiGuard("admin", "system.export");
  if (g instanceof NextResponse) return g;
  if (g.support) return supportJson({ error: "Not available in a support session.", code: "support_not_allowed" }, 403);
  return g;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // A download another site starts (a link or a redirect there: SameSite=Lax lets the cookie through) is refused.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return supportJson({ error: "Download the export from Settings → Import & export.", code: "cross_site" }, 403);
  const g = await gate();
  if (g instanceof NextResponse) return g;
  const { id } = await params;
  const row = await getWorkspaceExport(id);
  const size = row?.size ?? 0;
  const range = row?.status === "ready" ? parseRange(req.headers.get("range"), size) : null;
  if (range === "unsatisfiable") return new NextResponse(null, { status: 416, headers: { ...NO_STORE, "Content-Range": `bytes */${size}` } });
  try {
    const { row: r, stream } = await openWorkspaceExport(id, actorFrom(g), ipFrom(req), range ?? undefined);
    const headers: Record<string, string> = {
      ...NO_STORE,
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="${r.file_name ?? "compassdocs-export.tar"}"`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(range ? range.end - range.start + 1 : r.size ?? 0),
      ...(r.sha256 ? { "X-Content-SHA256": r.sha256 } : {}),
    };
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${r.size}`;
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (e) {
    if (e instanceof ExportError) return supportJson({ error: e.message, code: e.code }, e.status);
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (g instanceof NextResponse) return g;
  const { id } = await params;
  try {
    await deleteWorkspaceExport(id, actorFrom(g), ipFrom(req));
    return supportJson({ ok: true });
  } catch (e) {
    if (e instanceof ExportError) return supportJson({ error: e.message, code: e.code }, e.status);
    throw e;
  }
}
