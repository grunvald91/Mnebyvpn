-- MNEBYDNS #84 stage 3: offline control-plane pre-authorisation of
-- discrete traffic chunks. No live proxy, network enforcement or sales.
-- Future ingress MUST stop forwarding at min(approved bytes, allowed_until),
-- and MUST NOT release a hold until that socket is conclusively quiescent.
BEGIN;

CREATE TABLE smart_dns_quota_reservations (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  reservation_id text NOT NULL
    CHECK (length(reservation_id) BETWEEN 8 AND 96
           AND reservation_id ~ '^[A-Za-z0-9_-]+$'),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  allowed_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'HELD'
    CHECK (state IN ('HELD','SETTLED','RELEASED')),
  upload_bytes bigint,
  download_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  PRIMARY KEY(entitlement_id,reservation_id),
  CHECK (
    (state='HELD' AND closed_at IS NULL AND upload_bytes IS NULL AND download_bytes IS NULL)
    OR (state='RELEASED' AND closed_at IS NOT NULL AND upload_bytes=0 AND download_bytes=0)
    OR (state='SETTLED' AND closed_at IS NOT NULL AND
      upload_bytes>=0 AND download_bytes>=0 AND
      upload_bytes::numeric+download_bytes::numeric>0 AND
      upload_bytes::numeric+download_bytes::numeric<=reserved_bytes)
  ),
  CHECK (allowed_until > created_at)
);
CREATE INDEX smart_dns_quota_held_idx
  ON smart_dns_quota_reservations(entitlement_id)
  WHERE state='HELD';

REVOKE ALL ON smart_dns_quota_reservations FROM PUBLIC;

-- Enforce held+settled <= purchased total even when an older trusted writer
-- calls the legacy direct-debit API instead of this reservation API.
-- Refund/revoke/expiry deliberately override the invariant by changing state
-- away from ACTIVE: further forwarding must already have been disabled at
-- ingress. Settling such in-flight bytes then needs a reviewed recovery path.
CREATE FUNCTION guard_smart_dns_held_quota()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_held numeric;
BEGIN
  IF NEW.product='smart_dns' AND NEW.state='ACTIVE' THEN
    SELECT COALESCE(sum(r.reserved_bytes),0) INTO v_held
      FROM smart_dns_quota_reservations r
      WHERE r.entitlement_id=NEW.id AND r.state='HELD';
    IF NEW.quota_limit_bytes IS NULL
       OR NEW.quota_used_bytes::numeric+v_held>NEW.quota_limit_bytes::numeric THEN
      RAISE EXCEPTION 'Paid DNS held+used quota would exceed limit'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER smart_dns_held_quota_guard
  BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION guard_smart_dns_held_quota();

-- One reservation = one bounded transfer chunk. No self-releasing timeouts:
-- after a crash the hold persists until proven stopped, sacrificing unused
-- bytes rather than inadvertently authorising their retransmission.
-- 15 s is a PROPOSED maximum data-plane lease, not a measured SLA.
CREATE FUNCTION reserve_smart_dns_chunk(
  p_entitlement_id uuid, p_reservation_id text, p_bytes bigint
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_ent entitlements%ROWTYPE;
  v_previous smart_dns_quota_reservations%ROWTYPE;
  v_held numeric;
  v_credit_available numeric;
  v_now timestamptz;
BEGIN
  IF p_entitlement_id IS NULL OR p_reservation_id IS NULL
     OR length(p_reservation_id) NOT BETWEEN 8 AND 96
     OR p_reservation_id !~ '^[A-Za-z0-9_-]+$'
     OR p_bytes IS NULL OR p_bytes<=0 THEN RETURN 'DENY_INVALID'; END IF;

  -- All allocations and settlements of an entitlement lock this row FIRST.
  SELECT * INTO v_ent FROM entitlements
    WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;

  SELECT * INTO v_previous FROM smart_dns_quota_reservations
    WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
  IF FOUND THEN
    IF v_previous.state='HELD' AND v_previous.reserved_bytes=p_bytes THEN
      RETURN 'DUPLICATE';
    END IF;
    RETURN 'DENY_RESERVATION_CONFLICT';
  END IF;

  v_now:=clock_timestamp();
  IF v_ent.product<>'smart_dns' OR v_ent.state<>'ACTIVE'
     OR v_ent.quota_state<>'AVAILABLE' OR
     v_ent.starts_at IS NULL OR v_ent.starts_at>v_now
     OR v_ent.expires_at IS NULL OR v_ent.expires_at<=v_now
     OR v_ent.quota_limit_bytes IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM provisioning_state p
       WHERE p.entitlement_id=p_entitlement_id AND p.adapter='smart_dns'
         AND p.applied_revision=v_ent.revision
         AND p.last_observed_at IS NOT NULL) THEN
    RETURN 'DENY_INACTIVE';
  END IF;

  SELECT COALESCE(sum(reserved_bytes),0) INTO v_held
    FROM smart_dns_quota_reservations
    WHERE entitlement_id=p_entitlement_id AND state='HELD';
  SELECT COALESCE(sum(c.quota_bytes-c.consumed_bytes),0)
    INTO v_credit_available
    FROM entitlement_credits c
    JOIN orders o ON o.id=c.order_id
    WHERE c.entitlement_id=p_entitlement_id
      AND c.refunded_at IS NULL
      AND c.quota_bytes IS NOT NULL
      AND o.state='PAID';
  IF p_bytes::numeric+v_held >
     v_ent.quota_limit_bytes::numeric-v_ent.quota_used_bytes::numeric
     OR p_bytes::numeric+v_held>v_credit_available THEN
    RETURN 'DENY_QUOTA';
  END IF;

  INSERT INTO smart_dns_quota_reservations(
    entitlement_id,reservation_id,reserved_bytes,created_at,allowed_until)
  VALUES(p_entitlement_id,p_reservation_id,p_bytes,v_now,
         LEAST(v_ent.expires_at,v_now+interval '15 seconds'));
  RETURN 'RESERVED';
