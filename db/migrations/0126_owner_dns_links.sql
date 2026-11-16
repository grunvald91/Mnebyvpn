-- Owner-issued personal DoT links. Separate from customer purchases and quotas.
-- Only ciphertext and a digest leave the authenticated bot process.
BEGIN;
CREATE TABLE owner_dns_links (
  id uuid PRIMARY KEY,
  owner_telegram_id bigint NOT NULL CHECK(owner_telegram_id>0),
  token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  token_ciphertext text NOT NULL CHECK(length(token_ciphertext) BETWEEN 50 AND 300),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 100),
  permanent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK((permanent AND expires_at IS NULL) OR (NOT permanent AND expires_at IS NOT NULL)),
  UNIQUE(owner_telegram_id,request_key)
);
CREATE UNIQUE INDEX owner_dns_one_permanent ON owner_dns_links(owner_telegram_id) WHERE permanent;
REVOKE ALL ON owner_dns_links FROM PUBLIC;
CREATE TABLE owner_dns_link_edits (
  owner_telegram_id bigint NOT NULL,
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 100),
  link_id uuid NOT NULL REFERENCES owner_dns_links(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_telegram_id,request_key)
);
REVOKE ALL ON owner_dns_link_edits FROM PUBLIC;
-- SECURITY DEFINER exposes only the decision, never encrypted credentials or
-- owner IDs. Gateway role receives EXECUTE separately during deployment.
CREATE FUNCTION owner_dns_link_status(p_label text) RETURNS text
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
  RETURN 'ALLOWED';
END $$;
REVOKE ALL ON FUNCTION owner_dns_link_status(text) FROM PUBLIC;
COMMIT;
