// The workspace's mail configuration is one per database: the help addresses
// (hd_mailboxes), the send-from addresses (hd_send_addresses) and the refusal
// each carries, the Microsoft 365 links (hd_m365_*), and the inbound
// settings (the helpdesk settings' inbound address and secret, the inbound
// sender-check setting). Every helpdesk mail a test sends or receives goes
// through it, and a send writes back to it: a refused send-from address is
// recorded and a later accepted send clears it; a help address that sends
// through Microsoft 365 records Microsoft's refusal on its link.
//
// So it is a readers–writer lock, held for a whole test file:
//
//   exclusive  a file that changes the configuration (adds or wipes help
//              addresses, connects Microsoft 365, sets the inbound address):
//              helpdesk-mailboxes, helpdesk-m365-mail, helpdesk-review-fixes-s2,
//              helpdesk-share.
//   shared     every other file that installs a helpdesk mail transport
//              (setHelpdeskTransportForTests) and so sends, or receives, mail
//              through whatever configuration the workspace has.
//
// Without it a reader's ticket mail went out under a writer's default help
// address: it cleared the refusal the writer had just recorded, or tried
// Microsoft 365 with the writer's tenant (and the real login.microsoftonline.com,
// since only the writer points Graph at its fake) and stamped a refusal on the
// writer's link; and the writer's configuration changed what the reader's
// mail looked like. A file without a transport sends nothing (no SMTP is set
// in the test database), so it needs no lock.
//
// The lock is 728351, the key the writers already used among themselves.
// It is taken on a connection of its own, outside lib/db's pool, so a file
// holding it has all of its pool's connections for its tests; a process
// that dies frees it with its connection. Postgres queues a waiting
// exclusive request ahead of later shared ones, so a writer is not starved.
//
// release() first stops the file's mail (the transport is removed, so a
// send that starts later does nothing) and waits for every send already
// under way to finish its writes; only then may a writer go.

import { Client } from "pg";

export const WORKSPACE_MAIL_LOCK = 728351;

type MailModule = Pick<typeof import("../../src/lib/helpdesk/email"), "setHelpdeskTransportForTests" | "helpdeskMailSettledForTests">;

export interface WorkspaceMailLock {
  /** Stop this file's helpdesk mail, wait for sends under way, and let the lock go. */
  release(email: MailModule): Promise<void>;
}

export async function lockWorkspaceMail(mode: "shared" | "exclusive"): Promise<WorkspaceMailLock> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: `mail-lock:${mode}:${process.pid}` });
  await client.connect();
  await client.query(mode === "shared" ? "SELECT pg_advisory_lock_shared($1)" : "SELECT pg_advisory_lock($1)", [WORKSPACE_MAIL_LOCK]);
  let released = false;
  return {
    async release(email) {
      if (released) return;
      released = true;
      email.setHelpdeskTransportForTests(null);
      await email.helpdeskMailSettledForTests();
      // Ending the session ends the lock, whichever mode it was taken in.
      await client.end().catch(() => {});
    },
  };
}
