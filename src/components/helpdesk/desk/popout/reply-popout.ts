// The reply pop-out (1.20.18): the ticket's composer in a window of its own
// (/desk/tickets/[number]/reply), so an agent can finish a reply while they
// move around the desk. This module is the plumbing both windows share, kept
// free of React so the integration tests can run it.
//
// The sync model:
//   - The text is the composer's own draft (localStorage, per agent, ticket
//     and message type). Both windows are the same origin, so both read and
//     write the same draft: nothing is ever put in a URL.
//   - The rest of what the agent set up (Reply or Internal note, files
//     already uploaded, the macro picked, which carries its status, and the
//     send's idempotency key) is a hand-off record per agent and ticket. The
//     pane writes it as it pops out; the pop-out keeps it current while it
//     owns the reply and clears it on send; the pane reads it when the reply
//     comes back and clears it once the pop-out has let go.
//   - Ownership: a pop-out claims the reply with a random owner token kept
//     with its heartbeat. The pane takes a reply back only when the pop-out
//     hands it back, is gone, or the agent says so; it then records the
//     token as taken, and a pop-out that finds its token taken goes
//     read-only. Every send in the pop-out checks the token first.
//   - Events go over a BroadcastChannel ("compass-desk-reply").
//
// Security review fixes (1.20.18): storage keys and records carry the
// agent's user id, and a record for anyone else is refused (a shared
// computer); sign-out clears every desk key and closes the pop-outs; a
// send carries an idempotency key (client_send_id) and the agent's id
// (expect_user_id), both checked by the server.
//
// Trust: a BroadcastChannel and localStorage only reach the same origin.
// Every message and record is shape-checked here. Nothing here decides what
// anyone may do: the pop-out loads the ticket and sends through the same
// routes as the pane, which check access on every request. The pop-out
// drops window.opener as it loads and never reads it.

import { HD_PRIORITIES, HD_STATUSES, type HdAttachment, type HdMacro, type HdMacroActions, type HdPriority, type HdStatus } from "@/lib/helpdesk/types";

export type PopoutMode = "public" | "internal";

export const REPLY_CHANNEL = "compass-desk-reply";
/** A pop-out stamps its heartbeat this often while open. */
export const POPOUT_BEAT_MS = 4_000;
/** A heartbeat older than this is not trusted on its own: the pane asks. */
export const POPOUT_STALE_MS = 15_000;
/** A heartbeat older than this is a pop-out that is truly gone (a hidden window may beat once a minute). */
export const POPOUT_DEAD_MS = 150_000;
/** How long a pane waits for "here" before it decides. */
export const POPOUT_ANSWER_MS = 1_500;
/** A hand-off record older than this is ignored and deleted (a pop-out that died long ago). */
export const HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A "was sending as it closed" marker is checked for this long. */
export const SENDING_MAX_AGE_MS = 10 * 60 * 1000;
/** Sized like a mail compose window. */
export const POPOUT_SIZE = { width: 720, height: 780 };

const MAX_FILES = 10;
const TOKEN_RE = /^[a-f0-9]{16,64}$/;
export const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** 1.20.20: a browser tab's id for the reply lock (../reply-lock/tab). */
const TAB_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

