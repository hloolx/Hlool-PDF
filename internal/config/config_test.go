package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	for _, k := range s3EnvKeys {
		t.Setenv(k, "")
	}
	t.Setenv("HLOOL_ADDR", "")
	t.Setenv("HLOOL_DATA_DIR", "")
	t.Setenv("HLOOL_TLS_CERT", "")
	t.Setenv("HLOOL_TLS_KEY", "")
	t.Setenv("HLOOL_BEHIND_PROXY", "")
	t.Setenv("HLOOL_SECURE_COOKIES", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:8088" {
		t.Fatalf("default addr = %q", cfg.Addr)
	}
	if cfg.UseS3() {
		t.Fatal("S3 must be off without a bucket")
	}
	if cfg.SecureCookies {
		t.Fatal("secure cookies should be off without TLS/proxy by default")
	}
	if cfg.MaxProcessBodyBytes <= 0 || cfg.MaxStampBytes <= 0 {
		t.Fatal("body size limits must be positive")
	}
}

func TestLoadSelectsS3(t *testing.T) {
	t.Setenv("HLOOL_S3_BUCKET", "my-bucket")
	t.Setenv("HLOOL_S3_REGION", "us-east-1")
	t.Setenv("HLOOL_S3_PREFIX", "/team/")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.UseS3() {
		t.Fatal("S3 should be selected when a bucket is set")
	}
	if cfg.S3.Prefix != "team" {
		t.Fatalf("prefix should be trimmed of slashes, got %q", cfg.S3.Prefix)
	}
}

func TestLoadS3RequiresRegionOrEndpoint(t *testing.T) {
	t.Setenv("HLOOL_S3_BUCKET", "my-bucket")
	t.Setenv("HLOOL_S3_REGION", "")
	t.Setenv("HLOOL_S3_ENDPOINT", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when bucket is set without region/endpoint")
	}
}

func TestLoadTLSPairValidation(t *testing.T) {
	t.Setenv("HLOOL_TLS_CERT", "/tmp/cert.pem")
	t.Setenv("HLOOL_TLS_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when only one of cert/key is set")
	}
}

func TestLoadSecureCookiesWithProxy(t *testing.T) {
	t.Setenv("HLOOL_S3_BUCKET", "")
	t.Setenv("HLOOL_BEHIND_PROXY", "1")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SecureCookies {
		t.Fatal("secure cookies should be on behind a proxy")
	}
}

var s3EnvKeys = []string{
	"HLOOL_S3_BUCKET", "HLOOL_S3_REGION", "HLOOL_S3_ENDPOINT",
	"HLOOL_S3_PREFIX", "HLOOL_S3_FORCE_PATH_STYLE",
	"HLOOL_S3_SSE", "HLOOL_S3_KMS_KEY_ID", "HLOOL_S3_CHECKSUM",
}

func TestLoadS3SSEDefaults(t *testing.T) {
	for _, k := range s3EnvKeys {
		t.Setenv(k, "")
	}
	// Genuine AWS (no custom endpoint): default to SSE-S3.
	t.Setenv("HLOOL_S3_BUCKET", "my-bucket")
	t.Setenv("HLOOL_S3_REGION", "us-east-1")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.S3.SSE != "AES256" {
		t.Fatalf("AWS default SSE = %q, want AES256", cfg.S3.SSE)
	}
	if cfg.S3.ChecksumWhenSupported {
		t.Fatal("checksums must default to when-required for portability")
	}

	// Custom endpoint (R2/MinIO/B2): SSE header off by default, region auto.
	t.Setenv("HLOOL_S3_REGION", "")
	t.Setenv("HLOOL_S3_ENDPOINT", "https://accountid.r2.cloudflarestorage.com")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.S3.SSE != "none" {
		t.Fatalf("custom-endpoint default SSE = %q, want none", cfg.S3.SSE)
	}
	if cfg.S3.Region != "auto" {
		t.Fatalf("custom-endpoint region fallback = %q, want auto", cfg.S3.Region)
	}
}

func TestLoadS3SSEOverrides(t *testing.T) {
	for _, k := range s3EnvKeys {
		t.Setenv(k, "")
	}
	t.Setenv("HLOOL_S3_BUCKET", "my-bucket")
	t.Setenv("HLOOL_S3_REGION", "us-east-1")
	t.Setenv("HLOOL_S3_SSE", "aws:kms")
	t.Setenv("HLOOL_S3_KMS_KEY_ID", "key-123")
	t.Setenv("HLOOL_S3_CHECKSUM", "supported")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.S3.SSE != "aws:kms" || cfg.S3.KMSKeyID != "key-123" {
		t.Fatalf("kms config not honoured: %+v", cfg.S3)
	}
	if !cfg.S3.ChecksumWhenSupported {
		t.Fatal("HLOOL_S3_CHECKSUM=supported should enable SDK checksums")
	}

	t.Setenv("HLOOL_S3_SSE", "bogus")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for invalid HLOOL_S3_SSE")
	}
}
