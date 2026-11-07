-- Multi-node control plane, dormant until real two-node canary approval.
BEGIN;
ALTER TABLE vpn_node_assignments
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  ADD COLUMN last_observed_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  ADD COLUMN desired_node_revision bigint,
  ADD COLUMN applied_node_revision bigint NOT NULL DEFAULT 0 CHECK(applied_node_revision>=0);
UPDATE vpn_node_assignments
  SET desired_node_revision=GREATEST(1,desired_revision);
ALTER TABLE vpn_node_assignments
  ALTER COLUMN desired_node_revision SET NOT NULL,
  ADD CONSTRAINT vpn_node_revision_bounds CHECK(
    desired_node_revision BETWEEN 1 AND 1000000000
    AND applied_node_revision<=desired_node_revision);
CREATE INDEX vpn_node_assignments_retry_idx ON vpn_node_assignments(next_attempt_at,entitlement_id)
  WHERE state IN ('pending','active','revoking','failed');

-- Capacity admission must be serialized for ALL entry points, not only reserve().
-- An existing paid subscription must not be revoked because a node is full:
-- reactivate -> failed (pending manual placement), never overcommit.
CREATE FUNCTION vpn_node_capacity_admission() RETURNS trigger LANGUAGE plpgsql AS $capacity$
DECLARE
  v_max integer;
  v_occupied integer;
BEGIN
  IF NEW.state IN ('pending','active','revoking') AND (
    TG_OP='INSERT' OR OLD.state NOT IN ('pending','active','revoking')
  ) THEN
    SELECT max_clients INTO v_max FROM vpn_nodes WHERE id=NEW.node_id FOR UPDATE;
    SELECT count(*)::integer INTO v_occupied FROM vpn_node_assignments
      WHERE node_id=NEW.node_id AND state IN ('pending','active','revoking');
    IF v_max IS NULL OR v_occupied>=v_max THEN
      IF TG_OP='INSERT' THEN
        RAISE EXCEPTION 'VPN node capacity exceeded';
      END IF;
      NEW.state='failed';
      NEW.last_error_code='node_capacity';
    END IF;
  END IF;
  RETURN NEW;
END;
$capacity$;
CREATE TRIGGER vpn_node_capacity_guard
  BEFORE INSERT OR UPDATE OF state ON vpn_node_assignments
  FOR EACH ROW EXECUTE FUNCTION vpn_node_capacity_admission();

-- Node-level status changes must generate a NEW network operation revision
-- even when the customer's paid entitlement is unchanged.
CREATE FUNCTION vpn_node_state_revoke() RETURNS trigger LANGUAGE plpgsql AS $node_revoke$
BEGIN
  IF NEW.state='disabled' AND OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE vpn_node_assignments
      SET desired_node_revision=desired_node_revision+1,
          state=CASE WHEN state='revoked' THEN 'revoked' ELSE 'revoking' END,
          next_attempt_at=clock_timestamp(),last_error_code=NULL,
          updated_at=clock_timestamp()
      WHERE node_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$node_revoke$;
CREATE TRIGGER vpn_node_state_revoke_trigger
  AFTER UPDATE OF state ON vpn_nodes
  FOR EACH ROW EXECUTE FUNCTION vpn_node_state_revoke();

-- Payment/refund/expiry applies to every assigned node. Lock node rows in
-- deterministic order before deciding whether a previously revoked slot
-- may be reopened. The BEFORE trigger above enforces capacity atomically.
CREATE FUNCTION sync_vpn_node_assignment_revisions() RETURNS trigger LANGUAGE plpgsql AS $ent_sync$
DECLARE
  v_node_id uuid;
  v_bump boolean;
  v_allowed boolean;
BEGIN
  IF NEW.product = 'vpn' AND (
     NEW.revision IS DISTINCT FROM OLD.revision OR
     NEW.state IS DISTINCT FROM OLD.state OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
     NEW.quota_state IS DISTINCT FROM OLD.quota_state
  ) THEN
    v_allowed := NEW.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')
      AND NEW.quota_state='AVAILABLE'
      AND (NEW.expires_at IS NULL OR NEW.expires_at>clock_timestamp());
    v_bump := NEW.revision IS DISTINCT FROM OLD.revision
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.quota_state IS DISTINCT FROM OLD.quota_state
      OR ((NEW.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'))
           IS DISTINCT FROM
          (OLD.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')));
    FOR v_node_id IN SELECT node_id FROM vpn_node_assignments
      WHERE entitlement_id=NEW.id ORDER BY node_id LOOP
      PERFORM 1 FROM vpn_nodes WHERE id=v_node_id FOR UPDATE;
      UPDATE vpn_node_assignments
         SET desired_revision=NEW.revision,
             desired_node_revision=CASE
               WHEN v_bump THEN GREATEST(desired_node_revision+1,NEW.revision)
               ELSE desired_node_revision END,
             state=CASE
               WHEN v_allowed THEN CASE WHEN state='active' THEN 'active' ELSE 'pending' END
               ELSE CASE WHEN state='revoked' THEN 'revoked' ELSE 'revoking' END
             END,
             next_attempt_at=clock_timestamp(),
             last_error_code=NULL,
             updated_at=clock_timestamp()
       WHERE entitlement_id=NEW.id AND node_id=v_node_id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$ent_sync$;
CREATE TRIGGER vpn_node_assignment_revision_sync
  AFTER UPDATE OF revision,state,expires_at,quota_state ON entitlements
  FOR EACH ROW EXECUTE FUNCTION sync_vpn_node_assignment_revisions();
COMMIT;
