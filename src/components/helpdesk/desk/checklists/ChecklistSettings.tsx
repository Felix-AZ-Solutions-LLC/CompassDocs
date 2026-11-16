"use client";

// Desk settings → Checklists (1.19.2, agent W3; mock-up c2): the checklist
// library. A house table of templates (Checklist · Items · Added
// automatically to · Used), each row a button that opens it in the editor
// card under the table ("Editing · Leaver: IT"). The editor holds the name,
// the items (a grip that drags with a pointer and opens Move up / Move down
// from the keyboard, the title in place, a warn **Required** chip, the owner
// team and due offset as quiet text, an item settings popover and remove),
// Add item, and the request types that add it to every new request. Workflow
// tasks add checklists from the workflow builder's Task step; those uses are
// listed read-only. Tickets keep the copy they got: editing a template never
// changes a ticket.
//
// 1.20.14: drafts from Claude. A new checklist Claude drafted is unpublished
// (a "Draft from Claude" chip in the table): its editor opens with the dashed
// draft strip and Discard draft / Save draft / Publish checklist. Changes
// Claude proposed to a published checklist ("Changes from Claude") open in
// the editor in place of the live copy, with Discard changes / Publish
// changes; until then tickets and request types use the live copy.
// ?id=<checklist> opens that checklist (the links Claude hands out).
//
// 1.20.23: each checklist is in a desk department (or All departments, a desk
// Admin's choice): the editor's Desk department field, the list's filter and
// chip (settings/DeskDepartmentField). Agents add only their departments'
// (and All departments') by hand. One the person can't change opens read-only.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bot, GripVertical, ListChecks, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EYEBROW_TEXT } from "@/components/Heading";
import { EmptyState, Field, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { MenuItem, Popover } from "@/components/Popover";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, TD, TH } from "@/components/Table";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  CHECKLIST_LIMITS,
  DUE_DAY_CHOICES,
  dueDaysLabel,
  hasClaudeDraft,
  newItemKey,
  type HdChecklistTemplate,
  type HdChecklistTemplateItem,
  type HdChecklistTemplateRow,
} from "@/lib/helpdesk/checklists-shared";
import { getJson, sendJson } from "../api";
import {
  DeskDepartmentChip,
  DeskDepartmentFilter,
  DeskDepartmentSelect,
  byDeskDepartment,
  deptPayload,
  deptValue,
  deskDepartmentsChanged,
  useDeskDepartmentChoices,
} from "../settings/DeskDepartmentField";
import { deskDepartmentLabel, type HdDeskDepartmentChoices } from "@/lib/helpdesk/desk-departments-shared";

interface View {
  templates: HdChecklistTemplateRow[];
  teams: { id: number; name: string }[];
  request_types: { id: number; title: string; active: number }[];
}

interface Draft {
  name: string;
  items: HdChecklistTemplateItem[];
  request_type_ids: number[];
}

const EMPTY: Draft = { name: "", items: [{ key: "i1", title: "" }], request_type_ids: [] };

