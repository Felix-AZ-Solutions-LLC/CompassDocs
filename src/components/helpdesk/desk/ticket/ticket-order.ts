"use client";

// 1.20.28: how this agent orders a ticket's conversation in the desk,
// "newest" (the default: the reply box on top, newest first, older history
// folded) or "oldest" (the reply box at the bottom, nothing folded;
// lib/helpdesk/conversation-shared). The page starts from the agent's desk
// preference (DeskMe ticket_order, lib/helpdesk/notify-prefs); the pane's
// Order control changes it here at once, for every ticket opened after, and
// saves it so it follows the agent to their other devices.

import { useSyncExternalStore } from "react";
import type { HdTicketOrder } from "@/lib/helpdesk/conversation-shared";
import { sendJson } from "../api";
import { useDeskMe } from "../me";

let chosen: HdTicketOrder | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The order the conversation shows in now. */
export function useTicketOrder(): HdTicketOrder {
  const me = useDeskMe();
  const loaded: HdTicketOrder = me.ticket_order === "oldest" ? "oldest" : "newest";
  return useSyncExternalStore(subscribe, () => chosen ?? loaded, () => loaded);
}

/** The agent's choice: shown at once and saved as their preference (a failed save costs only the default next time). */
export function chooseTicketOrder(order: HdTicketOrder): void {
  if (chosen !== order) {
    chosen = order;
    for (const fn of listeners) fn();
  }
  void sendJson("/api/helpdesk/me/notification-prefs", "PUT", { ticket_order: order }).catch(() => undefined);
}
