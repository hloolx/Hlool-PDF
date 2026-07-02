package auth

import "database/sql"

// DB returns the underlying *sql.DB. This is used by providers.Store to share
// the same connection pool and transaction context.
func (d *DB) DB() *sql.DB {
	return d.db
}
