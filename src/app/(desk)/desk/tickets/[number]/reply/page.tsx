// /desk/tickets/[number]/reply (1.20.18): the ticket's reply in a window of
// its own, opened by the composer's Pop out. A desk page like any other: it
// sits in the (desk) group, so the desk layout has already asked for the
// sign-in, the forced password change, the licence and the Duo desk rule;
// the shell sees this path and draws no top bar or rail. Agents only, as
// the queue. The ticket itself loads from GET /api/helpdesk/tickets/[number]
// and every send goes through the same routes as the ticket pane, which
// check access on each request; a ticket the agent can't work shows the
// pane's refusal. The address carries the ticket number only: the reply's
// text travels in the browser's draft, never in a URL.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ShieldOff } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { EmptyState } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { ReplyPopout } from "@/components/helpdesk/desk/popout/ReplyPopout";
import { deskAccess } from "../../../../desk-access";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ number: string }> };

function ticketNumber(raw: string): number | null {
  const n = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(n) ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const n = ticketNumber((await params).number);
  return { title: n ? `Reply #${n}` : "Reply" };
}

export default async function ReplyPopoutPage({ params }: Props) {
  const n = ticketNumber((await params).number);
  if (!n) notFound();
  const user = await requireUser("desk");
  const access = await deskAccess(user);
  // The layout has shown the licence gate or "not for you" already when those apply.
  if (!access.agent) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <PageHeader className="sr-only" title={`Reply #${n}`} />
        <EmptyState icon={<ShieldOff />} title="Replies are for helpdesk agents" body="You can open the desk's reports or settings, but not reply on tickets." />
      </div>
    );
  }
  return <ReplyPopout number={n} />;
}
