package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo)
)

// Sentinel errors from the user/session store.
var (
	ErrUsernameTaken    = errors.New("username already taken")
	ErrUserNotFound     = errors.New("user not found")
	ErrSessionInvalid   = errors.New("session invalid or expired")
	ErrNotGuest         = errors.New("account is not an upgradeable guest")
	ErrIdentityNotFound = errors.New("identity not found")
	ErrIdentityLinked   = errors.New("identity already linked to an account")
)

// User is a registered account, or a temporary guest (IsGuest). ID doubles as
// the uid used to namespace the user's library storage, so it is a safe
// path/key segment. A guest carries a synthetic, un-pickable username; on
// upgrade the same ID is kept so the guest's library carries over untouched.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	CreatedAt    time.Time
	IsGuest      bool
	IsAdmin      bool
}

// DB is the SQLite-backed user and session store.
type DB struct {
	db *sql.DB
}

// OpenDB opens (creating if needed) the SQLite database at path and applies the
// schema. WAL + synchronous=NORMAL is the recommended durable-yet-fast combo
// for a single-node server; busy_timeout lets brief writer contention retry
// instead of failing.
func OpenDB(path string) (*DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(1)", path)
	sqldb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// Bound the connection pool: SQLite serializes writers, so an unbounded pool
	// just multiplies lock contention. A small pool plus busy_timeout keeps the
	// hot session-lookup path concurrent (WAL readers) without thrashing.
	maxConns := runtime.GOMAXPROCS(0) + 2
	if maxConns < 4 {
		maxConns = 4
	}
	sqldb.SetMaxOpenConns(maxConns)
	sqldb.SetMaxIdleConns(maxConns)
	sqldb.SetConnMaxIdleTime(5 * time.Minute)
	if err := sqldb.Ping(); err != nil {
		_ = sqldb.Close()
		return nil, err
	}
	db := &DB{db: sqldb}
	if err := db.migrate(); err != nil {
		_ = sqldb.Close()
		return nil, err
	}
	return db, nil
}

// Close closes the underlying database.
func (d *DB) Close() error { return d.db.Close() }

func (d *DB) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id            TEXT PRIMARY KEY,
			username      TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			created_at    INTEGER NOT NULL,
			is_guest      INTEGER NOT NULL DEFAULT 0,
			is_admin      INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username COLLATE NOCASE)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY,
			user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
		// Federated/third-party identities. (provider, subject) is the stable key
		// a login provider maps to; a user may have several. Rows cascade away
		// with the account, exactly like sessions.
		`CREATE TABLE IF NOT EXISTS identities (
			provider   TEXT NOT NULL,
			subject    TEXT NOT NULL,
			user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (provider, subject)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id)`,
		`CREATE TABLE IF NOT EXISTS app_settings (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS registration_invites (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			code_hash  TEXT NOT NULL UNIQUE,
			code_hint  TEXT NOT NULL,
			name       TEXT NOT NULL,
			max_uses   INTEGER NOT NULL,
			used_count INTEGER NOT NULL DEFAULT 0,
			expires_at INTEGER NOT NULL DEFAULT 0,
			disabled   INTEGER NOT NULL DEFAULT 0,
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			used_at    INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_registration_invites_created ON registration_invites (created_at DESC)`,
	}
	for _, stmt := range stmts {
		if _, err := d.db.Exec(stmt); err != nil {
			return err
		}
	}
	// Bring databases created before guest support up to date.
	if err := d.ensureColumn("users", "is_guest", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := d.ensureColumn("users", "is_admin", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if _, err := d.db.Exec(`CREATE INDEX IF NOT EXISTS idx_users_guest ON users (is_guest, created_at)`); err != nil {
		return err
	}
	if _, err := d.db.Exec(`CREATE INDEX IF NOT EXISTS idx_users_admin ON users (is_admin)`); err != nil {
		return err
	}
	return nil
}

// ensureColumn adds column to table if an older schema is missing it. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so the presence check goes through PRAGMA.
func (d *DB) ensureColumn(table, column, definition string) error {
	rows, err := d.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid, notNull, pk int
			name, colType    string
			dfltValue        sql.NullString
		)
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
			return err
		}
		if name == column {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = d.db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
	return err
}

// CreateUser inserts a new account or guest. Returns ErrUsernameTaken on a
// duplicate (case-insensitive) username.
func (d *DB) CreateUser(ctx context.Context, u User) error {
	guest := 0
	if u.IsGuest {
		guest = 1
	}
	admin := 0
	if u.IsAdmin {
		admin = 1
	}
	_, err := d.db.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, created_at, is_guest, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, u.CreatedAt.Unix(), guest, admin,
	)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrUsernameTaken
	}
	return err
}

