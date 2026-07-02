package auth

import (
	"context"
	"fmt"
)

// migration represents a versioned schema change.
type migration struct {
	version int
	name    string
	sql     string
}

// migrations is the ordered list of schema changes. Each migration runs exactly
// once, tracked in schema_migrations. Version numbers are sequential and must
// never be reused.
var migrations = []migration{
	{
		version: 1,
		name:    "create_service_providers",
		sql: `CREATE TABLE IF NOT EXISTS service_providers (
			id                TEXT PRIMARY KEY,
			kind              TEXT NOT NULL,
			name              TEXT NOT NULL,
			enabled           INTEGER NOT NULL DEFAULT 1,
			base_url          TEXT NOT NULL DEFAULT '',
			model             TEXT NOT NULL DEFAULT '',
			public_config     TEXT NOT NULL DEFAULT '{}',
			secret_config_enc TEXT NOT NULL DEFAULT '',
			created_at        INTEGER NOT NULL,
			updated_at        INTEGER NOT NULL
		)`,
	},
	{
		version: 2,
		name:    "create_email_verification_codes",
		sql: `CREATE TABLE IF NOT EXISTS email_verification_codes (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			email        TEXT NOT NULL,
			code_hash    TEXT NOT NULL,
			purpose      TEXT NOT NULL,
			expires_at   INTEGER NOT NULL,
			attempts     INTEGER NOT NULL DEFAULT 0,
			consumed_at  INTEGER NOT NULL DEFAULT 0,
			created_ip   TEXT NOT NULL,
			created_at   INTEGER NOT NULL
		)`,
	},
	{
		version: 3,
		name:    "add_email_to_identities",
		sql: `ALTER TABLE identities ADD COLUMN email TEXT NOT NULL DEFAULT ''`,
	},
	{
		version: 4,
		name:    "add_email_verified_to_identities",
		sql: `ALTER TABLE identities ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
	},
	{
		version: 5,
		name:    "create_installation_state",
		sql: `CREATE TABLE IF NOT EXISTS installation_state (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	},
}

// runMigrations applies pending migrations in order and records each in
// schema_migrations. It is idempotent: re-running after a crash safely resumes
// from the last committed migration.
func (d *DB) runMigrations(ctx context.Context) error {
	// Ensure schema_migrations exists before reading it.
	if _, err := d.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	for _, m := range migrations {
		var applied int
		err := d.db.QueryRowContext(ctx, `SELECT 1 FROM schema_migrations WHERE version = ?`, m.version).Scan(&applied)
		if err == nil {
			// Already applied.
			continue
		}

		// Apply migration.
		if _, err := d.db.ExecContext(ctx, m.sql); err != nil {
			return fmt.Errorf("migration %d (%s): %w", m.version, m.name, err)
		}

		// Record success.
		if _, err := d.db.ExecContext(ctx,
			`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, unixepoch())`,
			m.version, m.name,
		); err != nil {
			return fmt.Errorf("record migration %d: %w", m.version, err)
		}
	}

	return nil
}
