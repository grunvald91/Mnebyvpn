-- Owner-controlled reversible DNS route deployment state.
BEGIN;
ALTER TABLE dns_admin_domains DROP CONSTRAINT dns_admin_domains_status_check;
ALTER TABLE dns_admin_domains ADD CONSTRAINT dns_admin_domains_status_check
 CHECK (status IN ('PENDING','APPLY_REQUESTED','PROBING','CANARY','CONFIRM_REQUESTED','CONFIRMING',
                  'ACTIVE','FAILED','CANCELLED','REMOVAL_PENDING','REMOVING',
                  'ROLLBACK_REQUESTED'));
ALTER TABLE dns_admin_domains
 ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 ADD COLUMN canary_run_id bigint CHECK(canary_run_id IS NULL OR canary_run_id>0),
 ADD COLUMN canary_expires_at timestamptz,
 ADD COLUMN last_error_code text CHECK(last_error_code IS NULL OR length(last_error_code)<=96),
 ADD COLUMN verified_origin_ip inet,
 ADD COLUMN applied_at timestamptz,
 ADD COLUMN confirmed_at timestamptz;
CREATE INDEX dns_admin_domains_action_queue_idx ON dns_admin_domains (updated_at,id)
 WHERE status IN ('APPLY_REQUESTED','PROBING','CONFIRM_REQUESTED','CONFIRMING','REMOVAL_PENDING','REMOVING','ROLLBACK_REQUESTED');
ALTER TABLE dns_admin_domains ADD CONSTRAINT dns_admin_domains_canary_deadline
 CHECK (status NOT IN ('CANARY','CONFIRM_REQUESTED') OR canary_expires_at IS NOT NULL);
COMMIT;
