package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	db, err := OpenDB(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewService(db, Options{SecureCookies: false})
}

func TestRegisterAndLogin(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	user, err := svc.Register(ctx, "1.2.3.4", "alice", "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if len(user.ID) != 32 {
		t.Fatalf("uid should be 32 hex chars, got %q", user.ID)
	}

	// Duplicate (case-insensitive) username is rejected.
	if _, err := svc.Register(ctx, "1.2.3.4", "ALICE", "another password"); err != ErrUsernameTaken {
		t.Fatalf("expected ErrUsernameTaken, got %v", err)
	}

	logged, token, expires, err := svc.Login(ctx, "1.2.3.4", "alice", "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if logged.ID != user.ID || token == "" || !expires.After(time.Now()) {
		t.Fatalf("unexpected login result: %#v %q %v", logged, token, expires)
	}
}

func TestRegisterValidation(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "ab", "longenough123"); err != ErrInvalidUsername {
		t.Fatalf("short username should fail, got %v", err)
	}
	if _, err := svc.Register(ctx, "ip", "validname", "short"); err != ErrWeakPassword {
		t.Fatalf("short password should fail, got %v", err)
	}
}

func TestLoginWrongCredentials(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "bob", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := svc.Login(ctx, "ip", "bob", "wrongpassword"); err != ErrInvalidCredentials {
		t.Fatalf("wrong password should fail, got %v", err)
	}
	// Unknown user also collapses to ErrInvalidCredentials (no enumeration).
	if _, _, _, err := svc.Login(ctx, "ip", "ghost", "whatever12345"); err != ErrInvalidCredentials {
		t.Fatalf("unknown user should fail generically, got %v", err)
	}
}

func TestLoginLockout(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "carol", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, _, _, err := svc.Login(ctx, "10.0.0.1", "carol", "bad"); err != ErrInvalidCredentials {
			t.Fatalf("attempt %d: expected ErrInvalidCredentials, got %v", i, err)
		}
	}
	// Now locked — even the correct password is refused.
	if _, _, _, err := svc.Login(ctx, "10.0.0.1", "carol", "supersecret123"); err != ErrRateLimited {
		t.Fatalf("expected ErrRateLimited after 5 failures, got %v", err)
	}
	// A different IP is not affected.
	if _, _, _, err := svc.Login(ctx, "10.0.0.2", "carol", "supersecret123"); err != nil {
		t.Fatalf("other IP should still log in, got %v", err)
	}
}

func TestSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "dave", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	_, token, _, err := svc.Login(ctx, "ip", "dave", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	if u, err := svc.Authenticate(ctx, req); err != nil || u.Username != "dave" {
		t.Fatalf("authenticate failed: %#v, %v", u, err)
	}

	// Logout revokes the session.
	if err := svc.Logout(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, req); err != ErrSessionInvalid {
		t.Fatalf("session should be revoked after logout, got %v", err)
	}
}

func TestSessionExpiry(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "erin", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	_, token, _, err := svc.Login(ctx, "ip", "erin", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})

	// Jump past the TTL: the session must no longer authenticate.
	svc.now = func() time.Time { return time.Now().Add(sessionTTL + time.Hour) }
	if _, err := svc.Authenticate(ctx, req); err != ErrSessionInvalid {
		t.Fatalf("expired session should be invalid, got %v", err)
	}
}

