-- MNEBYDNS #84, stage 2: auditable directional DNS-relay traffic ledger.
-- OFFLINE control-plane code only; no live ingress, no public paid DNS.
-- A trustworthy source must authenticate each forwarded flow AND reserve
-- its bytes before forwarding. This POST-factum debit cannot enforce a hard cap.
BEGIN;

CREATE TABLE smart_dns_measured_traffic (
  entitlement_id uuid NOT NULL,
  usage_event_id text NOT NULL CHECK (length(usage_event_id) BETWEEN 1 AND 128),
  upload_bytes bigint NOT NULL CHECK (upload_bytes >= 0),
  download_bytes bigint NOT NULL CHECK (download_bytes >= 0),
  CHECK (upload_bytes > 0 OR download_bytes > 0),
  PRIMARY KEY (entitlement_id, usage_event_id),
  FOREIGN KEY (entitlement_id, usage_event_id)
    REFERENCES quota_usage_events(entitlement_id, usage_event_id) ON DELETE RESTRICT
);
-- Timestamps live in quota_usage_events.accepted_at, not duplicated here.
-- No domains, source IP, SNI values, credentials or DNS history are retained.
REVOKE ALL ON smart_dns_measured_traffic FROM PUBLIC;

-- Append-only measurements. Verify upload + download exactly matches the
-- existing accepted quota event even for privileged direct SQL inserts.
CREATE FUNCTION enforce_smart_dns_measured_traffic_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $
DECLARE
  v_charged bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Measured DNS traffic events are append-only'
      USING ERRCODE='23514';
  END IF;
  SELECT bytes INTO v_charged FROM quota_usage_events
   WHERE entitlement_id=NEW.entitlement_id AND usage_event_id=NEW.usage_event_id;
  IF NOT FOUND OR v_charged::numeric <>
      NEW.upload_bytes::numeric + NEW.download_bytes::numeric THEN
    RAISE EXCEPTION 'Directional DNS bytes do not match accepted quota debit'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER smart_dns_measured_traffic_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON smart_dns_measured_traffic
  FOR EACH ROW EXECUTE FUNCTION enforce_smart_dns_measured_traffic_integrity();
REVOKE ALL ON FUNCTION enforce_smart_dns_measured_traffic_integrity() FROM PUBLIC;

-- Atomic transfer accounting with exact-event idempotency. Distinct upload
-- and download amounts are mandatory to independently audit monthly usage.
-- This function MUST NOT be exposed to browsers/resolvers; a verified ingress
-- role will need separately scoped permission after real network E2E.
CREATE FUNCTION record_smart_dns_measured_traffic(
  p_entitlement_id uuid,
  p_usage_event_id text,
  p_upload_bytes bigint,
  p_download_bytes bigint
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_total numeric;
  v_event_exists boolean;
  v_upload bigint;
  v_download bigint;
  v_debit text;
BEGIN
  IF p_entitlement_id IS NULL
     OR p_usage_event_id IS NULL
     OR length(p_usage_event_id) NOT BETWEEN 1 AND 128
     OR p_upload_bytes IS NULL OR p_download_bytes IS NULL
     OR p_upload_bytes < 0 OR p_download_bytes < 0 THEN
    RETURN 'DENY_INVALID';
  END IF;
  v_total := p_upload_bytes::numeric + p_download_bytes::numeric;
  IF v_total <= 0 OR v_total > 9223372036854775807::numeric THEN
    RETURN 'DENY_INVALID';
  END IF;

  -- Per-entitlement serialization makes conflicting retries deterministic.
  PERFORM 1 FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;

  SELECT upload_bytes, download_bytes INTO v_upload, v_download
    FROM smart_dns_measured_traffic
    WHERE entitlement_id=p_entitlement_id AND usage_event_id=p_usage_event_id;
  IF FOUND THEN
    IF v_upload=p_upload_bytes AND v_download=p_download_bytes
      THEN RETURN 'DUPLICATE';
    END IF;
    RETURN 'DENY_EVENT_CONFLICT';
  END IF;

  -- An event inserted by the legacy counter must not be upgraded into
  -- fabricated directional traffic after the fact.
  SELECT EXISTS(
    SELECT 1 FROM quota_usage_events WHERE
      entitlement_id=p_entitlement_id AND usage_event_id=p_usage_event_id)
    INTO v_event_exists;
  IF v_event_exists THEN RETURN 'DENY_UNATTRIBUTED_EVENT'; END IF;

  -- This debit performs the existing FIFO credit settlement under the lock.
  -- Failure returns without changing measured traffic or the paid balance.
  v_debit := debit_smart_dns_quota(
    p_entitlement_id, p_usage_event_id, v_total::bigint);
  IF v_debit <> 'ACCEPTED' THEN RETURN v_debit; END IF;

  INSERT INTO smart_dns_measured_traffic
    (entitlement_id,usage_event_id,upload_bytes,download_bytes)
    VALUES(p_entitlement_id,p_usage_event_id,p_upload_bytes,p_download_bytes);
  RETURN 'ACCEPTED';
END;
$$;

-- Read-only monthly breakdown. An authenticated backend MUST get account_id
-- from a verified server-side session, never from an untrusted request body.
-- Every counted byte has exactly one event id and UTC month. Legacy direct
-- debits show separately as UNATTRIBUTED so reports can't imply completeness.
CREATE FUNCTION get_smart_dns_monthly_traffic(
  p_account_id uuid, p_entitlement_id uuid
) RETURNS TABLE(
  month_utc date,
  upload_bytes numeric,
  download_bytes numeric,
  measured_total_bytes numeric,
  unattributed_bytes numeric
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT date_trunc('month', q.accepted_at AT TIME ZONE 'UTC')::date,
         COALESCE(SUM(m.upload_bytes),0)::numeric,
         COALESCE(SUM(m.download_bytes),0)::numeric,
         COALESCE(SUM(m.upload_bytes + 0::numeric + m.download_bytes),0)::numeric,
         COALESCE(SUM(CASE WHEN m.usage_event_id IS NULL
           THEN q.bytes ELSE 0 END),0)::numeric
    FROM entitlements AS e
    JOIN quota_usage_events AS q ON q.entitlement_id=e.id
    LEFT JOIN smart_dns_measured_traffic AS m
      ON m.entitlement_id=q.entitlement_id
     AND m.usage_event_id=q.usage_event_id
   WHERE p_account_id IS NOT NULL
     AND p_entitlement_id IS NOT NULL
     AND e.account_id=p_account_id
     AND e.id=p_entitlement_id
     AND e.product='smart_dns'
   GROUP BY 1
   ORDER BY 1;
$$;

CREATE INDEX quota_usage_events_entitlement_month_idx
  ON quota_usage_events(entitlement_id, accepted_at);
REVOKE ALL ON FUNCTION record_smart_dns_measured_traffic(uuid,text,bigint,bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION get_smart_dns_monthly_traffic(uuid,uuid)
  FROM PUBLIC;
-- An authenticated website DB role must not receive table-wide event access.
-- The narrow reporting function checks account_id + entitlement_id itself.
-- The backend derives account_id from its verified session, not user input.
ALTER FUNCTION get_smart_dns_monthly_traffic(uuid,uuid) SECURITY DEFINER;
ALTER FUNCTION get_smart_dns_monthly_traffic(uuid,uuid)
  SET search_path TO pg_catalog,public,pg_temp;
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT EXECUTE ON FUNCTION get_smart_dns_monthly_traffic(uuid,uuid)
      TO mnebyvpn_site_auth;
  END IF;
END $;
COMMIT;