// CreateUserWithIdentity atomically creates an account and links a federated
// identity to it. Either both rows land or neither does. Returns ErrUsernameTaken
// on a duplicate username or ErrIdentityLinked if (provider, subject) is taken.
func (d *DB) CreateUserWithIdentity(ctx context.Context, u User, provider, subject string) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	guest := 0
	if u.IsGuest {
		guest = 1
	}
	admin := 0
	if u.IsAdmin {
		admin = 1
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, created_at, is_guest, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, u.CreatedAt.Unix(), guest, admin,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrUsernameTaken
		}
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)`,
		provider, subject, u.ID, u.CreatedAt.Unix(),
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrIdentityLinked
		}
		return err
	}
	return tx.Commit()
}

// LinkIdentity attaches a federated identity to an existing account. Returns
// ErrIdentityLinked if (provider, subject) is already mapped (possibly to
// another user).
func (d *DB) LinkIdentity(ctx context.Context, provider, subject, userID string, createdAt time.Time) error {
	_, err := d.db.ExecContext(ctx,
		`INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)`,
		provider, subject, userID, createdAt.Unix(),
	)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrIdentityLinked
	}
	return err
}

// UserByIdentity resolves the account a federated identity maps to. Returns
// ErrIdentityNotFound when the identity is unknown.
func (d *DB) UserByIdentity(ctx context.Context, provider, subject string) (User, error) {
	row := d.db.QueryRowContext(ctx,
		`SELECT u.id, u.username, u.password_hash, u.created_at, u.is_guest, u.is_admin
		   FROM identities i JOIN users u ON u.id = i.user_id
		  WHERE i.provider = ? AND i.subject = ?`,
		provider, subject,
	)
	u, err := scanUser(row)
	if errors.Is(err, ErrUserNotFound) {
		return User{}, ErrIdentityNotFound
	}
	return u, err
}

// UpgradeGuest converts a guest account into a registered one in place: the same
// id (and therefore the same library) is kept, the synthetic username/password
// are replaced and the guest flag is cleared. Returns ErrUsernameTaken if the
// chosen username is taken, or ErrNotGuest if id is missing or already a real
// account.
func (d *DB) UpgradeGuest(ctx context.Context, id, username, passwordHash string) error {
	res, err := d.db.ExecContext(ctx,
		`UPDATE users SET username = ?, password_hash = ?, is_guest = 0 WHERE id = ? AND is_guest = 1`,
		username, passwordHash, id,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrUsernameTaken
		}
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotGuest
	}
	return nil
}

// UserByUsername looks up an account by case-insensitive username.
func (d *DB) UserByUsername(ctx context.Context, username string) (User, error) {
	row := d.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at, is_guest, is_admin FROM users WHERE username = ? COLLATE NOCASE`,
		username,
	)
	return scanUser(row)
}

// UserByID looks up an account by id.
func (d *DB) UserByID(ctx context.Context, id string) (User, error) {
	row := d.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at, is_guest, is_admin FROM users WHERE id = ?`, id,
	)
	return scanUser(row)
}

// CreateSession records a session keyed by the SHA-256 hash of the raw token.
func (d *DB) CreateSession(ctx context.Context, tokenHash, userID string, createdAt, expiresAt time.Time) error {
	_, err := d.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, createdAt.Unix(), expiresAt.Unix(),
	)
	return err
}

// SessionUser returns the user for a still-valid session token hash. Expired or
// unknown sessions yield ErrSessionInvalid.
func (d *DB) SessionUser(ctx context.Context, tokenHash string, now time.Time) (User, error) {
	row := d.db.QueryRowContext(ctx,
		`SELECT u.id, u.username, u.password_hash, u.created_at, u.is_guest, u.is_admin
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = ? AND s.expires_at > ?`,
		tokenHash, now.Unix(),
	)
	u, err := scanUser(row)
	if errors.Is(err, ErrUserNotFound) {
		return User{}, ErrSessionInvalid
	}
	return u, err
}

// DeleteSession revokes a single session.
func (d *DB) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteExpiredSessions purges sessions that expired before now.
func (d *DB) DeleteExpiredSessions(ctx context.Context, now time.Time) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now.Unix())
	return err
}

// ExpiredGuestIDs returns the ids of guest accounts created at or before cutoff.
// The caller purges each guest's library and then DeleteUser's the row.
func (d *DB) ExpiredGuestIDs(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := d.db.QueryContext(ctx,
		`SELECT id FROM users WHERE is_guest = 1 AND created_at <= ?`, cutoff.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// DeleteUser removes a user row; its sessions cascade away via the foreign key.
func (d *DB) DeleteUser(ctx context.Context, id string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

func scanUser(row *sql.Row) (User, error) {
	var u User
	var createdAt int64
	var isGuest, isAdmin int
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &createdAt, &isGuest, &isAdmin); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrUserNotFound
		}
		return User{}, err
	}
	u.CreatedAt = time.Unix(createdAt, 0).UTC()
	u.IsGuest = isGuest != 0
	u.IsAdmin = isAdmin != 0
	return u, nil
}
