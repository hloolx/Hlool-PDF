// Package providers manages third-party service integration: AI matting, email,
// OAuth, and similar external APIs. Configuration is stored in the database with
// secret encryption; the frontend receives only masked status.
package providers

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/pbkdf2"
)

// Kind identifies the service category.
type Kind string

const (
	KindMatting Kind = "matting"
	KindMail    Kind = "mail"
	KindOAuth   Kind = "oauth"
	KindStorage Kind = "storage"
)

var (
	ErrProviderNotFound = errors.New("provider not found")
	ErrInvalidKind      = errors.New("invalid provider kind")
)

// Provider is a configured third-party service. PublicConfig holds non-sensitive
// fields safe for frontend display; SecretConfig holds API tokens, OAuth client
// secrets, SMTP passwords, and S3 keys encrypted at rest.
// JSON 标签与前端 admin/types.ts 的 Provider 类型一一对应(小写驼峰),缺了它们
// 列表会以 Go 字段名(大写)下发,前端读不到任何字段。
type Provider struct {
	ID           string                 `json:"id"`
	Kind         Kind                   `json:"kind"`
	Name         string                 `json:"name"`
	Enabled      bool                   `json:"enabled"`
	BaseURL      string                 `json:"baseURL"`
	Model        string                 `json:"model"`
	PublicConfig map[string]interface{} `json:"publicConfig"`
	SecretConfig map[string]interface{} `json:"secretConfig,omitempty"` // decrypted in-memory only
	CreatedAt    time.Time              `json:"createdAt"`
	UpdatedAt    time.Time              `json:"updatedAt"`
}

// Store manages provider configuration.
type Store struct {
	db         *sql.DB
	encryptKey []byte
}

// NewStore creates a provider store. encryptionSecret is used to derive the AES
// key for secret_config_enc; it must be stable across restarts (environment
// variable or database-stored wrapped key). If empty, secret fields cannot be
// stored and will fail with an error.
func NewStore(db *sql.DB, encryptionSecret string) (*Store, error) {
	if encryptionSecret == "" {
		return nil, errors.New("provider encryption secret is required")
	}
	// Derive a 32-byte AES-256 key from the secret using PBKDF2 with a fixed
	// salt. The salt is not secret (it's embedded here), but it ensures the
	// derived key isn't the raw password and resists rainbow tables.
	salt := []byte("hlool-pdf-provider-encryption-v1")
	key := pbkdf2.Key([]byte(encryptionSecret), salt, 100000, 32, sha256.New)
	return &Store{db: db, encryptKey: key}, nil
}

// Create inserts a new provider. SecretConfig is encrypted before storage.
func (s *Store) Create(ctx context.Context, p Provider) error {
	encSecret, err := s.encryptJSON(p.SecretConfig)
	if err != nil {
		return fmt.Errorf("encrypt secret config: %w", err)
	}
	pubJSON, err := json.Marshal(p.PublicConfig)
	if err != nil {
		return fmt.Errorf("marshal public config: %w", err)
	}

	enabled := 0
	if p.Enabled {
		enabled = 1
	}
	now := time.Now().Unix()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO service_providers (id, kind, name, enabled, base_url, model, public_config, secret_config_enc, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Kind, p.Name, enabled, p.BaseURL, p.Model, string(pubJSON), encSecret, now, now,
	)
	return err
}

// Get retrieves a provider by ID and decrypts SecretConfig.
func (s *Store) Get(ctx context.Context, id string) (Provider, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, kind, name, enabled, base_url, model, public_config, secret_config_enc, created_at, updated_at
		   FROM service_providers WHERE id = ?`, id)
	return s.scanProvider(row)
}

// List returns all providers of a given kind. Pass empty string for all kinds.
func (s *Store) List(ctx context.Context, kind Kind) ([]Provider, error) {
	var rows *sql.Rows
	var err error
	if kind == "" {
		rows, err = s.db.QueryContext(ctx,
			`SELECT id, kind, name, enabled, base_url, model, public_config, secret_config_enc, created_at, updated_at
			   FROM service_providers ORDER BY created_at ASC`)
	} else {
		rows, err = s.db.QueryContext(ctx,
			`SELECT id, kind, name, enabled, base_url, model, public_config, secret_config_enc, created_at, updated_at
			   FROM service_providers WHERE kind = ? ORDER BY created_at ASC`, kind)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var providers []Provider
	for rows.Next() {
		p, err := s.scanProviderRow(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, p)
	}
	return providers, rows.Err()
}

// Update replaces a provider's configuration. If SecretConfig is empty, the
// existing encrypted secrets are preserved.
func (s *Store) Update(ctx context.Context, p Provider) error {
	var encSecret string
	if len(p.SecretConfig) > 0 {
		enc, err := s.encryptJSON(p.SecretConfig)
		if err != nil {
			return fmt.Errorf("encrypt secret config: %w", err)
		}
		encSecret = enc
	} else {
		// Preserve existing secrets.
		var existing string
		err := s.db.QueryRowContext(ctx, `SELECT secret_config_enc FROM service_providers WHERE id = ?`, p.ID).Scan(&existing)
		if err != nil {
			return err
		}
		encSecret = existing
	}

	pubJSON, err := json.Marshal(p.PublicConfig)
	if err != nil {
		return fmt.Errorf("marshal public config: %w", err)
	}

	enabled := 0
	if p.Enabled {
		enabled = 1
	}
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx,
		`UPDATE service_providers
		    SET kind = ?, name = ?, enabled = ?, base_url = ?, model = ?, public_config = ?, secret_config_enc = ?, updated_at = ?
		  WHERE id = ?`,
		p.Kind, p.Name, enabled, p.BaseURL, p.Model, string(pubJSON), encSecret, now, p.ID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrProviderNotFound
	}
	return nil
}

// Delete removes a provider.
func (s *Store) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM service_providers WHERE id = ?`, id)
	return err
}

