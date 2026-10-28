-- DMARC aggregate reports (RFC 7489) and SMTP TLS reports (RFC 8460), both ways.
--
-- Received reports are rows attached to the domain they are about, so the panel
-- can total them by source and by sender. The (domain, org, report id) key makes
-- a resent report a no-op rather than a doubled count.
CREATE TABLE dmarc_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  org_name TEXT NOT NULL,
  org_email TEXT,
  report_id TEXT NOT NULL,
  policy_domain TEXT NOT NULL,
  policy_p TEXT,
  policy_sp TEXT,
  policy_pct INTEGER,
  adkim TEXT,
  aspf TEXT,
  date_begin TIMESTAMPTZ NOT NULL,
  date_end TIMESTAMPTZ NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dmarc_reports_unique_idx ON dmarc_reports (domain_id, org_name, report_id);
CREATE INDEX dmarc_reports_domain_idx ON dmarc_reports (domain_id, date_end DESC);

CREATE TABLE dmarc_report_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
  source_ip TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL,
  dkim_eval TEXT NOT NULL,
  spf_eval TEXT NOT NULL,
  header_from TEXT NOT NULL,
  envelope_from TEXT,
  dkim_results JSONB NOT NULL DEFAULT '[]',
  spf_results JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX dmarc_report_records_report_idx ON dmarc_report_records (report_id);

CREATE TABLE tls_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  org_name TEXT NOT NULL,
  report_id TEXT NOT NULL,
  contact TEXT,
  date_begin TIMESTAMPTZ NOT NULL,
  date_end TIMESTAMPTZ NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tls_reports_unique_idx ON tls_reports (domain_id, org_name, report_id);
CREATE INDEX tls_reports_domain_idx ON tls_reports (domain_id, date_end DESC);

CREATE TABLE tls_report_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES tls_reports(id) ON DELETE CASCADE,
  policy_type TEXT NOT NULL,
  policy_domain TEXT NOT NULL,
  mx_host TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  failures JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX tls_report_policies_report_idx ON tls_report_policies (report_id);

-- What this server saw, waiting for the daily report. One row per distinct
-- outcome per UTC day with a count, not one per message: a busy sender is one
-- row a day, and the report is built straight from these. Every key column is
-- NOT NULL with '' for "absent" so the unique index can be the upsert target.
CREATE TABLE dmarc_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day TEXT NOT NULL,
  policy_domain TEXT NOT NULL,
  header_from TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  envelope_from TEXT NOT NULL DEFAULT '',
  spf_result TEXT NOT NULL,
  spf_domain TEXT NOT NULL DEFAULT '',
  spf_aligned BOOLEAN NOT NULL DEFAULT false,
  dkim_result TEXT NOT NULL,
  dkim_domain TEXT NOT NULL DEFAULT '',
  dkim_aligned BOOLEAN NOT NULL DEFAULT false,
  disposition TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX dmarc_evaluations_key_idx ON dmarc_evaluations
  (day, policy_domain, header_from, source_ip, envelope_from, spf_result, spf_domain,
   spf_aligned, dkim_result, dkim_domain, dkim_aligned, disposition);

CREATE TABLE tls_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day TEXT NOT NULL,
  policy_domain TEXT NOT NULL,
  mx_host TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX tls_outcomes_key_idx ON tls_outcomes (day, policy_domain, mx_host, result);

-- One row per report this server decided to send, or decided not to. The
-- unique key is the claim, so two workers cannot both send yesterday's report,
-- and counting today's rows is the daily cap.
CREATE TABLE report_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  policy_domain TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX report_sends_key_idx ON report_sends (kind, policy_domain, day);
CREATE INDEX report_sends_created_idx ON report_sends (created_at);
