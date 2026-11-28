// Tables for CompassDocs Cloud plan usage (1.22.0; lib/plan-usage,
// lib/plan-report). Part of lib/db's boot schema, after users and the
// helpdesk. Created everywhere (self-hosted too, like support access's) and
// empty unless a cloud workspace with a plan writes them.
//
//   plan_usage_daily        one row per UTC day: the day's counts (agents,
//                           active users this month, storage bytes, AI
//                           dollars this month by feature) as last counted,
//                           and where its report to the console stands.
//                           Counts only: no names, no content. Kept 13
//                           months (the trends read six).
//   plan_active_users       who signed in or used the app this month (UTC):
//                           one row per person per month, 'user' (an
//                           account) or 'portal' (a customer portal
//                           contact). Never leaves the workspace: the
//                           console gets the count, the admin the list.
//   ai_usage                one row per AI request outside the desk (Ask,
//                           Write and Proofread, MCP): the feature, tokens
//                           and the cost at the price list (the desk's own
//                           ledger is hd_claude_usage). No prompt, no answer.
//   plan_notices            thresholds already emailed: one per meter per
//                           threshold per month.
//   plan_banner_dismissals  banners an admin dismissed: per admin, per
//                           threshold, per month (Decision 9).

export const PLAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plan_usage_daily (
    day date PRIMARY KEY,
    counted_at timestamptz NOT NULL DEFAULT now(),
    plan text NOT NULL DEFAULT '',
    agents integer NOT NULL DEFAULT 0,
    active_users integer NOT NULL DEFAULT 0,
    storage_bytes bigint NOT NULL DEFAULT 0,
    storage jsonb NOT NULL DEFAULT '{}',
    ai_usd numeric(14,6) NOT NULL DEFAULT 0,
    ai jsonb NOT NULL DEFAULT '{}',
    reported_at timestamptz,
    reported_counted_at timestamptz,
    report_attempts integer NOT NULL DEFAULT 0,
    report_error text NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS plan_active_users (
    month date NOT NULL,
    kind text NOT NULL,
    subject_id integer NOT NULL,
    first_at timestamptz NOT NULL DEFAULT now(),
    last_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (month, kind, subject_id)
  );

  CREATE TABLE IF NOT EXISTS ai_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    feature text NOT NULL,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    model text NOT NULL DEFAULT '',
    input_tokens integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    cache_read_tokens integer NOT NULL DEFAULT 0,
    cache_write_tokens integer NOT NULL DEFAULT 0,
    cost_usd numeric(14,6) NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);
  -- The month's desk spending by UTC month (the desk's own limits use its timezone).
  CREATE INDEX IF NOT EXISTS idx_hd_claude_usage_at ON hd_claude_usage(at);

  CREATE TABLE IF NOT EXISTS plan_notices (
    month date NOT NULL,
    meter text NOT NULL,
    threshold text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    recipients integer NOT NULL DEFAULT 0,
    PRIMARY KEY (month, meter, threshold)
  );

  CREATE TABLE IF NOT EXISTS plan_banner_dismissals (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month date NOT NULL,
    meter text NOT NULL,
    threshold text NOT NULL,
    dismissed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, month, meter, threshold)
  );
`;
