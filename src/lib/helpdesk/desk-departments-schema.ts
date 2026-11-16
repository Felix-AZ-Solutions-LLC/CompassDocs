// Helpdesk 1.20.23: desk departments (lib/helpdesk/desk-departments). Kept
// apart from the server code so lib/db's SCHEMA string can append it without
// importing anything. Additive and idempotent. Append after every table it
// alters: hd_teams, hd_macros, hd_automations, hd_workflows,
// hd_request_types, hd_canned_responses, hd_checklist_templates.
//
// Not the requester's directory department (VIP lists, contact cards, the
// report filter `department=`): that one is a directory field and is left
// alone. This is the desk's own grouping, always named "desk department" in
// code, the API (desk_department_id, ?desk_department=) and the database.
//
//   hd_desk_departments   a desk department: its name (unique, any case) and
//                         `is_default`, the one department that always exists
//                         ("General" on upgrade and on a new desk; it can be
//                         renamed, never deleted). At most one is the default
//                         (a partial unique index).
//   hd_default_desk_department()   that department's id, a STABLE function:
//                         the column default below, so a row written by code
//                         that never names a department (an import, the
//                         starter set, an older binary) lands in the default
//                         department, never in "All departments".
//   hd_teams.desk_department_id    NOT NULL: a team is in exactly one desk
//                         department (the one-team-one-department invariant
//                         is the column itself).
//   <content>.desk_department_id   on macros, canned responses, checklist
//                         templates, workflows, request types and automations.
//                         NULL = "All departments" (shared desk-wide; only a
//                         desk Admin sets or clears it). Personal macros and
//                         canned responses (owner_id set) are their owner's
//                         alone and carry no department (NULL, never read as
//                         All departments: see desk-departments).
//                         Recurring tickets carry none either: a schedule is
//                         its team's (team_id NOT NULL) and is in its team's
//                         department.
//
// Upgrade: the columns are added with the function as their default. A
// non-volatile default is evaluated once and stored in the catalog (Postgres
// 11+ "fast default"), so every existing team and item is in the default
// department ("General", created first) with no table rewrite; the foreign
// key's validation reads these small configuration tables once. Nothing
// changes for anyone: every team and every item is in General. Personal rows
// are then set back to NULL (an UPDATE that finds nothing on later boots).
// Every reference is ON DELETE RESTRICT: a department can't be dropped from
// under a team or an item and silently turn it into "All departments"
// (desk-departments deleteDeskDepartment refuses first, with a sentence).

export const HD_DESK_DEPARTMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_desk_departments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_desk_departments_name ON hd_desk_departments (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_desk_departments_default ON hd_desk_departments (is_default) WHERE is_default;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hd_desk_departments WHERE is_default) THEN
    IF EXISTS (SELECT 1 FROM hd_desk_departments WHERE lower(name) = 'general') THEN
      UPDATE hd_desk_departments SET is_default = true WHERE id = (SELECT min(id) FROM hd_desk_departments WHERE lower(name) = 'general');
    ELSE
      INSERT INTO hd_desk_departments (name, is_default, position) VALUES ('General', true, 0);
    END IF;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION hd_default_desk_department() RETURNS integer LANGUAGE sql STABLE AS $fn$
  SELECT id FROM hd_desk_departments WHERE is_default ORDER BY id LIMIT 1
$fn$;
ALTER TABLE hd_teams ADD COLUMN IF NOT EXISTS desk_department_id integer NOT NULL DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_hd_teams_desk_department ON hd_teams (desk_department_id);
ALTER TABLE hd_macros ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
ALTER TABLE hd_canned_responses ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
ALTER TABLE hd_checklist_templates ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
ALTER TABLE hd_workflows ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
ALTER TABLE hd_request_types ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
ALTER TABLE hd_automations ADD COLUMN IF NOT EXISTS desk_department_id integer DEFAULT hd_default_desk_department() REFERENCES hd_desk_departments(id) ON DELETE RESTRICT;
UPDATE hd_macros SET desk_department_id = NULL WHERE owner_id IS NOT NULL AND desk_department_id IS NOT NULL;
UPDATE hd_canned_responses SET desk_department_id = NULL WHERE owner_id IS NOT NULL AND desk_department_id IS NOT NULL;
`;
