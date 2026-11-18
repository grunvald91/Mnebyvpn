-- Rollback-safe schema assertions for signed AWG delivery.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.vpn_awg_command_outbox') IS NULL THEN
    RAISE EXCEPTION 'Missing durable AWG command outbox';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='vpn_awg_command_outbox'::regclass
      AND contype='f'
  ) THEN
    RAISE EXCEPTION 'AWG outbox must reference real peer allocation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='vpn_awg_command_outbox'::regclass
      AND contype='u'
  ) THEN
    RAISE EXCEPTION 'AWG delivery revision must be unique per peer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c,
      LATERAL aclexplode(COALESCE(c.relacl,'{}'::aclitem[])) p
    WHERE c.oid='vpn_awg_command_outbox'::regclass
      AND p.grantee=0 AND p.privilege_type='SELECT'
  ) THEN
    RAISE EXCEPTION 'AWG signed commands leaked to PUBLIC';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename='vpn_awg_command_outbox'
      AND indexname='vpn_awg_outbox_pending_idx'
  ) THEN
    RAISE EXCEPTION 'AWG outbox claim index missing';
  END IF;
END $$;
ROLLBACK;
