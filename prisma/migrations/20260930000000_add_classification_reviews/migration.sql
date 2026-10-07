BEGIN;

CREATE TABLE classification_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'CLAIMED',
  external_message_id text,
  reply_message text,
  resolved_category_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claim_expires_at timestamptz,
  message_sent_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT classification_reviews_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE CASCADE,

  CONSTRAINT classification_reviews_classification_fk
    FOREIGN KEY (classification_id)
    REFERENCES transaction_classifications (id)
    ON DELETE CASCADE,

  CONSTRAINT classification_reviews_resolved_category_fk
    FOREIGN KEY (resolved_category_id)
    REFERENCES categories (id),

  CONSTRAINT classification_reviews_status_check
    CHECK (status IN ('CLAIMED', 'WAITING_REPLY', 'RESOLVED')),

  CONSTRAINT classification_reviews_state_check
    CHECK (
      (
        status = 'CLAIMED'
        AND external_message_id IS NULL
        AND claim_expires_at IS NOT NULL
        AND message_sent_at IS NULL
        AND resolved_at IS NULL
        AND resolved_category_id IS NULL
      )
      OR
      (
        status = 'WAITING_REPLY'
        AND external_message_id IS NOT NULL
        AND claim_expires_at IS NULL
        AND message_sent_at IS NOT NULL
        AND resolved_at IS NULL
        AND resolved_category_id IS NULL
      )
      OR
      (
        status = 'RESOLVED'
        AND external_message_id IS NOT NULL
        AND claim_expires_at IS NULL
        AND message_sent_at IS NOT NULL
        AND resolved_at IS NOT NULL
        AND resolved_category_id IS NOT NULL
        AND reply_message IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX classification_reviews_classification_id_key
  ON classification_reviews (classification_id);

CREATE UNIQUE INDEX classification_reviews_active_tenant_unique_idx
  ON classification_reviews (tenant_id)
  WHERE status IN ('CLAIMED', 'WAITING_REPLY');

CREATE UNIQUE INDEX classification_reviews_external_message_unique_idx
  ON classification_reviews (tenant_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX classification_reviews_tenant_status_idx
  ON classification_reviews (tenant_id, status);

CREATE INDEX classification_reviews_tenant_created_idx
  ON classification_reviews (tenant_id, created_at);

COMMIT;
