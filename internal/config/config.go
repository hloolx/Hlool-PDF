// Package config parses the hlool-pdf runtime configuration from environment
// variables. It centralizes every tunable knob (listen address, data directory,
// storage backend selection, security gates and TLS) so the rest of the program
// receives a single validated struct.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Config is the fully-resolved runtime configuration.
type Config struct {
	// Addr is the TCP listen address (host:port).
	Addr string
	// DataDir is the server-side data directory: it holds the SQLite user
	// database and, when no S3 bucket is configured, the local user library.
	DataDir string
	// OpenBrowser opens the app in the default browser shortly after start.
	OpenBrowser bool

	// AllowedHosts is the Host-header allowlist (DNS-rebinding guard). Empty
	// means "derive a localhost default" (see Load).
	AllowedHosts []string
	// CORSOrigins lists cross-origin sites permitted to call the API.
	CORSOrigins []string

	// TLSCert / TLSKey enable the built-in HTTPS listener when both are set.
	TLSCert string
	TLSKey  string
	// BehindProxy trusts X-Forwarded-Proto from an upstream TLS-terminating proxy.
	BehindProxy bool
	// SecureCookies forces the Secure flag on session cookies. It is derived
	// (TLS or proxy ⇒ true) but can be overridden for unusual deployments.
	SecureCookies bool
	// AllowGuest enables the zero-friction temporary "guest" identity: a
	// first-time visitor gets an anonymous session automatically and can use
	// the app, with the guest's library burned after auth.GuestTTL. Disable it
	// for a closed instance that requires a registered account up front.
	AllowGuest bool

	// MaxProcessBodyBytes caps the multipart body of /api/process (source PDF
	// plus parameters).
	MaxProcessBodyBytes int64
	// MaxStampBytes caps an uploaded stamp image.
	MaxStampBytes int64
	// MaxConcurrentJobs bounds how many CPU/memory-heavy PDF jobs
	// (process/compose/image-to-pdf) run at once; excess requests wait briefly
	// then get 503. Defaults to GOMAXPROCS. Lower it on small-RAM instances —
	// each job can transiently use several times the source-PDF size.
	MaxConcurrentJobs int

	// S3 holds the object-storage backend settings. When S3.Bucket is empty
	// the local filesystem backend is used instead.
	S3 S3Config
}

// S3Config configures the optional S3 (or S3-compatible, e.g. MinIO,
// Cloudflare R2, Backblaze B2) backend. Credentials are taken from the standard
// AWS chain (env, shared config, IAM role) — never from these fields.
type S3Config struct {
	Bucket         string
	Region         string
	Endpoint       string // custom endpoint for MinIO / R2 / S3-compatible stores
	Prefix         string // optional key prefix prepended before users/{uid}/
	ForcePathStyle bool   // required by most MinIO deployments

	// SSE selects the server-side-encryption header written on every object:
	// "none", "AES256" (SSE-S3) or "aws:kms". It defaults to AES256 on AWS and
	// to "none" against a custom endpoint, because R2/B2 encrypt at rest on
	// their own and reject (or ignore) the SSE header.
	SSE string
	// KMSKeyID is the optional KMS key id used when SSE == "aws:kms" (empty =
	// the account's default aws/s3 key).
	KMSKeyID string
	// ChecksumWhenSupported keeps the AWS SDK's default behaviour of attaching
	// integrity checksums (CRC) + aws-chunked encoding to every upload. It is
	// false by default ("when required") because that default trips up most
	// non-AWS S3 implementations (R2, B2, some MinIO builds). Enable it only on
	// genuine AWS S3 for extra integrity coverage.
	ChecksumWhenSupported bool
}

// UseS3 reports whether the S3 backend should be used.
func (c Config) UseS3() bool { return strings.TrimSpace(c.S3.Bucket) != "" }

// TLSEnabled reports whether the built-in HTTPS listener should be used.
func (c Config) TLSEnabled() bool { return c.TLSCert != "" && c.TLSKey != "" }

const (
	defaultMaxProcessBodyMB = 220 // 200 MiB PDF + headroom for parameters
	defaultMaxStampMB       = 20
)