func (s *Store) scanProvider(row *sql.Row) (Provider, error) {
	var p Provider
	var kindStr string
	var enabled int
	var pubJSON, secEnc string
	var createdAt, updatedAt int64
	if err := row.Scan(&p.ID, &kindStr, &p.Name, &enabled, &p.BaseURL, &p.Model, &pubJSON, &secEnc, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Provider{}, ErrProviderNotFound
		}
		return Provider{}, err
	}

	p.Kind = Kind(kindStr)
	p.Enabled = enabled != 0
	p.CreatedAt = time.Unix(createdAt, 0).UTC()
	p.UpdatedAt = time.Unix(updatedAt, 0).UTC()

	if err := json.Unmarshal([]byte(pubJSON), &p.PublicConfig); err != nil {
		return Provider{}, fmt.Errorf("unmarshal public config: %w", err)
	}

	if secEnc != "" {
		sec, err := s.decryptJSON(secEnc)
		if err != nil {
			return Provider{}, fmt.Errorf("decrypt secret config: %w", err)
		}
		p.SecretConfig = sec
	}

	return p, nil
}

func (s *Store) scanProviderRow(rows *sql.Rows) (Provider, error) {
	var p Provider
	var kind string
	var enabled int
	var pubJSON, secEnc string
	var createdAt, updatedAt int64
	if err := rows.Scan(&p.ID, &kind, &p.Name, &enabled, &p.BaseURL, &p.Model, &pubJSON, &secEnc, &createdAt, &updatedAt); err != nil {
		return Provider{}, err
	}

	p.Kind = Kind(kind)
	p.Enabled = enabled != 0
	p.CreatedAt = time.Unix(createdAt, 0).UTC()
	p.UpdatedAt = time.Unix(updatedAt, 0).UTC()

	if err := json.Unmarshal([]byte(pubJSON), &p.PublicConfig); err != nil {
		return Provider{}, fmt.Errorf("unmarshal public config: %w", err)
	}

	if secEnc != "" {
		sec, err := s.decryptJSON(secEnc)
		if err != nil {
			return Provider{}, fmt.Errorf("decrypt secret config: %w", err)
		}
		p.SecretConfig = sec
	}

	return p, nil
}

// encryptJSON encrypts a JSON-serializable value using AES-GCM and returns a
// base64-encoded string safe for database storage.
func (s *Store) encryptJSON(v map[string]interface{}) (string, error) {
	plaintext, err := json.Marshal(v)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(s.encryptKey)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decryptJSON reverses encryptJSON.
func (s *Store) decryptJSON(encoded string) (map[string]interface{}, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(s.encryptKey)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	if len(ciphertext) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(plaintext, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// MaskSecrets returns a Provider with SecretConfig replaced by masked hints.
// Suitable for sending to the frontend.
func MaskSecrets(p Provider) Provider {
	masked := make(map[string]interface{})
	for k, v := range p.SecretConfig {
		if s, ok := v.(string); ok && len(s) > 4 {
			masked[k] = "****" + s[len(s)-4:]
		} else {
			masked[k] = "****"
		}
	}
	p.SecretConfig = masked
	return p
}

// ValidateKind checks if kind is a known provider category.
func ValidateKind(k Kind) error {
	switch k {
	case KindMatting, KindMail, KindOAuth, KindStorage:
		return nil
	default:
		return ErrInvalidKind
	}
}

// GenerateID creates a provider ID from kind and name.
func GenerateID(kind Kind, name string) string {
	return strings.ToLower(fmt.Sprintf("%s_%s", kind, strings.ReplaceAll(name, " ", "_")))
}
