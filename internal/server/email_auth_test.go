package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/library"
	"hlool-pdf/internal/providers"
)

/* ---------------- 邮箱验证码登录 ---------------- */

// fakeMailSender 记录发出的验证码,测试用它拿到明文验证码。
type fakeMailSender struct {
	to    string
	codes []string
	fail  bool
}

func (f *fakeMailSender) SendVerificationCode(to, code string) error {
	if f.fail {
		return context.DeadlineExceeded
	}
	f.to = to
	f.codes = append(f.codes, code)
	return nil
}

// newEmailHarness 搭一套带 provider store 与假发信器的服务端。
func newEmailHarness(t *testing.T, withMailProvider bool) (http.Handler, *fakeMailSender) {
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
	store, err := providers.NewStore(db.DB(), "test-encryption-secret")
	if err != nil {
		t.Fatal(err)
	}
	if withMailProvider {
		err := store.Create(context.Background(), providers.Provider{
			ID:      "mail_test",
			Kind:    providers.KindMail,
			Name:    "test-smtp",
			Enabled: true,
			PublicConfig: map[string]interface{}{
				"host": "smtp.example.com", "port": float64(465), "from": "noreply@example.com", "use_tls": true,
			},
			SecretConfig: map[string]interface{}{"username": "noreply@example.com", "password": "secret"},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sender := &fakeMailSender{}
	srv := New(auth.NewService(db, auth.Options{}), lib, store, nil, Options{})
	srv.newMailSender = func(providers.Provider) mailSender { return sender }
	return srv.Handler(), sender
}

func postJSONBody(t *testing.T, handler http.Handler, target, body string) *jsonResponse {
	t.Helper()
	rec := doRequest(t, handler, http.MethodPost, target, body)
	return rec
}

type jsonResponse struct {
	status  int
	body    map[string]any
	cookies []*http.Cookie
}

func doRequest(t *testing.T, handler http.Handler, method, target, body string) *jsonResponse {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
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

func TestEmailSendCodeDisabledWithoutProvider(t *testing.T) {
	handler, _ := newEmailHarness(t, false)
	res := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"user@example.com"}`)
	if res.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.status)
	}
	if res.body["code"] != "email_login_disabled" {
		t.Fatalf("code = %v, want email_login_disabled", res.body["code"])
	}
}

func TestEmailLoginFlow(t *testing.T) {
	handler, sender := newEmailHarness(t, true)

	res := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"User@Example.com"}`)
	if res.status != http.StatusOK {
		t.Fatalf("send-code status = %d, body = %v", res.status, res.body)
	}
	if sender.to != "user@example.com" {
		t.Fatalf("mail sent to %q, want normalized user@example.com", sender.to)
	}
	if len(sender.codes) != 1 || len(sender.codes[0]) != emailCodeLength {
		t.Fatalf("unexpected codes: %v", sender.codes)
	}

	verify := postJSONBody(t, handler, "/auth/email/verify",
		`{"email":"user@example.com","code":"`+sender.codes[0]+`"}`)
	if verify.status != http.StatusOK {
		t.Fatalf("verify status = %d, body = %v", verify.status, verify.body)
	}
	if name, _ := verify.body["username"].(string); name == "" {
		t.Fatalf("expected username in response, got %v", verify.body)
	}
	sessionSet := false
	for _, c := range verify.cookies {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			sessionSet = true
		}
	}
	if !sessionSet {
		t.Fatal("expected session cookie after verify")
	}

	// 验证码单次有效:重放同一验证码必须被拒。
	replay := postJSONBody(t, handler, "/auth/email/verify",
		`{"email":"user@example.com","code":"`+sender.codes[0]+`"}`)
	if replay.status != http.StatusUnauthorized {
		t.Fatalf("replay status = %d, want 401", replay.status)
	}

	// 同一邮箱再次登录复用同一账号(第三方身份幂等)。
	res2 := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"user@example.com"}`)
	if res2.status != http.StatusOK {
		t.Fatalf("second send-code status = %d", res2.status)
	}
	verify2 := postJSONBody(t, handler, "/auth/email/verify",
		`{"email":"user@example.com","code":"`+sender.codes[1]+`"}`)
	if verify2.status != http.StatusOK {
		t.Fatalf("second verify status = %d, body = %v", verify2.status, verify2.body)
	}
	if verify.body["username"] != verify2.body["username"] {
		t.Fatalf("same email should map to same account: %v vs %v", verify.body["username"], verify2.body["username"])
	}
}

func TestEmailVerifyWrongCodeExhaustsAttempts(t *testing.T) {
	handler, sender := newEmailHarness(t, true)
	if res := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"user@example.com"}`); res.status != http.StatusOK {
		t.Fatalf("send-code status = %d", res.status)
	}
	right := sender.codes[0]
	wrong := "000000"
	if wrong == right {
		wrong = "000001"
	}
	for i := 0; i < emailCodeMaxAttempts; i++ {
		res := postJSONBody(t, handler, "/auth/email/verify", `{"email":"user@example.com","code":"`+wrong+`"}`)
		if res.status != http.StatusUnauthorized {
			t.Fatalf("wrong code attempt %d status = %d, want 401", i+1, res.status)
		}
	}
	// 错满 5 次后,即使提交正确验证码也必须作废。
	res := postJSONBody(t, handler, "/auth/email/verify", `{"email":"user@example.com","code":"`+right+`"}`)
	if res.status != http.StatusUnauthorized {
		t.Fatalf("exhausted code status = %d, want 401", res.status)
	}
}

