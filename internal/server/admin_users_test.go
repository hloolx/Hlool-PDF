package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/library"
)

/* ---------------- harness with an admin ---------------- */

type adminHarness struct {
	handler    http.Handler
	auth       *auth.Service
	lib        library.Store
	adminToken string
	adminID    string
	userToken  string
	userID     string
}

func newAdminHarness(t *testing.T, opts Options) *adminHarness {
	t.Helper()
	ctx := context.Background()
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
	srv := New(authSvc, lib, nil, nil, opts)

	admin, _, err := authSvc.EnsureAdmin(ctx, "boss", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	_, adminToken, _, err := authSvc.Login(ctx, "test", "boss", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	user, err := authSvc.Register(ctx, "test", "alice", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	_, userToken, _, err := authSvc.Login(ctx, "test", "alice", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	return &adminHarness{
		handler:    srv.Handler(),
		auth:       authSvc,
		lib:        lib,
		adminToken: adminToken,
		adminID:    admin.ID,
		userToken:  userToken,
		userID:     user.ID,
	}
}

func (h *adminHarness) doAs(t *testing.T, token, method, target, contentType string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token})
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

func (h *adminHarness) uploadStamp(t *testing.T, token string) {
	t.Helper()
	body, contentType := buildMultipart(t, []filePart{{field: "file", filename: "seal.png", content: makePNG(t, 12, 12)}}, nil)
	if rec := h.doAs(t, token, http.MethodPost, "/api/stamps", contentType, body); rec.Code != http.StatusCreated {
		t.Fatalf("upload stamp = %d, body %s", rec.Code, rec.Body.String())
	}
}

/* ---------------- /api/admin/users ---------------- */

func TestAdminUserListAndUsage(t *testing.T) {
	h := newAdminHarness(t, Options{})

	// 普通用户禁入。
	if rec := h.doAs(t, h.userToken, http.MethodGet, "/api/admin/users", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin list users = %d, want 403", rec.Code)
	}

	h.uploadStamp(t, h.userToken)
	rec := h.doAs(t, h.adminToken, http.MethodGet, "/api/admin/users", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list users = %d, body %s", rec.Code, rec.Body.String())
	}
	var views []adminUserView
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil {
		t.Fatal(err)
	}
	if len(views) != 2 {
		t.Fatalf("expected 2 users, got %d", len(views))
	}
	byID := map[string]adminUserView{}
	for _, v := range views {
		byID[v.ID] = v
	}
	if v := byID[h.userID]; v.StampCount != 1 || v.LibraryBytes <= 0 {
		t.Fatalf("alice usage = %+v, want 1 stamp with bytes", v)
	}
	if v := byID[h.adminID]; !v.IsAdmin || v.StampCount != 0 {
		t.Fatalf("admin row = %+v", v)
	}
}

func TestAdminResetPasswordRevokesSessions(t *testing.T) {
	h := newAdminHarness(t, Options{})
	ctx := context.Background()

	// 弱密码被拒。
	rec := h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/"+h.userID+"/reset-password",
		"application/json", strings.NewReader(`{"password":"short"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("weak password = %d, want 400", rec.Code)
	}
	// 不能在这里重置自己的密码。
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/"+h.adminID+"/reset-password",
		"application/json", strings.NewReader(`{"password":"anothersecret123"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("self reset = %d, want 400", rec.Code)
	}
	// 未知用户 404。
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/ffffffffffffffffffffffffffffffff/reset-password",
		"application/json", strings.NewReader(`{"password":"anothersecret123"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown user reset = %d, want 404", rec.Code)
	}

	// 正常重置:旧会话失效、旧密码失效、新密码可登录。
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/"+h.userID+"/reset-password",
		"application/json", strings.NewReader(`{"password":"brandnewsecret456"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("reset = %d, body %s", rec.Code, rec.Body.String())
	}
	if rec := h.doAs(t, h.userToken, http.MethodGet, "/api/stamps", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("old session after reset = %d, want 401", rec.Code)
	}
	if _, _, _, err := h.auth.Login(ctx, "test2", "alice", "supersecret123"); err == nil {
		t.Fatal("old password should no longer log in")
	}
	if _, _, _, err := h.auth.Login(ctx, "test2", "alice", "brandnewsecret456"); err != nil {
		t.Fatalf("new password login: %v", err)
	}
}

func TestAdminDeleteUserBurnsLibrary(t *testing.T) {
	h := newAdminHarness(t, Options{})
	ctx := context.Background()
	h.uploadStamp(t, h.userToken)

	// 不能删除自己。
	if rec := h.doAs(t, h.adminToken, http.MethodDelete, "/api/admin/users/"+h.adminID, "", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("self delete = %d, want 400", rec.Code)
	}
	rec := h.doAs(t, h.adminToken, http.MethodDelete, "/api/admin/users/"+h.userID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete user = %d, body %s", rec.Code, rec.Body.String())
	}
	if _, err := h.auth.UserByID(ctx, h.userID); !errors.Is(err, auth.ErrUserNotFound) {
		t.Fatalf("user row after delete: %v", err)
	}
	if metas, err := h.lib.ListStamps(ctx, h.userID); err != nil || len(metas) != 0 {
		t.Fatalf("library after delete: %d stamps, err %v", len(metas), err)
	}
	if rec := h.doAs(t, h.userToken, http.MethodGet, "/api/stamps", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("session after delete = %d, want 401", rec.Code)
	}
}

func TestAdminGuestCleanup(t *testing.T) {
	h := newAdminHarness(t, Options{AllowGuest: true})

	rec := h.doAs(t, "", http.MethodPost, "/auth/guest", "", nil)
	if rec.Code/100 != 2 {
		t.Fatalf("create guest = %d, body %s", rec.Code, rec.Body.String())
	}
	guestToken := ""
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			guestToken = c.Value
		}
	}
	if guestToken == "" {
		t.Fatal("guest should receive a session cookie")
	}
	h.uploadStamp(t, guestToken)

	// 游客没有密码可重置。
	var guestID string
	{
		list := h.doAs(t, h.adminToken, http.MethodGet, "/api/admin/users", "", nil)
		var views []adminUserView
		if err := json.Unmarshal(list.Body.Bytes(), &views); err != nil {
			t.Fatal(err)
		}
		for _, v := range views {
			if v.IsGuest {
				guestID = v.ID
			}
		}
	}
	if guestID == "" {
		t.Fatal("guest not listed")
	}
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/"+guestID+"/reset-password",
		"application/json", strings.NewReader(`{"password":"whatever12345"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("guest reset = %d, want 400", rec.Code)
	}

	// 默认只清过期游客:刚创建的游客不受影响。
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/cleanup-guests",
		"application/json", strings.NewReader(`{"all":false}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("cleanup expired = %d, body %s", rec.Code, rec.Body.String())
	}
	var result map[string]int
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if result["burned"] != 0 {
		t.Fatalf("expired cleanup burned %d, want 0", result["burned"])
	}

	// all=true 连活跃游客一起焚毁。
	rec = h.doAs(t, h.adminToken, http.MethodPost, "/api/admin/users/cleanup-guests",
		"application/json", strings.NewReader(`{"all":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("cleanup all = %d, body %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if result["burned"] != 1 {
		t.Fatalf("cleanup all burned %d, want 1", result["burned"])
	}
	if metas, err := h.lib.ListStamps(context.Background(), guestID); err != nil || len(metas) != 0 {
		t.Fatalf("guest library after cleanup: %d stamps, err %v", len(metas), err)
	}
	if rec := h.doAs(t, guestToken, http.MethodGet, "/api/stamps", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("guest session after cleanup = %d, want 401", rec.Code)
	}
}

/* ---------------- caching headers ---------------- */

func TestStaticAssetCaching(t *testing.T) {
	db, err := auth.OpenDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	lib, err := library.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	webFS := fstest.MapFS{
		"index.html":           {Data: []byte("<html>app</html>")},
		"assets/app-abc123.js": {Data: []byte("console.log('x')")},
	}
	handler := New(auth.NewService(db, auth.Options{}), lib, nil, webFS, Options{}).Handler()

	get := func(target, inm string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// 带哈希的 assets 永久缓存。
	rec := get("/assets/app-abc123.js", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("asset = %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("asset Cache-Control = %q, want immutable", cc)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("asset should carry an ETag")
	}

	// index.html 协商缓存:no-cache + ETag,条件请求命中 304。
	rec = get("/", "")
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("index Cache-Control = %q, want no-cache", cc)
	}
	indexTag := rec.Header().Get("ETag")
	if indexTag == "" {
		t.Fatal("index should carry an ETag")
	}
	if rec = get("/", indexTag); rec.Code != http.StatusNotModified {
		t.Fatalf("conditional index = %d, want 304", rec.Code)
	}
}

func TestStampContentETagAndQuota(t *testing.T) {
	h := newAdminHarness(t, Options{})
	h.uploadStamp(t, h.userToken)

	list := h.doAs(t, h.userToken, http.MethodGet, "/api/stamps", "", nil)
	var stamps []stampView
	if err := json.Unmarshal(list.Body.Bytes(), &stamps); err != nil {
		t.Fatal(err)
	}
	if len(stamps) != 1 || stamps[0].Size <= 0 {
		t.Fatalf("stamp list = %+v, want one stamp with size", stamps)
	}

	content := h.doAs(t, h.userToken, http.MethodGet, stamps[0].URL, "", nil)
	if content.Code != http.StatusOK {
		t.Fatalf("stamp content = %d", content.Code)
	}
	if cc := content.Header().Get("Cache-Control"); !strings.Contains(cc, "private") {
		t.Fatalf("stamp Cache-Control = %q, want private", cc)
	}
	etag := content.Header().Get("ETag")
	if etag == "" {
		t.Fatal("stamp content should carry an ETag")
	}
	req := httptest.NewRequest(http.MethodGet, stamps[0].URL, nil)
	req.Header.Set("If-None-Match", etag)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: h.userToken})
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("conditional stamp content = %d, want 304", rec.Code)
	}

	quota := h.doAs(t, h.userToken, http.MethodGet, "/api/stamps/quota", "", nil)
	if quota.Code != http.StatusOK {
		t.Fatalf("quota = %d, body %s", quota.Code, quota.Body.String())
	}
	var q struct {
		StampCount      int   `json:"stampCount"`
		LibraryBytes    int64 `json:"libraryBytes"`
		MaxStamps       int   `json:"maxStamps"`
		MaxLibraryBytes int64 `json:"maxLibraryBytes"`
	}
	if err := json.Unmarshal(quota.Body.Bytes(), &q); err != nil {
		t.Fatal(err)
	}
	if q.StampCount != 1 || q.LibraryBytes != stamps[0].Size || q.MaxStamps != 200 || q.MaxLibraryBytes != 200<<20 {
		t.Fatalf("quota = %+v", q)
	}
}
