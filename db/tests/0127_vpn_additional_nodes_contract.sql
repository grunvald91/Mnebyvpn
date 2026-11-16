BEGIN;
DO $$
BEGIN
  IF (SELECT enabled FROM vpn_release_flags WHERE feature='vpn_additional_nodes') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Extra VPN nodes are not fail-closed on fresh database';
  END IF;
  INSERT INTO vpn_additional_nodes(node_id,country_code,country_name_ru,
    endpoint_host,endpoint_port,state,exit_country_proof_sha256,
    vpn_e2e_proof_sha256)
  VALUES ('nl-node-02','NL','Нидерланды','nl-node-02.nodes.example.net',
    2053,'testing',repeat('a',64),repeat('b',64));
  BEGIN
    UPDATE vpn_additional_nodes SET state='enabled' WHERE node_id='nl-node-02';
    RAISE EXCEPTION 'Unverified node enabled';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE vpn_additional_nodes SET verified_at=clock_timestamp(),state='enabled'
  WHERE node_id='nl-node-02';
  BEGIN
    INSERT INTO vpn_additional_nodes(node_id,country_code,country_name_ru,
      endpoint_host,endpoint_port,state,exit_country_proof_sha256,
      vpn_e2e_proof_sha256)
    VALUES ('de-node-01','DE','Германия','nl-node-02.nodes.example.net',
      2053,'testing',repeat('a',64),repeat('b',64));
    RAISE EXCEPTION 'Duplicate public hostname allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE vpn_additional_nodes SET endpoint_host='cdn.servgo.ru'
      WHERE node_id='nl-node-02';
    RAISE EXCEPTION 'Legacy host collision allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid='vpn_additional_node_receipts'::regclass AND a.grantee=0
  ) THEN RAISE EXCEPTION 'PUBLIC can read extra subscriber secrets'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid='vpn_additional_nodes'::regclass AND a.grantee=0
  ) THEN RAISE EXCEPTION 'PUBLIC can read private node registry'; END IF;
END $$;
ROLLBACK;