func TestGuestSessionAndUpgrade(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	guest, token, expires, err := svc.CreateGuest(ctx, "1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	if !guest.IsGuest || len(guest.ID) != 32 {
		t.Fatalf("unexpected guest: %#v", guest)
	}
	// Guest sessions live GuestTTL, not the full sessionTTL.
	if d := time.Until(expires); d > GuestTTL+time.Minute || d < GuestTTL-time.Minute {
		t.Fatalf("guest session ttl = %v, want ~%v", d, GuestTTL)
	}
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	if u, err := svc.Authenticate(ctx, req); err != nil || !u.IsGuest || u.ID != guest.ID {
		t.Fatalf("guest authenticate failed: %#v, %v", u, err)
	}

	// Upgrade in place: same id, no longer a guest, real credentials work.
	upgraded, err := svc.UpgradeGuest(ctx, "1.2.3.4", guest.ID, "alice", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	if upgraded.ID != guest.ID || upgraded.IsGuest || upgraded.Username != "alice" {
		t.Fatalf("upgrade kept wrong state: %#v", upgraded)
	}
	if u, _, _, err := svc.Login(ctx, "1.2.3.4", "alice", "supersecret123"); err != nil || u.ID != guest.ID {
		t.Fatalf("login after upgrade failed: %#v, %v", u, err)
	}
	// Upgrading again (now a real account) is rejected.
	if _, err := svc.UpgradeGuest(ctx, "1.2.3.4", guest.ID, "alice2", "supersecret123"); err != ErrNotGuest {
		t.Fatalf("re-upgrade should fail with ErrNotGuest, got %v", err)
	}
}

func TestUpgradeGuestUsernameTaken(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "taken", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	guest, _, _, err := svc.CreateGuest(ctx, "ip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpgradeGuest(ctx, "ip", guest.ID, "taken", "supersecret123"); err != ErrUsernameTaken {
		t.Fatalf("expected ErrUsernameTaken, got %v", err)
	}
	// The guest is untouched and still upgradeable to a free name.
	if _, err := svc.UpgradeGuest(ctx, "ip", guest.ID, "free", "supersecret123"); err != nil {
		t.Fatalf("guest should still be upgradeable, got %v", err)
	}
}

func TestExpiredGuestSweep(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	guest, token, _, err := svc.CreateGuest(ctx, "ip")
	if err != nil {
		t.Fatal(err)
	}
	real, err := svc.Register(ctx, "ip", "realuser", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}

	// A guest younger than the cutoff (the sweep uses now-GuestTTL) is not listed.
	if ids, err := svc.db.ExpiredGuestIDs(ctx, time.Now().Add(-time.Hour)); err != nil || len(ids) != 0 {
		t.Fatalf("fresh guest should not be expired: %#v, %v", ids, err)
	}
	// Past the guest cutoff, the guest (and only the guest) is listed.
	ids, err := svc.db.ExpiredGuestIDs(ctx, time.Now().Add(GuestTTL+time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != guest.ID {
		t.Fatalf("expected only the guest id, got %#v (real=%s)", ids, real.ID)
	}

	// Deleting the guest cascades its session away; the real account survives.
	if err := svc.db.DeleteUser(ctx, guest.ID); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	if _, err := svc.Authenticate(ctx, req); err != ErrSessionInvalid {
		t.Fatalf("deleted guest session should be invalid, got %v", err)
	}
	if _, err := svc.db.UserByID(ctx, real.ID); err != nil {
		t.Fatalf("real account must survive the sweep, got %v", err)
	}
}

func TestRequireAuthMiddleware(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.Register(ctx, "ip", "frank", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	_, token, _, _ := svc.Login(ctx, "ip", "frank", "supersecret123")

	handler := svc.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFrom(r.Context())
		if !ok {
			t.Fatal("user must be in context")
		}
		_, _ = w.Write([]byte(u.Username))
	}))

	// No cookie → 401.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/stamps", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Valid cookie → handler runs.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/stamps", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "frank" {
		t.Fatalf("expected authed handler, got %d %q", rec.Code, rec.Body.String())
	}
}

func TestLoginOrRegisterExternal(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// First login provisions a fresh federated account plus a session.
	ident := ExternalIdentity{Provider: "Google", Subject: "sub-123", DisplayName: "Alice Example"}
	user, token, expires, err := svc.LoginOrRegisterExternal(ctx, ident)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID == "" || user.IsGuest || token == "" || !expires.After(time.Now()) {
		t.Fatalf("unexpected first federated login: %#v %q %v", user, token, expires)
	}

	// The same identity (provider is matched case-insensitively) maps back to the
	// same account, but mints a brand-new session token each time.
	again, token2, _, err := svc.LoginOrRegisterExternal(ctx, ExternalIdentity{Provider: "google", Subject: "sub-123"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != user.ID {
		t.Fatalf("same identity must reuse the account: %s vs %s", again.ID, user.ID)
	}
	if token2 == token {
		t.Fatal("each login should issue a fresh session token")
	}

	// The minted session authenticates like any password session.
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token2})
	if u, err := svc.Authenticate(ctx, req); err != nil || u.ID != user.ID {
		t.Fatalf("federated session should authenticate: %#v %v", u, err)
	}

	// A different identity with the SAME display name gets a distinct account and
	// a de-duplicated username.
	other, _, _, err := svc.LoginOrRegisterExternal(ctx, ExternalIdentity{Provider: "github", Subject: "gh-9", DisplayName: "Alice Example"})
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == user.ID || other.Username == user.Username {
		t.Fatalf("distinct identities must yield distinct account+username, got %#v vs %#v", other, user)
	}

	// A federated-only account cannot be logged into with a password.
	if _, _, _, err := svc.Login(ctx, "1.2.3.4", user.Username, "any-password-123"); err != ErrInvalidCredentials {
		t.Fatalf("federated account must reject password login, got %v", err)
	}

	// Missing provider/subject is rejected up front.
	if _, _, _, err := svc.LoginOrRegisterExternal(ctx, ExternalIdentity{Subject: "x"}); err != ErrInvalidExternalIdentity {
		t.Fatalf("empty provider should fail, got %v", err)
	}
}

