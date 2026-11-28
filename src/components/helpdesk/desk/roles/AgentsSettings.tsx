"use client";

// Settings → Agents (agent J): the one place a person's desk level is
// set. A table of everyone on the desk (person, role, teams with "Lead of",
// availability), filtered by name, role and team, with counts per role.
// Managers and Admins change roles (up to the roles below their own) and
// teams; Team leads add, move between Newbie and Agent, and remove people
// in their own teams. Rows the viewer can't change show the role as a chip.
// Changes save at once and toast (STYLEGUIDE §Settings pages).
//
// The licence's helpdesk agent allowance: people who give roles
// (agents.assign_roles) see a usage meter under the header ("5 of 6
// agents", STYLEGUIDE §Usage meter), a warning when the desk is past it,
// and Add agent says so before anyone tries when every place is taken.
// The number shown is the key's own (`licensed`); `enforced` is false in
// grace, when nothing is refused.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ExternalLink, Pencil, Plus, TriangleAlert, UserMinus, UsersRound, X } from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { PlanMeter } from "@/components/plan/PlanMeter";
import { shortDate, usd, usdShort } from "@/lib/plan-shared";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState, Field, FormError, Select, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TR, TABLE_HEAD_ROW } from "@/components/Table";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { UsageMeter } from "@/components/UsageMeter";
import { UserAvatar } from "@/components/UserAvatar";
import { agentsNoun, allowanceBreakdown } from "@/lib/agent-allowance";
import { HD_ROLES, HD_ROLE_DESCRIPTION, HD_ROLE_LABEL, type HdCapsView, type HdDeskAgent, type HdRole } from "@/lib/helpdesk/roles-shared";
import { ApiError, getJson, sendJson } from "../api";
import { personOption, usePeople } from "../people";
import { RoleChip } from "./role-ui";

interface AgentRow extends HdDeskAgent {
  manageable: boolean;
}
interface TeamLite {
  id: number;
  name: string;
}
interface AgentsData {
  agents: AgentRow[];
  teams: TeamLite[];
  me: HdCapsView;
  counts: Record<HdRole, number>;
  /** The allowance in force (null: nothing is refused, no limit or in grace). */
  allowed: number | null;
  /** The key's own allowance (null = unlimited): the number shown. */
  licensed: number | null;
  enforced: boolean;
  /** Everyone listed counts. */
  used: number;
  /** How far past `licensed` (0 within it). */
  over: number;
  buy_url: string;
  /** 1.22.0: a CompassDocs Cloud plan's agent rules (absent self-hosted and on Enterprise licences). */
  plan?: PlanAgents;
}

/** 1.22.0 (design C): the plan's agents, and the price of one more. */
interface PlanAgents {
  name: string;
  label: string;
  included: number;
  max: number | null;
  /** Adds are held here (the maximum with its buffer); null = no hold. */
  hold_at: number | null;
  used: number;
  monthly_usd: number;
  price_usd: number;
  renews_at: string;
  billing: "annual" | "monthly";
  proration: { nowUsd: number; days: number; periodUsd: number; until: string };
  next: { name: string; label: string; price_usd: number; included: number; max: number | null } | null;
}

/** What Add agent needs to know about the allowance. */
interface AgentLimitView {
  /** Every place is taken and adds are refused. */
  full: boolean;
  allowed: number | null;
  buyUrl: string;
  /** Already counted: adding them at a role takes no place. */
  counted: Set<number>;
  /** 1.22.0: the CompassDocs Cloud plan's rules, when there is a plan. */
  plan?: PlanAgents;
}

const AVAILABILITY: Record<HdDeskAgent["availability"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  available: { label: "Available", tone: "ok" },
  away: { label: "Away", tone: "warn" },
  offline: { label: "Offline", tone: "neutral" },
};

/**
 * 1.20.28: a phone stacks each person's row (STYLEGUIDE §Tables, "A table that stacks on a phone"): name and the row's
 * actions, then role and availability, then teams across the width. From `sm` up it is the table, top-aligned.
 */
const STACK_ROW = "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2 max-sm:px-4 max-sm:py-3";
const STACK_CELL = "align-top max-sm:block max-sm:w-auto max-sm:min-w-0 max-sm:p-0";

