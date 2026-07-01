package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Errors surfaced to the HTTP layer. Login failures collapse to
// ErrInvalidCredentials to avoid leaking which usernames exist.
var (
	ErrInvalidUsername    = errors.New("username must be 3-64 characters (letters, digits, . _ - @)")
	ErrWeakPassword       = errors.New("password must be at least 8 characters")
	ErrInvalidCredentials = errors.New("incorrect username or password")
	ErrRateLimited        = errors.New("too many attempts, please try again later")
	// ErrInvalidExternalIdentity is returned when a third-party login hands over
	// an identity with no provider or subject.
	ErrInvalidExternalIdentity = errors.New("external identity is missing a provider or subject")
)

const (
	// SessionCookieName is the name of the session cookie.
	SessionCookieName = "hlool_session"
	sessionTTL        = 30 * 24 * time.Hour
	// GuestTTL is how long a guest account — its session and its library —
	// lives before the background sweep purges it. Guests are the temporary,
	// "burn after a day" identity; registering upgrades them to a real account.
	GuestTTL = 24 * time.Hour
	// guestUsernamePrefix marks the synthetic username of a guest. It contains a
	// ':' which usernamePattern forbids, so no registered account can collide
	// with (or impersonate) a guest's namespace.
	guestUsernamePrefix = "guest:"
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._@-]{3,64}$`)

// Service implements registration, login, logout and session authentication.
type Service struct {
	db              *DB
	loginLimiter    *limiter
	registerLimiter *limiter
	guestLimiter    *limiter
	secureCookies   bool
	dummyHash       string
	now             func() time.Time
}

// Options configures the Service.
type Options struct {
	SecureCookies bool
}

// NewService creates an auth Service over the given database.
func NewService(db *DB, opts Options) *Service {
	// A throwaway hash so login verifies in ~constant time even for unknown
	// users (defeats username enumeration via timing).
	dummy, _ := hashPassword("hlool-dummy-password")
	return &Service{
		db:              db,
		loginLimiter:    newLimiter(5, 15*time.Minute, 15*time.Minute),
		registerLimiter: newLimiter(10, time.Hour, time.Hour),
		// Guest creation is the default first-visit path (one call per new
		// browser), so it is far more permissive than register, with a short
		// cooldown — empty guests are cheap and swept after GuestTTL.
		guestLimiter:  newLimiter(60, 10*time.Minute, 10*time.Minute),
		secureCookies: opts.SecureCookies,
		dummyHash:     dummy,
		now:           time.Now,
	}
}

// validateCredentials trims and checks a username/password pair, returning the
// normalized username. Shared by Register and UpgradeGuest.
func validateCredentials(username, password string) (string, error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", ErrInvalidUsername
	}
	if len(password) < 8 || len(password) > 1024 {
		return "", ErrWeakPassword
	}
	return username, nil
}

// Register validates input, hashes the password and creates the account.
func (s *Service) Register(ctx context.Context, ip, username, password string) (User, error) {
	return s.register(ctx, ip, username, password, "", false)
}

// RegisterWithPolicy applies runtime registration settings, including invite
// requirements, before creating a password account.
func (s *Service) RegisterWithPolicy(ctx context.Context, ip, username, password, inviteCode string, settings AuthSettings) (User, error) {
	if !settings.RegisterEnabled {
		return User{}, ErrRegistrationClosed
	}
	return s.register(ctx, ip, username, password, inviteCode, settings.InviteRequired)
}

func (s *Service) register(ctx context.Context, ip, username, password, inviteCode string, requireInvite bool) (User, error) {
	if locked, _ := s.registerLimiter.locked(ip); locked {
		return User{}, ErrRateLimited
	}
	s.registerLimiter.fail(ip) // count every attempt to cap account-creation rate
	username, err := validateCredentials(username, password)
	if err != nil {
		return User{}, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return User{}, err
	}
	user := User{
		ID:           newUID(),
		Username:     username,
		PasswordHash: hash,
		CreatedAt:    s.now().UTC(),
	}
	if requireInvite {
		err = s.db.CreateUserWithInvite(ctx, user, inviteCode, s.now().UTC())
	} else {
		err = s.db.CreateUser(ctx, user)
	}
	if err != nil {
		return User{}, err
	}
	return user, nil
}

// CreateGuest mints a temporary guest account plus its session, returning the
// raw session token and its expiry (GuestTTL from now). ip caps guest creation
// rate. The guest's library lives under its uid exactly like a real account's,
// and is purged together with the account by the background sweep after
// GuestTTL — unless the guest upgrades first (see UpgradeGuest).
func (s *Service) CreateGuest(ctx context.Context, ip string) (User, string, time.Time, error) {
	if locked, _ := s.guestLimiter.locked(ip); locked {
		return User{}, "", time.Time{}, ErrRateLimited
	}
	s.guestLimiter.fail(ip)

	uid := newUID()
	now := s.now().UTC()
	user := User{
		ID:        uid,
		Username:  guestUsernamePrefix + uid,
		CreatedAt: now,
		IsGuest:   true,
	}
	if err := s.db.CreateUser(ctx, user); err != nil {
		return User{}, "", time.Time{}, err
	}

	rawToken, expires, err := s.issueSession(ctx, uid, GuestTTL)
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	return user, rawToken, expires, nil
}

// UpgradeGuest turns the guest with id uid into a registered account in place,
// keeping the uid so its library carries over. The caller should issue a fresh
// (full-length) session afterwards. Returns ErrNotGuest if uid is not an
// upgradeable guest, or ErrUsernameTaken on a duplicate username.
func (s *Service) UpgradeGuest(ctx context.Context, ip, uid, username, password string) (User, error) {
	return s.upgradeGuest(ctx, ip, uid, username, password, "", false)
}

// UpgradeGuestWithPolicy turns a guest into a real account while applying the
// same registration gates as password sign-up.
func (s *Service) UpgradeGuestWithPolicy(ctx context.Context, ip, uid, username, password, inviteCode string, settings AuthSettings) (User, error) {
	if !settings.RegisterEnabled {
		return User{}, ErrRegistrationClosed
	}
	return s.upgradeGuest(ctx, ip, uid, username, password, inviteCode, settings.InviteRequired)
}

func (s *Service) upgradeGuest(ctx context.Context, ip, uid, username, password, inviteCode string, requireInvite bool) (User, error) {
	if locked, _ := s.registerLimiter.locked(ip); locked {
		return User{}, ErrRateLimited
	}
	s.registerLimiter.fail(ip)
	username, err := validateCredentials(username, password)
	if err != nil {
		return User{}, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return User{}, err
	}
	if requireInvite {
		err = s.db.UpgradeGuestWithInvite(ctx, uid, username, hash, inviteCode, s.now().UTC())
	} else {
		err = s.db.UpgradeGuest(ctx, uid, username, hash)
	}
	if err != nil {
		return User{}, err
	}
	return s.db.UserByID(ctx, uid)
}

// Login verifies credentials and, on success, creates a session and returns the
// raw token and its expiry. ip is used for rate limiting / lockout.
func (s *Service) Login(ctx context.Context, ip, username, password string) (User, string, time.Time, error) {
	username = strings.TrimSpace(username)
	key := ip + "|" + strings.ToLower(username)
	if locked, _ := s.loginLimiter.locked(key); locked {
		return User{}, "", time.Time{}, ErrRateLimited
	}

	user, err := s.db.UserByUsername(ctx, username)
	if errors.Is(err, ErrUserNotFound) {
		_, _ = verifyPassword(password, s.dummyHash) // equalize timing
		s.loginLimiter.fail(key)
		return User{}, "", time.Time{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	ok, err := verifyPassword(password, user.PasswordHash)
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	if !ok {
		s.loginLimiter.fail(key)
		return User{}, "", time.Time{}, ErrInvalidCredentials
	}
	s.loginLimiter.reset(key)

	rawToken, expires, err := s.issueSession(ctx, user.ID, sessionTTL)
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	return user, rawToken, expires, nil
}

// issueSession mints a fresh session for userID and returns the raw token and
// its expiry. Login, guest creation and federated login all funnel through here,
// so session policy (token generation, hashing, TTL) lives in exactly one place.
func (s *Service) issueSession(ctx context.Context, userID string, ttl time.Duration) (string, time.Time, error) {
	rawToken, err := newToken()
	if err != nil {
		return "", time.Time{}, err
	}
	now := s.now()
	expires := now.Add(ttl)
	if err := s.db.CreateSession(ctx, hashToken(rawToken), userID, now, expires); err != nil {
		return "", time.Time{}, err
	}
	return rawToken, expires, nil
}

// ExternalIdentity is the normalized result of a third-party login provider
// (OIDC / OAuth2 / SAML / …). Provider+Subject is the stable federated key;
// DisplayName seeds the local username on first login (it is sanitized and
// de-duplicated — never trusted verbatim). Email is advisory only for now.
type ExternalIdentity struct {
	Provider    string
	Subject     string
	DisplayName string
	Email       string
	InviteCode  string
}

// LoginOrRegisterExternal is the reusable seam for pluggable third-party login.
// A provider-specific handler verifies its token however it likes (Google OIDC,
// GitHub OAuth, corporate SAML, …) and hands over the resolved identity; this
// maps it to a local account — provisioning one on first sight — and issues a
// normal session. Federated users therefore share the exact same session
// machinery (cookie, expiry, revocation, sweeps) as password users, so the rest
// of the app needs no special-casing. Returns the user, a raw token and expiry.
func (s *Service) LoginOrRegisterExternal(ctx context.Context, ident ExternalIdentity) (User, string, time.Time, error) {
	return s.LoginOrRegisterExternalWithPolicy(ctx, ident, AuthSettings{RegisterEnabled: true, ThirdPartyRegisterEnabled: true})
}

// LoginOrRegisterExternalWithPolicy gates first-time federated provisioning.
// Already-linked identities may still log in even when new third-party
// registration is closed.
func (s *Service) LoginOrRegisterExternalWithPolicy(ctx context.Context, ident ExternalIdentity, settings AuthSettings) (User, string, time.Time, error) {
	provider := strings.ToLower(strings.TrimSpace(ident.Provider))
	subject := strings.TrimSpace(ident.Subject)
	if provider == "" || subject == "" {
		return User{}, "", time.Time{}, ErrInvalidExternalIdentity
	}

	user, err := s.db.UserByIdentity(ctx, provider, subject)
	if errors.Is(err, ErrIdentityNotFound) {
		if !settings.RegisterEnabled {
			return User{}, "", time.Time{}, ErrRegistrationClosed
		}
		if !settings.ThirdPartyRegisterEnabled {
			return User{}, "", time.Time{}, ErrRegistrationClosed
		}
		user, err = s.provisionExternalUser(ctx, provider, subject, ident.DisplayName, ident.InviteCode, settings.InviteRequired)
	}
	if err != nil {
		return User{}, "", time.Time{}, err
	}

	token, expires, err := s.issueSession(ctx, user.ID, sessionTTL)
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	return user, token, expires, nil
}

func (s *Service) EnsureAdmin(ctx context.Context, username, password string) (User, bool, error) {
	username, err := validateCredentials(username, password)
	if err != nil {
		return User{}, false, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return User{}, false, err
	}
	user := User{
		ID:           newUID(),
		Username:     username,
		PasswordHash: hash,
		CreatedAt:    s.now().UTC(),
		IsAdmin:      true,
	}
	return s.db.UpsertAdmin(ctx, user)
}

func (s *Service) AuthSettings(ctx context.Context, defaults AuthSettings) (AuthSettings, error) {
	return s.db.AuthSettings(ctx, defaults)
}

func (s *Service) PutAuthSettings(ctx context.Context, settings AuthSettings) error {
	return s.db.PutAuthSettings(ctx, settings)
}

func (s *Service) CreateRegistrationInvites(ctx context.Context, name string, count, maxUses int, expiresAt time.Time, createdBy string) ([]CreatedInvite, error) {
	return s.db.CreateRegistrationInvites(ctx, name, count, maxUses, expiresAt, createdBy)
}

func (s *Service) ListRegistrationInvites(ctx context.Context, limit int) ([]RegistrationInvite, error) {
	return s.db.ListRegistrationInvites(ctx, limit)
}

func (s *Service) SetRegistrationInviteDisabled(ctx context.Context, id int64, disabled bool) error {
	return s.db.SetRegistrationInviteDisabled(ctx, id, disabled)
}

func (s *Service) DeleteRegistrationInvite(ctx context.Context, id int64) error {
	return s.db.DeleteRegistrationInvite(ctx, id)
}

// provisionExternalUser creates a local, federated-only account for a first-seen
// identity, retrying on the rare generated-username collision. The account gets
// an unusable random password hash so it can never be password-logged-into until
// the user explicitly sets one, yet still flows through the constant-time verify
// path. A request that loses a race to create the same identity adopts the
// winner's account instead of failing.
func (s *Service) provisionExternalUser(ctx context.Context, provider, subject, displayName, inviteCode string, requireInvite bool) (User, error) {
	hash, err := unusablePasswordHash()
	if err != nil {
		return User{}, err
	}
	base := sanitizeExternalName(displayName)
	for attempt := 0; attempt < 6; attempt++ {
		username, err := externalUsername(base, attempt)
		if err != nil {
			return User{}, err
		}
		user := User{
			ID:           newUID(),
			Username:     username,
			PasswordHash: hash,
			CreatedAt:    s.now().UTC(),
		}
		if requireInvite {
			err = s.db.CreateUserWithIdentityAndInvite(ctx, user, provider, subject, inviteCode, s.now().UTC())
		} else {
			err = s.db.CreateUserWithIdentity(ctx, user, provider, subject)
		}
		switch {
		case err == nil:
			return user, nil
		case errors.Is(err, ErrIdentityLinked):
			// Another concurrent login already created this identity; adopt it.
			return s.db.UserByIdentity(ctx, provider, subject)
		case errors.Is(err, ErrUsernameTaken):
			continue // collision on the generated name; try a different suffix
		default:
			return User{}, err
		}
	}
	return User{}, ErrUsernameTaken
}

// Authenticate resolves the user for a request's session cookie.
func (s *Service) Authenticate(ctx context.Context, r *http.Request) (User, error) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || cookie.Value == "" {
		return User{}, ErrSessionInvalid
	}
	return s.db.SessionUser(ctx, hashToken(cookie.Value), s.now())
}

// Logout revokes the session named by the request's cookie (no-op if absent).
func (s *Service) Logout(ctx context.Context, r *http.Request) error {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || cookie.Value == "" {
		return nil
	}
	return s.db.DeleteSession(ctx, hashToken(cookie.Value))
}

// SetSessionCookie writes the session cookie after a login or guest creation.
// MaxAge tracks the session's own expiry, so guest cookies live GuestTTL while
// login cookies live the full sessionTTL.
func (s *Service) SetSessionCookie(w http.ResponseWriter, rawToken string, expires time.Time) {
	maxAge := int(expires.Sub(s.now()).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    rawToken,
		Path:     "/",
		Expires:  expires,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteStrictMode,
	})
}

// ClearSessionCookie expires the session cookie on logout.
func (s *Service) ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCookies,
		SameSite: http.SameSiteStrictMode,
	})
}

func newUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func newToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// sanitizeExternalName reduces a provider-supplied display name to the username
// charset, clamped in length. It returns "" when nothing usable remains, in
// which case externalUsername falls back to a generated name.
func sanitizeExternalName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-', r == '@':
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), ".-_@")
	if len(out) > 48 {
		out = out[:48]
	}
	return out
}

// externalUsername proposes a username for a federated account: the sanitized
// base on the first attempt, then base + random suffix to dodge collisions. A
// base too short to be a valid username falls back to "user-<random>".
func externalUsername(base string, attempt int) (string, error) {
	if attempt == 0 && len(base) >= 3 {
		return base, nil
	}
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	if len(base) < 3 {
		base = "user"
	}
	return base + "-" + suffix, nil
}

// randomSuffix returns a short random hex token used to de-duplicate usernames.
func randomSuffix() (string, error) {
	var b [3]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// unusablePasswordHash hashes random bytes nobody holds, producing a valid
// Argon2id hash that no password can satisfy. Federated-only accounts use it so
// password login fails closed (in constant time) without a special code path.
func unusablePasswordHash() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hashPassword(base64.RawURLEncoding.EncodeToString(b[:]))
}
