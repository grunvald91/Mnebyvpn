-- RU188 signed AWG delivery worker: only fields required to select
-- already provisioned active VPN entitlements for a second AWG node.
-- The live post-release inventory confirmed no SELECT on this table,
-- so the worker's every-minute FI backfill retried without enrolling peers.
-- No access to billing tokens, secrets, or write privileges is added.
BEGIN;
DO $awg_fix$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles
                WHERE rolname='mnebyvpn_awg_delivery') THEN
    RAISE EXCEPTION 'Required existing RU188 AWG worker role missing';
  END IF;
  IF to_regclass('public.provisioning_state') IS NULL THEN
    RAISE EXCEPTION 'Existing canonical provisioning state table missing';
  END IF;
  GRANT SELECT (entitlement_id,adapter,applied_revision,last_observed_at)
    ON TABLE public.provisioning_state
    TO mnebyvpn_awg_delivery;
  IF NOT (
    SELECT bool_and(has_column_privilege(
      'mnebyvpn_awg_delivery','public.provisioning_state',column_name,'SELECT'))
    FROM (VALUES ('entitlement_id'),('adapter'),('applied_revision'),
                 ('last_observed_at')) AS expected(column_name)
  ) THEN
    RAISE EXCEPTION 'Scoped AWG worker provisioning read grant not effective';
  END IF;
END;
$awg_fix$;
COMMIT;
