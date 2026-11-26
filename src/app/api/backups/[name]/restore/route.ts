import { NextResponse } from "next/server";
import { apiGuard, cloudRefusal } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { restoreBackup, isValidBackupName, RestoreError } from "@/lib/backup";

export const dynamic = "force-dynamic";

// Restore the workspace from a backup set. DESTRUCTIVE — replaces all data.
// Since 1.20.27 the set's uploads come back too, and the audit log keeps its
// rows newer than the backup (lib/backup restoreBackup).
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  // 1.21.0: CompassDocs Cloud manages this (lib/cloud); 403 in cloud mode.
  const cloud = cloudRefusal("backups");
  if (cloud) return cloud;
  const gate = await apiGuard("admin", "system.backup_restore");
  if (gate instanceof NextResponse) return gate;
  const { name } = await params;
  if (!isValidBackupName(name)) {
    return NextResponse.json({ error: "Invalid backup." }, { status: 400 });
  }
  try {
    const r = await restoreBackup(name);
    // Recorded after the restore so the entry lands in the restored database.
    await audit({
      actor: actorFrom(gate),
      action: "backup.restore",
      targetType: "backup",
      targetLabel: name,
      details: { files_restored: r.files, audit_rows_kept: r.audit_rows_kept, ...(r.audit_rows_saved_in ? { audit_rows_saved_in: r.audit_rows_saved_in } : {}) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    // 1.20.27 (second review, Low): say which half failed and what had already been done (lib/backup RestoreError).
    const stage = e instanceof RestoreError ? e.stage : undefined;
    await audit({
      actor: actorFrom(gate),
      action: "backup.restore_failed",
      targetType: "backup",
      targetLabel: name,
      details: { stage: stage ?? "unknown", files_restored: e instanceof RestoreError ? e.files : null },
      ip: ipFrom(req),
    });
    return NextResponse.json(
      { error: `Restore failed. ${e?.message || "pg_restore error"}`, ...(stage ? { stage, files_restored: e.files } : {}) },
      { status: 500 }
    );
  }
}
