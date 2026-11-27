// Tables for support access and workspace exports (1.21.4; lib/support,
// lib/workspace-export). Part of lib/db's boot schema, after users and
// sessions. Created everywhere (self-hosted too) and empty unless a cloud
// workspace uses them.

export const SUPPORT_SCHEMA = `
  -- Support access (1.21.4, lib/support): a request from the CompassDocs
  -- console (or an emergency grant), what a workspace administrator decided,
  -- and the window it opened. id is the signed token's jti.
  CREATE TABLE IF NOT EXISTS support_requests (
    id text PRIMARY KEY,
    kind text NOT NULL DEFAULT 'request',
    status text NOT NULL DEFAULT 'pending',
    staff_name text NOT NULL,
    staff_email text NOT NULL,
    reason text NOT NULL,
    level text NOT NULL,
    duration_minutes integer NOT NULL,
    emergency_reason text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    decided_by integer,
    decided_by_name text,
    window_starts timestamptz,
    window_ends timestamptz,
    ended_at timestamptz,
    end_reason text,
    reviewed_at timestamptz,
    reviewed_by_name text
  );
  CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests(status);
  CREATE INDEX IF NOT EXISTS idx_support_requests_requested ON support_requests(requested_at DESC);

  -- One sign-in under a request: its own service account (principal_id,
  -- users.status 'service', auth_provider 'compassdocs_support'), never one
  -- of the customer's.
  CREATE TABLE IF NOT EXISTS support_sessions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id text NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
    principal_id integer REFERENCES users(id) ON DELETE SET NULL,
    token_id text NOT NULL,
    level text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    end_reason text,
    ended_by_name text,
    ip text,
    user_agent text,
    pages integer NOT NULL DEFAULT 0,
    actions integer NOT NULL DEFAULT 0,
    last_seen_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_support_sessions_request ON support_sessions(request_id);
  CREATE INDEX IF NOT EXISTS idx_support_sessions_principal ON support_sessions(principal_id);

  -- Every support token id accepted, until well after it expires: a token works once.
  CREATE TABLE IF NOT EXISTS support_token_uses (
    jti text PRIMARY KEY,
    kind text NOT NULL,
    used_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );

  -- A browser session opened by a support sign-in (lib/auth currentSession).
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS support_session_id integer;
`;

export const WORKSPACE_EXPORT_SCHEMA = `
  -- Workspace exports (1.21.4, lib/workspace-export): one archive of the
  -- database and every stored file, made in the background, downloadable by
  -- a workspace administrator until expires_at. id names the archive in the
  -- file store (exports/<id>.tar).
  CREATE TABLE IF NOT EXISTS workspace_exports (
    id text PRIMARY KEY,
    status text NOT NULL DEFAULT 'running',
    stage text NOT NULL DEFAULT 'database',
    requested_by integer,
    requested_by_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    files_total integer NOT NULL DEFAULT 0,
    files_done integer NOT NULL DEFAULT 0,
    bytes_total bigint NOT NULL DEFAULT 0,
    bytes_done bigint NOT NULL DEFAULT 0,
    size bigint,
    sha256 text,
    file_name text,
    error text,
    expires_at timestamptz,
    downloads integer NOT NULL DEFAULT 0,
    last_downloaded_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_exports_created ON workspace_exports(created_at DESC);
`;
