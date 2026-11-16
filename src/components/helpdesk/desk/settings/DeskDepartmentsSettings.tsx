"use client";

// 1.20.23: Desk settings → Teams → Desk departments (desk Admin; STYLEGUIDE
// §Helpdesk: desk departments). A desk department groups teams (each team is
// in exactly one) and holds their macros, canned responses, checklists,
// workflows, request types and automations; agents see their departments'
// and those shared with all departments. Not the requester's directory
// department (VIP lists, contact cards), which is the directory's.
//
//   Desk departments   each with its teams and what it holds, Rename, and
//                      Delete: refused while teams are in it (move them
//                      first); content still in it moves to a department
//                      picked in the dialog. The default department (General
//                      on upgrade) can be renamed, never deleted.
//   Which team is in which   one row per team with a Select: moving a team
//                      takes its own team macros and canned responses along,
//                      nothing else; its tickets meet the new department's
//                      automations from then on. Review M5: when the move
//                      changes what applies to the team, a dialog lists it
//                      (AffectedList) and the move waits for confirm; a move
//                      that would break an automation is refused with the
//                      server's sentence naming it.

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Building2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Field, FormError, SectionEmpty, Select } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { DESK_DEPARTMENT_LIMITS, type HdDeskDepartmentCounts, type HdDeskDepartmentRow } from "@/lib/helpdesk/desk-departments-shared";
import { getJson, listOf, noteDuoRequired, sendJson } from "../api";
import { deskDepartmentsChanged } from "./DeskDepartmentField";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** "2 teams · 12 macros · 3 automations" (what it holds, non-zero only). */
function holds(d: HdDeskDepartmentRow): string {
  const c: HdDeskDepartmentCounts = d.counts;
  const parts = [
    plural(d.teams.length, "team"),
    c.macros && plural(c.macros, "macro"),
    c.canned && plural(c.canned, "canned response"),
    c.checklists && plural(c.checklists, "checklist"),
    c.workflows && plural(c.workflows, "workflow"),
    c.request_types && plural(c.request_types, "request type"),
    c.automations && plural(c.automations, "automation"),
    c.recurring && plural(c.recurring, "recurring ticket"),
  ].filter(Boolean);
  return parts.join(" · ");
}

const contentCount = (d: HdDeskDepartmentRow) => d.counts.macros + d.counts.canned + d.counts.checklists + d.counts.workflows + d.counts.request_types + d.counts.automations;

