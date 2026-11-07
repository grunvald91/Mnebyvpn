-- Multi-node provisioning metadata. Additive only; NEVER deploys a worker or changes live VPN routing.
BEGIN;
ALTER TABLE vpn_node_assignments
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  ADD COLUMN last_observed_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);

CREATE INDEX vpn_node_assignments_retry_idx
  ON vpn_node_assignments(next_attempt_at, entitlement_id)
  WHERE state IN ('pending','active','revoking','failed');

-- Payment, refund, expiration and renewal updates must notify *every* assigned node.
-- No user/node credential is ever inserted into this table.
CREATE FUNCTION sync_vpn_node_assignment_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product = 'vpn' AND (
     NEW.revision IS DISTINCT FROM OLD.revision OR
     NEW.state IS DISTINCT FROM OLD.state OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
     NEW.quota_state IS DISTINCT FROM OLD.quota_state
  ) THEN
    UPDATE vpn_node_assignments
       SET desired_revision = NEW.revision,
           state = CASE
             WHEN NEW.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')
                  AND NEW.quota_state = 'AVAILABLE'
                  AND (NEW.expires_at IS NULL OR NEW.expires_at > clock_timestamp())
               THEN CASE
                 WHEN state='active' THEN 'active'
                 WHEN state='revoked' AND NEW.revision=desired_revision THEN 'revoked'
                 ELSE 'pending' END
             ELSE 'revoking'
           END,
           next_attempt_at = clock_timestamp(),
           last_error_code = NULL,
           updated_at = clock_timestamp()
     WHERE entitlement_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vpn_node_assignment_revision_sync
  AFTER UPDATE OF revision,state,expires_at,quota_state ON entitlements
  FOR EACH ROW EXECUTE FUNCTION sync_vpn_node_assignment_revisions();

-- New control plane has no authority to change global entitlement ACTIVE.
-- Existing billing/provisioning stays unchanged.
COMMIT;
