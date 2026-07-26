package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/library"
	"hlool-pdf/internal/providers"
)

// /auth/register 成功即签发会话 cookie(「注册并登录」),前端不再需要补一次
// /auth/login。
func TestRegisterIssuesSessionCookie(t *testing.T) {
	h := newHarness(t)
	rec := h.do(t, http.MethodPost, "/auth/register", "application/json",
		strings.NewReader(`{"username":"newbie","password":"supersecret123"}`), false)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register = %d, body %s", rec.Code, rec.Body.String())
	}
	session := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			session = c.Value
		}
	}
	if session == "" {
		t.Fatal("register should set a session cookie")
	}
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: session})
	me := httptest.NewRecorder()
	h.handler.ServeHTTP(me, req)
	if me.Code != http.StatusOK {
		t.Fatalf("me with register cookie = %d, want 200", me.Code)
	}
}

// POST /api/admin/providers/{id}/test 必须真的有路由(修复前 adminProviderByID 把
// 一切子路径 404 掉,测试连接按钮永远失败)。未配置 token 的 matting provider 应
// 返回 200 + success:false,而不是 404。
func TestProviderTestRouteReachable(t *testing.T) {
	db, err := auth.OpenDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	lib, err := library.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	authSvc := auth.NewService(db, auth.Options{})
	store, err := providers.NewStore(db.DB(), "test-encryption-secret")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(authSvc, lib, store, nil, Options{}).Handler()

	if _, _, err := authSvc.EnsureAdmin(context.Background(), "admin", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	_, token, _, err := authSvc.Login(context.Background(), "test", "admin", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Create(context.Background(), providers.Provider{
		ID: "matting_test", Kind: providers.KindMatting, Name: "test", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/providers/matting_test/test", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("provider test route = %d, body %s, want 200", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if success, ok := body["success"].(bool); !ok || success {
		t.Fatalf("expected success=false for unconfigured matting provider, got %v", body)
	}
}
