package auth

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newCodeService(t *testing.T) *Service {
	t.Helper()
	db, err := OpenDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewService(db, Options{})
}

func TestEmailLoginCodeSingleUse(t *testing.T) {
	svc := newCodeService(t)
	ctx := context.Background()
	if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "hash-1", "1.2.3.4", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "hash-1", 5); err != nil || !ok {
		t.Fatalf("first consume = (%v, %v), want (true, nil)", ok, err)
	}
	// 单次有效:同一验证码不可重放。
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "hash-1", 5); err != nil || ok {
		t.Fatalf("replay consume = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestEmailLoginCodeWrongHashExhaustsAttempts(t *testing.T) {
	svc := newCodeService(t)
	ctx := context.Background()
	if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "right", "1.2.3.4", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "wrong", 5); err != nil || ok {
			t.Fatalf("wrong attempt %d = (%v, %v), want (false, nil)", i+1, ok, err)
		}
	}
	// 错满 5 次后,正确哈希也必须作废。
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "right", 5); err != nil || ok {
		t.Fatalf("exhausted consume = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestEmailLoginCodeExpiry(t *testing.T) {
	svc := newCodeService(t)
	ctx := context.Background()
	// 负 TTL 造出一条已过期的验证码。
	if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "hash-1", "1.2.3.4", -time.Second); err != nil {
		t.Fatal(err)
	}
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "hash-1", 5); err != nil || ok {
		t.Fatalf("expired consume = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestEmailLoginCodeLatestWins(t *testing.T) {
	svc := newCodeService(t)
	ctx := context.Background()
	if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "old", "1.2.3.4", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "new", "1.2.3.4", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	// 只认最新一条:旧验证码天然作废。
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "old", 5); err != nil || ok {
		t.Fatalf("old code consume = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := svc.ConsumeEmailLoginCode(ctx, "a@b.com", "new", 5); err != nil || !ok {
		t.Fatalf("new code consume = (%v, %v), want (true, nil)", ok, err)
	}
}

func TestCountRecentEmailLoginCodes(t *testing.T) {
	svc := newCodeService(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := svc.StoreEmailLoginCode(ctx, "a@b.com", "h", "1.1.1.1", 10*time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, err := svc.StoreEmailLoginCode(ctx, "c@d.com", "h", "1.1.1.1", 10*time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	// 按邮箱匹配。
	if n, err := svc.CountRecentEmailLoginCodes(ctx, "a@b.com", "9.9.9.9", 15*time.Minute); err != nil || n != 3 {
		t.Fatalf("count by email = (%d, %v), want 3", n, err)
	}
	// 按 IP 匹配(跨邮箱累计,防止换邮箱刷)。
	if n, err := svc.CountRecentEmailLoginCodes(ctx, "x@y.com", "1.1.1.1", 15*time.Minute); err != nil || n != 5 {
		t.Fatalf("count by ip = (%d, %v), want 5", n, err)
	}
	if n, err := svc.CountRecentEmailLoginCodes(ctx, "x@y.com", "9.9.9.9", 15*time.Minute); err != nil || n != 0 {
		t.Fatalf("count unrelated = (%d, %v), want 0", n, err)
	}
}
