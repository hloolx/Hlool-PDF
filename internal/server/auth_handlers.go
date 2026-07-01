package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"hlool-pdf/internal/auth"
)

const maxAuthBody = 8 << 10

type credentials struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	InviteCode string `json:"inviteCode"`
}

type userView struct {
	Username string `json:"username"`
	IsGuest  bool   `json:"isGuest"`
	IsAdmin  bool   `json:"isAdmin"`
}

// newUserView builds the client-facing view of a user. A guest's synthetic
// username embeds its uid, so it is never sent to the client.
func newUserView(u auth.User) userView {
	if u.IsGuest {
		return userView{IsGuest: true}
	}
	return userView{Username: u.Username, IsAdmin: u.IsAdmin}
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var c credentials
	if err := readJSON(w, r, &c, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	settings, err := s.authSettings(r)
	if err != nil {
		writeInternalError(w, "auth settings", err)
		return
	}
	// A caller who is currently a guest upgrades that account in place: the uid
	// is kept, so the guest's library (stamps + settings) carries over instead
	// of being stranded under a throwaway account.
	if current, err := s.auth.Authenticate(r.Context(), r); err == nil && current.IsGuest {
		user, err := s.auth.UpgradeGuestWithPolicy(r.Context(), s.clientIP(r), current.ID, c.Username, c.Password, c.InviteCode, settings)
		s.writeRegisterResult(w, "register-claim", user, err)
		return
	}
	user, err := s.auth.RegisterWithPolicy(r.Context(), s.clientIP(r), c.Username, c.Password, c.InviteCode, settings)
	s.writeRegisterResult(w, "register", user, err)
}

// writeRegisterResult maps a Register/UpgradeGuest outcome to an HTTP response.
func (s *Server) writeRegisterResult(w http.ResponseWriter, op string, user auth.User, err error) {
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, newUserView(user))
	case errors.Is(err, auth.ErrUsernameTaken):
		writeError(w, http.StatusConflict, errors.New("该用户名已被注册"))
	case errors.Is(err, auth.ErrRegistrationClosed):
		writeError(w, http.StatusForbidden, err)
	case isRegistrationInviteError(err):
		writeError(w, http.StatusBadRequest, err)
	case errors.Is(err, auth.ErrInvalidUsername), errors.Is(err, auth.ErrWeakPassword):
		writeError(w, http.StatusBadRequest, err)
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, err)
	default:
		writeInternalError(w, op, err)
	}
}

func isRegistrationInviteError(err error) bool {
	return errors.Is(err, auth.ErrRegistrationInviteRequired) ||
		errors.Is(err, auth.ErrRegistrationInviteInvalid) ||
		errors.Is(err, auth.ErrRegistrationInviteDisabled) ||
		errors.Is(err, auth.ErrRegistrationInviteUsed) ||
		errors.Is(err, auth.ErrRegistrationInviteExpired) ||
		errors.Is(err, auth.ErrRegistrationInviteUnavailable)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var c credentials
	if err := readJSON(w, r, &c, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	user, token, expires, err := s.auth.Login(r.Context(), s.clientIP(r), c.Username, c.Password)
	switch {
	case err == nil:
		s.auth.SetSessionCookie(w, token, expires)
		writeJSON(w, http.StatusOK, newUserView(user))
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeError(w, http.StatusUnauthorized, err)
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, err)
	default:
		writeInternalError(w, "login", err)
	}
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	_ = s.auth.Logout(r.Context(), r)
	s.auth.ClearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// guest mints a temporary anonymous session so a first-time visitor can use the
// app with zero friction. It is idempotent: an existing valid session (guest or
// real) is returned as-is rather than minting a duplicate guest.
func (s *Server) guest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	settings, err := s.authSettings(r)
	if err != nil {
		writeInternalError(w, "auth settings", err)
		return
	}
	if !settings.GuestEnabled {
		writeError(w, http.StatusForbidden, errors.New("guest access is disabled"))
		return
	}
	if user, err := s.auth.Authenticate(r.Context(), r); err == nil {
		writeJSON(w, http.StatusOK, newUserView(user))
		return
	}
	user, token, expires, err := s.auth.CreateGuest(r.Context(), s.clientIP(r))
	switch {
	case err == nil:
		s.auth.SetSessionCookie(w, token, expires)
		writeJSON(w, http.StatusOK, newUserView(user))
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, err)
	default:
		writeInternalError(w, "guest", err)
	}
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	user, err := s.auth.Authenticate(r.Context(), r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("authentication required"))
		return
	}
	writeJSON(w, http.StatusOK, newUserView(user))
}

func (s *Server) authConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	settings, err := s.authSettings(r)
	if err != nil {
		writeInternalError(w, "auth config", err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return json.NewDecoder(r.Body).Decode(dst)
}
