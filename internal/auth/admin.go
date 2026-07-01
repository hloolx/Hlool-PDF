package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrRegistrationClosed            = errors.New("registration is closed")
	ErrRegistrationInviteRequired    = errors.New("registration invite is required")
	ErrRegistrationInviteInvalid     = errors.New("registration invite is invalid")
	ErrRegistrationInviteDisabled    = errors.New("registration invite is disabled")
	ErrRegistrationInviteUsed        = errors.New("registration invite is used")
	ErrRegistrationInviteExpired     = errors.New("registration invite is expired")
	ErrRegistrationInviteUnavailable = errors.New("registration invite is unavailable")
	ErrAdminRequired                 = errors.New("admin privileges required")
)

// AuthSettings are runtime switches controlled by the admin page. Defaults come
// from deployment env, but once saved they live in SQLite and take effect
// immediately.
type AuthSettings struct {
	RegisterEnabled           bool `json:"registerEnabled"`
	InviteRequired            bool `json:"inviteRequired"`
	ThirdPartyRegisterEnabled bool `json:"thirdPartyRegisterEnabled"`
	GuestEnabled              bool `json:"guestEnabled"`
}

type RegistrationInvite struct {
	ID        int64
	CodeHint  string
	Name      string
	MaxUses   int
	UsedCount int
	ExpiresAt time.Time
	Disabled  bool
	CreatedBy string
	CreatedAt time.Time
	UsedAt    time.Time
}

type CreatedInvite struct {
	Invite RegistrationInvite
	Code   string
}

const (
	settingRegisterEnabled           = "auth.register_enabled"
	settingInviteRequired            = "auth.invite_required"
	settingThirdPartyRegisterEnabled = "auth.third_party_register_enabled"
	settingGuestEnabled              = "auth.guest_enabled"
)

// AuthSettings loads auth switches, falling back per-key to defaults when the
// database has not saved an admin choice yet.
func (d *DB) AuthSettings(ctx context.Context, defaults AuthSettings) (AuthSettings, error) {
	settings := defaults
	rows, err := d.db.QueryContext(ctx, `SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?)`,
		settingRegisterEnabled, settingInviteRequired, settingThirdPartyRegisterEnabled, settingGuestEnabled)
	if err != nil {
		return settings, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return settings, err
		}
		enabled := value == "true"
		switch key {
		case settingRegisterEnabled:
			settings.RegisterEnabled = enabled
		case settingInviteRequired:
			settings.InviteRequired = enabled
		case settingThirdPartyRegisterEnabled:
			settings.ThirdPartyRegisterEnabled = enabled
		case settingGuestEnabled:
			settings.GuestEnabled = enabled
		}
	}
	return settings, rows.Err()
}

func (d *DB) PutAuthSettings(ctx context.Context, settings AuthSettings) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().Unix()
	values := map[string]bool{
		settingRegisterEnabled:           settings.RegisterEnabled,
		settingInviteRequired:            settings.InviteRequired,
		settingThirdPartyRegisterEnabled: settings.ThirdPartyRegisterEnabled,
		settingGuestEnabled:              settings.GuestEnabled,
	}
	for key, enabled := range values {
		value := "false"
		if enabled {
			value = "true"
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			key, value, now,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) UpsertAdmin(ctx context.Context, u User) (User, bool, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at, is_guest, is_admin FROM users WHERE username = ? COLLATE NOCASE`,
		u.Username,
	)
	existing, err := scanUser(row)
	if errors.Is(err, ErrUserNotFound) {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO users (id, username, password_hash, created_at, is_guest, is_admin) VALUES (?, ?, ?, ?, 0, 1)`,
			u.ID, u.Username, u.PasswordHash, u.CreatedAt.Unix(),
		); err != nil {
			return User{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return User{}, false, err
		}
		u.IsAdmin = true
		return u, true, nil
	}
	if err != nil {
		return User{}, false, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ?, is_guest = 0, is_admin = 1 WHERE id = ?`,
		u.PasswordHash, existing.ID,
	); err != nil {
		return User{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, false, err
	}
	existing.PasswordHash = u.PasswordHash
	existing.IsGuest = false
	existing.IsAdmin = true
	return existing, false, nil
}

func (d *DB) CreateRegistrationInvites(ctx context.Context, name string, count, maxUses int, expiresAt time.Time, createdBy string) ([]CreatedInvite, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "邀请"
	}
	if count < 1 {
		count = 1
	}
	if count > 100 {
		count = 100
	}
	if maxUses < 1 {
		maxUses = 1
	}
	if maxUses > 1000 {
		maxUses = 1000
	}
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	expUnix := int64(0)
	if !expiresAt.IsZero() {
		expUnix = expiresAt.UTC().Unix()
	}
	out := make([]CreatedInvite, 0, count)
	for len(out) < count {
		code, err := newInviteCode()
		if err != nil {
			return nil, err
		}
		res, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO registration_invites
			 (code_hash, code_hint, name, max_uses, used_count, expires_at, disabled, created_by, created_at, used_at)
			 VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 0)`,
			hashInviteCode(code), inviteCodeHint(code), name, maxUses, createdBy, now.Unix(),
		)
		if err != nil {
			return nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		if n == 0 {
			continue
		}
		id, err := res.LastInsertId()
		if err != nil {
			return nil, err
		}
		if expUnix > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE registration_invites SET expires_at = ? WHERE id = ?`, expUnix, id); err != nil {
				return nil, err
			}
		}
		out = append(out, CreatedInvite{
			Code: code,
			Invite: RegistrationInvite{
				ID:        id,
				CodeHint:  inviteCodeHint(code),
				Name:      name,
				MaxUses:   maxUses,
				UsedCount: 0,
				ExpiresAt: expiresAt.UTC(),
				CreatedBy: createdBy,
				CreatedAt: now,
			},
		})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *DB) ListRegistrationInvites(ctx context.Context, limit int) ([]RegistrationInvite, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := d.db.QueryContext(ctx,
		`SELECT id, code_hint, name, max_uses, used_count, expires_at, disabled, created_by, created_at, used_at
		   FROM registration_invites
		  ORDER BY created_at DESC, id DESC
		  LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RegistrationInvite{}
	for rows.Next() {
		invite, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, invite)
	}
	return out, rows.Err()
}

