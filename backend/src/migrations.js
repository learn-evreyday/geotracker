import { withTx } from './db.js';

const MIGRATIONS = [
  `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS citext;
  `,
  `
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    serial_number citext UNIQUE NOT NULL,
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  -- Backfill/migrate existing installs: add serial_number to devices
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number citext;
  UPDATE devices
    SET serial_number = UPPER(TRIM(COALESCE(serial_number::text, 'AUTO-' || id::text)))
    WHERE serial_number IS NULL;
  UPDATE devices
    SET serial_number = UPPER(TRIM(serial_number::text))
    WHERE serial_number IS NOT NULL;
  ALTER TABLE devices
    ALTER COLUMN serial_number TYPE citext
    USING serial_number::citext;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'devices_serial_number_key'
    ) THEN
      -- Unique constraint (idempotent-ish across fresh installs)
      ALTER TABLE devices ADD CONSTRAINT devices_serial_number_key UNIQUE (serial_number);
    END IF;
  END $$;
  ALTER TABLE devices ALTER COLUMN serial_number SET NOT NULL;
  `,
  `
  CREATE TABLE IF NOT EXISTS device_assignments (
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, user_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY,
    actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    entity_type text NULL,
    entity_id text NULL,
    ip text NULL,
    user_agent text NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug citext UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS company_users (
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS company_devices (
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, device_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('offline', 'low_battery')),
    severity text NOT NULL,
    message text NOT NULL,
    is_read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS alerts_device_id_idx ON alerts(device_id);
  CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts(created_at DESC);
  `,
  `
  ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
  ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN ('offline', 'low_battery', 'critical_battery'));
  `,
];

export async function runMigrations() {
  await withTx(async (client) => {
    for (const sql of MIGRATIONS) {
      await client.query(sql);
    }
  });
}

