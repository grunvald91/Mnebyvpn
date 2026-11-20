-- FI217 AWG native device enrollment: user submits ONLY an X25519 PUBLIC key.
-- Release remains disabled. Nothing in a client handshake calls RU188.
-- The privileged RU188 worker alone may consume the bounded queue.
BEGIN;

CREATE TABLE vpn_awg_device_requests (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE CASCADE,
  node_id text NOT NULL DEFAULT 'fi-test-01'
    CHECK (node_id='fi-test-01'),
  peer_public_key text NOT NULL UNIQUE
    CHECK(peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  billing_revision bigint NOT NULL CHECK (billing_revision >= 1),
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','processing','staged','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='processing' AND claimed_at IS NOT NULL) OR
         (state<>'processing' AND claimed_at IS NULL))
);
CREATE INDEX vpn_awg_device_requests_queue_idx
  ON vpn_awg_device_requests(next_attempt_at,created_at)
  WHERE state IN ('queued','processing');
REVOKE ALL ON vpn_awg_device_requests FROM PUBLIC;

-- The public site never writes to the table. The session-scoped SECURITY
-- DEFINER function is the ONLY permitted enrollment write for site_auth.
CREATE FUNCTION website_request_fi_awg_device(
  p_session_sha text,p_entitlement uuid,p_peer_public_key text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $fi_awg$
DECLARE
  v_revision bigint;
  v_existing text;
  v_allocation text;
BEGIN
  IF p_session_sha IS NULL OR p_session_sha !~ '^[a-f0-9]{64}$'
     OR p_entitlement IS NULL OR p_peer_public_key IS NULL
     OR p_peer_public_key !~ '^[A-Za-z0-9+/]{43}=$'
     OR length(decode(p_peer_public_key,'base64'))<>32
     OR decode(p_peer_public_key,'base64')=decode(repeat('00',32),'hex') THEN
    RETURN 'DENY_INPUT';
  END IF;

  -- Cross-check real website account, live VPN entitlement, current VLESS
  -- provisioning, explicit AWG customer release and FI proof freshness.
  SELECT e.revision INTO v_revision
    FROM public.website_sessions AS s
    JOIN public.entitlements AS e ON e.account_id=s.account_id
    JOIN public.provisioning_state AS v ON v.entitlement_id=e.id
      AND v.adapter='vpn' AND v.applied_revision=e.revision
      AND v.last_observed_at IS NOT NULL
    JOIN public.vpn_release_flags AS f
      ON f.feature='vpn_awg_clients' AND f.enabled=true
    JOIN public.vpn_awg_node_pools AS p
      ON p.node_id='fi-test-01' AND p.state='verified'
      AND p.endpoint_host='fi.mnebyvpn.site'
      AND p.subnet_cidr=cidr '10.73.91.0/24'
      AND p.verified_at<=clock_timestamp()+interval '30 seconds'
      AND p.verified_at>clock_timestamp()-interval '1 hour'
    JOIN public.vpn_node_enrollment_inventory AS n
      ON n.node_id=p.node_id AND n.status='enrolled'
      AND n.endpoint_host=p.endpoint_host
    WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
      AND e.id=p_entitlement AND e.product='vpn'
      AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
    FOR SHARE OF e;
  IF NOT FOUND OR v_revision IS NULL THEN RETURN 'DENY_ACCESS'; END IF;

  -- An entitlement may have only ONE peer on this FI node. Public API must
  -- never replace a previously applied or queued device's key.
  SELECT a.peer_public_key INTO v_allocation
    FROM public.vpn_awg_peer_allocations AS a
    WHERE a.node_id='fi-test-01' AND a.entitlement_id=p_entitlement;
  IF v_allocation IS NOT NULL AND v_allocation<>p_peer_public_key THEN
    RETURN 'DENY_BOUND';
  END IF;

  INSERT INTO public.vpn_awg_device_requests(
    entitlement_id,node_id,peer_public_key,billing_revision
  ) VALUES (p_entitlement,'fi-test-01',p_peer_public_key,v_revision)
  ON CONFLICT DO NOTHING;

  SELECT r.peer_public_key INTO v_existing
    FROM public.vpn_awg_device_requests AS r
    WHERE r.entitlement_id=p_entitlement;
  IF v_existing=p_peer_public_key THEN RETURN 'QUEUED'; END IF;
  RETURN 'DENY_BOUND';
END;
$fi_awg$;

-- No public reading of the request queue; status is account scoped.
CREATE FUNCTION website_fi_awg_device_status(
  p_session_sha text,p_entitlement uuid,p_peer_public_key text
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $fi_status$
  SELECT CASE
    WHEN a.state='applied' AND o.state='applied'
      AND o.node_receipt_sha256 ~ '^[a-f0-9]{64}$' THEN 'ACKNOWLEDGED'
    WHEN q.state='processing' THEN 'PROCESSING'
    WHEN q.state='staged' THEN 'STAGED'
    WHEN q.state='blocked' THEN 'BLOCKED'
    ELSE 'QUEUED'
  END
  FROM public.website_sessions AS s
  JOIN public.entitlements AS e
    ON e.account_id=s.account_id AND e.id=p_entitlement
  JOIN public.provisioning_state v ON v.entitlement_id=e.id
    AND v.adapter='vpn' AND v.applied_revision=e.revision
    AND v.last_observed_at IS NOT NULL
  JOIN public.vpn_release_flags f
    ON f.feature='vpn_awg_clients' AND f.enabled=true
  JOIN public.vpn_awg_device_requests AS q
    ON q.entitlement_id=e.id AND q.peer_public_key=p_peer_public_key
    AND q.billing_revision=e.revision AND q.node_id='fi-test-01'
  LEFT JOIN public.vpn_awg_peer_allocations a
    ON a.entitlement_id=e.id AND a.node_id=q.node_id
    AND a.peer_public_key=q.peer_public_key
  LEFT JOIN public.vpn_awg_command_outbox o
    ON o.entitlement_id=a.entitlement_id AND o.node_id=a.node_id
    AND o.revision=a.revision AND o.op='grant'
  WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
    AND e.product='vpn' AND e.state='ACTIVE'
    AND e.expires_at>clock_timestamp()
  LIMIT 1;
$fi_status$;

REVOKE ALL ON FUNCTION website_request_fi_awg_device(text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION website_fi_awg_device_status(text,uuid,text) FROM PUBLIC;
DO $fi_role$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT EXECUTE ON FUNCTION website_request_fi_awg_device(text,uuid,text)
      TO mnebyvpn_site_auth;
    GRANT EXECUTE ON FUNCTION website_fi_awg_device_status(text,uuid,text)
      TO mnebyvpn_site_auth;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_awg_delivery') THEN
    GRANT SELECT,UPDATE ON vpn_awg_device_requests TO mnebyvpn_awg_delivery;
  END IF;
END;
$fi_role$;
COMMIT;