export function DeskDepartmentsSettings() {
  const [rows, setRows] = useState<HdDeskDepartmentRow[] | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<HdDeskDepartmentRow | null>(null);
  const [moving, setMoving] = useState<number | null>(null);

  const load = () =>
    getJson<{ departments: HdDeskDepartmentRow[] }>("/api/helpdesk/admin/desk-departments", "Couldn't load the desk departments.")
      .then((d) => {
        setRows(listOf<HdDeskDepartmentRow>(d, "departments"));
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const changed = () => {
    deskDepartmentsChanged();
    return load();
  };

  async function create() {
    const name = await promptDialog({
      title: "New desk department",
      body: "A group of teams with its own macros, canned responses, checklists, workflows and automations, like HR or Facilities. You move teams into it next.",
      label: "Name",
      placeholder: "Human resources",
      confirmLabel: "Create desk department",
      validate: (v) => (v.trim().length > DESK_DEPARTMENT_LIMITS.name ? `Up to ${DESK_DEPARTMENT_LIMITS.name} characters.` : undefined),
    });
    if (!name) return;
    try {
      await sendJson("/api/helpdesk/admin/desk-departments", "POST", { name: name.trim() }, "Couldn't create the desk department.");
      toast("ok", `${name.trim()} created. Move its teams into it below.`);
      await changed();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function rename(d: HdDeskDepartmentRow) {
    const name = await promptDialog({ title: `Rename ${d.name}`, label: "Name", initial: d.name, confirmLabel: "Rename" });
    if (!name || name.trim() === d.name) return;
    try {
      await sendJson(`/api/helpdesk/admin/desk-departments/${d.id}`, "PATCH", { name: name.trim() }, "Couldn't rename the desk department.");
      toast("ok", "Desk department renamed.");
      await changed();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  /** Nothing in it: the usual confirm, then gone. Teams or content in it: the dialog says what first. */
  async function startDelete(d: HdDeskDepartmentRow) {
    if (d.teams.length || contentCount(d)) return setDeleting(d);
    const ok = await confirmDialog({ title: `Delete ${d.name}?`, body: "It holds no teams and no content. This cannot be undone.", confirmLabel: "Delete desk department", danger: true });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/desk-departments/${d.id}`, "DELETE", undefined, "Couldn't delete the desk department.");
      toast("ok", `${d.name} deleted.`);
      await changed();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function moveTeam(teamId: number, teamName: string, from: number, to: number) {
    const target = rows?.find((d) => d.id === to);
    const source = rows?.find((d) => d.id === from);
    setMoving(teamId);
    try {
      const url = `/api/helpdesk/admin/desk-departments/${to}/teams`;
      let r = await putTeamMove(url, { team_id: teamId });
      // Review M5: what stops applying to the team is shown and confirmed before it moves.
      if (r.status === 409 && r.data.code === "confirm_team_move" && r.data.affected) {
        const ok = await confirmDialog({
          title: `Move ${teamName} to ${target?.name ?? "that desk department"}?`,
          body: <AffectedList affected={r.data.affected} from={source?.name ?? "its desk department"} to={target?.name ?? "the new one"} />,
          confirmLabel: "Move team",
        });
        if (ok !== true) return;
        r = await putTeamMove(url, { team_id: teamId, confirm: true });
      }
      if (!r.ok) throw new Error(r.data.error || "Couldn't move the team.");
      const own = r.data.moved ? r.data.moved.macros + r.data.moved.canned : 0;
      toast("ok", `${teamName} is now in ${target?.name ?? "that desk department"}.${own ? ` Its ${plural(own, "team macro or canned response", "team macros and canned responses")} went with it.` : ""}`);
      await changed();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setMoving(null);
    }
  }

  const teams = (rows ?? []).flatMap((d) => d.teams.map((t) => ({ ...t, dept: d.id }))).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <PageContainer>
      <PageHeader
        icon={<Building2 />}
        title="Desk departments"
        subtitle="Group teams, and the macros, canned responses, checklists, workflows and automations they use. Agents see their own desk departments' and those shared with all departments."
        actions={
          <Button icon={<Plus />} onClick={create}>
            New desk department
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rows === null && !error && <LoadingRow className="py-10" />}
      {rows && (
        <>
          <Card id="desk-departments" padding="none" title="Desk departments" description="New teams and new content start in the default one. Admins see every department; a team's agents see their own." className="mb-6 scroll-mt-6">
            <ul role="list" className="divide-y divide-slate-100" data-testid="hd-desk-departments">
              {rows.map((d) => (
                <li key={d.id} className="flex items-start gap-3 px-4 py-3" data-testid="hd-desk-department-row">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                    <Building2 className="h-4.5 w-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{d.name}</span>
                      {d.is_default && (
                        <Chip tone="neutral" size="sm">
                          Default
                        </Chip>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">{holds(d)}</span>
                  </span>
                  <button type="button" onClick={() => rename(d)} aria-label={`Rename ${d.name}`} data-tt="Rename" className={iconButtonClass("quiet", "sm")}>
                    <Pencil aria-hidden />
                  </button>
                  {!d.is_default && (
                    <button type="button" onClick={() => void startDelete(d)} aria-label={`Delete ${d.name}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                      <Trash2 aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card
            id="desk-department-teams"
            className="scroll-mt-6"
            padding="none"
            title="Which team is in which desk department"
            description="A team is in one desk department. Moving it takes its own team macros and canned responses along; everything else stays. Its tickets meet the new department's automations from then on."
          >
            {teams.length === 0 ? (
              <SectionEmpty className="px-4 py-6" action={{ href: "/desk/settings/teams", label: "Add a team" }}>
                No teams yet. Each team you add starts in the default desk department.
              </SectionEmpty>
            ) : (
              <ul role="list" className="divide-y divide-slate-100" data-testid="hd-desk-department-teams">
                {teams.map((t) => (
                  <TeamRow key={t.id} team={t} departments={rows} busy={moving === t.id} onMove={(to) => moveTeam(t.id, t.name, t.dept, to)} />
                ))}
              </ul>
            )}
          </Card>
          <p className="mt-4 text-sm text-slate-500">
            Queues don&apos;t change: an agent still works their teams&apos; tickets. This is not the requester&apos;s department from the directory, which{" "}
            <Link href="/desk/settings/contact-cards" className="link">
              contact cards
            </Link>{" "}
            and reports use.
          </p>
        </>
      )}
      <DeleteDialog
        department={deleting}
        others={(rows ?? []).filter((d) => d.id !== deleting?.id)}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          void changed();
        }}
      />
    </PageContainer>
  );
}

type Ref = { id: number; title: string };

/** What a team move changes (the route's `affected`, lib/helpdesk/desk-departments TeamMoveImpact). */
interface TeamMoveAffected {
  rules: Ref[];
  request_types: Ref[];
  checklists: Ref[];
  workflows: Ref[];
  recurring: Ref[];
  agents: Ref[];
}

interface TeamMoveAnswer {
  error?: string;
  code?: string;
  affected?: TeamMoveAffected;
  moved?: { macros: number; canned: number } | null;
}

/** PUT a team move, keeping the 409's body (the list to confirm), which sendJson drops. */
async function putTeamMove(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: TeamMoveAnswer }> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const data = ((await res.json().catch(() => ({}))) ?? {}) as TeamMoveAnswer;
  noteDuoRequired(res.status, data.code);
  return { ok: res.ok, status: res.status, data };
}

/** Review M5: the move dialog's list, one group per kind, non-empty only. */
function AffectedList({ affected, from, to }: { affected: TeamMoveAffected; from: string; to: string }) {
  const groups: [string, Ref[]][] = [
    [`Automations of other desk departments that name the team stop running on its tickets`, affected.rules],
    [`Request types of other desk departments still route to it`, affected.request_types],
    [`Checklists of other desk departments still give it items`, affected.checklists],
    [`Workflows of other desk departments still route to it`, affected.workflows],
    [`Its recurring tickets use a request type ${to} doesn't see`, affected.recurring],
    [`Its agents who lose ${from}'s content (macros, canned responses, checklists, workflows)`, affected.agents],
  ];
  return (
    <div className="space-y-3 text-sm" data-testid="hd-team-move-affected">
      <p className="text-slate-600">Its team macros and canned responses go with it. This changes too:</p>
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <div key={label}>
            <p className="font-medium text-slate-900">{label}</p>
            <ul role="list" className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
              {list.slice(0, 8).map((r) => (
                <li key={r.id}>{r.title}</li>
              ))}
              {list.length > 8 && <li>and {plural(list.length - 8, "more", "more")}</li>}
            </ul>
          </div>
        ))}
    </div>
  );
}

