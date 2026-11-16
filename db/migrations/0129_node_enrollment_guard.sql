-- P1 hardening: an enrollment state cannot be forged by direct INSERT/UPDATE
-- or by silently exchanging a node key after operator approval.
BEGIN;

CREATE OR REPLACE FUNCTION vpn_node_enrollment_guard_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'planned' OR NEW.approved_at IS NOT NULL
       OR NEW.enrolled_at IS NOT NULL THEN
      RAISE EXCEPTION 'New node must start planned and unapproved';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'planned' THEN
      RAISE EXCEPTION 'Approved or revoked node identity must not be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- Approving one identity may not later silently authorize another.
  IF OLD.status <> 'planned' AND
    (NEW.node_id IS DISTINCT FROM OLD.node_id OR
     NEW.endpoint_host IS DISTINCT FROM OLD.endpoint_host OR
     NEW.identity_public_spki IS DISTINCT FROM OLD.identity_public_spki) THEN
    RAISE EXCEPTION 'Approved node identity is immutable';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Node creation timestamp is immutable';
  END IF;
  IF NEW.status NOT IN (
    CASE OLD.status WHEN 'planned' THEN 'planned'
      WHEN 'approved' THEN 'approved'
      WHEN 'enrolled' THEN 'enrolled'
      ELSE 'revoked' END,
    CASE OLD.status WHEN 'planned' THEN 'approved'
      WHEN 'approved' THEN 'enrolled'
      WHEN 'enrolled' THEN 'revoked'
      ELSE 'revoked' END,
    CASE OLD.status WHEN 'planned' THEN 'revoked'
      WHEN 'approved' THEN 'revoked'
      ELSE OLD.status END
  ) THEN
    RAISE EXCEPTION 'Invalid node enrollment state transition';
  END IF;
  IF NEW.status='planned' AND
     (NEW.approved_at IS NOT NULL OR NEW.enrolled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Unapproved node cannot have approval/enrollment timestamps';
  END IF;
  IF NEW.status='approved' AND NEW.enrolled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Unenrolled node cannot have enrollment timestamp';
  END IF;
  IF OLD.status='revoked' AND
     NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at THEN
    RAISE EXCEPTION 'Revoked node timestamps are immutable';
  END IF;
  IF OLD.approved_at IS NOT NULL AND
     NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Approval timestamp is immutable';
  END IF;
  IF OLD.enrolled_at IS NOT NULL AND
     NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at THEN
    RAISE EXCEPTION 'Enrollment timestamp is immutable';
  END IF;
  IF OLD.status='approved' AND NEW.status='enrolled' AND
     NOT EXISTS(
       SELECT 1 FROM vpn_node_enrollment_challenges c
       WHERE c.node_id=OLD.node_id
         AND c.consumed_at IS NOT NULL
         AND c.consumed_at <= c.expires_at
         AND c.consumed_at >= c.issued_at
         AND c.consumed_at >= clock_timestamp()-interval '5 minutes'
     ) THEN
    RAISE EXCEPTION 'Enrollment requires a consumed unexpired challenge';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER vpn_node_enrollment_immutability ON vpn_node_enrollment_inventory;
CREATE TRIGGER vpn_node_enrollment_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON vpn_node_enrollment_inventory
  FOR EACH ROW EXECUTE FUNCTION vpn_node_enrollment_guard_identity();

REVOKE ALL ON FUNCTION vpn_node_enrollment_guard_identity() FROM PUBLIC;
COMMIT;
