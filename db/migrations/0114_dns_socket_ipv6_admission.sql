-- Offline admission: identify a paid flow by actual TCP destination IPv6.
-- No public listeners, no NIC routing and no DoT configuration changes.
BEGIN;
CREATE FUNCTION dns_ingress_identify_destination_ipv6(p_destination inet)
RETURNS TABLE(entitlement_id uuid,entitlement_revision bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $ipv6$
  SELECT p.entitlement_id,p.entitlement_revision
    FROM authorize_paid_smart_dns_ingress(p_destination) AS p
   WHERE p_destination IS NOT NULL AND family(p_destination)=6
     AND masklen(p_destination)=128;
$ipv6$;
REVOKE ALL ON FUNCTION dns_ingress_identify_destination_ipv6(inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dns_ingress_identify_destination_ipv6(inet)
  TO mnebyvpn_dns_ingress;
COMMIT;
