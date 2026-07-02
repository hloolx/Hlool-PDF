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
)

// newInstallHarness 搭一套「还没有管理员」的服务端(可选配置远程初始化令牌)。
func newInstallHarness(t *testing.T, setupToken string) (http.Handler, *auth.Service) {
	t.Helper()
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
	srv := New(authSvc, lib, nil, nil, Options{SetupToken: setupToken})
	return srv.Handler(), authSvc
}

func installRequest(t *testing.T, handler http.Handler, remoteAddr, body string) *jsonResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/auth/install", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	out := &jsonResponse{status: rec.Code, cookies: rec.Result().Cookies()}
	if rec.Body.Len() > 0 {
		var decoded map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err == nil {
			out.body = decoded
		}
	}
	return out
}

func TestAuthConfigReportsNeedsInstall(t *testing.T) {
	handler, authSvc := newInstallHarness(t, "")

	res := doRequest(t, handler, http.MethodGet, "/auth/config", "")
	if res.body["needsInstall"] != true {
		t.Fatalf("needsInstall = %v, want true", res.body["needsInstall"])
	}

	// 建出管理员后翻 false,且缓存生效。
	if _, _, err := authSvc.EnsureAdmin(context.Background(), "boss", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	res2 := doRequest(t, handler, http.MethodGet, "/auth/config", "")
	if res2.body["needsInstall"] != false {
		t.Fatalf("after admin, needsInstall = %v, want false", res2.body["needsInstall"])
	}
}

func TestInstallFromLoopbackWithoutToken(t *testing.T) {
	handler, authSvc := newInstallHarness(t, "SOME-TOKEN")

	res := installRequest(t, handler, "127.0.0.1:5555",
		`{"username":"boss","password":"supersecret123","guestEnabled":true,"registerEnabled":false}`)
	if res.status != http.StatusCreated {
		t.Fatalf("install status = %d, body = %v", res.status, res.body)
	}
	if res.body["isAdmin"] != true {
		t.Fatalf("expected admin user view, got %v", res.body)
	}
	var hasSession bool
	for _, c := range res.cookies {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			hasSession = true
		}
	}
	if !hasSession {
		t.Fatal("expected session cookie after install")
	}

	// 访问开关按向导写入。
	settings, err := authSvc.AuthSettings(context.Background(), auth.AuthSettings{})
	if err != nil {
		t.Fatal(err)
	}
	if !settings.GuestEnabled || settings.RegisterEnabled {
		t.Fatalf("settings = %+v, want guest on / register off", settings)
	}

	// 二次初始化被拒。
	res2 := installRequest(t, handler, "127.0.0.1:5555",
		`{"username":"boss2","password":"supersecret123"}`)
	if res2.status != http.StatusConflict {
		t.Fatalf("second install status = %d, want 409", res2.status)
	}
}

func TestInstallRemoteRequiresToken(t *testing.T) {
	handler, _ := newInstallHarness(t, "GOOD-TOKEN")

	// 远程 + 无/错令牌 → 403
	res := installRequest(t, handler, "203.0.113.9:4444",
		`{"username":"boss","password":"supersecret123","token":"WRONG"}`)
	if res.status != http.StatusForbidden {
		t.Fatalf("wrong token status = %d, want 403", res.status)
	}

	// 远程 + 正确令牌 → 放行
	res2 := installRequest(t, handler, "203.0.113.9:4444",
		`{"username":"boss","password":"supersecret123","token":"GOOD-TOKEN"}`)
	if res2.status != http.StatusCreated {
		t.Fatalf("good token status = %d, body = %v", res2.status, res2.body)
	}
}

func TestInstallRemoteBlockedWithoutConfiguredToken(t *testing.T) {
	// 没配令牌(理论上不会发生,防御默认):远程一律拒绝。
	handler, _ := newInstallHarness(t, "")
	res := installRequest(t, handler, "203.0.113.9:4444",
		`{"username":"boss","password":"supersecret123","token":""}`)
	if res.status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.status)
	}
}

func TestInstallValidatesCredentials(t *testing.T) {
	handler, _ := newInstallHarness(t, "")
	res := installRequest(t, handler, "127.0.0.1:5555", `{"username":"boss","password":"short"}`)
	if res.status != http.StatusBadRequest {
		t.Fatalf("weak password status = %d, want 400", res.status)
	}
}
