-- Stage 5 review fixes: debit/settlement race, observable unresolved holds,
-- and least-privilege RPC for a future trusted network ingress. OFFLINE ONLY.
-- Do not grant these functions to a public DNS resolver or web client.
BEGIN;

-- A transfer that was PRE-authorized while active can complete after a
-- refund/expiry. Do not silently discard those observed bytes, nor deduct
-- from refunded credits. Keep them in a separate immutable audit ledger until
-- merchant-specific post-revocation billing rules are approved.
CREATE TABLE smart_dns_late_traffic (
  entitlement_id uuid NOT NULL,
  reservation_id text NOT NULL,
  upload_bytes bigint NOT NULL CHECK (upload_bytes>=0),
  download_bytes bigint NOT NULL CHECK (download_bytes>=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(reason IN ('DENY_INACTIVE','DENY_QUOTA')),
  PRIMARY KEY(entitlement_id,reservation_id),
  FOREIGN KEY(entitlement_id,reservation_id)
    REFERENCES smart_dns_quota_reservations(entitlement_id,reservation_id)
    ON DELETE RESTRICT,
  CHECK(upload_bytes::numeric+download_bytes::numeric>0)
);
REVOKE ALL ON smart_dns_late_traffic FROM PUBLIC;

-- Preserve the original fencing epoch in every new ingress-issued chunk.
-- Existing legacy reservations can be audited only by the old trusted owner;
-- they cannot be forged into a revision-backed ingress permit.
ALTER TABLE smart_dns_quota_reservations
  ADD COLUMN granted_revision bigint CHECK (granted_revision > 0);

CREATE FUNCTION guard_smart_dns_late_traffic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Late DNS traffic audit records are append-only'
    USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER smart_dns_late_traffic_append_only
  BEFORE UPDATE OR DELETE ON smart_dns_late_traffic
  FOR EACH ROW EXECUTE FUNCTION guard_smart_dns_late_traffic();

-- Replaces 0111 settlement atomically. On expiry/refund race the transaction
-- still closes HELD reservation and inserts an immutable LATE entry. There is
-- NO second debit to refunded credits and no silent byte loss from audit.
CREATE OR REPLACE FUNCTION settle_smart_dns_chunk(
  p_entitlement_id uuid,p_reservation_id text,
  p_upload_bytes bigint,p_download_bytes bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_res smart_dns_quota_reservations%ROWTYPE;
  v_result text;
  v_total numeric;
BEGIN
  IF p_entitlement_id IS NULL OR p_reservation_id IS NULL
     OR length(p_reservation_id) NOT BETWEEN 8 AND 96
     OR p_reservation_id !~ '^[A-Za-z0-9_-]+$'
     OR p_upload_bytes IS NULL OR p_download_bytes IS NULL
     OR p_upload_bytes<0 OR p_download_bytes<0 THEN RETURN 'DENY_INVALID';
  END IF;
  v_total:=p_upload_bytes::numeric+p_download_bytes::numeric;
  IF v_total>9223372036854775807::numeric THEN RETURN 'DENY_INVALID'; END IF;

  PERFORM 1 FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  SELECT * INTO v_res FROM smart_dns_quota_reservations
    WHERE entitlement_id=p_entitlement_id
      AND reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_RESERVATION'; END IF;
  IF v_res.state<>'HELD' THEN
    IF v_res.upload_bytes=p_upload_bytes AND
       v_res.download_bytes=p_download_bytes THEN RETURN 'DUPLICATE'; END IF;
    RETURN 'DENY_RESERVATION_CONFLICT';
  END IF;
  IF v_total>v_res.reserved_bytes THEN RETURN 'DENY_OVER_RESERVATION'; END IF;
  IF v_total=0 THEN
    UPDATE smart_dns_quota_reservations SET
      state='RELEASED',upload_bytes=0,download_bytes=0,closed_at=clock_timestamp()
     WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
    RETURN 'RELEASED';
  END IF;

  -- Resolve the HELD state inside the same transaction, under the original
  -- entitlement row lock. No other reservation can steal freed bytes.
  UPDATE smart_dns_quota_reservations SET state='SETTLED',
    upload_bytes=p_upload_bytes,download_bytes=p_download_bytes,
    closed_at=clock_timestamp()
   WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
  v_result:=record_smart_dns_measured_traffic(
    p_entitlement_id,'reserve:'||p_reservation_id,
    p_upload_bytes,p_download_bytes);
  IF v_result='ACCEPTED' THEN RETURN 'SETTLED'; END IF;

  IF v_result IN ('DENY_INACTIVE','DENY_QUOTA') THEN
    INSERT INTO smart_dns_late_traffic(
      entitlement_id,reservation_id,upload_bytes,download_bytes,reason)
    VALUES(p_entitlement_id,p_reservation_id,p_upload_bytes,p_download_bytes,v_result);
    RETURN 'LATE_RECORDED';
  END IF;

  -- Unexpected ledger mismatch: do not release held quota or falsely accept.
  UPDATE smart_dns_quota_reservations SET
    state='HELD',upload_bytes=NULL,download_bytes=NULL,closed_at=NULL
   WHERE entitlement_id=p_entitlement_id AND reservation_id=p_reservation_id;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION settle_smart_dns_chunk(uuid,text,bigint,bigint) FROM PUBLIC;

-- No web account or DNS-origin can directly select quota tables. A future
-- authenticated ingress role gets only narrow routines. The role is NOLOGIN;
-- deployment must explicitly bind a separately approved login identity.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_dns_ingress') THEN
    CREATE ROLE mnebyvpn_dns_ingress NOLOGIN;
  END IF;
END $$;

-- These wrappers are the only SQL interface for a trusted ingress. A single
-- call performs reserve plus the entitlement-revision check while row-locked,
-- eliminating the prior read-after-reserve roundtrip ambiguity. Status and
-- permit are returned from the same DB transaction.
CREATE FUNCTION dns_ingress_active(p_ent uuid,p_revision bigint)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
 SELECT EXISTS(
  SELECT 1 FROM entitlements e
    JOIN provisioning_state p ON p.entitlement_id=e.id
      AND p.adapter='smart_dns' AND p.applied_revision=e.revision
  WHERE e.id=p_ent AND e.revision=p_revision AND e.product='smart_dns'
    AND e.state='ACTIVE' AND e.starts_at<=clock_timestamp()
    AND e.expires_at>clock_timestamp()
    AND e.quota_state='AVAILABLE' AND e.quota_used_bytes<e.quota_limit_bytes
    AND p.last_observed_at IS NOT NULL
    AND EXISTS(
      SELECT 1 FROM entitlement_credits c
      JOIN orders o ON o.id=c.order_id
      WHERE c.entitlement_id=e.id AND c.refunded_at IS NULL
        AND c.quota_bytes>c.consumed_bytes AND o.state='PAID'));
$$;
REVOKE ALL ON FUNCTION dns_ingress_active(uuid,bigint) FROM PUBLIC;

CREATE FUNCTION dns_ingress_reserve(
  p_ent uuid,p_revision bigint,p_event text,p_bytes bigint)
RETURNS TABLE(status text,reserved_bytes bigint,allowed_until timestamptz,
              entitlement_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_current bigint;
  v_status text;
BEGIN
  SELECT e.revision INTO v_current FROM entitlements e
    WHERE e.id=p_ent FOR UPDATE;
  IF NOT FOUND OR v_current IS DISTINCT FROM p_revision THEN
    RETURN QUERY SELECT 'DENY_REVISION'::text,NULL::bigint,
      NULL::timestamptz,NULL::bigint;
    RETURN;
  END IF;
  v_status:=reserve_smart_dns_chunk(p_ent,p_event,p_bytes);
  IF v_status<>'RESERVED' THEN
    RETURN QUERY SELECT v_status,NULL::bigint,NULL::timestamptz,NULL::bigint;
    RETURN;
  END IF;
  UPDATE smart_dns_quota_reservations r SET granted_revision=v_current
    WHERE r.entitlement_id=p_ent AND r.reservation_id=p_event
      AND r.state='HELD' AND r.granted_revision IS NULL;
  RETURN QUERY SELECT v_status,r.reserved_bytes,r.allowed_until,v_current
    FROM smart_dns_quota_reservations r
    WHERE r.entitlement_id=p_ent AND r.reservation_id=p_event
      AND r.state='HELD';
END;
$$;
REVOKE ALL ON FUNCTION dns_ingress_reserve(uuid,bigint,text,bigint) FROM PUBLIC;

CREATE FUNCTION dns_ingress_settle(
  p_ent uuid,p_revision bigint,p_event text,p_upload bigint,p_download bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- A changed CURRENT revision does not suppress a legitimate settlement,
  -- but a caller must prove it is closing its ORIGINAL reservation epoch.
  IF NOT EXISTS (
    SELECT 1 FROM smart_dns_quota_reservations r
      WHERE r.entitlement_id=p_ent AND r.reservation_id=p_event
        AND r.granted_revision=p_revision
  ) THEN RETURN 'DENY_REVISION'; END IF;
  RETURN settle_smart_dns_chunk(p_ent,p_event,p_upload,p_download);
END;
$$;
REVOKE ALL ON FUNCTION dns_ingress_settle(uuid,bigint,text,bigint,bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION dns_ingress_active(uuid,bigint)
  TO mnebyvpn_dns_ingress;
GRANT EXECUTE ON FUNCTION dns_ingress_reserve(uuid,bigint,text,bigint)
  TO mnebyvpn_dns_ingress;
GRANT EXECUTE ON FUNCTION dns_ingress_settle(uuid,bigint,text,bigint,bigint)
  TO mnebyvpn_dns_ingress;

-- Authenticated dashboard can detect report incompleteness without arbitrary
-- SELECT access to underlying traffic, holds or orders.
CREATE FUNCTION get_smart_dns_audit_totals(p_account uuid,p_ent uuid)
RETURNS TABLE(held_bytes numeric,late_bytes numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT
   (SELECT COALESCE(sum(r.reserved_bytes),0)::numeric
     FROM smart_dns_quota_reservations r
     WHERE r.entitlement_id=e.id AND r.state='HELD'),
   (SELECT COALESCE(sum(l.upload_bytes::numeric+l.download_bytes::numeric),0)
     FROM smart_dns_late_traffic l WHERE l.entitlement_id=e.id)
   FROM entitlements e
   WHERE e.id=p_ent AND e.account_id=p_account AND e.product='smart_dns';
$$;
REVOKE ALL ON FUNCTION get_smart_dns_audit_totals(uuid,uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT EXECUTE ON FUNCTION get_smart_dns_audit_totals(uuid,uuid)
      TO mnebyvpn_site_auth;
  END IF;
END $$;
COMMIT;
