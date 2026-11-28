"use client";

// Settings → Plan & usage (1.22.0, design A): the CompassDocs Cloud plan
// and what this workspace used this month. Four routed tabs under the
// section's SubNav: Overview (the plan card and the four meters with their
// six-month trends), Active users, Storage and AI (by feature, and the
// monthly spending choice). Everything reads GET /api/admin/plan (plan-data);
// a 404 means the licence carries no plan, said as the page's empty state.

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CircleCheckBig,
  CirclePause,
  Cloud,
  Download,
  ExternalLink,
  HardDrive,
  Headset,
  Info,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  UsersRound,
  Wallet,
  X,
} from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, type ChipTone } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { Modal } from "@/components/Modal";
import { EmptyState, Field, FormError, SectionEmpty, TextInput } from "@/components/form";
import { CardTitle } from "@/components/Heading";
import { ListFilter } from "@/components/ListFilter";
import { RadioCards } from "@/components/PolicyFields";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TR, TABLE_HEAD_ROW } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { RelativeTime } from "@/components/RelativeTime";
import {
  AI_FEATURES,
  AI_FEATURE_LABEL,
  AI_MARKUP,
  EXTRA_AGENT_USD,
  GB,
  STORAGE_STEP_GB,
  STORAGE_STEP_USD,
  gb,
  monthName,
  pct,
  shortDate,
  usd,
  usdShort,
  validEmail,
  BILLING_ALL_ADMINS,
  type AiSpending,
  type BillingContact,
  type MeterState,
  type PlanPerson,
} from "@/lib/plan-shared";
import { AgentsChip } from "./AgentsChip";
import { PlanMeter } from "./PlanMeter";
import { PlanTrend } from "./PlanTrend";
import { UpgradeDialog, upgradeLabel } from "./UpgradeDialog";
import { usePlan, type PlanData } from "./plan-data";

export type PlanTab = "overview" | "people" | "storage" | "ai";

export function PlanUsage({ tab }: { tab: PlanTab }) {
  const { load, reload } = usePlan();
  if (load.state === "loading") return <LoadingRow />;
  if (load.state === "none")
    return load.mismatch ? (
      // Design F, with no earlier license for this workspace to run on: say what is missing, not "no plan".
      <EmptyState
        icon={<ShieldAlert />}
        title="Waiting for this workspace's plan license"
        body={`The license in force is for another workspace (${load.mismatch.licenseWorkspace}), so there is no plan to show here yet and nothing is billed. Everything keeps working. Once CompassDocs sends the license for ${load.mismatch.workspaceId}, its plan and usage appear here.`}
        action={{ href: "/admin/license", label: "Open License" }}
      />
    ) : (
      <EmptyState
        icon={<Cloud />}
        title="No CompassDocs Cloud plan"
        body="This workspace's license carries no Cloud plan, so there is nothing to meter here. Its seats and agents are on the License page."
        action={{ href: "/admin/license", label: "Open License" }}
      />
    );
  if (load.state === "error") return <FormError>{load.message}</FormError>;
  const d = load.data;
  return (
    <div className="flex flex-col gap-4">
      {tab === "overview" && <Overview d={d} reload={reload} />}
      {tab === "people" && <People d={d} />}
      {tab === "storage" && <Storage d={d} />}
      {tab === "ai" && <Ai d={d} reload={reload} />}
    </div>
  );
}

/** The header's actions (design A1): the one primary upgrade action, by plan. */
export function PlanHeaderActions({ email }: { email: string }) {
  const { load } = usePlan();
  const [open, setOpen] = useState(false);
  // The past-the-buffer banner's upgrade button lands here with #upgrade.
  useEffect(() => {
    if (load.state === "ready" && window.location.hash === "#upgrade") setOpen(true);
  }, [load.state]);
  if (load.state !== "ready") return null;
  const d = load.data;
  const up = upgradeLabel(d.plan.name);
  if (!up) return null;
  return (
    <>
      <Button icon={<ArrowUpRight />} onClick={() => setOpen(true)} className="print:hidden">
        {up.label}
      </Button>
      <UpgradeDialog
        open={open}
        onClose={() => setOpen(false)}
        ctx={{ current: d.plan.name, target: up.target, workspace: d.workspace.name, renewsAt: d.plan.renewsAt, priceUsd: d.plan.priceUsd, replyTo: d.billingContact || email }}
      />
    </>
  );
}

