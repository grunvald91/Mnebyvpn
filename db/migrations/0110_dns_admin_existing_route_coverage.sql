-- Existing shared Smart DNS routes have independent ownership from owner-created exact-host routes.
-- COVERED means read-only verified coverage; do not allow user removal or trigger exact-host reapply.
BEGIN;
ALTER TABLE dns_admin_domains DROP CONSTRAINT dns_admin_domains_status_check;
ALTER TABLE dns_admin_domains ADD CONSTRAINT dns_admin_domains_status_check
 CHECK (status IN (
  'PENDING','APPLY_REQUESTED','PROBING','CANARY',
  'CONFIRM_REQUESTED','CONFIRMING','ACTIVE','COVERED',
  'FAILED','CANCELLED','REMOVAL_PENDING','REMOVING','ROLLBACK_REQUESTED'
 ));
COMMIT;
