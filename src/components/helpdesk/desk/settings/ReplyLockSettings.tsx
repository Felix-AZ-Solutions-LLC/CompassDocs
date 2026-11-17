"use client";

// Settings → Reply lock (1.20.20, lib/helpdesk/reply-lock): one agent at a
// time writes a ticket's public reply. On or off for the whole desk, and how
// long an idle holder keeps the lock. Who may take a reply over is a desk
// role capability (Roles → Take over a reply). 1.20.20 (review): who holds a
// reply now, with Release for one ticket and "Release all of Sam's locks".

import { useEffect, useState } from "react";
import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, SectionEmpty, Select, Toggle } from "@/components/form";
import { Button } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { RelativeTime } from "@/components/RelativeTime";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdLiveLock, HdReplyLockSettings } from "@/lib/helpdesk/reply-lock-shared";
import { getJson, sendJson } from "../api";

const URL_ = "/api/helpdesk/admin/reply-lock";
const MINUTES = [1, 2, 3, 5, 10, 15];

export function ReplyLockSettings() {
  const [s, setS] = useState<HdReplyLockSettings | null>(null);
  const [locks, setLocks] = useState<HdLiveLock[]>([]);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(s);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ settings: HdReplyLockSettings; locks?: HdLiveLock[] }>(URL_, "Couldn't load the reply lock settings.")
      .then((d) => {
        setS(d.settings);
        setLocks(d.locks ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !s) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!s) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<HdReplyLockSettings>) => {
    markDirty();
    setS({ ...s, ...patch });
  };

  async function release(target: { number: number } | { user_id: number; name: string }) {
    const all = "user_id" in target;
    const ok = await confirmDialog({
      title: all ? `Release all of ${target.name}'s locks?` : `Release the reply on #${target.number}?`,
      body: "Nobody holds them afterwards. Nothing written is sent or lost, and anyone can start the reply again.",
      confirmLabel: all ? "Release all" : "Release",
    });
    if (ok !== true) return;
    const key = all ? `u${target.user_id}` : `t${target.number}`;
    setReleasing(key);
    try {
      const r = await sendJson<{ released: unknown[]; locks: HdLiveLock[] }>(
        URL_,
        "POST",
        { release: all ? { user_id: target.user_id } : { number: target.number } },
        "Couldn't release the lock."
      );
      setLocks(r.locks);
      toast("ok", r.released.length === 1 ? "Released one lock." : `Released ${r.released.length} locks.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setReleasing(null);
    }
  }

  const holders = Array.from(new Map(locks.map((l) => [l.user_id, l.name])).entries());

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const r = await sendJson<{ settings: HdReplyLockSettings }>(URL_, "PUT", s, "Couldn't save the reply lock settings.");
      setS(r.settings);
      markClean(JSON.stringify(r.settings));
      toast("ok", r.settings.enabled ? "Reply locks are on." : "Reply locks are off.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<LockKeyhole />} title="Reply lock" subtitle="One agent at a time writes a ticket's reply. Others see who, and can still add notes." />
      <div className="flex flex-col gap-4">
        <Card id="reply-lock" className="scroll-mt-6" title="Reply lock">
          <Toggle size="full"
            label="Lock a ticket's reply while someone writes it"
            help="The first agent who starts a reply holds it. Everyone else sees who is replying and can't send a reply until they're done. Internal notes and field changes are never locked."
            checked={s.enabled}
            onChange={(v) => set({ enabled: v })}
          />
          <p className="mt-4 text-sm text-slate-600">
            Team leads, managers and admins can take a reply over; the person writing it keeps their text. Change who can in{" "}
            <Link href="/desk/settings/roles" className="link">
              Roles
            </Link>{" "}
            (Take over a reply).
          </p>
        </Card>
        <Card id="reply-lock-idle" className="scroll-mt-6" title="When a lock lets go" description="A lock goes as soon as its holder sends, empties the reply box, lets go or closes the ticket.">
          <Field
            label="Or after this long without touching the reply"
            help="Someone who walks away from a half-written reply doesn't hold the ticket up. A lock also ends an hour after it was taken without a send, and an agent holds at most three at once."
            size="sm"
          >
            <Select value={s.idle_minutes} disabled={!s.enabled} onChange={(e) => set({ idle_minutes: Number(e.target.value) })}>
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m === 1 ? "1 minute" : `${m} minutes`}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
        <Card id="reply-lock-now" className="scroll-mt-6" title="Replies being written now" description="Release a lock someone left behind. Their text stays with them.">
          {holders.length === 0 ? (
            <SectionEmpty>Nobody is writing a reply right now.</SectionEmpty>
          ) : (
            <div className="flex flex-col gap-4" data-testid="reply-lock-holders">
              {holders.map(([userId, name]) => (
                <section key={userId} aria-label={`${name}'s replies`} className="rounded-lg border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                    <span className="text-sm font-semibold text-slate-900">{name}</span>
                    <Button variant="secondary" size="sm" busy={releasing === `u${userId}`} onClick={() => void release({ user_id: userId, name })}>
                      Release all of {name}&apos;s locks
                    </Button>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {locks
                      .filter((l) => l.user_id === userId)
                      .map((l) => (
                        <li key={l.ticket_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                          <Link href={`/desk/tickets/${l.number}`} className="link min-w-0 flex-1 truncate">
                            #{l.number} {l.subject}
                          </Link>
                          <span className="text-xs text-slate-500">
                            since <RelativeTime value={l.since} />, last edit <RelativeTime value={l.touched_at} />
                          </span>
                          <Button variant="secondary" size="sm" busy={releasing === `t${l.number}`} onClick={() => void release({ number: l.number })}>
                            Release
                          </Button>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save reply lock settings" />
    </PageContainer>
  );
}