type Base = { n: number; u: number };
export type PopoutMessage =
  /** A pop-out for ticket n is open: it claims the reply with its owner token. */
  | (Base & { type: "open"; token: string })
  /** A pop-out answers a ping: still here, with its token. */
  | (Base & { type: "here"; token: string })
  /** Anyone asks: is a pop-out open for n? */
  | (Base & { type: "ping" })
  /** The agent typed in the pop-out (keeps the pane's presence "replying"). */
  | (Base & { type: "typing" })
  /** The pop-out sent the reply or note. `warning`: sent, but the status stayed (shown as text only). */
  | (Base & { type: "sent"; kind: "public" | "internal" | "review"; warning?: string })
  /** The pop-out applied a macro's other changes after sending: reload. */
  | (Base & { type: "changed" })
  /** The pop-out went away without sending (it saved the hand-off). */
  | (Base & { type: "closed" })
  /** The pane asks the pop-out to come to the front. */
  | (Base & { type: "focus" })
  /** The pane asks for the reply back: the pop-out saves and closes, unless busy. */
  | (Base & { type: "bring-back" })
  /** The pop-out is sending, uploading or asking a solve question: it can't give the reply back now. */
  | (Base & { type: "busy" })
  /** The pane took the reply back from the pop-out holding `token`. */
  | (Base & { type: "taken"; token: string })
  /** The pop-out holding `token` has seen it was taken and let go. */
  | (Base & { type: "ack"; token: string })
  /** Text for the pop-out's composer (Claude in the desk's "Use as reply"). */
  | (Base & { type: "fill"; text: string; mode: PopoutMode; replace: string | null })
  /** Someone signed out in this browser: every pop-out closes. */
  | { type: "signout" };

const SIMPLE = new Set(["ping", "typing", "changed", "closed", "focus", "bring-back", "busy"]);
const TOKENED = new Set(["open", "here", "taken", "ack"]);

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** A channel message as this module sends them, or null. Unknown fields are dropped. */
export function parsePopoutMessage(raw: unknown): PopoutMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "signout") return { type: "signout" };
  const n = posInt(o.n);
  const u = posInt(o.u);
  if (!n || !u || typeof o.type !== "string") return null;
  if (SIMPLE.has(o.type)) return { type: o.type, n, u } as PopoutMessage;
  if (TOKENED.has(o.type)) {
    if (typeof o.token !== "string" || !TOKEN_RE.test(o.token)) return null;
    return { type: o.type, n, u, token: o.token } as PopoutMessage;
  }
  if (o.type === "sent") {
    if (o.kind !== "public" && o.kind !== "internal" && o.kind !== "review") return null;
    const warning = typeof o.warning === "string" && o.warning.trim() ? o.warning.trim().slice(0, 300) : undefined;
    return warning ? { type: "sent", n, u, kind: o.kind, warning } : { type: "sent", n, u, kind: o.kind };
  }
  if (o.type === "fill") {
    if (typeof o.text !== "string" || !o.text || o.text.length > 20_000) return null;
    if (o.mode !== "public" && o.mode !== "internal") return null;
    const replace = typeof o.replace === "string" && o.replace.length <= 20_000 ? o.replace : null;
    return { type: "fill", n, u, text: o.text, mode: o.mode, replace };
  }
  return null;
}

// --- Random ids ------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pop-out's owner token. */
export function newOwnerToken(): string {
  return randomHex(16);
}

/** A send's idempotency key (client_send_id). */
export function newSendId(): string {
  return randomHex(16);
}

// --- The hand-off record -----------------------------------------------------------------

/** What the composer hands over besides its text. */
export interface ReplyHandoff {
  /** Whose it is: a record for anyone else is refused. */
  u: number;
  mode: PopoutMode;
  files: HdAttachment[];
  macro: HdMacro | null;
  /** The send's idempotency key, kept until it goes through. */
  send_id: string | null;
  /**
   * 1.20.20, the reply lock (../reply-lock): the browser tab id the pane handed the lock to (the pop-out adopts it),
   * the pane's own tab id (the lock goes back there), and when the reply was last touched (idle keeps counting).
   */
  lock_tab?: string | null;
  lock_home?: string | null;
  lock_at?: number | null;
  /** When it was written (ms). */
  at: number;
}

function cleanFile(v: unknown): HdAttachment | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const id = posInt(f.id);
  if (!id || typeof f.name !== "string" || !f.name || f.name.length > 255) return null;
  const size = typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : 0;
  const type = typeof f.type === "string" ? f.type.slice(0, 200) : "";
  return { id, name: f.name, size, type };
}

