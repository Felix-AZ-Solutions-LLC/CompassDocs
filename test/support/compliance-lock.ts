// The workspace's compliance settings (the settings rows ack_defaults,
// ack_report and friends: lib/compliance-settings) are one per database, and
// a policy reads them as it goes: its re-confirmation default and recert
// months when it is first set to required, the due-date cascade, whether
// leads see policies. Files that test those settings change them inside
// SETTINGS_LOCK (728342); every other file that sets policies to required
// read them with no lock, so a policy created while another file had
// switched the default to "material" was not the policy the test expected.
//
// So, as for the mail configuration (test/support/mail-lock), it is a
// readers–writer lock:
//
//   holdComplianceSettings()   a file whose policies read the settings holds
//                              it shared for its whole run;
//   .exclusive() / .shared()   a describe that changes them switches the same
//                              connection to exclusive for its tests and back.
//                              The shared hold is let go before the exclusive
//                              one is asked for, so a file never waits on
//                              itself (and two such files never deadlock);
//   whole-file writers         keep taking SETTINGS_LOCK exclusively on their
//                              own connection, as before.
//
// The lock is taken on a connection of its own, outside lib/db's pool, and a
// process that dies frees it with its connection.

import { Client } from "pg";

export const SETTINGS_LOCK = 728342;

export interface ComplianceSettingsLock {
  /** Hold it alone (a describe that writes the settings). */
  exclusive(): Promise<void>;
  /** Back to reading alongside other readers. */
  shared(): Promise<void>;
  release(): Promise<void>;
}

export async function holdComplianceSettings(): Promise<ComplianceSettingsLock> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: `compliance-lock:${process.pid}` });
  await client.connect();
  await client.query("SELECT pg_advisory_lock_shared($1)", [SETTINGS_LOCK]);
  let mode: "shared" | "exclusive" | "none" = "shared";
  const unlock = async () => {
    if (mode === "shared") await client.query("SELECT pg_advisory_unlock_shared($1)", [SETTINGS_LOCK]);
    if (mode === "exclusive") await client.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]);
    mode = "none";
  };
  return {
    async exclusive() {
      if (mode === "exclusive") return;
      await unlock();
      await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
      mode = "exclusive";
    },
    async shared() {
      if (mode === "shared") return;
      await unlock();
      await client.query("SELECT pg_advisory_lock_shared($1)", [SETTINGS_LOCK]);
      mode = "shared";
    },
    async release() {
      mode = "none";
      await client.end().catch(() => {});
    },
  };
}
