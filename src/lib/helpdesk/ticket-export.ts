// Helpdesk 1.20.8: tickets as CSV, from the desk's queue (any built-in view,
// team, saved view or filtered list). GET /api/helpdesk/tickets/export takes
// the list's own query, so an export holds exactly the tickets the list
// does, every page of them, in the list's order, in the caller's scope
// (lib/helpdesk/tickets ticketListWhere: the same WHERE as the list).
//
//   who        tickets.export (Manager and Admin by default), as the time and
//              report CSVs. Requester-side routes never reach this.
//   cap        TICKET_EXPORT_MAX_ROWS (10,000) tickets; the route says when
//              it cut the list short (x-compass-export-capped) and the desk
//              asks before a capped export.
//   columns    Number, Subject, Status, Priority, Team, Owner, Requester,
//              Requester email, Category, Sub-category, Tags, Created,
//              Updated, First reply, Solved, Due, Channel, Help address,
//              Event start, Event end, Event place, then one column per live
//              custom field (archived fields are left out) headed by its
//              label, in the settings page's order. A custom field's cell is
//              filled only on tickets of a team it is assigned to (what the
//              ticket shows); agent-only and Public fields alike, since this
//              is an agent's export.
//   values     plain text; times "YYYY-MM-DD HH:MM" in the workspace's zone
//              (helpdeskTimezone), an all-day event's days as YYYY-MM-DD.
//              Due is the running target (first reply until answered, then
//              resolution), as the list's Due sort reads it. A cancelled
//              event is left out.
//   format     UTF-8 with a BOM (Excel), CRLF, every text cell through
//              lib/csv csvCell: quoted, quotes doubled, and a leading ' on a
//              cell that starts with = + - @, a tab or a carriage return (so a
//              subject or a label never runs as a formula). Numbers (the
//              ticket number, a Number field) go out bare.
//   memory     the ticket ids are read first (at most 10,000 integers), then
//              the rows stream out 500 at a time: one query for the tickets,
//              one for their custom values, one for the people they name.
//
// Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import { csvCell } from "../csv";
import { sortSqlFor, ticketListWhere, type TicketListFilters } from "./tickets";
import { customFieldApplies, customValueText, listCustomFields, type HdCustomField } from "./custom-fields";
import { HD_PRIORITY_LABEL, HD_SOURCE_LABEL, HD_STATUS_LABEL, type HdPriority, type HdSource, type HdStatus } from "./types";
import type { Role } from "../types";
import { TICKET_EXPORT_COLUMNS, TICKET_EXPORT_MAX_ROWS } from "./ticket-export-shared";

export * from "./ticket-export-shared";

const BATCH = 500;

export interface TicketExportPlan {
  /** The tickets to write, in the list's order (at most TICKET_EXPORT_MAX_ROWS). */
  ids: number[];
  /** Every ticket the list holds. */
  total: number;
  capped: boolean;
}

