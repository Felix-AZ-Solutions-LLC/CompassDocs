import { NextResponse } from "next/server";
import { getUpdateStatus } from "@/lib/version";
import { apiGuard, cloudRefusal } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: Request) {
  // 1.21.0: CompassDocs Cloud manages this (lib/cloud); 403 in cloud mode.
  const cloud = cloudRefusal("updates");
  if (cloud) return cloud;
  const gate = await apiGuard("admin", "system.version_read");
  if (gate instanceof NextResponse) return gate;
  // ?refresh=1 bypasses the 6-hour cache for a manual "check now".
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return NextResponse.json(await getUpdateStatus(force));
}