function plural(n: number, role: HdRole): string {
  const label = HD_ROLE_LABEL[role];
  return `${n} ${n === 1 ? label : `${label}s`}`;
}

export function AgentsSettings() {
  const [data, setData] = useState<AgentsData | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | HdRole>("");
  const [teamFilter, setTeamFilter] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingTeams, setEditingTeams] = useState<AgentRow | null>(null);

  const reload = useCallback(() => {
    getJson<AgentsData>("/api/helpdesk/admin/agents", "Couldn't load the agents.")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => reload(), [reload]);

  const teamName = useMemo(() => new Map((data?.teams ?? []).map((t) => [t.id, t.name])), [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.agents ?? []).filter(
      (a) =>
        (!roleFilter || a.role === roleFilter) &&
        (!teamFilter || a.team_ids.includes(Number(teamFilter))) &&
        (!q || `${a.name} ${a.email} ${a.username}`.toLowerCase().includes(q))
    );
  }, [data, query, roleFilter, teamFilter]);

  const me = data?.me;
  const canAdd = Boolean(me && me.assignable_roles.length);
  // The allowance is for people who give roles; a Team lead adds within it but doesn't see it.
  const showAllowance = canAdd && Boolean(me?.caps.includes("agents.assign_roles"));

  async function changeRole(a: AgentRow, role: HdRole) {
    setBusyId(a.user_id);
    try {
      await sendJson(`/api/helpdesk/admin/agents/${a.user_id}`, "PATCH", { role }, "Couldn't change the role.");
      toast("ok", `${a.name} is now ${HD_ROLE_LABEL[role]}.`);
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: AgentRow) {
    const lead = me && !me.caps.includes("agents.assign_roles");
    const ok = await confirmDialog({
      title: `Remove ${a.name} from the desk?`,
      body: lead
        ? "They leave your teams' queues. Their tickets stay assigned to them until someone reassigns them."
        : "They lose their desk role and leave every team. Their tickets stay assigned to them until someone reassigns them.",
      confirmLabel: "Remove from desk",
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(a.user_id);
    try {
      const r = await sendJson<{ still_on_desk?: HdDeskAgent }>(`/api/helpdesk/admin/agents/${a.user_id}`, "DELETE", undefined, "Couldn't remove them.");
      toast(
        "ok",
        r.still_on_desk
          ? `${a.name} left. They keep desk access through their workspace role (Work helpdesk tickets).`
          : `${a.name} is no longer on the desk.`
      );
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const summary = data
    ? HD_ROLES.filter((r) => data.counts[r] > 0)
        .map((r) => plural(data.counts[r], r))
        .join(" · ")
    : "";

  return (
    <PageContainer>
      <PageHeader
        icon={<UsersRound />}
        title="Agents"
        subtitle="Who works the desk, at which level, in which teams."
        actions={
          canAdd ? (
            <Button icon={<Plus />} onClick={() => setAdding(true)}>
              Add agent
            </Button>
          ) : undefined
        }
      />
      {data && showAllowance && (data.plan ? <PlanAgentsMeter p={data.plan} /> : <AgentAllowance d={data} />)}
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {data === null && !error && <LoadingRow className="py-10" />}
      {data && data.agents.length === 0 && (
        <EmptyState
          icon={<UsersRound />}
          title="Nobody works the desk yet"
          body="Add the people who answer requests and give each a level: a Newbie's replies wait for a team lead's review, an Agent replies directly."
          action={canAdd ? { onClick: () => setAdding(true), label: "Add agent" } : undefined}
        />
      )}
      {data && data.agents.length > 0 && (
        <Card padding="none">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
            <ListFilter value={query} onChange={setQuery} label="Filter agents" placeholder="Filter by name…" shown={rows.length} total={data.agents.length} noun="agents" />
            <Select dense className="w-auto" aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as "" | HdRole)}>
              <option value="">All roles</option>
              {HD_ROLES.map((r) => (
                <option key={r} value={r}>
                  {HD_ROLE_LABEL[r]} ({data.counts[r] ?? 0})
                </option>
              ))}
            </Select>
            <Select dense className="w-auto max-w-56" aria-label="Filter by team" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="">All teams</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 sm:ml-auto">{summary}</p>
          </div>
          {rows.length === 0 ? (
            <SectionEmpty className="px-4 py-6">Nobody matches. Clear the filters to see everyone.</SectionEmpty>
          ) : (
            // 1.20.28: top-aligned, and stacked on a phone (STYLEGUIDE §Tables, "A table that stacks on a phone"): rows
            // were centred against a tall Teams cell, leaving a gap above each person, and the Role column was cut.
            <Table scroll minWidth="46rem" className="max-sm:block max-sm:min-w-0">
              <thead className={`${TABLE_HEAD_ROW} max-sm:hidden`}>
                <tr>
                  <Th>Person</Th>
                  <Th fit>Role</Th>
                  <Th>Teams</Th>
                  <Th fit>Availability</Th>
                  <Th fit className="relative">
                    {/* relative: the sr-only label stays inside the table's scroll box on a phone */}
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="max-sm:block">
                {rows.map((a) => {
                  const options = me ? HD_ROLES.filter((r) => me.assignable_roles.includes(r) || r === a.role) : [a.role];
                  const leads = a.lead_team_ids.map((t) => teamName.get(t)).filter(Boolean) as string[];
                  const avail = AVAILABILITY[a.availability] ?? AVAILABILITY.available;
                  return (
                    <tr key={a.user_id} className={`${TR} ${STACK_ROW}`} data-testid="agent-row">
                      <Td className={`${STACK_CELL} max-sm:col-start-1 max-sm:row-start-1`}>
                        <span className="flex min-w-0 items-center gap-3">
                          <UserAvatar name={a.name} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-800">{a.name}</span>
                            {a.email && <span className="block truncate text-xs text-slate-500">{a.email}</span>}
                          </span>
                        </span>
                      </Td>
                      <Td fit className={`${STACK_CELL} max-sm:col-start-1 max-sm:row-start-2`}>
                        {a.manageable && !a.locked ? (
                          <Select
                            dense
                            className="w-auto"
                            aria-label={`Desk role of ${a.name}`}
                            value={a.role}
                            disabled={busyId === a.user_id}
                            onChange={(e) => changeRole(a, e.target.value as HdRole)}
                          >
                            {options.map((r) => (
                              <option key={r} value={r}>
                                {HD_ROLE_LABEL[r]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <RoleChip role={a.role} fromWorkspace={a.locked} />
                        )}
                      </Td>
                      <Td className={`${STACK_CELL} max-sm:col-span-2 max-sm:row-start-3`}>
                        {a.team_ids.length === 0 ? (
                          <span className="text-xs text-slate-500">{a.role === "manager" || a.role === "admin" ? "Every team" : "No team yet"}</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {a.team_ids.map((t) => (
                              <Chip key={t} tone="neutral" size="sm">
                                {teamName.get(t) ?? `Team ${t}`}
                              </Chip>
                            ))}
                          </span>
                        )}
                        {leads.length > 0 && <span className="mt-1 block text-xs text-slate-500">Lead of {leads.join(", ")}</span>}
                      </Td>
                      <Td fit className={`${STACK_CELL} max-sm:col-start-2 max-sm:row-start-2 max-sm:justify-self-end`}>
                        <Chip tone={avail.tone} size="sm">
                          {avail.label}
                        </Chip>
                      </Td>
                      <Td fit className={`${STACK_CELL} max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end`}>
                        {a.manageable && (
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setEditingTeams(a)}
                              disabled={busyId === a.user_id}
                              aria-label={`Change ${a.name}'s teams`}
                              data-tt="Teams"
                              className={iconButtonClass("quiet", "sm")}
                            >
                              <Pencil aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(a)}
                              disabled={busyId === a.user_id}
                              aria-label={`Remove ${a.name} from the desk`}
                              data-tt="Remove"
                              className={iconButtonClass("quiet", "sm", "hover-danger")}
                            >
                              <UserMinus aria-hidden />
                            </button>
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {me && (
        <p className="mt-4 text-sm text-slate-500">
          {me.caps.includes("agents.assign_roles")
            ? me.role === "admin"
              ? "You can give any role."
              : `You can give roles up to ${HD_ROLE_LABEL[me.assignable_roles.at(-1) ?? "agent"]}.`
            : "You can add Newbies and Agents to your teams, move them between the two, and remove them from your teams."}{" "}
          What each role can do is on the Roles page.
        </p>
      )}
      {data && me && (
        <AddAgentModal
          open={adding}
          onClose={() => setAdding(false)}
          me={me}
          teams={data.teams}
          onDesk={new Set(data.agents.filter((a) => a.source !== "derived").map((a) => a.user_id))}
          limit={{
            // 1.22.0: with a plan, adds are held at its maximum with the buffer instead of the licence's `agents`.
            full: data.plan ? data.plan.hold_at !== null && data.used >= data.plan.hold_at : data.enforced && data.allowed !== null && data.used >= data.allowed,
            allowed: data.plan ? data.plan.hold_at : data.allowed,
            buyUrl: data.buy_url,
            counted: new Set(data.agents.map((a) => a.user_id)),
            plan: data.plan,
          }}
          onLimit={reload}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {data && me && editingTeams && (
        <TeamsModal
          agent={editingTeams}
          me={me}
          teams={data.teams}
          onClose={() => setEditingTeams(null)}
          onSaved={() => {
            setEditingTeams(null);
            reload();
          }}
        />
      )}
    </PageContainer>
  );
}

/** "Buy more agents ↗" to the licence's purchase page, in a new tab. */
function BuyAgentsLink({ href, className = "" }: { href: string; className?: string }) {
  return (
    <a className={`link inline-flex items-center gap-1 font-medium ${className}`} href={href} target="_blank" rel="noopener noreferrer">
      Buy more agents
      <ExternalLink className="h-3 w-3" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** The licence's agent allowance under the page header: the meter, and a warning past it. */
function AgentAllowance({ d }: { d: AgentsData }) {
  if (d.licensed === null) {
    // 1.20.27: no count here; the list's filter says it right under ("82 agents" twice, 40px apart).
    return <p className="mb-4 text-sm text-slate-500">Unlimited agents on your license.</p>;
  }
  // In grace nothing is refused: no warning, the meter's text says so (and by how much it will be over).
  const grace = !d.enforced;
  const muted = [
    "on your license",
    allowanceBreakdown(d.licensed),
    grace ? "not enforced while the license is in grace" : "",
    grace && d.over > 0 ? `over by ${d.over} once renewed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Adding someone new needs one place more than the desk is over by.
  const need = d.over + 1;
  return (
    <>
      {d.over > 0 && !grace && (
        <div className="notice-warn mb-4 flex gap-2 rounded-lg border px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <b>
              {d.used} people work the desk and your license includes {d.licensed}.
            </b>{" "}
            Nobody loses access. To add someone new, buy {need} more {need === 1 ? "agent" : "agents"} or take {need} {need === 1 ? "person" : "people"} off
            the desk.
          </p>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-xs">
        <UsersRound className="h-4 w-4 text-slate-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold text-slate-900">
              {d.used} of {agentsNoun(d.licensed)}
            </span>
            <span className="text-slate-500">{muted}</span>
          </div>
          <UsageMeter className="mt-2" value={d.used} max={d.licensed} warnOver={!grace} label="Helpdesk agents in use" />
        </div>
        <BuyAgentsLink href={d.buy_url} className="text-sm" />
      </div>
    </>
  );
}

/**
 * 1.22.0 (design C): the Agents page's meter on a CompassDocs Cloud plan:
 * "3 of 3 agents · included in Starter · $9.99/mo each beyond that", the bar
 * to the plan's maximum with its buffer, and no "Buy more agents" (extra
 * agents are added here, at their price).
 */
function PlanAgentsMeter({ p }: { p: PlanAgents }) {
  const limit = p.max ?? Math.max(p.included, 1);
  const end = p.hold_at ?? limit * 1.2;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-xs" data-testid="plan-agents-meter">
      <UsersRound className="h-4 w-4 text-slate-500" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold text-slate-900">
            {p.used} of {agentsNoun(p.included)}
          </span>
          <span className="text-slate-500">
            included in {p.label} · {usd(p.monthly_usd)}/mo each beyond that{p.max !== null ? ` · up to ${p.max}` : ""}
          </span>
        </div>
        <PlanMeter
          className="mt-2 max-w-md"
          value={p.used}
          limit={limit}
          end={end}
          label="Helpdesk agents"
          valueText={`${p.used} agents: ${p.included} included${p.max !== null ? `, up to ${p.max}` : ""}`}
          marks={[{ at: p.included, label: `${p.included} included` }, ...(p.max !== null && p.max !== p.included ? [{ at: p.max, label: `${p.max} max` }] : [])]}
        />
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * 1.22.0 (design C1–C3): what adding one more agent means on the plan.
 * "held": at the maximum with its buffer (C3); "buffer": past the maximum,
 * within the buffer (C2); "extra": past the included agents (C1); null:
 * within the included ones, nothing changes from today's dialog.
 */
function planStep(p: PlanAgents | undefined, adding: boolean): "held" | "buffer" | "extra" | null {
  if (!p || !adding) return null;
  if (p.hold_at !== null && p.used >= p.hold_at) return "held";
  if (p.max !== null && p.used >= p.max) return "buffer";
  if (p.used >= p.included) return "extra";
  return null;
}

/** The teams a viewer may tick: every team for Managers/Admins, their own for a Team lead. */
function allowedTeams(me: HdCapsView, teams: TeamLite[]): TeamLite[] {
  if (me.caps.includes("agents.assign_roles") || me.caps.includes("teams.manage")) return teams;
  return teams.filter((t) => me.team_ids.includes(t.id));
}

function TeamChecks({ teams, value, onChange, legend }: { teams: TeamLite[]; value: number[]; onChange: (ids: number[]) => void; legend: string }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-500">{legend}</legend>
      {teams.length === 0 ? (
        <SectionEmpty action={{ href: "/desk/settings/teams", label: "Open Teams" }}>No teams yet. Create them on the Teams page first.</SectionEmpty>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {teams.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={value.includes(t.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))}
              />
              {t.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function AddAgentModal({
  open,
  onClose,
  me,
  teams,
  onDesk,
  limit,
  onLimit,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  me: HdCapsView;
  teams: TeamLite[];
  onDesk: Set<number>;
  limit: AgentLimitView;
  /** The server refused for the allowance: refresh the page's numbers (the meter, the disabled state). */
  onLimit: () => void;
  onAdded: () => void;
}) {
  const titleId = useId();
  const people = usePeople();
  const [who, setWho] = useState<number | null>(null);
  const [role, setRole] = useState<HdRole>("newbie");
  const [teamIds, setTeamIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** The server's 402 (someone took the last place meanwhile): shown with the purchase link. */
  const [limitError, setLimitError] = useState("");
  const allowed = allowedTeams(me, teams);
  const lead = !me.caps.includes("agents.assign_roles");
  // Every place taken: only someone already counted (a workspace agent given a desk role) can still be added.
  const blocked = limit.full && !(who !== null && limit.counted.has(who));
  // 1.22.0: a CompassDocs Cloud plan's price step (design C).
  const adding = !(who !== null && limit.counted.has(who));
  const step = planStep(limit.plan, adding);

  useEffect(() => {
    if (!open) return;
    setWho(null);
    setRole(me.assignable_roles.includes("newbie") ? "newbie" : me.assignable_roles[0] ?? "newbie");
    setTeamIds(lead && allowed.length === 1 ? [allowed[0].id] : []);
    setError("");
    setLimitError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const person = people?.find((p) => p.id === who);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Held (every place taken): the button is aria-disabled and the notice says why; nothing is sent.
    if (blocked) return;
    if (!who) return setError("Choose who to add.");
    if (lead && !teamIds.length) return setError("Choose at least one of your teams.");
    setBusy(true);
    setError("");
    setLimitError("");
    try {
      await sendJson(
        "/api/helpdesk/admin/agents",
        "POST",
        // 1.22.0: an extra agent's price was shown on the button: the add confirms it.
        { user_id: who, role, team_ids: teamIds, ...(step === "extra" || step === "buffer" ? { confirm_extra: true } : {}) },
        "Couldn't add them."
      );
      toast("ok", `${person?.name || person?.username || "They"} joined the desk as ${HD_ROLE_LABEL[role]}.`);
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 402 && err.code === "agent_limit") {
        setLimitError(err.message);
        onLimit();
      } else if (err instanceof ApiError && err.code === "confirm_price") {
        // Someone else added an agent meanwhile: the price step now applies. Show it.
        setError("The desk changed while this was open: check the price below and add them again.");
        onLimit();
      }
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Add agent
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">Put someone on the desk at a level, in the teams whose queues they work.</p>
        {limit.plan && step === "held" && !limitError && <PlanHeld p={limit.plan} />}
        {(limitError || (limit.full && limit.allowed !== null && !limit.plan)) && (
          <div className="notice-warn mt-3 flex gap-2 rounded-lg border px-3 py-2 text-sm" role={limitError ? "alert" : undefined}>
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              {limitError ? (
                <p>{limitError}</p>
              ) : (
                <p>
                  <b>{limit.allowed === 1 ? "The 1 agent on your license is in use." : `All ${limit.allowed} agents on your license are in use.`}</b> Buy more agents to add someone, or take someone off the desk first.
                </p>
              )}
              {!limit.plan && <BuyAgentsLink href={limit.buyUrl} className="mt-1" />}
            </div>
          </div>
        )}
        {/* 1.22.0: held at the plan's limit (design C3): the notice and the comparison stand in for the fields. */}
        <div className={`mt-4 space-y-4 ${limit.plan && step === "held" ? "hidden" : ""}`}>
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Person</p>
            {person ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="truncate font-medium text-slate-800">{person.name || person.username}</span>
                <button type="button" className="link text-xs" onClick={() => setWho(null)}>
                  Change
                </button>
              </div>
            ) : (
              <EntityPicker
                options={(people ?? []).filter((p) => !onDesk.has(p.id)).map(personOption)}
                onPick={(id) => setWho(id)}
                label="Person"
                placeholder="Search people…"
              />
            )}
          </div>
          <Field label="Role" help={HD_ROLE_DESCRIPTION[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as HdRole)}>
              {me.assignable_roles.map((r) => (
                <option key={r} value={r}>
                  {HD_ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <TeamChecks teams={allowed} value={teamIds} onChange={setTeamIds} legend={lead ? "Your teams" : "Teams (optional for Managers and Admins)"} />
          {limit.plan && step === "buffer" && <PlanBuffer p={limit.plan} />}
          {limit.plan && (step === "extra" || step === "buffer") && <PlanPrice p={limit.plan} inBuffer={step === "buffer"} />}
          {error && <FormError>{error}</FormError>}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {limit.plan && step === "held" && limit.plan.next && (
            <a href="/admin/plan#upgrade" className={buttonClass("primary")}>
              <ArrowUpRight className="h-4 w-4" aria-hidden />
              {limit.plan.next.name === "dedicated" ? "Talk to us about Dedicated" : `Upgrade to ${limit.plan.next.label}`}
            </a>
          )}
          <Button
            type="submit"
            busy={busy}
            variant={limit.plan && step === "held" ? "secondary" : "primary"}
            disabled={blocked && !limit.plan}
            aria-disabled={blocked && limit.plan ? true : undefined}
            aria-describedby={blocked && limit.plan ? "plan-held-reason" : undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            icon={<Plus />}
          >
            {limit.plan && (step === "extra" || step === "buffer") ? `Add to desk · ${usd(limit.plan.monthly_usd)}/mo` : "Add to desk"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** C1: the price box. Past the included agents the add costs $9.99/mo, prorated to the plan's renewal. */
function PlanPrice({ p, inBuffer }: { p: PlanAgents; inBuffer: boolean }) {
  const extraAfter = p.used + 1 - p.included;
  return (
    <div className="notice-info rounded-lg border px-3 py-2 text-sm" data-testid="plan-price">
      <p className="font-semibold">Adds an extra agent: {usd(p.monthly_usd)}/mo, prorated.</p>
      <p className="mt-0.5 text-xs">
        {inBuffer
          ? `With this one, ${extraAfter} extra ${extraAfter === 1 ? "agent" : "agents"}: ${usd(extraAfter * p.monthly_usd)} a month.`
          : `${p.used === p.included ? `All ${p.included} agents included in ${p.label} are in use.` : `${p.label} includes ${p.included} agents.`} About ${usd(p.proration.nowUsd)} is charged now for the rest of your plan ${
              p.billing === "annual" ? `year (to ${shortDate(p.proration.until)})` : "month"
            }, then it renews with the plan.`}
      </p>
    </div>
  );
}

/** C2: past the plan's maximum, inside the buffer: the add still works, and we talk. */
function PlanBuffer({ p }: { p: PlanAgents }) {
  const left = (p.hold_at ?? p.used) - p.used;
  return (
    <div className="notice-warn flex gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="plan-buffer">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        <b>
          This is your {ordinal(p.used + 1)} agent; {p.label} goes up to {p.max}.
        </b>{" "}
        You can add {left} more while we talk{p.next ? ` about ${p.next.label}` : ""}
        {p.next && p.next.max !== null ? `, which includes ${p.next.included} agents and goes up to ${p.next.max}` : ""}.
      </p>
    </div>
  );
}

/** C3: at the maximum with its buffer, new agents are held; nobody already on the desk is removed. */
function PlanHeld({ p }: { p: PlanAgents }) {
  const extraNow = Math.max(0, p.used - p.included);
  const n = p.next;
  const extraNext = n ? Math.max(0, p.used - n.included) : 0;
  return (
    <>
      <div className="notice-warn mt-3 flex gap-2 rounded-lg border px-3 py-2 text-sm" role="note" id="plan-held-reason" data-testid="plan-held">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          <b>
            This workspace has {p.used} agents, {p.label}'s limit with its buffer.
          </b>{" "}
          Everyone on the desk keeps working. To add more, {n ? `move to ${n.label}${n.max !== null ? ` (up to ${n.max} agents)` : ""}` : "talk to CompassDocs"}, or take someone off the desk first.
        </p>
      </div>
      {n && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="text-xs text-slate-500">{p.label} now</p>
            <p className="font-semibold text-slate-900">{p.used} agents</p>
            <p className="text-xs text-slate-600">
              {usdShort(p.price_usd)} + {extraNow} × {usd(p.monthly_usd)}
            </p>
            <p className="text-xs text-slate-600">{usd(p.price_usd + extraNow * p.monthly_usd)}/mo</p>
          </div>
          <div className="rounded-lg border border-compass-300 bg-compass-50/60 p-3 text-sm dark:border-compass-500">
            <p className="text-xs text-slate-500">{n.label}</p>
            <p className="font-semibold text-slate-900">{p.used} agents</p>
            <p className="text-xs text-slate-600">
              {usdShort(n.price_usd)} + {extraNext} × {usd(p.monthly_usd)}
            </p>
            <p className="text-xs text-slate-600">{usd(n.price_usd + extraNext * p.monthly_usd)}/mo</p>
          </div>
        </div>
      )}
    </>
  );
}

function TeamsModal({ agent, me, teams, onClose, onSaved }: { agent: AgentRow; me: HdCapsView; teams: TeamLite[]; onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const allowed = allowedTeams(me, teams);
  const [teamIds, setTeamIds] = useState<number[]>(agent.team_ids.filter((t) => allowed.some((a) => a.id === t)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const outside = agent.team_ids.filter((t) => !allowed.some((a) => a.id === t));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await sendJson(`/api/helpdesk/admin/agents/${agent.user_id}`, "PATCH", { team_ids: teamIds }, "Couldn't change their teams.");
      toast("ok", `${agent.name}'s teams saved.`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {agent.name}&rsquo;s teams
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        They work these teams&rsquo; queues.{agent.role === "team_lead" ? " As a Team lead, they lead every team they belong to." : ""}
      </p>
      <div className="mt-4">
        <TeamChecks teams={allowed} value={teamIds} onChange={setTeamIds} legend="Teams" />
        {outside.length > 0 && <p className="mt-2 text-xs text-slate-500">They are also in {outside.length === 1 ? "a team" : `${outside.length} teams`} you don&rsquo;t manage; those stay as they are.</p>}
        {error && <FormError className="mt-3">{error}</FormError>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button busy={busy} onClick={save}>
          Save teams
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