/** The tickets an export writes: the list's WHERE and order, capped. */
export async function planTicketExport(user: { id: number; role: Role }, f: TicketListFilters): Promise<TicketExportPlan> {
  const { whereSql, params } = await ticketListWhere(user, f);
  const total = (await hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets t WHERE ${whereSql}`, params))?.n ?? 0;
  if (!total) return { ids: [], total: 0, capped: false };
  const rows = await hq<{ id: number }>(
    `SELECT t.id FROM hd_tickets t WHERE ${whereSql} ORDER BY ${sortSqlFor(f)} LIMIT ${TICKET_EXPORT_MAX_ROWS}`,
    params
  );
  return { ids: rows.map((r) => Number(r.id)), total, capped: total > rows.length };
}

interface Row {
  id: number;
  number: number;
  subject: string;
  status: string;
  priority: string;
  team_id: number | null;
  team: string | null;
  owner: string | null;
  requester_name: string | null;
  requester_email: string | null;
  category: string | null;
  subcategory: string | null;
  tags: string[] | null;
  created: string | null;
  updated: string | null;
  first_reply: string | null;
  solved: string | null;
  due: string | null;
  source: string;
  mailbox: string | null;
  ev_start: string | null;
  ev_end: string | null;
  ev_place: string | null;
}

const T = (col: string) => `to_char(${col} AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI')`;

const ROWS_SQL = `
  SELECT t.id, t.number, t.subject, t.status, t.priority, t.team_id, tm.name AS team,
         COALESCE(NULLIF(a.name, ''), a.username) AS owner, t.requester_name, t.requester_email,
         t.category, t.subcategory, t.tags,
         ${T("t.created_at")} AS created, ${T("t.updated_at")} AS updated, ${T("t.first_replied_at")} AS first_reply, ${T("t.solved_at")} AS solved,
         ${T("(CASE WHEN t.first_replied_at IS NULL AND t.first_reply_due IS NOT NULL THEN t.first_reply_due ELSE t.resolve_due END)")} AS due,
         t.source, mb.address AS mailbox,
         CASE WHEN ev.all_day = 1 AND ev.start_date IS NOT NULL THEN to_char(ev.start_date, 'YYYY-MM-DD') ELSE ${T("ev.starts_at")} END AS ev_start,
         CASE WHEN ev.all_day = 1 AND ev.end_date IS NOT NULL THEN to_char(ev.end_date, 'YYYY-MM-DD') ELSE ${T("ev.ends_at")} END AS ev_end,
         ev.place AS ev_place
    FROM hd_tickets t
    LEFT JOIN hd_teams tm ON tm.id = t.team_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN hd_mailboxes mb ON mb.id = t.mailbox_id
    LEFT JOIN hd_ticket_events ev ON ev.ticket_id = t.id AND ev.cancelled_at IS NULL
   WHERE t.id = ANY($2::int[]) AND t.deleted_at IS NULL`; // 1.20.8 review: a ticket moved to the recycle bin since the plan is not written

/** A row's cells: numbers bare (never a formula), everything else through csvCell. */
const line = (cells: unknown[]) => cells.map((c) => (typeof c === "number" && Number.isFinite(c) ? String(c) : csvCell(c))).join(",") + "\r\n";

/** Column headings for the custom fields: the label, with the key added where two fields share a label. */
function fieldHeadings(fields: HdCustomField[]): string[] {
  const seen = new Map<string, number>();
  for (const f of fields) seen.set(f.label.toLowerCase(), (seen.get(f.label.toLowerCase()) ?? 0) + 1);
  return fields.map((f) => ((seen.get(f.label.toLowerCase()) ?? 0) > 1 ? `${f.label} (${f.key})` : f.label));
}

/** One batch of tickets as CSV lines, in `ids` order. */
async function batchLines(ids: number[], fields: HdCustomField[], tz: string): Promise<string> {
  const rows = await hq<Row>(ROWS_SQL, [tz, ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const values = new Map<string, { value: unknown; display: string }>();
  const people = new Set<number>();
  if (fields.length) {
    const vr = await hq<{ ticket_id: number; field_id: number; value: unknown; display: string }>(
      "SELECT ticket_id, field_id, value, display FROM hd_ticket_custom_values WHERE ticket_id = ANY($1::int[]) AND field_id = ANY($2::int[])",
      [ids, fields.map((f) => f.id)]
    );
    const userFields = new Set(fields.filter((f) => f.type === "user").map((f) => f.id));
    for (const v of vr) {
      values.set(`${v.ticket_id}:${v.field_id}`, { value: v.value, display: v.display });
      if (userFields.has(v.field_id) && typeof v.value === "number") people.add(v.value);
    }
  }
  const names = new Map<number, string>();
  if (people.size) {
    for (const r of await hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [[...people]])) {
      names.set(Number(r.id), r.name);
    }
  }
  let out = "";
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue; // deleted, or moved to the recycle bin, between the plan and this batch
    const custom = fields.map((f) => {
      if (!customFieldApplies(f, r.team_id)) return "";
      const v = values.get(`${id}:${f.id}`);
      if (!v) return "";
      if (f.type === "number" && typeof v.value === "number") return v.value;
      return customValueText(f, v.value as never, { names, kept: v.display });
    });
    out += line([
      Number(r.number),
      r.subject,
      HD_STATUS_LABEL[r.status as HdStatus] ?? r.status,
      HD_PRIORITY_LABEL[r.priority as HdPriority] ?? r.priority,
      r.team ?? "",
      r.owner ?? "",
      r.requester_name ?? "",
      r.requester_email ?? "",
      r.category ?? "",
      r.subcategory ?? "",
      (r.tags ?? []).join(", "),
      r.created ?? "",
      r.updated ?? "",
      r.first_reply ?? "",
      r.solved ?? "",
      r.due ?? "",
      HD_SOURCE_LABEL[r.source as HdSource] ?? r.source,
      r.mailbox ?? "",
      r.ev_start ?? "",
      r.ev_end ?? "",
      r.ev_place ?? "",
      ...custom,
    ]);
  }
  return out;
}

/**
 * The CSV as a stream: the BOM and the header row, then the tickets 500 at
 * a time. `tz` is the workspace's zone.
 */
export async function ticketExportStream(ids: number[], tz: string): Promise<ReadableStream<Uint8Array>> {
  const fields = (await listCustomFields()).filter((f) => !f.archived);
  const enc = new TextEncoder();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("﻿" + line([...TICKET_EXPORT_COLUMNS, ...fieldHeadings(fields)])));
    },
    async pull(controller) {
      if (at >= ids.length) {
        controller.close();
        return;
      }
      const batch = ids.slice(at, at + BATCH);
      at += BATCH;
      try {
        controller.enqueue(enc.encode(await batchLines(batch, fields, tz)));
      } catch (e) {
        console.error("[helpdesk] ticket export:", e);
        controller.error(e);
      }
    },
  });
}
