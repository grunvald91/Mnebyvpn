-- Disposable PostgreSQL negative contracts for bounded chunk preauth.
-- One reservation is one transfer chunk, NOT a live authenticated TCP flow.
BEGIN;
DO $$
DECLARE
  account_a uuid:='c1110000-0000-4000-8000-000000000001';
  account_b uuid:='c1110000-0000-4000-8000-000000000002';
  order_a uuid:='c1110000-0000-4000-8000-000000000003';
  order_b uuid:='c1110000-0000-4000-8000-000000000004';
  ent_a uuid;
  ent_b uuid;
  outcome text;
  used_bytes bigint;
  held_bytes numeric;
  event_count bigint;
  report record;
BEGIN
  INSERT INTO accounts(id) VALUES(account_a),(account_b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
  VALUES(order_a,account_a,'smart_dns','mock',10000,'RUB'),
        (order_b,account_b,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(order_a,'mock','r111-a','r111-ca',repeat('a',64),
                                 10000,'RUB',3600,1000) INTO outcome;
  IF outcome<>'APPLIED' THEN RAISE EXCEPTION 'paid A: %',outcome; END IF;
  SELECT settle_verified_payment(order_b,'mock','r111-b','r111-cb',repeat('b',64),
                                 10000,'RUB',3600,500) INTO outcome;
  IF outcome<>'APPLIED' THEN RAISE EXCEPTION 'paid B: %',outcome; END IF;
  SELECT id INTO ent_a FROM entitlements WHERE source_order_id=order_a;
  SELECT id INTO ent_b FROM entitlements WHERE source_order_id=order_b;

  -- Payment / entitlement alone may not allocate bytes before node ACK.
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-01',100) INTO outcome;
  IF outcome<>'DENY_INACTIVE' THEN
    RAISE EXCEPTION 'pre-ACK reservation allowed: %',outcome;
  END IF;
  UPDATE entitlements SET state='ACTIVE' WHERE id IN(ent_a,ent_b);
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-01',100) INTO outcome;
  IF outcome<>'DENY_INACTIVE' THEN
    RAISE EXCEPTION 'missing observed node revision allowed: %',outcome;
  END IF;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT id,'smart_dns',revision,clock_timestamp() FROM entitlements
    WHERE id IN(ent_a,ent_b);

  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-01',700) INTO outcome;
  IF outcome<>'RESERVED' THEN RAISE EXCEPTION 'A reserve 700: %',outcome; END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-02',300) INTO outcome;
  IF outcome<>'RESERVED' THEN RAISE EXCEPTION 'A reserve 300: %',outcome; END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-02',300) INTO outcome;
  IF outcome<>'DUPLICATE' THEN RAISE EXCEPTION 'A reservation retry: %',outcome; END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-02',299) INTO outcome;
  IF outcome<>'DENY_RESERVATION_CONFLICT' THEN
    RAISE EXCEPTION 'A changed reservation id: %',outcome;
  END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-03',1) INTO outcome;
  IF outcome<>'DENY_QUOTA' THEN RAISE EXCEPTION 'overlapping hold leaked: %',outcome; END IF;

  SELECT quota_used_bytes INTO used_bytes FROM entitlements WHERE id=ent_a;
  IF used_bytes<>0 THEN RAISE EXCEPTION 'preauthorisation billed unsent traffic'; END IF;
  SELECT count(*) INTO event_count FROM quota_usage_events WHERE entitlement_id=ent_a;
  IF event_count<>0 THEN RAISE EXCEPTION 'preauth incorrectly wrote usage event'; END IF;

  -- A legacy direct debit MUST NOT bypass the pending 1000-byte hold. The
  -- trigger fails closed rather than allowing a hidden capacity violation.
  BEGIN
    SELECT debit_smart_dns_quota(ent_a,'legacy-bypass',1) INTO outcome;
    RAISE EXCEPTION 'legacy writer exceeded held+used capacity: %',outcome;
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT reserve_smart_dns_chunk(ent_b,'b-chunk-01',500) INTO outcome;
  IF outcome<>'RESERVED' THEN RAISE EXCEPTION 'B reserve: %',outcome; END IF;
  IF EXISTS (SELECT 1 FROM smart_dns_quota_reservations
             WHERE entitlement_id=ent_a AND reservation_id='b-chunk-01') THEN
    RAISE EXCEPTION 'B hold leaked to A';
  END IF;

  -- A chunk can carry fewer actual bytes than were reserved. Only actual
  -- forwarded payload enters the paid ledger and UTC monthly report.
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-01',250,300) INTO outcome;
  IF outcome<>'SETTLED' THEN RAISE EXCEPTION 'A settle 550: %',outcome; END IF;
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-01',250,300) INTO outcome;
  IF outcome<>'DUPLICATE' THEN RAISE EXCEPTION 'A settlement retry: %',outcome; END IF;
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-01',249,301) INTO outcome;
  IF outcome<>'DENY_RESERVATION_CONFLICT' THEN
    RAISE EXCEPTION 'A changed settlement amount: %',outcome;
  END IF;
  SELECT quota_used_bytes INTO used_bytes FROM entitlements WHERE id=ent_a;
  IF used_bytes<>550 THEN RAISE EXCEPTION 'A should charge 550, not 700'; END IF;

  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-03',150) INTO outcome;
  IF outcome<>'RESERVED' THEN
    RAISE EXCEPTION 'Unused A allowance not reusable after settle: %',outcome;
  END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-04',1) INTO outcome;
  IF outcome<>'DENY_QUOTA' THEN
    RAISE EXCEPTION 'A over-reservation accepted: %',outcome;
  END IF;
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-03',0,151) INTO outcome;
  IF outcome<>'DENY_OVER_RESERVATION' THEN
    RAISE EXCEPTION 'more than reserved forwarded: %',outcome;
  END IF;

  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-02',0,0) INTO outcome;
  IF outcome<>'RELEASED' THEN RAISE EXCEPTION 'zero byte release: %',outcome; END IF;
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-02',0,0) INTO outcome;
  IF outcome<>'DUPLICATE' THEN RAISE EXCEPTION 'zero byte retry: %',outcome; END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-04',300) INTO outcome;
  IF outcome<>'RESERVED' THEN RAISE EXCEPTION 'reclaimed A chunk: %',outcome; END IF;

  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-03',90,60) INTO outcome;
  IF outcome<>'SETTLED' THEN RAISE EXCEPTION 'A settle 150: %',outcome; END IF;
  SELECT settle_smart_dns_chunk(ent_a,'a-chunk-04',100,200) INTO outcome;
  IF outcome<>'SETTLED' THEN RAISE EXCEPTION 'A settle last 300: %',outcome; END IF;
  SELECT quota_used_bytes INTO used_bytes FROM entitlements WHERE id=ent_a;
  IF used_bytes<>1000 THEN RAISE EXCEPTION 'A total not 1000: %',used_bytes; END IF;
  IF EXISTS (SELECT 1 FROM entitlements WHERE id=ent_a AND quota_state<>'EXHAUSTED') THEN
    RAISE EXCEPTION 'A quota not exhausted';
  END IF;
  SELECT reserve_smart_dns_chunk(ent_a,'a-chunk-05',1) INTO outcome;
  IF outcome<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'A exhausted still open: %',outcome; END IF;
  SELECT count(*) INTO event_count FROM quota_usage_events WHERE entitlement_id=ent_a;
  IF event_count<>3 THEN RAISE EXCEPTION 'A event count should be 3: %',event_count; END IF;

  SELECT * INTO report FROM get_smart_dns_monthly_traffic(account_a,ent_a);
  IF NOT FOUND OR report.upload_bytes<>440 OR report.download_bytes<>560
      OR report.measured_total_bytes<>1000 OR report.unattributed_bytes<>0 THEN
    RAISE EXCEPTION 'reserved/actual mismatch in monthly report';
  END IF;
  SELECT count(*) INTO event_count FROM get_smart_dns_monthly_traffic(account_b,ent_a);
  IF event_count<>0 THEN RAISE EXCEPTION 'other account can read A monthly data'; END IF;
  SELECT quota_used_bytes INTO used_bytes FROM entitlements WHERE id=ent_b;
  IF used_bytes<>0 THEN RAISE EXCEPTION 'B charged for A'; END IF;

  -- B's lease can expire while a hold remains. Duplicate requests MUST
  -- not treat its original status as a fresh licence to forward more bytes.
  UPDATE smart_dns_quota_reservations
    SET created_at=clock_timestamp()-interval '40 seconds',
        allowed_until=clock_timestamp()-interval '25 seconds'
    WHERE entitlement_id=ent_b AND reservation_id='b-chunk-01';
  SELECT reserve_smart_dns_chunk(ent_b,'b-chunk-01',500) INTO outcome;
  IF outcome<>'DENY_LEASE_EXPIRED' THEN
    RAISE EXCEPTION 'expired lease replay accepted: %',outcome;
  END IF;
  SELECT reserve_smart_dns_chunk(ent_b,'b-chunk-02',1) INTO outcome;
  IF outcome<>'DENY_QUOTA' THEN
    RAISE EXCEPTION 'expired hold silently released quota: %',outcome;
  END IF;

  -- B reserves 500 then expires during the lease. No NEW grant, and
  -- positive late settlement fails closed rather than inventing extra quota.
  UPDATE entitlements SET starts_at=clock_timestamp()-interval '2 hours',
                          expires_at=clock_timestamp()-interval '1 second'
    WHERE id=ent_b;
  SELECT reserve_smart_dns_chunk(ent_b,'b-chunk-02',1) INTO outcome;
  IF outcome<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'B expiry ignored: %',outcome; END IF;
  SELECT settle_smart_dns_chunk(ent_b,'b-chunk-01',100,100) INTO outcome;
  IF outcome<>'LATE_RECORDED' THEN
    RAISE EXCEPTION 'B late traffic was not audited: %',outcome;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM smart_dns_quota_reservations
     WHERE entitlement_id=ent_b AND reservation_id='b-chunk-01'
       AND state='SETTLED' AND upload_bytes=100 AND download_bytes=100)
     OR NOT EXISTS (SELECT 1 FROM smart_dns_late_traffic
       WHERE entitlement_id=ent_b AND reservation_id='b-chunk-01'
         AND upload_bytes=100 AND download_bytes=100) THEN
    RAISE EXCEPTION 'B late settlement missing immutable audit'; END IF;
  SELECT settle_smart_dns_chunk(ent_b,'b-chunk-01',100,100) INTO outcome;
  IF outcome<>'DUPLICATE' THEN RAISE EXCEPTION 'B late retry double-counted: %',outcome; END IF;
END $$;
ROLLBACK;
