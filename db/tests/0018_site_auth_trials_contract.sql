-- Site identities are canonical and a free trial is once per account,
-- regardless of whether the user authenticated through Telegram or Yandex.
BEGIN;
INSERT INTO accounts(id,yandex_user_id) VALUES
 ('91000000-0000-4000-8000-000000000001','91000000001'),
 ('91000000-0000-4000-8000-000000000002','91000000002');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  INSERT INTO accounts(id,yandex_user_id)
   VALUES('91000000-0000-4000-8000-000000000003','91000000001');
 EXCEPTION WHEN unique_violation THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Yandex actor collision unexpectedly accepted'; END IF;
END; $$;

INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
VALUES
 ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
  'vpn','internal_trial',0,'XTR','TRIAL'),
 ('92000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000001',
  'vpn','internal_trial',0,'XTR','TRIAL');
-- A Yandex-only account has no Telegram ID and no browser guest token.
INSERT INTO trial_grants(telegram_user_id,account_id,order_id,product)
 VALUES(NULL,'91000000-0000-4000-8000-000000000001',
 '92000000-0000-4000-8000-000000000001','vpn');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  INSERT INTO trial_grants(telegram_user_id,account_id,order_id,product)
   VALUES(NULL,'91000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000002','vpn');
 EXCEPTION WHEN unique_violation THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Second free trial for same account accepted'; END IF;
END; $$;
ROLLBACK;
