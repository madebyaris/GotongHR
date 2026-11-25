import pg from "pg";

const { Client } = pg;

export interface AnomalyMigrateInput {
  migratorUrl: string;
}

/**
 * Adds the review note and the pending-inbox index.
 * Run this after migrateClock. The punch row is not deleted on review.
 */
export async function migrateAnomalies(input: AnomalyMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(columnSql);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
}

const columnSql = `
ALTER TABLE att_clock_events
  ADD COLUMN IF NOT EXISTS review_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'att_clock_events_review_note_check'
  ) THEN
    ALTER TABLE att_clock_events
      ADD CONSTRAINT att_clock_events_review_note_check
      CHECK (
        review_note IS NULL
        OR (
          char_length(review_note) BETWEEN 1 AND 500
          AND review_note = btrim(review_note)
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS att_clock_events_needs_review_idx
  ON att_clock_events (tenant_id, captured_at, id)
  WHERE review_status = 'needs_review';

COMMENT ON COLUMN att_clock_events.review_note IS
  'Optional note stored when a manager marks the punch reviewed. The clock row stays.';
`;