func (d *DB) SetRegistrationInviteDisabled(ctx context.Context, id int64, disabled bool) error {
	value := 0
	if disabled {
		value = 1
	}
	res, err := d.db.ExecContext(ctx, `UPDATE registration_invites SET disabled = ? WHERE id = ?`, value, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (d *DB) DeleteRegistrationInvite(ctx context.Context, id int64) error {
	res, err := d.db.ExecContext(ctx, `DELETE FROM registration_invites WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (d *DB) CreateUserWithInvite(ctx context.Context, u User, inviteCode string, now time.Time) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertUserTx(ctx, tx, u); err != nil {
		return err
	}
	if err := consumeRegistrationInviteTx(ctx, tx, inviteCode, u.ID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (d *DB) UpgradeGuestWithInvite(ctx context.Context, id, username, passwordHash, inviteCode string, now time.Time) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
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
	if err := consumeRegistrationInviteTx(ctx, tx, inviteCode, id, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (d *DB) CreateUserWithIdentityAndInvite(ctx context.Context, u User, provider, subject, inviteCode string, now time.Time) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertUserTx(ctx, tx, u); err != nil {
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
	if err := consumeRegistrationInviteTx(ctx, tx, inviteCode, u.ID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func insertUserTx(ctx context.Context, tx *sql.Tx, u User) error {
	guest := 0
	if u.IsGuest {
		guest = 1
	}
	admin := 0
	if u.IsAdmin {
		admin = 1
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, created_at, is_guest, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, u.CreatedAt.Unix(), guest, admin,
	)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrUsernameTaken
	}
	return err
}

func consumeRegistrationInviteTx(ctx context.Context, tx *sql.Tx, code, userID string, now time.Time) error {
	normalized := normalizeInviteCode(code)
	if normalized == "" {
		return ErrRegistrationInviteRequired
	}
	var invite RegistrationInvite
	row := tx.QueryRowContext(ctx,
		`SELECT id, code_hint, name, max_uses, used_count, expires_at, disabled, created_by, created_at, used_at
		   FROM registration_invites
		  WHERE code_hash = ?`,
		hashInviteCode(normalized),
	)
	if err := scanInviteRow(row, &invite); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRegistrationInviteInvalid
		}
		return err
	}
	if invite.Disabled {
		return ErrRegistrationInviteDisabled
	}
	if !invite.ExpiresAt.IsZero() && !invite.ExpiresAt.After(now) {
		return ErrRegistrationInviteExpired
	}
	if invite.UsedCount >= invite.MaxUses {
		return ErrRegistrationInviteUsed
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE registration_invites
		    SET used_count = used_count + 1,
		        used_at = ?
		  WHERE id = ?
		    AND disabled = 0
		    AND used_count < max_uses
		    AND (expires_at = 0 OR expires_at > ?)`,
		now.Unix(), invite.ID, now.Unix(),
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrRegistrationInviteUnavailable
	}
	_ = userID // kept for future audit/use-history without changing the call site.
	return nil
}

type inviteScanner interface {
	Scan(dest ...any) error
}

func scanInvite(rows inviteScanner) (RegistrationInvite, error) {
	var invite RegistrationInvite
	err := scanInviteRow(rows, &invite)
	return invite, err
}

func scanInviteRow(row inviteScanner, invite *RegistrationInvite) error {
	var expiresAt, createdAt, usedAt int64
	var disabled int
	if err := row.Scan(
		&invite.ID, &invite.CodeHint, &invite.Name, &invite.MaxUses, &invite.UsedCount,
		&expiresAt, &disabled, &invite.CreatedBy, &createdAt, &usedAt,
	); err != nil {
		return err
	}
	invite.Disabled = disabled != 0
	if expiresAt > 0 {
		invite.ExpiresAt = time.Unix(expiresAt, 0).UTC()
	}
	if createdAt > 0 {
		invite.CreatedAt = time.Unix(createdAt, 0).UTC()
	}
	if usedAt > 0 {
		invite.UsedAt = time.Unix(usedAt, 0).UTC()
	}
	return nil
}

func newInviteCode() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	raw := strings.ToUpper(hex.EncodeToString(b[:]))
	return fmt.Sprintf("REG-%s-%s-%s-%s", raw[0:4], raw[4:8], raw[8:12], raw[12:16]), nil
}

func normalizeInviteCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

func hashInviteCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeInviteCode(code)))
	return hex.EncodeToString(sum[:])
}

func inviteCodeHint(code string) string {
	normalized := normalizeInviteCode(code)
	if len(normalized) <= 4 {
		return normalized
	}
	return normalized[len(normalized)-4:]
}