// --- Overview -----------------------------------------------------------------------------------

function countedLine(iso: string | null): React.ReactNode {
  if (!iso) return "Not counted yet";
  return (
    <>
      Counted <RelativeTime value={iso} />
    </>
  );
}

/** Who the warning emails go to, in words (the licence's contact is named as such). */
function contactWords(c: Pick<BillingContact, "email" | "source">): string {
  if (!c.email) return "All admins";
  return c.source === "license" ? `${c.email} (from the license)` : c.email;
}

function Overview({ d, reload }: { d: PlanData; reload: () => void }) {
  const p = d.plan;
  const [contactOpen, setContactOpen] = useState(false);
  return (
    <>
      <Card padding="p-5" className="@container">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{p.label}</CardTitle>
          <Chip tone="info" size="sm">
            {p.billing === "annual" ? "Billed annually" : "Billed monthly"}
          </Chip>
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <div className="flex gap-1">
            <dt className="sr-only">Price</dt>
            <dd>
              <b className="font-semibold text-slate-900">{usdShort(p.priceUsd)}</b> a month
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Renews</dt>
            <dd className="font-semibold text-slate-900">{shortDate(p.renewsAt)}</dd>
          </div>
          {d.workspace.address && (
            <div className="flex min-w-0 gap-1">
              <dt>Workspace</dt>
              <dd className="min-w-0 font-semibold text-slate-900 [overflow-wrap:anywhere]">{d.workspace.address}</dd>
            </div>
          )}
          <div id="billing-contact" className="flex scroll-mt-6 flex-wrap items-baseline gap-1">
            <dt>Billing contact</dt>
            <dd className="font-semibold text-slate-900" data-testid="billing-contact">
              {contactWords({ email: d.billingContact, source: d.billingContactSource })}
            </dd>
            <dd>
              <button type="button" className="link text-xs print:hidden" onClick={() => setContactOpen(true)}>
                Change
              </button>
            </dd>
          </div>
        </dl>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden />
            {monthName(d.month)} {d.month.slice(0, 4)} · counts start again on {d.nextMonthStart}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {countedLine(d.countedAt)}
          </span>
        </p>
      </Card>
      <div className="@container">
        <div className="grid gap-4 @2xl:grid-cols-2">
          <AgentsCard d={d} />
          <UsersCard d={d} />
          <StorageCard d={d} />
          <AiCard d={d} />
        </div>
      </div>
      <p className="text-xs text-slate-500">The dashed line on each trend is the plan's limit. {monthName(d.month)}'s point is hollow: the month isn't over.</p>
      {contactOpen && <BillingContactDialog d={d} onClose={() => setContactOpen(false)} onSaved={reload} />}
    </>
  );
}

/**
 * Decision 5: where the plan's warning emails go. The licence's contact
 * (when it names one) is shown as such and stays the default; an admin
 * can choose every admin instead, or another address. The toast says who
 * they go to now, from the server's answer.
 */
