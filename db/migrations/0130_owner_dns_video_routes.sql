-- Split owner-only DNS video handling by an explicit, authenticated link policy.
-- Existing links retain VPN-origin CDN answers; new Smart DNS links use mapped CDN.
-- No client IP, Nginx loopback source or query headers are treated as VPN evidence.
BEGIN;

ALTER TABLE owner_dns_links
  ADD COLUMN video_route text NOT NULL DEFAULT 'vpn_origin'
  CHECK (video_route IN ('vpn_origin','smart_dns'));

-- Preserve one permanent owner link per *route*; legacy 'permanent' stays valid.
DROP INDEX owner_dns_one_permanent;
CREATE UNIQUE INDEX owner_dns_one_permanent_per_route
  ON owner_dns_links(owner_telegram_id,video_route) WHERE permanent;

-- Reuse the credential status function without exposing bearer or account data.
-- Legacy clients receive ALLOWED unchanged; Smart DNS links get a distinct
-- status consumed only by the updated owner resolver.
CREATE OR REPLACE FUNCTION owner_dns_link_status(p_label text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.owner_dns_links%ROWTYPE;
BEGIN
  IF p_label IS NULL OR p_label !~ '^[a-z0-9]{12}$' THEN RETURN 'UNKNOWN'; END IF;
  SELECT * INTO link FROM public.owner_dns_links
    WHERE token_sha256=encode(sha256(convert_to(p_label,'UTF8')),'hex');
  IF NOT FOUND THEN RETURN 'UNKNOWN'; END IF;
  IF link.revoked_at IS NOT NULL OR
     (link.expires_at IS NOT NULL AND link.expires_at<=clock_timestamp())
    THEN RETURN 'DENY_INACTIVE'; END IF;
  IF link.video_route='smart_dns' THEN RETURN 'ALLOWED_SMART_DNS'; END IF;
  RETURN 'ALLOWED';
END $$;
REVOKE ALL ON FUNCTION owner_dns_link_status(text) FROM PUBLIC;

COMMIT;
