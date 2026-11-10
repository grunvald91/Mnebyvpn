-- Owner-only Telegram domain intake for Smart DNS.
-- Entries are NOT live CoreDNS/Nginx rules until a separate guarded
-- reconciler verifies TLS origin, DNS RR policy and deploys atomically.
BEGIN;
CREATE TABLE dns_admin_domains (
  id bigserial PRIMARY KEY,
  domain text NOT NULL UNIQUE,
  product text NOT NULL DEFAULT 'custom' CHECK (length(product) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','ACTIVE','FAILED','CANCELLED','REMOVAL_PENDING')
  ),
  requested_by bigint CHECK (requested_by IS NULL OR requested_by>0),
  updated_by bigint CHECK (updated_by IS NULL OR updated_by>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dns_admin_domain_length CHECK (length(domain) BETWEEN 4 AND 253),
  CONSTRAINT dns_admin_domain_lowercase CHECK (domain=lower(domain))
);
CREATE INDEX dns_admin_domains_recent_idx
  ON dns_admin_domains (updated_at DESC, id DESC);
REVOKE ALL ON dns_admin_domains FROM PUBLIC;
REVOKE ALL ON SEQUENCE dns_admin_domains_id_seq FROM PUBLIC;
-- Oracle Cloud main entry and public website; both are only pending requests.
-- OCI console uses cloud.oracle.com per docs.oracle.com.
INSERT INTO dns_admin_domains (domain,product,status,requested_by)
VALUES ('oracle.com','Oracle','PENDING',NULL),
       ('cloud.oracle.com','Oracle','PENDING',NULL)
ON CONFLICT (domain) DO NOTHING;
COMMIT;