function BillingContactDialog({ d, onClose, onSaved }: { d: PlanData; onClose: () => void; onSaved: () => void }) {
  type Choice = "license" | "admins" | "email";
  const titleId = useId();
  const lic = d.licenseContact;
  const initial: Choice = d.billingContactSource === "here" ? "email" : d.billingContactSource === "license" ? "license" : lic && d.billingContactSource === "default" ? "license" : "admins";
  const [choice, setChoice] = useState<Choice>(initial);
  const [email, setEmail] = useState(d.billingContactSource === "here" ? d.billingContact : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    if (choice === "email" && !validEmail(email.trim())) return setError("Enter an email address.");
    setBusy(true);
    try {
      const value = choice === "email" ? email.trim() : choice === "admins" ? BILLING_ALL_ADMINS : "";
      const res = await fetch("/api/admin/plan/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ billing_contact: value }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error || "Couldn't save the billing contact.");
      const now = body?.billing_contact as BillingContact | undefined;
      toast("ok", now?.email ? `Warning emails go to ${now.email}${now.source === "license" ? ", the license's contact" : ""}.` : "Warning emails go to every admin.");
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const options: { value: Choice; label: string; description: string; extra?: React.ReactNode }[] = [
    ...(lic ? [{ value: "license" as const, label: "The license's contact", description: `${lic}, as CompassDocs has it on your plan.` }] : []),
    { value: "admins", label: "Every admin", description: "Everyone who can open Plan & usage." },
    {
      value: "email",
      label: "Another address",
      description: "One address instead of every admin.",
      extra: (
        <Field label="Email address" size="xs">
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
      ),
    },
  ];
  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          Billing contact
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-600">Who gets the plan's warning emails (80%, the limit, past the buffer, AI paused).</p>
      <div className="mt-4">
        <RadioCards label="Billing contact" name="billing-contact" value={choice} onChange={setChoice} options={options} />
      </div>
      {error && <FormError className="mt-3">{error}</FormError>}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button busy={busy} onClick={save}>
          Save
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

function stateChip(tone: ChipTone, text: string, icon?: React.ReactNode, testid?: string) {
  return (
    <Chip tone={tone} data-testid={testid}>
      {icon}
      {text}
    </Chip>
  );
}

function MeterCard({
  id,
  icon,
  title,
  chip,
  big,
  of,
  meter,
  body,
  footer,
  trend,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  chip: React.ReactNode;
  big: string;
  of: string;
  meter: React.ReactNode;
  body: React.ReactNode;
  footer: React.ReactNode;
  trend: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-slate-200 bg-surface p-5 shadow-xs" aria-labelledby={`${id}-title`} data-plan-meter={id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <CardTitle id={`${id}-title`} icon={icon}>
          {title}
        </CardTitle>
        {chip}
      </div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{big}</span>
        <span className="text-sm text-slate-500">{of}</span>
      </p>
      <div className="mt-3">{meter}</div>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
      <div className="mt-auto flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-t border-slate-100 pt-3 [&>figure]:w-40">
        <div className="text-sm">{footer}</div>
        {trend}
      </div>
    </section>
  );
}

function SeeLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="link inline-flex items-center gap-1 font-medium print:hidden">
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

const warnIcon = <TriangleAlert className="h-3 w-3" aria-hidden />;

function AgentsCard({ d }: { d: PlanData }) {
  const a = d.agents;
  const m = d.meters.agents;
  const label = d.plan.label;
  const chip = <AgentsChip used={a.used} included={a.included} max={a.max} holdAt={a.holdAt} state={m.state} label={label} extraUsd={EXTRA_AGENT_USD} />;
  // No maximum (agents by contract): no buffer, no amber, the bar is just how many (STYLEGUIDE §Plan meter).
  const soft = a.max !== null;
  const limit = a.max ?? Math.max(a.included, a.used, 1);
  const end = a.holdAt ?? limit;
  return (
    <MeterCard
      id="agents"
      icon={<Headset />}
      title="Agents"
      chip={chip}
      big={String(a.used)}
      of={a.max !== null ? `of ${a.included} included · up to ${a.max} on ${label}` : `on ${label}, by contract`}
      meter={
        <PlanMeter
          value={a.used}
          limit={limit}
          end={end}
          label="Helpdesk agents"
          soft={soft}
          valueText={`${a.used} agents: ${a.included} included${a.max !== null ? `, up to ${a.max}, new agents held at ${a.holdAt}` : ", more by contract"}`}
          marks={[{ at: a.included, label: `${a.included} included` }, ...(a.max !== null && a.max !== a.included ? [{ at: a.max, label: `${a.max} max` }] : [])]}
        />
      }
      body={
        a.max === null ? (
          `${label}'s agents are by contract: adding one changes nothing here.`
        ) : (
          <>
            Each agent past {a.included} is {usd(EXTRA_AGENT_USD)}/mo, prorated; {label} allows {a.max}, and {a.holdAt} with the buffer.{" "}
            {a.extra > 0 ? `${a.extra} extra this month: ${usd(a.extra * EXTRA_AGENT_USD)} a month.` : "No extra agents this month."}
          </>
        )
      }
      footer={
        <a href="/desk/settings/agents" target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1 font-medium print:hidden">
          Manage agents
          <ExternalLink className="h-3 w-3" aria-hidden />
          <span className="sr-only"> (opens the desk in a new tab)</span>
        </a>
      }
      trend={<PlanTrend points={m.trend} limit={a.max} label="Agents, last six months" format={(n) => `${n} agents`} limitLabel={a.max !== null ? String(a.max) : undefined} />}
    />
  );
}

const pctOf = pct;

function UsersCard({ d }: { d: PlanData }) {
  const m = d.meters.users;
  const limit = m.limit;
  const chip =
    limit === null
      ? stateChip("ok", "No cap")
      : m.state === "past"
        ? stateChip("error", "Past the buffer", warnIcon, "users-chip")
        : m.state === "over"
          ? stateChip("warn", `Over by ${(m.value - limit).toLocaleString("en-US")} · in buffer`, warnIcon, "users-chip")
          : m.state === "warn"
            ? stateChip("warn", `${pctOf(m.value, limit)}% of plan`, warnIcon, "users-chip")
            : stateChip("ok", "Within plan", undefined, "users-chip");
  return (
    <MeterCard
      id="users"
      icon={<UsersRound />}
      title="Active users"
      chip={chip}
      big={m.value.toLocaleString("en-US")}
      of={limit === null ? "this month" : `of ${limit.toLocaleString("en-US")} this month`}
      meter={
        limit === null ? null : (
          <PlanMeter
            value={m.value}
            limit={limit}
            end={m.cap ?? limit * 1.2}
            label="Active users this month"
            valueText={m.value > limit ? `${m.value} of ${limit}, over by ${m.value - limit}` : `${m.value} of ${limit}`}
            marks={[{ at: limit, label: limit.toLocaleString("en-US") }]}
          />
        )
      }
      body={`People who signed in this month: readers, editors, agents and requesters. Each counts once.${m.cap !== null ? ` Buffer to ${m.cap.toLocaleString("en-US")}.` : ""}`}
      footer={<SeeLink href="/admin/plan/people">See who counted</SeeLink>}
      trend={<PlanTrend points={m.trend} limit={limit} label="Active users, last six months" format={(n) => `${n} people`} limitLabel={limit !== null ? limit.toLocaleString("en-US") : undefined} />}
    />
  );
}

function StorageCard({ d }: { d: PlanData }) {
  const m = d.meters.storage;
  const s = d.storage;
  const limit = m.limit;
  const chip =
    limit === null
      ? stateChip("ok", "By contract")
      : m.state === "over"
        ? stateChip("info", `${s.steps} extra ${STORAGE_STEP_GB} GB · ${usdShort(s.steps * STORAGE_STEP_USD)}/mo`, undefined, "storage-chip")
        : m.state === "warn"
          ? stateChip("warn", `${pctOf(s.bytes / GB, limit)}% of plan`, warnIcon, "storage-chip")
          : stateChip("ok", "Within plan", undefined, "storage-chip");
  return (
    <MeterCard
      id="storage"
      icon={<HardDrive />}
      title="Storage"
      chip={chip}
      big={gb(s.bytes)}
      of={limit === null ? "stored" : `of ${limit} GB`}
      meter={
        limit === null ? null : (
          <PlanMeter
            value={s.bytes / GB}
            limit={limit}
            end={limit * 1.2}
            label="Storage used"
            valueText={`${gb(s.bytes)} of ${limit} GB`}
            marks={[{ at: limit, label: `${limit} GB` }]}
          />
        )
      }
      body={limit === null ? "Backups and exports don't count." : `Past ${limit} GB, each extra ${STORAGE_STEP_GB} GB is ${usdShort(STORAGE_STEP_USD)} a month. Backups and exports don't count.`}
      footer={<SeeLink href="/admin/plan/storage">See storage</SeeLink>}
      trend={<PlanTrend points={m.trend} limit={limit} label="Storage at each month's end, last six months, in GB" format={(n) => `${n} GB`} limitLabel={limit !== null ? String(limit) : undefined} />}
    />
  );
}

function spendingWords(s: AiSpending, cap: number | null): string {
  return s === "keep" ? "Off" : s === "stop" ? "At the allowance" : `${usd(cap ?? 0)} a month`;
}

function aiChip(d: PlanData): React.ReactNode {
  const ai = d.ai;
  if (ai.paused) return stateChip("neutral", "Paused · cap reached", <CirclePause className="h-3 w-3" aria-hidden />, "ai-chip");
  if (ai.allowanceUsd === null) return stateChip("ok", "By contract", undefined, "ai-chip");
  const st: MeterState = d.meters.ai.state;
  if (st === "over") return stateChip("info", `${usd(ai.beyondUsd)} beyond · billed ${usd(ai.billedUsd)}`, undefined, "ai-chip");
  if (st === "warn") return stateChip("warn", `${pctOf(ai.spentUsd, ai.allowanceUsd)}% used`, warnIcon, "ai-chip");
  return stateChip("ok", "Within allowance", undefined, "ai-chip");
}

function AiCard({ d }: { d: PlanData }) {
  const ai = d.ai;
  const allowance = ai.allowanceUsd;
  const lastDay = new Date(Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5, 7)), 0)).getUTCDate();
  return (
    <MeterCard
      id="ai"
      icon={<Sparkles />}
      title="AI allowance"
      chip={aiChip(d)}
      big={usd(ai.spentUsd)}
      of={allowance === null ? "this month" : `of ${usd(allowance)} this month`}
      meter={
        allowance === null ? null : (
          <PlanMeter
            value={ai.spentUsd}
            limit={allowance}
            end={allowance * 1.2}
            label="AI this month, at cost"
            valueText={`${usd(ai.spentUsd)} of ${usd(allowance)}`}
            startLabel="$0"
            marks={[{ at: allowance, label: usdShort(allowance) }]}
          />
        )
      }
      body={
        <>
          {allowance !== null ? `Beyond ${usdShort(allowance)}, AI is billed at cost +${Math.round(AI_MARKUP * 100)}%. ` : ""}
          {ai.paceUsd !== null ? `On pace for about ${usd(ai.paceUsd)} by ${lastDay} ${monthName(d.month).slice(0, 3)}. ` : ""}
          Spending cap: <b className="font-semibold text-slate-800">{spendingWords(d.spending.spending, d.spending.capUsd)}</b> ·{" "}
          <Link href="/admin/plan/ai#ai-spending" className="link print:hidden">
            Change
          </Link>
        </>
      }
      footer={<SeeLink href="/admin/plan/ai">See AI by feature</SeeLink>}
      trend={<PlanTrend points={d.meters.ai.trend} limit={allowance} label="AI at cost, last six months, in dollars" format={(n) => usd(n)} limitLabel={allowance !== null ? usdShort(allowance) : undefined} />}
    />
  );
}

// --- Active users ----------------------------------------------------------------------------------

interface PeopleBody {
  count: number;
  by_kind: Record<string, number>;
  people: PlanPerson[];
  /** How many the list carries (the most recent; the CSV has everyone). */
  shown: number;
}

function People({ d }: { d: PlanData }) {
  // The count, the chips and the list: one answer, one read (they always agree).
  const [body, setBody] = useState<PeopleBody | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch("/api/admin/plan/people", { cache: "no-store" })
      .then(async (r) => {
        const b = await r.json().catch(() => null);
        if (!r.ok || !b) throw new Error(b?.error || "Couldn't load who counted.");
        setBody(b as PeopleBody);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const rows = body?.people ?? null;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !t || `${r.name} ${r.countedAs} ${r.detail}`.toLowerCase().includes(t));
  }, [rows, q]);
  const byKind = Object.entries(body?.by_kind ?? {}).filter(([, n]) => n > 0);
  const total = body?.count ?? null;
  return (
    <Card
      padding="none"
      title={`Who counted in ${monthName(d.month)}`}
      description={`${total === null ? "" : `${total.toLocaleString("en-US")} ${total === 1 ? "person" : "people"} so far. `}Each person counts once, under their highest role. The list stays in this workspace.`}
      actions={
        <a href="/api/admin/plan/people?format=csv" download className={iconButtonClass("bordered", "sm", "print:hidden")} data-tt="Download CSV" aria-label="Download CSV">
          <Download aria-hidden />
        </a>
      }
    >
      {byKind.length > 0 && (
        <ul role="list" className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-3">
          {byKind.map(([k, n]) => (
            <li key={k}>
              <Chip tone="neutral">
                {k} {n.toLocaleString("en-US")}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <FormError className="px-4 py-3">{error}</FormError>
      ) : rows === null ? (
        <LoadingRow />
      ) : rows.length === 0 ? (
        <SectionEmpty className="px-4 py-6">Nobody has signed in yet this month. People appear here the first day they do.</SectionEmpty>
      ) : (
        <>
          {rows.length > 8 && (
            <div className="border-b border-slate-100 px-4 py-3">
              <ListFilter value={q} onChange={setQ} label="Filter people" placeholder="Filter people" shown={shown.length} total={rows.length} noun="people" />
            </div>
          )}
          {shown.length === 0 ? (
            <SectionEmpty className="px-4 py-6" action={{ onClick: () => setQ(""), label: "Clear the filter" }}>
              Nobody matches “{q}”.
            </SectionEmpty>
          ) : (
            <Table>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <Th>Person</Th>
                  <Th>Counted as</Th>
                  <Th align="right">Last sign-in</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.name}-${i}`} className={TR}>
                    <Td className="font-medium text-slate-800">{r.name}</Td>
                    <Td>
                      <span className="text-slate-800">{r.countedAs}</span>
                      {r.detail && <span className="block text-xs text-slate-500">{r.detail}</span>}
                    </Td>
                    <Td align="right" className="text-slate-600">
                      <RelativeTime value={r.lastAt} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {body && body.count > body.shown && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              Showing the {body.shown.toLocaleString("en-US")} most recent of {body.count.toLocaleString("en-US")}. The CSV has everyone.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// --- Storage ------------------------------------------------------------------------------------

const AREAS: { key: "files" | "documents" | "helpdesk"; label: string; help: string; swatch: string }[] = [
  { key: "files", label: "Attachments and images", help: "In documents, handbooks and training", swatch: "bg-compass-600" },
  { key: "documents", label: "Documents", help: "Text, version history and the Trash", swatch: "bg-compass-300" },
  { key: "helpdesk", label: "Helpdesk", help: "Ticket attachments and email", swatch: "bg-slate-400" },
];

function Storage({ d }: { d: PlanData }) {
  const s = d.storage;
  const total = Math.max(1, s.bytes);
  return (
    <Card padding="none" title="What's using storage" description={d.storage.limitBytes ? `${gb(s.bytes)} of ${gb(d.storage.limitBytes)}` : gb(s.bytes)}>
      <div className="px-4 pt-4">
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          {AREAS.map((a) => (s.areas[a.key] > 0 ? <div key={a.key} className={a.swatch} style={{ width: `${(s.areas[a.key] / total) * 100}%` }} /> : null))}
        </div>
      </div>
      <ul role="list" className="divide-y divide-slate-100 px-4">
        {AREAS.map((a) => (
          <li key={a.key} className="flex items-center gap-3 py-3">
            <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-sm ${a.swatch}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800">{a.label}</p>
              <p className="text-xs text-slate-500">{a.help}</p>
            </div>
            <span className="text-sm font-medium text-slate-800 tabular-nums">{gb(s.areas[a.key])}</span>
          </li>
        ))}
        <li className="flex items-center justify-between py-3 text-sm font-semibold text-slate-900">
          <span>Counted</span>
          <span className="tabular-nums">{gb(s.bytes)}</span>
        </li>
      </ul>
      <div className="px-4 pb-4">
        <div className="notice-info flex gap-2 rounded-lg border px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
          <p>
            <b className="font-semibold">Not counted:</b> backups (ours, kept for you), workspace exports while they wait to be downloaded
            {s.notCounted.exports > 0 ? ` (${gb(s.notCounted.exports)})` : ""}, and the search index. Emptying the Trash frees space.
          </p>
        </div>
      </div>
    </Card>
  );
}

// --- AI -----------------------------------------------------------------------------------------------

function Ai({ d, reload }: { d: PlanData; reload: () => void }) {
  const ai = d.ai;
  const max = Math.max(0.01, ...AI_FEATURES.map((f) => ai.byFeature[f]));
  return (
    <>
      <Card padding="none" title={`AI by feature in ${monthName(d.month)}`} description={ai.allowanceUsd !== null ? `${usd(ai.spentUsd)} of ${usd(ai.allowanceUsd)}` : usd(ai.spentUsd)}>
        <ul role="list" className="divide-y divide-slate-100 px-4">
          {AI_FEATURES.map((f) => {
            const v = ai.byFeature[f];
            const extra = f === "desk" ? `${ai.details.deskTurns.toLocaleString("en-US")} ${ai.details.deskTurns === 1 ? "answer" : "answers"}` : f === "ask" ? `${ai.details.askAnswers.toLocaleString("en-US")} ${ai.details.askAnswers === 1 ? "answer" : "answers"}` : AI_FEATURE_LABEL[f].help;
            return (
              <li key={f} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                <div className="min-w-0">
                  <p className="text-sm text-slate-800">{AI_FEATURE_LABEL[f].label(d.workspace.name)}</p>
                  <p className="text-xs text-slate-500">{extra}</p>
                </div>
                <div aria-hidden className="hidden h-1.5 overflow-hidden rounded-full bg-slate-100 sm:block">
                  <div className="h-full rounded-full bg-compass-600" style={{ width: `${(v / max) * 100}%` }} />
                </div>
                <span className="text-right text-sm font-medium text-slate-800 tabular-nums">{usd(v)}</span>
              </li>
            );
          })}
          <li className="flex items-center justify-between gap-3 py-3 text-sm font-semibold text-slate-900">
            <span>{ai.allowanceUsd === null ? "AI by contract" : ai.beyondUsd > 0 ? `${usd(ai.beyondUsd)} beyond the allowance · billed ${usd(ai.billedUsd)}` : "Within allowance · nothing billed yet"}</span>
            <span className="tabular-nums">{usd(ai.spentUsd)}</span>
          </li>
        </ul>
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          The desk's own Claude limits (Desk settings → Claude in the desk) still apply inside this.
        </p>
      </Card>
      <Spending d={d} reload={reload} />
    </>
  );
}

function Spending({ d, reload }: { d: PlanData; reload: () => void }) {
  const allowance = d.ai.allowanceUsd;
  const [choice, setChoice] = useState<AiSpending>(d.spending.spending);
  const [cap, setCap] = useState(d.spending.capUsd !== null ? String(d.spending.capUsd) : String(Math.max(40, Math.ceil((allowance ?? 0) * 2))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = choice !== d.spending.spending || (choice === "cap" && Number(cap) !== d.spending.capUsd);
  const a = allowance !== null ? usdShort(allowance) : "the allowance";

  async function save() {
    setError("");
    if (choice === "cap") {
      const n = Number(cap);
      if (!Number.isFinite(n) || n <= 0) return setError("Enter a monthly cap in dollars.");
      if (allowance !== null && n < allowance) return setError(`The cap includes the ${a} allowance: enter at least ${a}, or choose Stop at the allowance.`);
    }
    // Ask before pausing AI at once: only with a real limit (the allowance, or a valid cap) already reached.
    const limitNow = choice === "stop" ? allowance : choice === "cap" ? Number(cap) : null;
    if (limitNow !== null && Number.isFinite(limitNow) && limitNow > 0 && d.ai.spentUsd >= limitNow) {
      const ok = await confirmDialog({
        title: "Pause AI for the rest of the month?",
        body: `This month's AI (${usd(d.ai.spentUsd)}) is already at that limit, so Claude in the desk, Ask, Write and Proofread pause until ${d.nextMonthStart}. Everything else keeps working.`,
        confirmLabel: "Save and pause AI",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/plan/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_spending: choice, ...(choice === "cap" ? { ai_cap_usd: Number(cap) } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error || "Couldn't save.");
      toast("ok", choice === "keep" ? "AI stays on past the allowance." : choice === "stop" ? `AI pauses once ${a} is used.` : `AI pauses at ${usd(Number(cap))} a month.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      id="ai-spending"
      className="scroll-mt-6"
      title="Monthly AI spending"
      icon={<Wallet />}
      description={allowance !== null ? `${d.plan.label} includes about ${a} of AI a month. Choose what happens after that.` : `${d.plan.label}'s AI is by contract. You can cap it at a monthly amount.`}
    >
      <RadioCards
        label="Monthly AI spending"
        name="ai-spending"
        value={choice}
        onChange={setChoice}
        options={[
          {
            value: "keep",
            label: "Keep AI on",
            description: allowance !== null ? `Beyond ${a}, AI is billed at cost +${Math.round(AI_MARKUP * 100)}%. You get an email when the allowance runs out.` : "AI stays on all month, under your contract.",
          },
          // No allowance (AI by contract): nothing to stop at, so no "Stop at the allowance".
          ...(allowance !== null ? [{ value: "stop" as const, label: "Stop at the allowance", description: `AI pauses for the rest of the month once ${a} is used. Nothing extra is billed.` }] : []),
          {
            value: "cap",
            label: "Cap at an amount",
            description: allowance !== null ? `AI is billed beyond ${a} up to your cap, then pauses for the month.` : "AI pauses for the rest of the month once this much is used.",
            extra: (
              <Field label="Cap, a month" size="xs" help={allowance !== null ? `Including the ${a} allowance.` : undefined}>
                <TextInput inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
            ),
          },
        ]}
      />
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
        {[
          ["This month", usd(d.ai.spentUsd)],
          ["Beyond allowance", usd(d.ai.beyondUsd)],
          ["Billed so far", usd(d.ai.billedUsd)],
          ["Last month", usd(d.ai.lastMonthUsd)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="text-lg font-semibold text-slate-900 tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        Costs are counted from the AI provider's token counts at its price list. Desk settings → Claude in the desk keeps its own per-agent and desk limits inside this. Changing the choice is in the audit log.
      </p>
      {d.ai.paused && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700" role="status">
          <CirclePause className="h-4 w-4 text-slate-500" aria-hidden />
          AI is paused until {d.nextMonthStart}. Raise the cap or keep AI on to start it again now.
        </p>
      )}
      {!d.ai.paused && d.spending.spending !== "keep" && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700">
          <CircleCheckBig className="h-4 w-4 ink-ok" aria-hidden />
          AI is on. It pauses at {d.spending.spending === "stop" ? a : usd(d.spending.capUsd ?? 0)} this month.
        </p>
      )}
      {error && <FormError className="mt-3">{error}</FormError>}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} busy={busy} disabled={!dirty}>
          Save
        </Button>
        {dirty && <span className="text-xs ink-warn">Unsaved changes</span>}
      </div>
    </Card>
  );
}