function cleanMacro(v: unknown): HdMacro | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const id = posInt(m.id);
  if (!id || typeof m.title !== "string" || typeof m.body !== "string" || m.title.length > 500 || m.body.length > 20_000) return null;
  const a = m.actions && typeof m.actions === "object" && !Array.isArray(m.actions) ? (m.actions as Record<string, unknown>) : {};
  const actions: HdMacroActions = {};
  if (typeof a.status === "string" && (HD_STATUSES as readonly string[]).includes(a.status)) actions.status = a.status as HdStatus;
  if (typeof a.priority === "string" && (HD_PRIORITIES as readonly string[]).includes(a.priority)) actions.priority = a.priority as HdPriority;
  if (posInt(a.team_id)) actions.team_id = a.team_id as number;
  if (Array.isArray(a.tags_add)) {
    const tags = a.tags_add.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 100).slice(0, 50);
    if (tags.length) actions.tags_add = tags;
  }
  return {
    id,
    title: m.title,
    body: m.body,
    actions,
    team_id: posInt(m.team_id),
    owner_id: posInt(m.owner_id),
    created_by: posInt(m.created_by),
    created_at: typeof m.created_at === "string" ? m.created_at : "",
    updated_at: typeof m.updated_at === "string" ? m.updated_at : "",
  };
}

/** A stored hand-off record for agent `uid`, checked; null when absent, someone else's, malformed or too old. */
export function parseHandoff(raw: unknown, uid: number, now = Date.now()): ReplyHandoff | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.u !== uid) return null;
  if (o.mode !== "public" && o.mode !== "internal") return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
  if (!at || now - at > HANDOFF_MAX_AGE_MS || at - now > 60_000) return null;
  const files: HdAttachment[] = [];
  const seen = new Set<number>();
  for (const f of Array.isArray(o.files) ? o.files : []) {
    const c = cleanFile(f);
    if (c && !seen.has(c.id) && files.length < MAX_FILES) {
      seen.add(c.id);
      files.push(c);
    }
  }
  const send_id = typeof o.send_id === "string" && SEND_ID_RE.test(o.send_id) ? o.send_id : null;
  const tab = (v: unknown) => (typeof v === "string" && TAB_ID_RE.test(v) ? v : null);
  const lock_at = typeof o.lock_at === "number" && Number.isFinite(o.lock_at) && o.lock_at > 0 && o.lock_at <= now + 60_000 ? o.lock_at : null;
  return { u: uid, mode: o.mode, files, macro: cleanMacro(o.macro), send_id, lock_tab: tab(o.lock_tab), lock_home: tab(o.lock_home), lock_at, at };
}

// --- Addresses and window names (never any draft text) ------------------------------

/** The pop-out's page: the ticket number only. */
export function popoutPath(n: number): string {
  return `/desk/tickets/${n}/reply`;
}

/** One named window per ticket: a second open of the same ticket finds the first. */
export function popoutWindowName(n: number): string {
  return `compass-reply-${n}`;
}

const POPOUT_PATH_RE = /^\/desk\/tickets\/[1-9]\d{0,15}\/reply\/?$/;

/** Is this the pop-out page (the desk shell then draws no top bar or rail)? */
export function isReplyPopoutPath(path: string | null | undefined): boolean {
  return !!path && POPOUT_PATH_RE.test(path);
}

/** window.open features: a popup sized like a compose window, centred on the opener. */
export function popoutFeatures(screen: { x: number; y: number; width: number; height: number }): string {
  const { width, height } = POPOUT_SIZE;
  const left = Math.max(0, Math.round(screen.x + (screen.width - width) / 2));
  const top = Math.max(0, Math.round(screen.y + (screen.height - height) / 3));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

// --- Browser storage, wrapped (private windows and blocked storage throw) ----------

/** Every desk key starts with this; each carries the agent's id right after its name. */
export const DESK_KEY_PREFIX = "compass-desk-";

export const draftKey = (u: number, n: number, mode: PopoutMode) => `compass-desk-draft:${u}:${n}:${mode}`;
const stateKey = (u: number, n: number) => `compass-desk-reply-state:${u}:${n}`;
const aliveKey = (u: number, n: number) => `compass-desk-reply-alive:${u}:${n}`;
const takenKey = (u: number, n: number) => `compass-desk-reply-taken:${u}:${n}`;
const sendingKey = (u: number, n: number) => `compass-desk-reply-sending:${u}:${n}`;

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function get(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* storage full or blocked: the reply stays where it is */
  }
}

