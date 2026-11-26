-- Forward-only security hardening, task retry bounds, cancellation, and memory integrity.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing OAuth users already have verified identities in user_auth_identities.
UPDATE users u
SET email_verified = TRUE
WHERE email_verified = FALSE
  AND EXISTS (
    SELECT 1
    FROM user_auth_identities uai
    WHERE uai.user_id = u.id
  );

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS tasks_running_updated_idx
  ON tasks (updated_at)
  WHERE state = 'running';

-- Clean up any orphaned memory user references before adding the foreign key.
UPDATE memories
SET user_id = NULL
WHERE user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = memories.user_id
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'memories_user_id_fkey'
  ) THEN
    ALTER TABLE memories
      ADD CONSTRAINT memories_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
