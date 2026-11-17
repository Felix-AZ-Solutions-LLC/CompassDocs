import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { backupReadStream, deleteBackup, isValidBackupFile, isValidBackupName } from "@/lib/backup";

export const dynamic = "force-dynamic";

// Download a backup file: the database dump, or (1.20.27) its uploads archive.
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await apiGuard("admin", "system.backup_download");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  if (!isValidBackupFile(name)) {
    return NextResponse.json({ error: "Invalid backup." }, { status: 400 });
  }
  const stream = backupReadStream(name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Opened before the audit row, so a missing file is a 404 and not a download on the record.
  const ready = await new Promise<boolean>((resolve) => {
    stream.once("open", () => resolve(true));
    stream.once("error", () => resolve(false));
  });
  if (!ready) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // 1.20.27 (security review M12): a backup is the whole workspace, so every download is on the record.
  await audit({ actor: actorFrom(gate), action: "backup.download", targetType: "backup", targetLabel: name, ip: ipFrom(req) });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

// Delete a backup set's local files. 1.20.27 (security review M12): off-site copies are never deleted from here.
export async function DELETE(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await apiGuard("admin", "system.backup_delete");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  if (!isValidBackupName(name)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const ok = await deleteBackup(name);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "backup.delete",
    targetType: "backup",
    targetLabel: name,
    details: { local_only: true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
