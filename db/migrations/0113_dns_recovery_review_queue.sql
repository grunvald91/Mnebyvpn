-- Offline-only review queue: evidence != proof of stopped traffic.
-- NEVER release a quota hold based on age, heartbeat or operator notes.
BEGIN;

CREATE TABLE smart_dns_recovery_evidence (
  evidence_id uuid PRIMARY KEY,
  entitlement_id uuid NOT NULL,
  reservation_id text NOT NULL,
  evidence_kind text NOT NULL
    CHECK(evidence_kind IN ('NODE_STOP_LOG','TCP_CAPTURE','OPERATOR_NOTE')),
  digest_sha256 text NOT NULL CHECK(digest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_by text NOT NULL DEFAULT session_user,
  FOREIGN KEY(entitlement_id,reservation_id)
    REFERENCES smart_dns_quota_reservations(entitlement_id,reservation_id)
    ON DELETE RESTRICT,
  UNIQUE(entitlement_id,reservation_id,evidence_kind,digest_sha256)
);
REVOKE ALL ON smart_dns_recovery_evidence FROM PUBLIC;

CREATE FUNCTION reject_dns_recovery_evidence_changes()
RETURNS trigger LANGUAGE plpgsql AS $dnsrev$
BEGIN
  RAISE EXCEPTION 'DNS recovery evidence is immutable'
    USING ERRCODE='23514';
END;
$dnsrev$;
CREATE TRIGGER dns_recovery_evidence_append_only
  BEFORE UPDATE OR DELETE ON smart_dns_recovery_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_dns_recovery_evidence_changes();
REVOKE ALL ON FUNCTION reject_dns_recovery_evidence_changes() FROM PUBLIC;

CREATE INDEX smart_dns_unresolved_held_idx
  ON smart_dns_quota_reservations(allowed_until,entitlement_id)
  WHERE state='HELD';
CREATE INDEX smart_dns_late_recorded_idx
  ON smart_dns_late_traffic(recorded_at,entitlement_id);

-- Only a separately-provisioned reviewer may call queue/evidence methods.
-- This role has NO LOGIN and is not granted to production API or ingress.
DO $dnsrev$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_dns_reviewer') THEN
    CREATE ROLE mnebyvpn_dns_reviewer NOLOGIN;
  END IF;
END $dnsrev$;

-- Cases are computed from held and late ledgers; never delete or silently
-- change them. Last observation time is NOT proof of network disconnection.
CREATE FUNCTION dns_list_unresolved_recovery(p_limit integer DEFAULT 100)
RETURNS TABLE(
  entitlement_id uuid,
  reservation_id text,
  kind text,
  reference_at timestamptz,
  held_bytes bigint,
  late_upload_bytes bigint,
  late_download_bytes bigint,
  evidence_count bigint
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dnsrev$
  SELECT s.entitlement_id,s.reservation_id,s.kind,s.reference_at,
         s.held_bytes,s.late_upload_bytes,s.late_download_bytes,
         (SELECT count(*) FROM smart_dns_recovery_evidence ev
           WHERE ev.entitlement_id=s.entitlement_id
             AND ev.reservation_id=s.reservation_id) AS evidence_count
    FROM (
      SELECT r.entitlement_id,r.reservation_id,
             'STALE_HELD'::text AS kind,
             r.allowed_until AS reference_at,
             r.reserved_bytes AS held_bytes,
             0::bigint AS late_upload_bytes,0::bigint AS late_download_bytes
      FROM smart_dns_quota_reservations r
      WHERE r.state='HELD' AND r.allowed_until<clock_timestamp()
      UNION ALL
      SELECT l.entitlement_id,l.reservation_id,
             'LATE_AUDIT'::text AS kind,
             l.recorded_at AS reference_at,
             0::bigint AS held_bytes,
             l.upload_bytes AS late_upload_bytes,
             l.download_bytes AS late_download_bytes
      FROM smart_dns_late_traffic l
    ) AS s
    WHERE p_limit BETWEEN 1 AND 100
    ORDER BY s.reference_at,s.entitlement_id,s.reservation_id
    LIMIT LEAST(p_limit,100);
$dnsrev$;
REVOKE ALL ON FUNCTION dns_list_unresolved_recovery(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dns_list_unresolved_recovery(integer)
  TO mnebyvpn_dns_reviewer;

-- An audit attachment is ONLY a hash of externally stored evidence.
-- Its existence is NEVER sufficient to reset a hold, debit refunded credit,
-- or mark a monthly statement financially complete.
CREATE FUNCTION dns_attach_recovery_evidence(
  p_ent uuid,p_reservation text,p_evidence uuid,
  p_kind text,p_digest text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dnsrev$
DECLARE v_old smart_dns_recovery_evidence%ROWTYPE;
BEGIN
  IF p_ent IS NULL OR p_evidence IS NULL OR p_reservation IS NULL
     OR length(p_reservation) NOT BETWEEN 8 AND 96
     OR p_reservation !~ '^[A-Za-z0-9_-]+$'
     OR p_kind IS NULL
     OR p_kind NOT IN ('NODE_STOP_LOG','TCP_CAPTURE','OPERATOR_NOTE')
     OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
  THEN RETURN 'DENY_INVALID'; END IF;

  SELECT * INTO v_old FROM smart_dns_recovery_evidence
    WHERE evidence_id=p_evidence;
  IF FOUND THEN
    IF v_old.entitlement_id=p_ent AND v_old.reservation_id=p_reservation
       AND v_old.evidence_kind=p_kind AND v_old.digest_sha256=p_digest
    THEN RETURN 'DUPLICATE'; END IF;
    RETURN 'DENY_CONFLICT';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM smart_dns_quota_reservations r
      WHERE r.entitlement_id=p_ent AND r.reservation_id=p_reservation
        AND (
          (r.state='HELD' AND r.allowed_until<clock_timestamp())
          OR EXISTS (
            SELECT 1 FROM smart_dns_late_traffic l
              WHERE l.entitlement_id=r.entitlement_id
                AND l.reservation_id=r.reservation_id)
        )
  ) THEN RETURN 'DENY_NOT_UNRESOLVED'; END IF;

  INSERT INTO smart_dns_recovery_evidence(
    evidence_id,entitlement_id,reservation_id,evidence_kind,digest_sha256)
    VALUES(p_evidence,p_ent,p_reservation,p_kind,p_digest)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'RECORDED'; END IF;
  RETURN 'DENY_DUPLICATE_EVIDENCE';
END;
$dnsrev$;
REVOKE ALL ON FUNCTION dns_attach_recovery_evidence(uuid,text,uuid,text,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dns_attach_recovery_evidence(uuid,text,uuid,text,text)
  TO mnebyvpn_dns_reviewer;

-- Read-only, account-scoped, explicit UTC SETTLEMENT month for LATE traffic.
-- Never merge these values into already debited paid quota or claim packets
-- crossed the wire at the exact recorded_at time.
CREATE FUNCTION get_smart_dns_monthly_late_traffic(
  p_account uuid,p_ent uuid
) RETURNS TABLE(
  month_utc date,upload_bytes numeric,download_bytes numeric,
  event_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dnsrev$
  SELECT date_trunc('month',l.recorded_at AT TIME ZONE 'UTC')::date,
         COALESCE(sum(l.upload_bytes),0)::numeric,
         COALESCE(sum(l.download_bytes),0)::numeric,
         count(*)::bigint
    FROM entitlements e
    JOIN smart_dns_late_traffic l ON l.entitlement_id=e.id
    WHERE p_account IS NOT NULL AND p_ent IS NOT NULL
      AND e.id=p_ent AND e.account_id=p_account AND e.product='smart_dns'
    GROUP BY 1 ORDER BY 1;
$dnsrev$;
REVOKE ALL ON FUNCTION get_smart_dns_monthly_late_traffic(uuid,uuid)
  FROM PUBLIC;
DO $dnsrev$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT EXECUTE ON FUNCTION get_smart_dns_monthly_late_traffic(uuid,uuid)
      TO mnebyvpn_site_auth;
  END IF;
END $dnsrev$;

COMMIT;
