import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import type { AppSettings } from "@/lib/settings";
import { apiGuard, cloudRefusal } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { sanitizeDarkStyle } from "@/lib/dark-style";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "workspace.settings_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getAppSettings());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "workspace.settings_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // The default dark style (1.20.35) is refused out loud rather than dropped,
  // before anything is written: it changes what everyone on Workspace default sees.
  if (body?.dark_style !== undefined && !sanitizeDarkStyle(body.dark_style)) {
    return NextResponse.json({ error: "dark_style must be slate, graphite or black." }, { status: 400 });
  }

  // 1.21.0: the backup schedule is CompassDocs Cloud's in cloud mode (lib/cloud), refused before anything is written.
  if (body?.backup_frequency !== undefined || body?.backup_keep !== undefined) {
    const cloud = cloudRefusal("backups");
    if (cloud) return cloud;
  }

  if (body?.approval_mode !== undefined) {
    const mode = body.approval_mode === "open" ? "open" : "strict";
    await setSetting("approval_mode", mode);
    await audit({
      actor: actorFrom(gate),
      action: "settings.approval_mode",
      details: { mode },
      ip: ipFrom(req),
    });
  }

  // Appearance & workspace settings (all optional; validated/clamped in the lib).
  const keys: (keyof AppSettings)[] = [
    "company_name",
    "logo_url",
    "accent_color",
    "dark_style",
    "timezone",
    "date_format",
    "time_format",
    "session_timeout_minutes",
    "trash_retention_days",
    "backup_frequency",
    "backup_keep",
    "max_attachment_mb",
    "max_video_mb",
    "comments_enabled",
    "comments_blocked_words",
    "nested_pages_enabled",
    "backlinks_enabled",
  ];
  const patch: Partial<AppSettings> = {};
  for (const k of keys) {
    if (body?.[k] !== undefined) (patch as any)[k] = body[k];
  }
  const darkStyleBefore = patch.dark_style !== undefined ? (await getAppSettings()).dark_style : null;
  const settings = Object.keys(patch).length ? await updateAppSettings(patch) : undefined;
  // Turning backlinks on backfills doc_links for content saved before the
  // feature existed (saves keep it fresh from then on). Fire-and-forget.
  if (patch.backlinks_enabled === true) {
    void import("@/lib/backlinks").then((m) => m.reindexAllDocLinks()).catch(() => {});
  }
  if (settings) {
    await audit({
      actor: actorFrom(gate),
      action: "settings.workspace",
      details: { fields: Object.keys(patch) },
      ip: ipFrom(req),
    });
    if (darkStyleBefore !== null && darkStyleBefore !== settings.dark_style) {
      await audit({
        actor: actorFrom(gate),
        action: "settings.dark_style",
        details: { from: darkStyleBefore, to: settings.dark_style },
        ip: ipFrom(req),
      });
    }
  }

  return NextResponse.json({ ok: true, settings });
}