func TestEmailSendCodeRateLimited(t *testing.T) {
	handler, _ := newEmailHarness(t, true)
	for i := 0; i < emailRateMaxSends; i++ {
		res := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"user@example.com"}`)
		if res.status != http.StatusOK {
			t.Fatalf("send %d status = %d", i+1, res.status)
		}
	}
	res := postJSONBody(t, handler, "/auth/email/send-code", `{"email":"user@example.com"}`)
	if res.status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", res.status)
	}
}

/* ---------------- /auth/config 扩展字段 ---------------- */

func TestAuthConfigReportsLoginMethods(t *testing.T) {
	// 未配置任何 provider:两个字段都是关闭态。
	handler, _ := newEmailHarness(t, false)
	res := doRequest(t, handler, http.MethodGet, "/auth/config", "")
	if res.status != http.StatusOK {
		t.Fatalf("status = %d", res.status)
	}
	if res.body["emailLoginEnabled"] != false {
		t.Fatalf("emailLoginEnabled = %v, want false", res.body["emailLoginEnabled"])
	}
	if list, ok := res.body["oauthProviders"].([]any); !ok || len(list) != 0 {
		t.Fatalf("oauthProviders = %v, want []", res.body["oauthProviders"])
	}

	// 配好 SMTP 后 emailLoginEnabled 翻真。
	handler2, _ := newEmailHarness(t, true)
	res2 := doRequest(t, handler2, http.MethodGet, "/auth/config", "")
	if res2.body["emailLoginEnabled"] != true {
		t.Fatalf("emailLoginEnabled = %v, want true", res2.body["emailLoginEnabled"])
	}
	// 原有字段不能丢。
	for _, key := range []string{"registerEnabled", "inviteRequired", "thirdPartyRegisterEnabled", "guestEnabled"} {
		if _, ok := res2.body[key]; !ok {
			t.Fatalf("missing legacy field %q in /auth/config", key)
		}
	}
}

func TestAuthConfigListsConfiguredOAuth(t *testing.T) {
	db, err := auth.OpenDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	lib, err := library.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store, err := providers.NewStore(db.DB(), "test-encryption-secret")
	if err != nil {
		t.Fatal(err)
	}
	err = store.Create(context.Background(), providers.Provider{
		ID: "oauth_github", Kind: providers.KindOAuth, Name: "github", Enabled: true,
		PublicConfig: map[string]interface{}{"client_id": "abc"},
		SecretConfig: map[string]interface{}{"client_secret": "def"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// 凭据不全的不算配置好。
	err = store.Create(context.Background(), providers.Provider{
		ID: "oauth_google", Kind: providers.KindOAuth, Name: "google", Enabled: true,
		PublicConfig: map[string]interface{}{"client_id": "abc"},
		SecretConfig: map[string]interface{}{},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := New(auth.NewService(db, auth.Options{}), lib, store, nil, Options{}).Handler()

	res := doRequest(t, handler, http.MethodGet, "/auth/config", "")
	list, ok := res.body["oauthProviders"].([]any)
	if !ok || len(list) != 1 || list[0] != "github" {
		t.Fatalf("oauthProviders = %v, want [github]", res.body["oauthProviders"])
	}

	// 未配置的提供方发起登录:302 回登录页并带 authError,而不是 500/JSON。
	res2 := doRequest(t, handler, http.MethodGet, "/auth/oauth/google", "")
	if res2.status != http.StatusFound {
		t.Fatalf("unconfigured oauth start status = %d, want 302", res2.status)
	}
}