function TeamRow({
  team,
  departments,
  busy,
  onMove,
}: {
  team: { id: number; name: string; dept: number };
  departments: HdDeskDepartmentRow[];
  busy: boolean;
  onMove: (to: number) => void;
}) {
  const id = useId();
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="hd-desk-department-team">
      <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
        {team.name}
      </label>
      <Select id={id} dense value={team.dept} disabled={busy} onChange={(e) => onMove(Number(e.target.value))} className="w-auto min-w-48">
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
    </li>
  );
}

function DeleteDialog({
  department,
  others,
  onClose,
  onDeleted,
}: {
  department: HdDeskDepartmentRow | null;
  others: HdDeskDepartmentRow[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const titleId = useId();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstChoice = String(others.find((d) => d.is_default)?.id ?? others[0]?.id ?? "");
  const deptId = department?.id ?? null;
  useEffect(() => {
    setTo(firstChoice);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when another department's dialog opens
  }, [deptId]);

  if (!department) return null;
  const hasTeams = department.teams.length > 0;

  async function remove() {
    if (!department) return;
    setBusy(true);
    setError("");
    try {
      await sendJson(`/api/helpdesk/admin/desk-departments/${department.id}?move_content_to=${encodeURIComponent(to)}`, "DELETE", undefined, "Couldn't delete the desk department.");
      toast("ok", `${department.name} deleted. Its content is in ${others.find((d) => String(d.id) === to)?.name ?? "the other desk department"} now.`);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          Delete {department.name}?
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      {hasTeams ? (
        <p className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm" role="note">
          Move its {plural(department.teams.length, "team")} ({department.teams.map((t) => t.name).join(", ")}) to another desk department first, under Which team is in which. A team is
          always in a department.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">It still holds {holds(department).replace(/^0 teams · /, "")}. Choose where they go; nothing else changes.</p>
          <Field label="Move its content to">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <FormError>{error}</FormError>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {hasTeams ? "Close" : "Cancel"}
        </Button>
        {!hasTeams && (
          <Button variant="danger" busy={busy} onClick={remove} disabled={!to}>
            Move content and delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