export function ChecklistSettings() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<number | "new" | null>(null);
  const depts = useDeskDepartmentChoices("checklists");
  const [deptFilter, setDeptFilter] = useState("");

  const load = () =>
    getJson<View>("/api/helpdesk/admin/checklists", "Couldn't load the checklists.")
      .then((d) => {
        setView(d);
        setError("");
        // 1.20.14: ?id= opens that checklist (a link from Claude) on the first load.
        let asked: number | null = null;
        try {
          asked = Number(new URLSearchParams(window.location.search).get("id")) || null;
        } catch {
          asked = null;
        }
        setChosen((c) =>
          c === null && asked && d.templates.some((t) => t.id === asked)
            ? asked
            : c === null || (typeof c === "number" && !d.templates.some((t) => t.id === c))
              ? d.templates[0]?.id ?? null
              : c
        );
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  function open(id: number | "new") {
    setChosen(id);
    setTimeout(() => document.getElementById("checklist-editor")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  }

  const current = typeof chosen === "number" ? view?.templates.find((t) => t.id === chosen) ?? null : null;
  const editorKey = chosen === "new" ? "new" : current ? `t${current.id}-${current.updated_at}-${current.draft_at ?? ""}-${current.published}` : "none";

  return (
    <PageContainer>
      <PageHeader
        icon={<ListChecks />}
        title="Checklists"
        subtitle="Reusable lists of steps. Add one to a ticket by hand, or have a request type or workflow task add it for you."
        actions={
          <Button icon={<Plus />} onClick={() => open("new")}>
            New checklist
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {!view && !error && <LoadingRow className="py-10" />}
      {view && view.templates.length === 0 && chosen !== "new" && (
        <EmptyState
          icon={<ListChecks />}
          title="No checklists yet"
          body="Write the steps your team repeats, like a new starter's accounts and laptop, once. Mark the ones that must be done before a ticket can be solved."
          action={{ onClick: () => open("new"), label: "New checklist", icon: <Plus /> }}
        />
      )}
      {view && view.templates.length > 0 && depts?.filter && (
        <div className="mb-3 flex justify-end">
          <DeskDepartmentFilter choices={depts} value={deptFilter} onChange={setDeptFilter} />
        </div>
      )}
      {view && view.templates.length > 0 && byDeskDepartment(view.templates, deptFilter).length === 0 && (
        <SectionEmpty className="mb-3" action={{ label: "Show every desk department", onClick: () => setDeptFilter("") }}>
          No checklist in this desk department.
        </SectionEmpty>
      )}
      {view && byDeskDepartment(view.templates, deptFilter).length > 0 && (
        <Card padding="none" className="overflow-hidden">
          <Table aria-label="Checklists" className="table-fixed">
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <th scope="col" className={`${TH} w-[38%] sm:w-[22%]`}>
                  Checklist
                </th>
                <th scope="col" className={`${TH} hidden w-20 sm:table-cell`}>
                  Items
                </th>
                <th scope="col" className={TH}>
                  Added automatically to
                </th>
                <th scope="col" className={`${TH} hidden w-28 sm:table-cell`}>
                  Used
                </th>
              </tr>
            </thead>
            <tbody>
              {byDeskDepartment(view.templates, deptFilter).map((t) => {
                const on = t.id === chosen;
                return (
                  <tr key={t.id} className={`relative border-b border-slate-100 transition-colors last:border-b-0 ${on ? "bg-compass-50" : "hover:bg-slate-50/70"}`}>
                    <td className={TD}>
                      <button
                        type="button"
                        onClick={() => open(t.id)}
                        aria-current={on ? "true" : undefined}
                        className="block w-full min-w-0 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-compass-500"
                      >
                        <span className="block truncate font-semibold text-slate-900">{t.name}</span>
                        {depts?.filter && (
                          <span className="mt-1 block">
                            <DeskDepartmentChip id={t.desk_department_id} choices={depts} />
                          </span>
                        )}
                        {hasClaudeDraft(t) && (
                          <span className="mt-1 block">
                            <span className={chipClass("accent", "sm")}>{t.published ? "Changes from Claude" : "Draft from Claude"}</span>
                          </span>
                        )}
                        <span className="mt-0.5 block text-xs text-slate-500 sm:hidden">
                          {t.items.length} items · {usedLabel(t.used)}
                        </span>
                      </button>
                    </td>
                    <td className={`${TD} hidden tabular-nums text-slate-600 sm:table-cell`}>{t.items.length}</td>
                    <td className={`${TD} text-slate-500`}>{t.added_to.length ? t.added_to.join("; ") : "Nothing (added by hand)"}</td>
                    <td className={`${TD} hidden whitespace-nowrap text-slate-500 sm:table-cell`}>{usedLabel(t.used)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      {view && (chosen === "new" || current) && (
        <Editor
          key={editorKey}
          template={current}
          teams={view.teams}
          types={view.request_types}
          workflowUses={current ? current.added_to.filter((a) => !a.startsWith("Request type ")) : []}
          depts={depts}
          onSaved={(t) => {
            setChosen(t.id);
            deskDepartmentsChanged();
            void load();
          }}
          onDeleted={() => {
            setChosen(null);
            void load();
          }}
          onCancelNew={() => setChosen(view.templates[0]?.id ?? null)}
        />
      )}
    </PageContainer>
  );
}

function usedLabel(n: number): string {
  return n === 0 ? "Not yet" : n === 1 ? "Once" : `${n} times`;
}

function Editor({
  template,
  teams,
  types,
  workflowUses,
  depts,
  onSaved,
  onDeleted,
  onCancelNew,
}: {
  template: (HdChecklistTemplate & { can_edit?: boolean }) | null;
  teams: View["teams"];
  types: View["request_types"];
  workflowUses: string[];
  depts: HdDeskDepartmentChoices | null;
  onSaved: (t: HdChecklistTemplate) => void;
  onDeleted: () => void;
  onCancelNew: () => void;
}) {
  // 1.20.14: changes Claude proposed are what the editor shows; publishing them is saving.
  const shown = template?.draft ?? template;
  const claude = template && hasClaudeDraft(template) ? template : null;
  const [draft, setDraft] = useState<Draft>(() =>
    shown ? { name: shown.name, items: shown.items.map((i) => ({ ...i })), request_type_ids: [...shown.request_type_ids] } : EMPTY
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 1.20.23: its desk department; a new one starts in the person's starting department.
  const [dept, setDept] = useState(deptValue(template ? template.desk_department_id : (depts?.default_id ?? null)));
  const startDept = depts?.default_id ?? null;
  useEffect(() => {
    if (!template) setDept(deptValue(startDept));
  }, [template, startDept]);
  const readOnly = template?.can_edit === false;
  const [drag, setDrag] = useState<string | null>(null);
  const titles = useRef(new Map<string, HTMLInputElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(draft));
  useLeaveGuard(dirty, hasUnsavedChanges);
  const teamName = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const change = (next: Draft) => {
    markDirty();
    setDraft(next);
  };
  const setItem = (key: string, patch: Partial<HdChecklistTemplateItem>) =>
    change({ ...draft, items: draft.items.map((i) => (i.key === key ? clean({ ...i, ...patch }) : i)) });
  const move = (key: string, by: number, focus = true) => {
    const i = draft.items.findIndex((x) => x.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= draft.items.length) return;
    const items = [...draft.items];
    const [it] = items.splice(i, 1);
    items.splice(j, 0, it);
    change({ ...draft, items });
    if (focus) setTimeout(() => grips.current.get(key)?.focus(), 0);
  };
  const addItem = () => {
    if (draft.items.length >= CHECKLIST_LIMITS.items) return;
    const key = newItemKey(draft.items.map((i) => i.key));
    change({ ...draft, items: [...draft.items, { key, title: "" }] });
    setTimeout(() => titles.current.get(key)?.focus(), 0);
  };
  const removeItem = (key: string) => change({ ...draft, items: draft.items.filter((i) => i.key !== key) });

  async function save(publish = false) {
    setError("");
    // 1.20.14 (review fix): publishing names the draft this editor showed (draft_at); a newer one is refused (409) so it is never published unseen.
    const publishing = publish && claude ? (claude.published ? { publish_draft: true, draft_at: claude.draft_at } : { publish: true, draft_at: claude.draft_at }) : {};
    const body = { ...draft, name: draft.name.trim(), items: draft.items.filter((i) => i.title.trim()), ...publishing, desk_department_id: deptPayload(dept) };
    if (!body.name) return setError("Give the checklist a name.");
    if (!body.items.length) return setError("Add at least one item.");
    setBusy(true);
    try {
      const r = template
        ? await sendJson<{ template: HdChecklistTemplate }>(`/api/helpdesk/admin/checklists/${template.id}`, "PUT", body, "Couldn't save the checklist.")
        : await sendJson<{ template: HdChecklistTemplate }>("/api/helpdesk/admin/checklists", "POST", body, "Couldn't create the checklist.");
      markClean(JSON.stringify(draft));
      toast(
        "ok",
        claude && !claude.published
          ? publish
            ? "Checklist published. Agents can add it now."
            : "Draft saved. It stays unpublished."
          : claude
            ? "Changes published. Tickets keep the copy they already have."
            : template
              ? "Checklist saved. Tickets keep the copy they already have."
              : "Checklist created."
      );
      onSaved(r.template);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!template) return onCancelNew();
    const unpublished = !template.published;
    const ok = await confirmDialog(
      unpublished
        ? { title: `Discard the draft ${template.name}?`, body: "It was never published, so no ticket has it.", confirmLabel: "Discard draft", danger: true }
        : {
            title: `Delete ${template.name}?`,
            body: "Tickets that already have it keep their copy. Request types stop adding it.",
            confirmLabel: "Delete checklist",
            danger: true,
          }
    );
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/checklists/${template.id}`, "DELETE", undefined, unpublished ? "Couldn't discard the draft." : "Couldn't delete the checklist.");
      markClean(JSON.stringify(draft));
      toast("ok", unpublished ? "Draft discarded." : "Checklist deleted.");
      onDeleted();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  /** 1.20.14: drop the changes Claude proposed; the published checklist stays as it is. */
  async function discardChanges() {
    if (!template) return;
    setBusy(true);
    try {
      const r = await sendJson<{ template: HdChecklistTemplate }>(`/api/helpdesk/admin/checklists/${template.id}`, "PUT", { discard_draft: true, draft_at: template.draft_at }, "Couldn't discard the changes.");
      markClean(JSON.stringify(draft));
      toast("ok", "Changes discarded. The published checklist is unchanged.");
      onSaved(r.template);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const activeTypes = types.filter((t) => t.active || draft.request_type_ids.includes(t.id));

  return (
    <Card id="checklist-editor" className="mt-4 scroll-mt-4">
      <h2 id="checklist-editor-h" className={EYEBROW_TEXT}>
        {template ? `${claude && !claude.published ? "Draft" : "Editing"} · ${template.name}` : "New checklist"}
      </h2>
      {claude && (
        <section
          aria-label="Draft from Claude"
          className="mt-3 rounded-xl border-[1.5px] border-dashed border-compass-300 bg-compass-50 p-3 dark:border-compass-500/50 dark:bg-compass-500/10"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-900 text-slate-50" aria-hidden>
              <Bot className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-slate-900">{claude.published ? "Changes from Claude" : "Draft from Claude"}</span>
            <span className="text-xs text-slate-500">
              {claude.draft_by_name ? `asked by ${claude.draft_by_name} · ` : ""}
              {claude.draft_at && <RelativeTime value={claude.draft_at} />}
              {claude.draft_at ? " · " : ""}not published
            </span>
          </div>
          <p className="mt-1.5 text-sm text-slate-700 sm:pl-9">
            {claude.published
              ? "Review the changes below. Tickets and request types use the published checklist until you publish them."
              : "Review it below. Nobody can add it to a ticket and nothing adds it automatically until you publish it."}
          </p>
        </section>
      )}
      {readOnly && (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" role="note">
          This checklist belongs to {deskDepartmentLabel(template?.desk_department_id, depts?.departments ?? [])}, which you don&apos;t manage. You can read it, not change it.
        </p>
      )}
      <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
        <Field label="Name">
          <TextInput value={draft.name} maxLength={CHECKLIST_LIMITS.name} onChange={(e) => change({ ...draft, name: e.target.value })} placeholder="Leaver: IT" />
        </Field>
        <DeskDepartmentSelect
          choices={depts}
          value={dept}
          onChange={(v) => {
            markDirty();
            setDept(v);
          }}
          disabled={readOnly}
        />
      </div>
      <ol aria-label="Items" className="mt-3">
        {draft.items.map((it, i) => (
          <li
            key={it.key}
            draggable={drag === it.key}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", it.key);
            }}
            onDragOver={(e) => {
              if (!drag || drag === it.key) return;
              e.preventDefault();
              const from = draft.items.findIndex((x) => x.key === drag);
              if (from >= 0 && from !== i) move(drag, i - from, false);
            }}
            onDragEnd={() => setDrag(null)}
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 py-1.5 ${drag === it.key ? "opacity-60" : ""}`}
          >
            <GripMenu
              label={it.title || `Item ${i + 1}`}
              first={i === 0}
              last={i === draft.items.length - 1}
              buttonRef={(el) => (el ? grips.current.set(it.key, el) : grips.current.delete(it.key))}
              onPointerDown={() => setDrag(it.key)}
              onPointerUp={() => setDrag(null)}
              onMove={(by) => move(it.key, by)}
            />
            <input
              ref={(el) => {
                if (el) titles.current.set(it.key, el);
                else titles.current.delete(it.key);
              }}
              value={it.title}
              maxLength={CHECKLIST_LIMITS.itemTitle}
              onChange={(e) => setItem(it.key, { title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (i === draft.items.length - 1) addItem();
                  else titles.current.get(draft.items[i + 1].key)?.focus();
                }
              }}
              aria-label={`Item ${i + 1}`}
              placeholder="What needs doing"
              className="min-w-0 flex-1 basis-48 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-200 focus:border-compass-500 focus:outline-none focus:ring-2 focus:ring-compass-500/20"
            />
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
              {it.required && <span className={chipClass("warn", "sm")}>Required</span>}
              {it.team_id && <span className="text-xs text-slate-500">{teamName.get(it.team_id) ?? "A deleted team"}</span>}
              {it.due_days !== undefined && it.due_days !== null && <span className="text-xs text-slate-500">{shortDue(it.due_days)}</span>}
              <ItemSettings item={it} teams={teams} onChange={(p) => setItem(it.key, p)} />
              <button
                type="button"
                onClick={() => removeItem(it.key)}
                disabled={draft.items.length === 1}
                aria-label={`Remove ${it.title || `item ${i + 1}`}`}
                data-tt="Remove"
                className={iconButtonClass("quiet", "sm", "hover-danger")}
              >
                <X aria-hidden />
              </button>
            </span>
          </li>
        ))}
      </ol>
      <Button variant="secondary" size="sm" icon={<Plus />} className="mt-3" onClick={addItem} disabled={draft.items.length >= CHECKLIST_LIMITS.items}>
        Add item
      </Button>

      <fieldset className="mt-6">
        <legend className="text-sm font-semibold text-slate-800">Add it automatically</legend>
        <p className="mt-0.5 text-xs text-slate-500">Every new request of these types gets this checklist. A workflow task adds checklists from its own settings in the workflow builder.</p>
        {activeTypes.length === 0 ? (
          <SectionEmpty className="mt-2">There are no request types yet.</SectionEmpty>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {activeTypes.map((t) => {
              const on = draft.request_type_ids.includes(t.id);
              return (
                <label
                  key={t.id}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
                    on ? "border-compass-300 bg-compass-50 text-compass-800" : "border-slate-200 text-slate-700 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      change({ ...draft, request_type_ids: on ? draft.request_type_ids.filter((x) => x !== t.id) : [...draft.request_type_ids, t.id] })
                    }
                    className="h-4 w-4 accent-compass-600"
                  />
                  {t.title}
                </label>
              );
            })}
          </div>
        )}
        {workflowUses.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-slate-600" aria-label="Workflow tasks that add it">
            {workflowUses.map((w) => (
              <li key={w} className="flex items-center gap-2">
                <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {error && <p className="notice-error mt-4 rounded-lg border px-3 py-2 text-sm" role="alert">{error}</p>}
      <div className={`mt-5 flex flex-wrap items-center justify-end gap-2 print:hidden ${readOnly ? "hidden" : ""}`}>
        <Button variant="ghost" icon={<Trash2 />} className="mr-auto hover-danger" onClick={remove}>
          {claude && !claude.published ? "Discard draft" : template ? "Delete" : "Cancel"}
        </Button>
        {dirty && <span className="text-sm text-amber-700 dark:text-amber-300">Unsaved changes</span>}
        {claude && !claude.published ? (
          <>
            <Button variant="secondary" busy={busy} onClick={() => save(false)}>
              Save draft
            </Button>
            <Button busy={busy} onClick={() => save(true)}>
              Publish checklist
            </Button>
          </>
        ) : claude ? (
          <>
            <Button variant="secondary" busy={busy} onClick={discardChanges}>
              Discard changes
            </Button>
            <Button busy={busy} onClick={() => save(true)}>
              Publish changes
            </Button>
          </>
        ) : (
          <Button busy={busy} onClick={() => save(false)}>
            {template ? "Save checklist" : "Create checklist"}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Drop unset optional fields so a saved template stays tidy. */
function clean(i: HdChecklistTemplateItem): HdChecklistTemplateItem {
  const out: HdChecklistTemplateItem = { key: i.key, title: i.title };
  if (i.required) out.required = true;
  if (i.team_id) out.team_id = i.team_id;
  if (i.due_days !== undefined && i.due_days !== null) out.due_days = i.due_days;
  return out;
}

function shortDue(d: number): string {
  return d === 0 ? "Due same day" : `Due +${d} ${d === 1 ? "day" : "days"}`;
}

/** The grip: drags with a pointer; from the keyboard it opens Move up / Move down. */
function GripMenu({
  label,
  first,
  last,
  buttonRef,
  onPointerDown,
  onPointerUp,
  onMove,
}: {
  label: string;
  first: boolean;
  last: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onMove: (by: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <span className="relative">
      <button
        ref={(el) => {
          ref.current = el;
          buttonRef(el);
        }}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${label}`}
        data-tt="Drag to move, or click for Move up and Move down"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={() => setOpen((o) => !o)}
        className={`${iconButtonClass("quiet", "sm")} cursor-grab active:cursor-grabbing`}
      >
        <GripVertical aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={ref} role="menu" label={`Move ${label}`} width="w-44">
        <MenuItem icon={<ArrowUp />} disabled={first} onClick={() => (setOpen(false), onMove(-1))}>
          Move up
        </MenuItem>
        <MenuItem icon={<ArrowDown />} disabled={last} onClick={() => (setOpen(false), onMove(1))}>
          Move down
        </MenuItem>
      </Popover>
    </span>
  );
}

/** Required, owner team and due offset for one item, in a popover. */
function ItemSettings({ item, teams, onChange }: { item: HdChecklistTemplateItem; teams: View["teams"]; onChange: (p: Partial<HdChecklistTemplateItem>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const name = item.title || "this item";
  return (
    <span className="relative">
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Settings for ${name}`}
        data-tt="Required, owner and due date"
        onClick={() => setOpen((o) => !o)}
        className={iconButtonClass("quiet", "sm")}
      >
        <SlidersHorizontal aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={ref} label={`Settings for ${name}`} align="end" width="w-72" padding="p-4">
        <div className="space-y-4">
          <Toggle
            label="Required"
            help="The ticket can't be solved until it's ticked."
            checked={!!item.required}
            onChange={(v) => onChange({ required: v || undefined })}
          />
          <Field label="Owner team" help="Shown on the ticket. Its calendar counts the due date.">
            <Select value={item.team_id ?? ""} onChange={(e) => onChange({ team_id: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">No owner team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due" help="Business days after the checklist is added, skipping weekends and holidays.">
            <Select
              value={item.due_days ?? ""}
              onChange={(e) => onChange({ due_days: e.target.value === "" ? undefined : Number(e.target.value) })}
            >
              <option value="">No due date</option>
              {DUE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {dueDaysLabel(d)}
                </option>
              ))}
              {item.due_days !== undefined && item.due_days !== null && !(DUE_DAY_CHOICES as readonly number[]).includes(item.due_days) && (
                <option value={item.due_days}>{dueDaysLabel(item.due_days)}</option>
              )}
            </Select>
          </Field>
        </div>
      </Popover>
    </span>
  );
}
