// Helpdesk 1.20.21: Start a workflow from the desk, the parts the desk's
// dialog and the server share (lib/helpdesk/workflow-start holds the rules
// and the writes). No server imports here.
//
// Two outcomes, decided on the server under the ticket's row lock and shown
// in the dialog before the agent submits:
//   this   the ticket has no request type and no workflow run: it becomes a
//          request of the chosen type (its answers set) and the run lives on
//          it, so its progress shows in the side panel's Workflow card
//   new    it has a request type or a run already: a new request of the
//          chosen type is opened for the same requester, linked to this
//          ticket by an internal note on each, and the run lives there
// A ticket whose type an earlier desk start set but whose run never started
// is `this` again, so the start can be retried on it.
// The dialog sends the outcome it showed (`expect`); if the ticket changed
// meanwhile the server answers 409 (code workflow_mode_changed) and nothing
// is written, so the agent never gets the other outcome unannounced.

import type { HdFormAnswers, HdFormField } from "./types";

export type HdStartMode = "this" | "new";

/** A request type the dialog (or New ticket) offers, with what starts. */
export interface HdStartableType {
  id: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  team_id: number | null;
  team_name: string | null;
  form: HdFormField[];
  /** Answers prefilled from the requester's directory entry (fields with default_from). */
  defaults: HdFormAnswers;
  /** The published workflow it starts (null: none; New ticket lists such types too). */
  workflow: { id: number; title: string; version: number; steps: number } | null;
}

/** GET /api/helpdesk/tickets/[number]/start-workflow. */
export interface HdStartWorkflowOptions {
  /** May a workflow be started from this ticket at all (open, not a task, not merged)? */
  eligible: boolean;
  /** Why not, as a sentence; null when eligible. */
  reason: string | null;
  mode: HdStartMode;
  ticket: { number: number; subject: string; request_type_title: string | null; in_workflow: boolean };
  /** `portal`: a customer-portal contact (offered the portal's types only; their request is a portal ticket). */
  requester: { id: number | null; name: string; portal: boolean };
  types: HdStartableType[];
}

/** POST /api/helpdesk/tickets/[number]/start-workflow → 200. */
export interface HdStartWorkflowResult {
  mode: HdStartMode;
  /** The run started (false: the type was set or the request opened, but its workflow had gone meanwhile). */
  started: boolean;
  /** The same key was sent before: this is the first try's outcome, and nothing was done again. */
  duplicate: boolean;
  /** The ticket the run lives on: this ticket, or the new request. */
  request: { number: number; subject: string };
  run_id: number | null;
  workflow: { title: string; version: number } | null;
}

/** Machine-readable refusals beside `error`. */
export const WORKFLOW_START_CODES = {
  modeChanged: "workflow_mode_changed",
  notEligible: "workflow_not_startable",
  typeUnavailable: "request_type_unavailable",
} as const;

export const START_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The body's client_start_id: the cleaned key, or "bad" when absent or malformed (it is required). */
export function cleanStartId(v: unknown): string | "bad" {
  return typeof v === "string" && START_ID_RE.test(v) ? v : "bad";
}

/** What the dialog says will happen, before the agent submits. */
export function startModeSentence(mode: HdStartMode, t: { number: number; request_type_title: string | null; in_workflow: boolean }, requester: string): string {
  if (mode === "this") return `The workflow runs on this ticket, #${t.number}, which becomes ${requester}'s request. Its progress shows in the side panel.`;
  const why = t.request_type_title ? `#${t.number} is already a ${t.request_type_title} request` : `#${t.number} already has a workflow`;
  return `${why}, so a new request is opened for ${requester} and the workflow runs there. Each ticket gets an internal note linking to the other.`;
}

/** The primary button's label, which follows the outcome (STYLEGUIDE §Overlays, choice dialog). */
export function startButtonLabel(mode: HdStartMode): string {
  return mode === "this" ? "Start on this ticket" : "Open a request and start";
}

/** "Workflow started by Sam Lee: New starter (version 3)." The words the timeline note and the audit share. */
export function startedLine(agent: string, workflowTitle: string, version: number): string {
  return `Workflow started by ${agent}: ${workflowTitle} (version ${version})`;
}