END;
$$;

-- Complete a chunk after trusted ingress has stopped forwarding it.
-- Zero actual bytes releases its entire hold; positive bytes charge only
-- what ACTUALLY crossed the stream, and unused reserved bytes become free.
-- Never call this to "clear expired holds" while a socket might be alive.
-- Late settlement AFTER expiry/refund is deliberately denied, requiring
-- stopped-stream reconciliation; it must not silently grant new capacity.
CREATE FUNCTION settle_smart_dns_chunk(
  p_entitlement_id uuid,p_reservation_id text,
  p_upload_bytes bigint,p_download_bytes bigint
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_res smart_dns_quota_reservations%ROWTYPE;
  v_result text;
  v_total numeric;
BEGIN
  IF p_entitlement_id IS NULL OR p_reservation_id IS NULL
     OR length(p_reservation_id) NOT BETWEEN 8 AND 96
     OR p_reservation_id !~ '^[A-Za-z0-9_-]+$'
     OR p_upload_bytes IS NULL OR p_download_bytes IS NULL
     OR p_upload_bytes<0 OR p_download_bytes<0 THEN
    RETURN 'DENY_INVALID';
  END IF;
  v_total:=p_upload_bytes::numeric+p_download_bytes::numeric;
  IF v_total>9223372036854775807::numeric THEN
    RETURN 'DENY_INVALID';
  END IF;

  PERFORM 1 FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  SELECT * INTO v_res FROM smart_dns_quota_reservations
    WHERE entitlement_id=p_entitlement_id
      AND reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_RESERVATION'; END IF;
  IF v_res.state<>'HELD' THEN
    IF v_res.upload_bytes=p_upload_bytes AND
       v_res.download_bytes=p_download_bytes THEN
      RETURN 'DUPLICATE';
    END IF;
    RETURN 'DENY_RESERVATION_CONFLICT';
  END IF;
  IF v_total>v_res.reserved_bytes THEN RETURN 'DENY_OVER_RESERVATION'; END IF;

  IF v_total=0 THEN
    UPDATE smart_dns_quota_reservations SET
      state='RELEASED',upload_bytes=0,download_bytes=0,
      closed_at=clock_timestamp()
    WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
    RETURN 'RELEASED';
  END IF;

  -- Remove the hold within this same transaction before charging actual
  -- bytes. On a denied debit restore the hold; no capacity is leaked.
  UPDATE smart_dns_quota_reservations SET state='SETTLED',
    upload_bytes=p_upload_bytes,download_bytes=p_download_bytes,
    closed_at=clock_timestamp()
  WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
  v_result:=record_smart_dns_measured_traffic(
    p_entitlement_id,'reserve:'||p_reservation_id,
    p_upload_bytes,p_download_bytes);
  IF v_result<>'ACCEPTED' THEN
    UPDATE smart_dns_quota_reservations SET
      state='HELD',upload_bytes=NULL,download_bytes=NULL,closed_at=NULL
    WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
    RETURN v_result;
  END IF;
  RETURN 'SETTLED';
END;
$$;

REVOKE ALL ON FUNCTION guard_smart_dns_held_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_smart_dns_chunk(uuid,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_smart_dns_chunk(uuid,text,bigint,bigint) FROM PUBLIC;
COMMIT;
