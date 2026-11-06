-- Phase 9: trial time starts only after an independently observed node ENABLE.
-- No live migration is allowed without production review. Trial remains disabled.
BEGIN;
ALTER TABLE trial_grants
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN access_expires_at timestamptz,
  ADD CONSTRAINT trial_dates_together CHECK(
    (activated_at IS NULL AND access_expires_at IS NULL) OR
    (activated_at IS NOT NULL AND
      access_expires_at = activated_at + interval '24 hours')
  );

-- Unactivated reservations are not active access. Existing trial rows from
-- development created with a clock at click time must be corrected.
UPDATE entitlements e
SET starts_at=NULL,expires_at=NULL
FROM trial_grants t
WHERE e.source_order_id=t.order_id AND t.activated_at IS NULL
  AND e.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED');

CREATE OR REPLACE FUNCTION acknowledge_provisioning(
  p_entitlement_id uuid,p_adapter text,p_revision bigint,
  p_fencing_token bigint,p_observed_enabled boolean
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_ent entitlements%ROWTYPE;
  v_trial trial_grants%ROWTYPE;
  v_pending boolean;
  v_expected boolean;
  v_rows integer;
  v_at timestamptz;
BEGIN
  -- Acquire the order-wide trial lock FIRST. This serializes the two entitlements
  -- of a bundle before any entitlement row lock, avoiding cross-adapter deadlock.
  SELECT t.* INTO v_trial
    FROM trial_grants t
    JOIN entitlements e ON e.source_order_id=t.order_id
   WHERE e.id=p_entitlement_id
     FOR UPDATE OF t;
  SELECT * INTO v_ent FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_ent.product IS DISTINCT FROM p_adapter
     OR v_ent.revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;

  v_pending := v_trial.order_id IS NOT NULL
    AND v_trial.activated_at IS NULL
    AND v_ent.starts_at IS NULL AND v_ent.expires_at IS NULL;
  v_expected := v_ent.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','ACTIVE')
    AND v_ent.quota_state='AVAILABLE'
    AND (v_ent.quota_limit_bytes IS NULL
        OR v_ent.quota_used_bytes<v_ent.quota_limit_bytes)
    AND (v_pending OR COALESCE(v_ent.expires_at>clock_timestamp(),false));

  IF p_observed_enabled IS DISTINCT FROM v_expected THEN RETURN false; END IF;
  UPDATE provisioning_state
     SET applied_revision=p_revision,last_observed_at=clock_timestamp()
   WHERE entitlement_id=p_entitlement_id AND adapter=p_adapter
     AND fencing_token=p_fencing_token;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RETURN false; END IF;

  IF v_pending AND v_expected THEN
    v_at:=clock_timestamp();
    UPDATE trial_grants
       SET activated_at=v_at,access_expires_at=v_at+interval '24 hours'
     WHERE order_id=v_trial.order_id AND activated_at IS NULL;
    -- Revision 2 is a deliberate second pass: the first node operation used
    -- a short provisional hard expiry, now it MUST apply the exact 24h deadline.
    WITH changed AS (
      UPDATE entitlements SET
        starts_at=v_at,
        expires_at=v_at+interval '24 hours',
        revision=revision+1,
        state=CASE WHEN id=p_entitlement_id THEN 'ACTIVE' ELSE state END
      WHERE source_order_id=v_trial.order_id
        AND state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','ACTIVE')
      RETURNING id,revision
    )
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      SELECT id,revision FROM changed
      ON CONFLICT(entitlement_id,desired_revision) DO NOTHING;
  ELSIF v_expected THEN
    UPDATE entitlements SET state='ACTIVE'
    WHERE id=p_entitlement_id
      AND state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED');
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION acknowledge_provisioning(uuid,text,bigint,bigint,boolean) FROM PUBLIC;
COMMIT;
