-- Disposable DB-only recovery-review regression: evidence is not
-- proof of quiescence and cannot recycle an unconfirmed HOLD.
BEGIN;
DO $q113$
DECLARE
  acct uuid:='c1130000-0000-4000-8000-000000000001';
  other_acct uuid:='c1130000-0000-4000-8000-000000000002';
  ord uuid:='c1130000-0000-4000-8000-000000000003';
  ent uuid;
  result text;
  row_count bigint;
  q record;
BEGIN
  INSERT INTO accounts(id) VALUES(acct),(other_acct);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
  VALUES(ord,acct,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(ord,'mock','p113','c113',repeat('f',64),
         10000,'RUB',3600,512) INTO result;
  IF result<>'APPLIED' THEN RAISE EXCEPTION 'payment failed: %',result; END IF;
  SELECT id INTO ent FROM entitlements WHERE source_order_id=ord;
  UPDATE entitlements SET state='ACTIVE' WHERE id=ent;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT ent,'smart_dns',revision,clock_timestamp()
      FROM entitlements WHERE id=ent;
  SELECT status INTO result FROM dns_ingress_reserve(ent,1,'held-113-a',200);
  IF result<>'RESERVED' THEN RAISE EXCEPTION 'held reserve: %',result; END IF;
  SELECT status INTO result FROM dns_ingress_reserve(ent,1,'late-113-b',250);
  IF result<>'RESERVED' THEN RAISE EXCEPTION 'late reserve: %',result; END IF;

  -- Expire just ONE reservation's time window (not current TCP state):
  -- it must appear in a review queue but remain HELD.
  UPDATE smart_dns_quota_reservations
    SET created_at=clock_timestamp()-interval '1 minute',
        allowed_until=clock_timestamp()-interval '30 seconds'
    WHERE entitlement_id=ent AND reservation_id='held-113-a';
  SELECT count(*) INTO row_count FROM dns_list_unresolved_recovery(10)
    WHERE kind='STALE_HELD' AND entitlement_id=ent;
  IF row_count<>1 THEN RAISE EXCEPTION 'stale held case missing: %',row_count; END IF;

  UPDATE entitlements SET state='EXPIRED',revision=revision+1 WHERE id=ent;
  SELECT dns_ingress_settle(ent,1,'late-113-b',75,125) INTO result;
  IF result<>'LATE_RECORDED' THEN RAISE EXCEPTION 'late audit: %',result; END IF;
  SELECT count(*) INTO row_count FROM dns_list_unresolved_recovery(10)
    WHERE entitlement_id=ent;
  IF row_count<>2 THEN RAISE EXCEPTION 'expected two unresolved cases: %',row_count; END IF;
  SELECT count(*) INTO row_count FROM dns_list_unresolved_recovery(101);
  IF row_count<>0 THEN RAISE EXCEPTION 'limit bypass accepted'; END IF;

  SELECT * INTO q FROM get_smart_dns_monthly_late_traffic(acct,ent);
  IF NOT FOUND OR q.upload_bytes<>75 OR q.download_bytes<>125 OR q.event_count<>1
     OR q.month_utc<>date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date
  THEN RAISE EXCEPTION 'late UTC month attribution incorrect'; END IF;
  SELECT count(*) INTO row_count FROM get_smart_dns_monthly_late_traffic(other_acct,ent);
  IF row_count<>0 THEN RAISE EXCEPTION 'other account can see late traffic'; END IF;

  SELECT dns_attach_recovery_evidence(
    ent,'held-113-a','c1130000-0000-4000-8000-000000000011',
    'OPERATOR_NOTE',repeat('a',64)) INTO result;
  IF result<>'RECORDED' THEN RAISE EXCEPTION 'could not append evidence: %',result; END IF;
  SELECT dns_attach_recovery_evidence(
    ent,'held-113-a','c1130000-0000-4000-8000-000000000011',
    'OPERATOR_NOTE',repeat('a',64)) INTO result;
  IF result<>'DUPLICATE' THEN RAISE EXCEPTION 'evidence retry not idempotent: %',result; END IF;
  SELECT dns_attach_recovery_evidence(
    ent,'held-113-a','c1130000-0000-4000-8000-000000000011',
    'TCP_CAPTURE',repeat('a',64)) INTO result;
  IF result<>'DENY_CONFLICT' THEN RAISE EXCEPTION 'conflicting id accepted: %',result; END IF;
  SELECT dns_attach_recovery_evidence(
    ent,'held-113-a','c1130000-0000-4000-8000-000000000012',
    'OPERATOR_NOTE',repeat('a',64)) INTO result;
  IF result<>'DENY_DUPLICATE_EVIDENCE' THEN
    RAISE EXCEPTION 'duplicate digest under new UUID accepted: %',result; END IF;
  SELECT dns_attach_recovery_evidence(
    ent,'held-113-a','c1130000-0000-4000-8000-000000000013',
    'TCP_CAPTURE','spoof') INTO result;
  IF result<>'DENY_INVALID' THEN RAISE EXCEPTION 'bad SHA accepted'; END IF;
  SELECT dns_attach_recovery_evidence(
    ent,'late-113-b','c1130000-0000-4000-8000-000000000014',
    'TCP_CAPTURE',repeat('b',64)) INTO result;
  IF result<>'RECORDED' THEN RAISE EXCEPTION 'late evidence denied %',result; END IF;

  SELECT * INTO q FROM dns_list_unresolved_recovery(10)
    WHERE entitlement_id=ent AND reservation_id='held-113-a';
  IF q.kind<>'STALE_HELD' OR q.held_bytes<>200 OR q.evidence_count<>1 THEN
    RAISE EXCEPTION 'evidence accidentally released/resized held traffic'; END IF;
  SELECT * INTO q FROM dns_list_unresolved_recovery(10)
    WHERE entitlement_id=ent AND reservation_id='late-113-b';
  IF q.kind<>'LATE_AUDIT' OR q.late_upload_bytes<>75 OR
    q.late_download_bytes<>125 OR q.evidence_count<>1 THEN
    RAISE EXCEPTION 'late traffic lost while appending evidence'; END IF;
  IF (SELECT state FROM smart_dns_quota_reservations
      WHERE entitlement_id=ent AND reservation_id='held-113-a')<>'HELD' THEN
    RAISE EXCEPTION 'evidence illegally released HELD quota'; END IF;
  BEGIN
    UPDATE smart_dns_recovery_evidence SET digest_sha256=repeat('c',64);
    RAISE EXCEPTION 'recovery evidence was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$q113$;

DO $q114$
BEGIN
  IF has_table_privilege('mnebyvpn_dns_reviewer',
      'public.smart_dns_quota_reservations','SELECT')
     OR has_table_privilege('mnebyvpn_dns_reviewer',
      'public.smart_dns_recovery_evidence','INSERT')
     OR has_function_privilege('mnebyvpn_dns_reviewer',
      'public.dns_ingress_settle(uuid,bigint,text,bigint,bigint)','EXECUTE')
     OR NOT has_function_privilege('mnebyvpn_dns_reviewer',
      'public.dns_list_unresolved_recovery(integer)','EXECUTE')
     OR NOT has_function_privilege('mnebyvpn_dns_reviewer',
      'public.dns_attach_recovery_evidence(uuid,text,uuid,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'recovery reviewer has unsafe grants'; END IF;
END
$q114$;

SET LOCAL ROLE mnebyvpn_dns_reviewer;
SELECT * FROM dns_list_unresolved_recovery(5);
SELECT dns_attach_recovery_evidence(
  'c1130000-0000-4000-8000-000000000001'::uuid,'unknown-113',
  'c1130000-0000-4000-8000-000000000100'::uuid,
  'OPERATOR_NOTE',repeat('d',64));
RESET ROLE;
ROLLBACK;