// Load reads the configuration from the environment, applies defaults and
// validates it. It never reads command-line flags; the caller may override
// individual fields afterwards.
func Load() (Config, error) {
	cfg := Config{
		Addr:        envOr("HLOOL_ADDR", "127.0.0.1:8088"),
		DataDir:     envOr("HLOOL_DATA_DIR", defaultDataDir()),
		OpenBrowser: envBool("HLOOL_OPEN_BROWSER", false),

		AllowedHosts: splitCSV(os.Getenv("HLOOL_ALLOWED_HOSTS")),
		CORSOrigins:  splitCSV(os.Getenv("HLOOL_CORS_ORIGINS")),

		TLSCert:     strings.TrimSpace(os.Getenv("HLOOL_TLS_CERT")),
		TLSKey:      strings.TrimSpace(os.Getenv("HLOOL_TLS_KEY")),
		BehindProxy: envBool("HLOOL_BEHIND_PROXY", false),
		AllowGuest:  envBool("HLOOL_ALLOW_GUEST", true),

		MaxProcessBodyBytes: envInt64("HLOOL_MAX_PROCESS_BODY_MB", defaultMaxProcessBodyMB) << 20,
		MaxStampBytes:       envInt64("HLOOL_MAX_STAMP_MB", defaultMaxStampMB) << 20,
		MaxConcurrentJobs:   int(envInt64("HLOOL_MAX_CONCURRENT_JOBS", int64(runtime.GOMAXPROCS(0)))),

		S3: S3Config{
			Bucket:         strings.TrimSpace(os.Getenv("HLOOL_S3_BUCKET")),
			Region:         strings.TrimSpace(os.Getenv("HLOOL_S3_REGION")),
			Endpoint:       strings.TrimSpace(os.Getenv("HLOOL_S3_ENDPOINT")),
			Prefix:         strings.Trim(strings.TrimSpace(os.Getenv("HLOOL_S3_PREFIX")), "/"),
			ForcePathStyle: envBool("HLOOL_S3_FORCE_PATH_STYLE", false),
			KMSKeyID:       strings.TrimSpace(os.Getenv("HLOOL_S3_KMS_KEY_ID")),
		},
	}

	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return Config{}, fmt.Errorf("HLOOL_TLS_CERT and HLOOL_TLS_KEY must be set together")
	}
	if cfg.UseS3() {
		if cfg.S3.Region == "" && cfg.S3.Endpoint == "" {
			return Config{}, fmt.Errorf("HLOOL_S3_REGION (or HLOOL_S3_ENDPOINT) is required when HLOOL_S3_BUCKET is set")
		}
		// R2 and most S3-compatible stores expect region "auto" behind a custom
		// endpoint; the AWS SDK still needs *some* region to sign requests.
		if cfg.S3.Region == "" {
			cfg.S3.Region = "auto"
		}
		sse, err := normalizeSSE(os.Getenv("HLOOL_S3_SSE"), cfg.S3.Endpoint != "")
		if err != nil {
			return Config{}, err
		}
		cfg.S3.SSE = sse
		mode, err := checksumWhenSupported(os.Getenv("HLOOL_S3_CHECKSUM"))
		if err != nil {
			return Config{}, err
		}
		cfg.S3.ChecksumWhenSupported = mode
	}

	// Secure cookies whenever the connection is (or terminates as) HTTPS.
	cfg.SecureCookies = cfg.TLSEnabled() || cfg.BehindProxy
	if v, ok := envBoolOptional("HLOOL_SECURE_COOKIES"); ok {
		cfg.SecureCookies = v
	}

	if abs, err := filepath.Abs(cfg.DataDir); err == nil {
		cfg.DataDir = abs
	}
	return cfg, nil
}

func defaultDataDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "hlool-pdf")
	}
	return filepath.Join(".", ".hlool-data")
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64)
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}

func envBool(key string, fallback bool) bool {
	if v, ok := envBoolOptional(key); ok {
		return v
	}
	return fallback
}

func envBoolOptional(key string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}

// normalizeSSE validates HLOOL_S3_SSE and resolves the empty (unset) case to a
// provider-aware default: "none" behind a custom endpoint (R2/B2/MinIO encrypt
// at rest themselves), "AES256" on genuine AWS S3.
func normalizeSSE(value string, customEndpoint bool) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		if customEndpoint {
			return "none", nil
		}
		return "AES256", nil
	case "none", "off", "false":
		return "none", nil
	case "aes256", "sse-s3", "s3":
		return "AES256", nil
	case "aws:kms", "kms":
		return "aws:kms", nil
	default:
		return "", fmt.Errorf("HLOOL_S3_SSE must be one of none|AES256|aws:kms (got %q)", value)
	}
}

// checksumWhenSupported maps HLOOL_S3_CHECKSUM to the SDK request-checksum mode.
// The default is "required" (false), which keeps uploads compatible with the
// many S3 implementations that reject the SDK's default aws-chunked/CRC trailer.
func checksumWhenSupported(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "required", "when_required", "when-required":
		return false, nil
	case "supported", "when_supported", "when-supported":
		return true, nil
	default:
		return false, fmt.Errorf("HLOOL_S3_CHECKSUM must be required|supported (got %q)", value)
	}
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}
