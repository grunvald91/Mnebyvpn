-- Synchronize provisional readiness for new bundle trials. Paid and single
-- trial activation retain their prior behavior. Never extend an existing clock.
BEGIN;
ALTER TABLE public.provisioning_state ADD COLUMN observed_provisional_until timestamptz;
-- Starting a new observation invalidates the previous provisional receipt.
-- A failed or interrupted retry cannot lend stale readiness to its sibling.
CREATE OR REPLACE FUNCTION public.claim_provisioning_fence(p_entitlement_id uuid, p_adapter text)
RETURNS bigint LANGUAGE plpgsql AS $
DECLARE
  v_token bigint;
BEGIN
  IF p_adapter NOT IN ('vpn', 'smart_dns') OR NOT EXISTS (
    SELECT 1 FROM entitlements
     WHERE id = p_entitlement_id AND product = p_adapter
  ) THEN RAISE EXCEPTION 'Invalid adapter for entitlement'; END IF;
  INSERT INTO provisioning_state(entitlement_id, adapter, fencing_token)
    VALUES(p_entitlement_id, p_adapter, 1)
    ON CONFLICT (entitlement_id, adapter)
    DO UPDATE SET fencing_token = provisioning_state.fencing_token + 1,
                  observed_provisional_until = NULL
    RETURNING fencing_token INTO v_token;
  RETURN v_token;
END;
$;

