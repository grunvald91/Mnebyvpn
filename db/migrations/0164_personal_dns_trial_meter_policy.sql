-- German ingress recognition with immutable trial policy; no public grants.
BEGIN;
CREATE FUNCTION public.personal_dns_meter_policy(p_label text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN NOT public.recognize_personal_dns_credential(p_label) THEN 'UNKNOWN'
   WHEN EXISTS(SELECT 1 FROM public.personal_dns_credentials c
     JOIN public.entitlements e ON e.id=c.entitlement_id
     JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
     WHERE c.token_sha256=encode(sha256(convert_to(p_label,'UTF8')),'hex')
       AND o.provider='internal_trial' AND o.product='bundle' AND o.amount_minor=0)
   THEN 'TRIAL' ELSE 'LEGACY' END
$$;
REVOKE ALL ON FUNCTION public.personal_dns_meter_policy(text) FROM PUBLIC;
-- Reuse only existing explicit recognition callers. Do not grant to PUBLIC.
DO $roles$
DECLARE r record;
BEGIN
 FOR r IN SELECT DISTINCT pr.rolname FROM pg_proc p
   CROSS JOIN LATERAL aclexplode(p.proacl) a
   JOIN pg_roles pr ON pr.oid=a.grantee
   WHERE p.oid='public.recognize_personal_dns_credential(text)'::regprocedure
     AND a.privilege_type='EXECUTE'
 LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.personal_dns_meter_policy(text) TO %I',r.rolname);
 END LOOP;
END;
$roles$;
COMMIT;
