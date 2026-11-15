"use client";

// 1.20.11: how this agent reads emailed messages in the conversation,
// "formatted" (the email as sent, ticket/InlineEmail) or "plain" (the text
// body). The page starts from the agent's desk preference (DeskMe
// email_view, lib/helpdesk/notify-prefs); switching a message makes that
// choice the default for messages shown after it, here and from then on,
// and saves it to the preference. A message already on screen keeps its own
// state, so switching one never flips the others.

import { useSyncExternalStore } from "react";
import type { HdEmailView } from "@/lib/helpdesk/email-html-shared";
import { sendJson } from "../api";
import { useDeskMe } from "../me";

let chosen: HdEmailView | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The default for a message that comes on screen now. */
export function useEmailViewDefault(): HdEmailView {
  const me = useDeskMe();
  const loaded = me.email_view === "plain" ? "plain" : "formatted";
  return useSyncExternalStore(subscribe, () => chosen ?? loaded, () => loaded);
}

/** The agent's choice, kept for the session and (unless `save` is false) saved as their preference. */
export function rememberEmailView(view: HdEmailView, save = true): void {
  if (chosen !== view) {
    chosen = view;
    for (const fn of listeners) fn();
  }
  if (save) {
    // A failed save costs only the default next time; the message still switched.
    void sendJson("/api/helpdesk/me/notification-prefs", "PUT", { email_view: view }).catch(() => undefined);
  }
}