CREATE FUNCTION public.acknowledge_provisioning_observed(
  p_entitlement_id uuid, p_adapter text, p_revision bigint,
  p_fencing_token bigint, p_observed_enabled boolean, p_observed_expiry timestamptz
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_ent entitlements%ROWTYPE;
  v_trial trial_grants%ROWTYPE;
  v_pending boolean;
  v_paid_duration bigint;
  v_paid_pending boolean;
  v_expected boolean;
  v_bundle_pending boolean;
  v_rows integer;
  v_at timestamptz;
BEGIN
  SELECT t.* INTO v_trial
    FROM trial_grants t
    JOIN entitlements e ON e.source_order_id = t.order_id
   WHERE e.id = p_entitlement_id
     FOR UPDATE OF t;
  SELECT * INTO v_ent FROM entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_ent.product IS DISTINCT FROM p_adapter
     OR v_ent.revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;

  v_pending := v_trial.order_id IS NOT NULL
    AND v_trial.activated_at IS NULL
    AND v_ent.starts_at IS NULL AND v_ent.expires_at IS NULL;
  v_bundle_pending := v_pending AND v_trial.product='bundle';
  IF v_bundle_pending AND p_observed_enabled IS TRUE AND (
    p_observed_expiry IS NULL
    OR p_observed_expiry <= clock_timestamp()+interval '10 seconds'
    OR p_observed_expiry > clock_timestamp()+interval '5 minutes 1 second'
  ) THEN RETURN false; END IF;
  SELECT t.duration_seconds INTO v_paid_duration
    FROM orders o JOIN order_terms t ON t.order_id = o.id
    WHERE o.id = v_ent.source_order_id AND o.provider IN ('yookassa', 'prodamus', 'telegram_stars')
      AND o.state = 'PAID' AND v_ent.product = 'vpn'
      AND v_ent.state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED')
      AND v_ent.starts_at IS NULL AND v_ent.expires_at IS NULL
    LIMIT 1;
  v_paid_pending := v_paid_duration IS NOT NULL;
  v_expected := v_ent.state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE')
    AND v_ent.quota_state = 'AVAILABLE'
    AND (v_ent.quota_limit_bytes IS NULL
        OR v_ent.quota_used_bytes < v_ent.quota_limit_bytes)
    AND (v_pending OR v_paid_pending OR
      COALESCE(v_ent.expires_at > clock_timestamp(), false));

  IF p_observed_enabled IS DISTINCT FROM v_expected THEN RETURN false; END IF;
  UPDATE provisioning_state
     SET applied_revision = p_revision, last_observed_at = clock_timestamp(),
         observed_provisional_until = CASE WHEN v_bundle_pending AND p_observed_enabled THEN p_observed_expiry ELSE NULL END
   WHERE entitlement_id = p_entitlement_id AND adapter = p_adapter
     AND fencing_token = p_fencing_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RETURN false; END IF;

  IF v_pending AND v_expected THEN
    v_at := clock_timestamp();
    -- The trial row lock serializes both adapters. A stale, superseded,
    -- missing or near-expiry provisional observation cannot start the clock.
    IF v_bundle_pending AND NOT (
      SELECT count(*)=2 AND count(DISTINCT e.product)=2
      FROM entitlements e JOIN provisioning_state p
        ON p.entitlement_id=e.id AND p.adapter=e.product
      WHERE e.source_order_id=v_trial.order_id AND e.account_id=v_trial.account_id
        AND e.product IN ('vpn','smart_dns')
        AND e.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')
        AND e.starts_at IS NULL AND e.expires_at IS NULL
        AND e.quota_state='AVAILABLE'
        AND (e.quota_limit_bytes IS NULL OR e.quota_used_bytes<e.quota_limit_bytes)
        AND p.applied_revision=e.revision
        AND p.observed_provisional_until>v_at+interval '10 seconds'
    ) THEN RETURN true; END IF;
    UPDATE trial_grants
       SET activated_at = v_at, access_expires_at = v_at + interval '24 hours'
     WHERE order_id = v_trial.order_id AND activated_at IS NULL;
    WITH changed AS (
      UPDATE entitlements SET
        starts_at = v_at,
        expires_at = v_at + interval '24 hours',
        revision = revision + 1,
        state = CASE WHEN NOT v_bundle_pending AND id = p_entitlement_id THEN 'ACTIVE' ELSE state END
      WHERE source_order_id = v_trial.order_id
        AND state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE')
      RETURNING id, revision
    )
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      SELECT id, revision FROM changed
      ON CONFLICT(entitlement_id, desired_revision) DO NOTHING;
  ELSIF v_paid_pending AND v_expected THEN
    v_at := clock_timestamp();
    -- First node-ack proves a hard-enforced provisional VPN credential.
    -- Credit starts now, NOT at the prior payment time. A second node
    -- reconciliation must apply the full purchased deadline before ACTIVE.
    UPDATE entitlement_credits
       SET starts_at = v_at,
           ends_at = v_at + make_interval(secs => v_paid_duration::double precision)
     WHERE entitlement_id = p_entitlement_id
       AND order_id = v_ent.source_order_id AND refunded_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE entitlements SET starts_at = v_at,
       expires_at = v_at + make_interval(secs => v_paid_duration::double precision),
       revision = revision + 1
     WHERE id = p_entitlement_id AND state IN
       ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED');
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      SELECT id, revision FROM entitlements WHERE id = p_entitlement_id
      ON CONFLICT(entitlement_id, desired_revision) DO NOTHING;
  ELSIF v_expected THEN
    UPDATE entitlements SET state = 'ACTIVE'
    WHERE id = p_entitlement_id
      AND state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED');
  END IF;
  RETURN true;
END;
$$;
-- Compatibility entrypoint: older workers cannot start a pending bundle
-- without its observed hard deadline. Single trials and paid access unchanged.
CREATE OR REPLACE FUNCTION public.acknowledge_provisioning(
 p_entitlement_id uuid,p_adapter text,p_revision bigint,
 p_fencing_token bigint,p_observed_enabled boolean
) RETURNS boolean LANGUAGE sql AS $$
 SELECT public.acknowledge_provisioning_observed($1,$2,$3,$4,$5,NULL::timestamptz)
$$;
REVOKE ALL ON FUNCTION public.acknowledge_provisioning_observed(uuid,text,bigint,bigint,boolean,timestamptz) FROM PUBLIC;
-- Mirror only existing explicit execution privileges, never PUBLIC. Existing
-- worker roles retain invoker semantics and no new table-wide grants.
DO $acl$
DECLARE r record;
BEGIN
 FOR r IN SELECT grantee, is_grantable FROM pg_proc p,
   LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid='public.acknowledge_provisioning(uuid,text,bigint,bigint,boolean)'::regprocedure
     AND a.privilege_type='EXECUTE' AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.acknowledge_provisioning_observed(uuid,text,bigint,bigint,boolean,timestamptz) TO %I%s',
     pg_get_userbyid(r.grantee),CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
 END LOOP;
END $acl$;
COMMIT;