func TestRegisterWithInvitePolicy(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	settings := AuthSettings{RegisterEnabled: true, InviteRequired: true, ThirdPartyRegisterEnabled: true}

	if _, err := svc.RegisterWithPolicy(ctx, "ip", "invitee", "supersecret123", "", settings); err != ErrRegistrationInviteRequired {
		t.Fatalf("missing invite should fail, got %v", err)
	}

	created, err := svc.CreateRegistrationInvites(ctx, "batch", 1, 1, time.Time{}, "admin-id")
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || created[0].Code == "" {
		t.Fatalf("unexpected created invite: %#v", created)
	}
	user, err := svc.RegisterWithPolicy(ctx, "ip", "invitee", "supersecret123", created[0].Code, settings)
	if err != nil {
		t.Fatalf("register with invite failed: %v", err)
	}
	if user.Username != "invitee" {
		t.Fatalf("unexpected user: %#v", user)
	}
	if _, err := svc.RegisterWithPolicy(ctx, "ip", "second", "supersecret123", created[0].Code, settings); err != ErrRegistrationInviteUsed {
		t.Fatalf("one-use invite should be consumed, got %v", err)
	}
}

func TestAuthSettingsAndAdminBootstrap(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	defaults := AuthSettings{RegisterEnabled: true, GuestEnabled: true}

	initial, err := svc.AuthSettings(ctx, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if !initial.RegisterEnabled || !initial.GuestEnabled || initial.InviteRequired {
		t.Fatalf("defaults not applied: %#v", initial)
	}

	next := AuthSettings{RegisterEnabled: false, InviteRequired: true, ThirdPartyRegisterEnabled: false, GuestEnabled: false}
	if err := svc.PutAuthSettings(ctx, next); err != nil {
		t.Fatal(err)
	}
	loaded, err := svc.AuthSettings(ctx, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != next {
		t.Fatalf("settings round trip = %#v, want %#v", loaded, next)
	}

	admin, created, err := svc.EnsureAdmin(ctx, "root", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	if !created || !admin.IsAdmin {
		t.Fatalf("expected created admin, got %#v created=%v", admin, created)
	}
	logged, _, _, err := svc.Login(ctx, "ip", "root", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	if !logged.IsAdmin {
		t.Fatalf("login should preserve admin flag: %#v", logged)
	}
}

func TestExternalRegistrationPolicy(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	ident := ExternalIdentity{Provider: "oidc", Subject: "sub-1", DisplayName: "OIDC User"}

	closed := AuthSettings{RegisterEnabled: false, ThirdPartyRegisterEnabled: true}
	if _, _, _, err := svc.LoginOrRegisterExternalWithPolicy(ctx, ident, closed); err != ErrRegistrationClosed {
		t.Fatalf("global registration off should block new external users, got %v", err)
	}
	thirdPartyOff := AuthSettings{RegisterEnabled: true, ThirdPartyRegisterEnabled: false}
	if _, _, _, err := svc.LoginOrRegisterExternalWithPolicy(ctx, ident, thirdPartyOff); err != ErrRegistrationClosed {
		t.Fatalf("third-party registration off should block new external users, got %v", err)
	}

	created, err := svc.CreateRegistrationInvites(ctx, "oauth", 1, 1, time.Time{}, "admin-id")
	if err != nil {
		t.Fatal(err)
	}
	withInvite := AuthSettings{RegisterEnabled: true, InviteRequired: true, ThirdPartyRegisterEnabled: true}
	user, token, _, err := svc.LoginOrRegisterExternalWithPolicy(ctx, ExternalIdentity{
		Provider:    ident.Provider,
		Subject:     ident.Subject,
		DisplayName: ident.DisplayName,
		InviteCode:  created[0].Code,
	}, withInvite)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID == "" || token == "" {
		t.Fatalf("unexpected external login: %#v token=%q", user, token)
	}
	// Existing external identity can still sign in after new third-party
	// provisioning is closed.
	again, _, _, err := svc.LoginOrRegisterExternalWithPolicy(ctx, ident, thirdPartyOff)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != user.ID {
		t.Fatalf("existing identity should reuse user: %#v vs %#v", again, user)
	}
}