function del(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

function json(key: string): Record<string, unknown> | null {
  const raw = get(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The composer's unsent text for this agent, ticket and message type. */
export function readDraft(u: number, n: number, mode: PopoutMode): string {
  return get(draftKey(u, n, mode)) ?? "";
}

export function writeDraft(u: number, n: number, mode: PopoutMode, text: string): void {
  if (text) set(draftKey(u, n, mode), text);
  else del(draftKey(u, n, mode));
}

/** The hand-off record; one that is too old or malformed is deleted as it is found. */
export function readHandoff(u: number, n: number): ReplyHandoff | null {
  const raw = json(stateKey(u, n));
  if (!raw) return null;
  const h = parseHandoff(raw, u);
  if (!h) del(stateKey(u, n));
  return h;
}

export function writeHandoff(u: number, n: number, h: Omit<ReplyHandoff, "at" | "u">): void {
  set(
    stateKey(u, n),
    JSON.stringify({ u, mode: h.mode, files: h.files, macro: h.macro, send_id: h.send_id, lock_tab: h.lock_tab ?? null, lock_home: h.lock_home ?? null, lock_at: h.lock_at ?? null, at: Date.now() })
  );
}

export function clearHandoff(u: number, n: number): void {
  del(stateKey(u, n));
}

/** The pop-out's heartbeat: its owner token and when it last beat. */
export function stampAlive(u: number, n: number, token: string): void {
  set(aliveKey(u, n), JSON.stringify({ u, token, at: Date.now() }));
}

/** Remove the heartbeat, only if it is still this token's. */
export function clearAlive(u: number, n: number, token?: string): void {
  if (token && readAlive(u, n)?.token !== token) return;
  del(aliveKey(u, n));
}

/** The heartbeat (token and age in ms), or null when there is none or it is someone else's. */
export function readAlive(u: number, n: number, now = Date.now()): { token: string; age: number } | null {
  const o = json(aliveKey(u, n));
  if (!o || o.u !== u || typeof o.token !== "string" || !TOKEN_RE.test(o.token) || typeof o.at !== "number") return null;
  return { token: o.token, age: Math.max(0, now - o.at) };
}

/** How old the pop-out's heartbeat is (ms), or null when there is none. */
export function aliveAge(u: number, n: number, now = Date.now()): number | null {
  return readAlive(u, n, now)?.age ?? null;
}

/** The pane took the reply back from the pop-out holding `token`. */
export function markTaken(u: number, n: number, token: string): void {
  set(takenKey(u, n), JSON.stringify({ u, token, at: Date.now() }));
}

/** Was the reply taken back from the pop-out holding `token`? */
export function wasTaken(u: number, n: number, token: string): boolean {
  const o = json(takenKey(u, n));
  return !!o && o.u === u && o.token === token;
}

export function clearTaken(u: number, n: number): void {
  del(takenKey(u, n));
}

/** Does the pop-out holding `token` still own the reply (its heartbeat is its own and nobody took it)? */
export function stillOwner(u: number, n: number, token: string): boolean {
  if (wasTaken(u, n, token)) return false;
  const a = readAlive(u, n);
  return !a || a.token === token;
}

/** The pop-out went away while a send was on its way: the pane checks before giving the text back. */
export function markSending(u: number, n: number, mode: PopoutMode): void {
  set(sendingKey(u, n), JSON.stringify({ u, mode, at: Date.now() }));
}

export function readSending(u: number, n: number, now = Date.now()): { mode: PopoutMode } | null {
  const o = json(sendingKey(u, n));
  if (!o) return null;
  if (o.u !== u || (o.mode !== "public" && o.mode !== "internal") || typeof o.at !== "number" || now - o.at > SENDING_MAX_AGE_MS) {
    del(sendingKey(u, n));
    return null;
  }
  return { mode: o.mode };
}

export function clearSending(u: number, n: number): void {
  del(sendingKey(u, n));
}

/** Every desk key in this browser's storage. */
function deskKeys(): string[] {
  const s = store();
  if (!s) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(DESK_KEY_PREFIX)) out.push(k);
    }
  } catch {
    /* storage refused */
  }
  return out;
}

