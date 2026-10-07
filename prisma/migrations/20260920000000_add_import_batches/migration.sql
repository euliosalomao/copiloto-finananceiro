BEGIN;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_id_tenant_unique_idx
  UNIQUE (id, tenant_id);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider text NOT NULL,
  format text NOT NULL,
  source text NOT NULL,
  source_message_id text,
  source_attachment_id text,
  file_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING',
  total_transactions integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  possible_duplicate_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  metadata jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT import_batches_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE CASCADE,

  CONSTRAINT import_batches_account_tenant_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES accounts (id, tenant_id)
    ON DELETE CASCADE,

  CONSTRAINT import_batches_status_check
    CHECK (status IN ('PROCESSING', 'IMPORTED', 'NEEDS_REVIEW', 'FAILED')),

  CONSTRAINT import_batches_file_hash_check
    CHECK (file_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT import_batches_source_attachment_check
    CHECK (source_attachment_id IS NULL OR source_message_id IS NOT NULL),

  CONSTRAINT import_batches_counts_check
    CHECK (
      total_transactions >= 0 AND
      imported_count >= 0 AND
      duplicate_count >= 0 AND
      possible_duplicate_count >= 0 AND
      failed_count >= 0
    ),

  CONSTRAINT import_batches_finished_at_check
    CHECK (
      (status = 'PROCESSING' AND finished_at IS NULL) OR
      (status IN ('IMPORTED', 'NEEDS_REVIEW', 'FAILED') AND finished_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX import_batches_source_attachment_unique_idx
  ON import_batches (
    tenant_id,
    source,
    source_message_id,
    source_attachment_id
  )
  WHERE source_message_id IS NOT NULL
    AND source_attachment_id IS NOT NULL;

CREATE UNIQUE INDEX import_batches_source_message_unique_idx
  ON import_batches (tenant_id, source, source_message_id)
  WHERE source_message_id IS NOT NULL
    AND source_attachment_id IS NULL;

CREATE UNIQUE INDEX import_batches_file_unique_idx
  ON import_batches (tenant_id, account_id, provider, format, file_hash);

CREATE INDEX import_batches_account_started_idx
  ON import_batches (account_id, started_at DESC);

CREATE INDEX import_batches_tenant_status_idx
  ON import_batches (tenant_id, status);

COMMIT;
