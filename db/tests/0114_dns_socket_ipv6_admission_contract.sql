-- Disposable PostgreSQL test of destination-IP identity, not WAN routing.
BEGIN;
DO $case114$
DECLARE
  account_id uuid:='c1140000-0000-4000-8000-000000000001';
  order_id uuid:='c1140000-0000-4000-8000-000000000002';
  ent uuid;
  v text;
  identity_row record;
BEGIN
  INSERT INTO accounts(id) VALUES(account_id);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(order_id,account_id,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(order_id,'mock','p114','c114',
         repeat('e',64),10000,'RUB',3600,500) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'paid fixture: %',v; END IF;
  SELECT id INTO ent FROM entitlements WHERE source_order_id=order_id;
  SELECT claim_smart_dns_ipv6(ent,'2001:db8:0:114::1'::inet) INTO v;
  IF v<>'BOUND' THEN RAISE EXCEPTION 'fixture IPv6 bind: %',v; END IF;

  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '2001:db8:0:114::1'::inet);
  IF FOUND THEN RAISE EXCEPTION 'pre-provision ingress admitted'; END IF;
  UPDATE entitlements SET state='ACTIVE' WHERE id=ent;
  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '2001:db8:0:114::1'::inet);
  IF FOUND THEN RAISE EXCEPTION 'missing observed revision admitted'; END IF;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    VALUES(ent,'smart_dns',1,clock_timestamp());
  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '2001:db8:0:114::1'::inet);
  IF NOT FOUND OR identity_row.entitlement_id<>ent OR
    identity_row.entitlement_revision<>1 THEN
    RAISE EXCEPTION 'correct destination failed authorized lookup'; END IF;

  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '2001:db8:0:114::2'::inet);
  IF FOUND THEN RAISE EXCEPTION 'other IPv6 matched subscription'; END IF;
  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '203.0.113.1'::inet);
  IF FOUND THEN RAISE EXCEPTION 'IPv4 claimed subscriber'; END IF;
  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '::ffff:203.0.113.1'::inet);
  IF FOUND THEN RAISE EXCEPTION 'IPv4-mapped address bypass'; END IF;

  UPDATE entitlements SET state='EXPIRED',revision=revision+1 WHERE id=ent;
  SELECT * INTO identity_row FROM dns_ingress_identify_destination_ipv6(
    '2001:db8:0:114::1'::inet);
  IF FOUND THEN RAISE EXCEPTION 'revoked destination still authorized'; END IF;
END
$case114$;

DO $grants114$
BEGIN
  IF NOT has_function_privilege('mnebyvpn_dns_ingress',
      'public.dns_ingress_identify_destination_ipv6(inet)','EXECUTE')
    OR has_function_privilege('mnebyvpn_dns_reviewer',
      'public.dns_ingress_identify_destination_ipv6(inet)','EXECUTE') THEN
    RAISE EXCEPTION 'IPv6 ingress lookup accessible to wrong role';
  END IF;
END
$grants114$;
SET LOCAL ROLE mnebyvpn_dns_ingress;
SELECT * FROM dns_ingress_identify_destination_ipv6('2001:db8:0:114::2'::inet);
RESET ROLE;
ROLLBACK;