/** The agent id a desk key belongs to (the part after the name), or null for a key from before 1.20.18. */
export function deskKeyOwner(key: string): number | null {
  const m = /^compass-desk-[a-z-]+:(\d+):\d+(?::(?:public|internal))?$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Set once a browser's 1.20.16 drafts were adopted (outside the desk prefix, so sign-out leaves it). */
export const LEGACY_ADOPTED_KEY = "compass-drafts-adopted-1.20.18";
const LEGACY_DRAFT_RE = /^compass-desk-draft:([1-9]\d{0,15}):(public|internal)$/;

/**
 * The upgrade from 1.20.16 (one time per browser): its drafts named no agent
 * (`compass-desk-draft:<ticket>:<type>`). Each is adopted by the agent signed in
 * now, unless they already have a draft of their own for that ticket and type,
 * and the old key goes, so an agent mid-reply when the upgrade lands keeps the
 * text. Returns how many were adopted.
 */
export function adoptLegacyDrafts(uid: number): number {
  if (get(LEGACY_ADOPTED_KEY)) return 0;
  let adopted = 0;
  for (const k of deskKeys()) {
    const m = LEGACY_DRAFT_RE.exec(k);
    if (!m) continue;
    const text = get(k);
    const mine = draftKey(uid, Number(m[1]), m[2] as PopoutMode);
    if (text && !get(mine)) {
      set(mine, text);
      adopted++;
    }
    del(k);
  }
  set(LEGACY_ADOPTED_KEY, "1");
  return adopted;
}

/**
 * Remove the desk keys that are not `uid`'s (another agent's drafts on a shared computer; the
 * 1.20.16 drafts are adopted first, adoptLegacyDrafts). With no uid, remove every desk key (sign-out).
 */
export function pruneDeskStorage(uid: number | null): number {
  let removed = 0;
  for (const k of deskKeys()) {
    if (uid !== null && deskKeyOwner(k) === uid) continue;
    del(k);
    removed++;
  }
  return removed;
}

// --- The channel ---------------------------------------------------------------------

/** A BroadcastChannel, or null where there is none (old browsers, some private modes). */
export function openChannel(onMessage: (m: PopoutMessage) => void): { post: (m: PopoutMessage) => void; close: () => void } {
  let ch: BroadcastChannel | null = null;
  try {
    ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(REPLY_CHANNEL);
  } catch {
    ch = null;
  }
  if (ch) {
    ch.onmessage = (e: MessageEvent) => {
      const m = parsePopoutMessage(e.data);
      if (m) onMessage(m);
    };
  }
  return {
    post(m) {
      try {
        ch?.postMessage(m);
      } catch {
        /* closed */
      }
    },
    close() {
      try {
        ch?.close();
      } catch {
        /* closed */
      }
      ch = null;
    },
  };
}

/**
 * Sign-out in this browser (1.20.18): every pop-out closes and every desk key goes
 * (drafts, hand-offs, heartbeats). Call it before the session ends.
 */
export function forgetDeskOnSignOut(): void {
  const ch = openChannel(() => {});
  ch.post({ type: "signout" });
  ch.close();
  pruneDeskStorage(null);
}
