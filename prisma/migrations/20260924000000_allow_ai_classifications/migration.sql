BEGIN;

-- O Prisma não representa CHECK constraints no schema. Remove somente o
-- check existente que menciona classified_by, independentemente do nome que
-- ele recebeu na criação original, e o recria com AI explicitamente aceito.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'transaction_classifications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%classified_by%'
  LOOP
    EXECUTE format(
      'ALTER TABLE transaction_classifications DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE transaction_classifications
  ADD CONSTRAINT transaction_classifications_classified_by_check
  CHECK (classified_by IN ('DEFAULT', 'RULE', 'AI', 'USER'));

COMMIT;
