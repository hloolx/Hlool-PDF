package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"hlool-pdf/internal/auth"
)

const maxAdminBody = 64 << 10

type inviteView struct {
	ID        int64   `json:"id"`
	Code      string  `json:"code,omitempty"`
	CodeHint  string  `json:"codeHint"`
	Name      string  `json:"name"`
	MaxUses   int     `json:"maxUses"`
	UsedCount int     `json:"usedCount"`
	ExpiresAt *string `json:"expiresAt,omitempty"`
	Disabled  bool    `json:"disabled"`
	CreatedAt string  `json:"createdAt"`
	UsedAt    *string `json:"usedAt,omitempty"`
	Status    string  `json:"status"`
}

func (s *Server) adminSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.authSettings(r)
		if err != nil {
			writeInternalError(w, "admin settings", err)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var settings auth.AuthSettings
		if err := readJSON(w, r, &settings, maxAdminBody); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		if err := s.auth.PutAuthSettings(r.Context(), settings); err != nil {
			writeInternalError(w, "put admin settings", err)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) adminInvites(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		invites, err := s.auth.ListRegistrationInvites(r.Context(), 200)
		if err != nil {
			writeInternalError(w, "list invites", err)
			return
		}
		out := make([]inviteView, 0, len(invites))
		now := time.Now()
		for _, invite := range invites {
			out = append(out, toInviteView(invite, "", now))
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodPost:
		var req struct {
			Name          string `json:"name"`
			Count         int    `json:"count"`
			MaxUses       int    `json:"maxUses"`
			ExpiresInDays int    `json:"expiresInDays"`
		}
		if err := readJSON(w, r, &req, maxAdminBody); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		var expiresAt time.Time
		if req.ExpiresInDays > 0 {
			if req.ExpiresInDays > 3650 {
				writeError(w, http.StatusBadRequest, errors.New("invite expiration is too far in the future"))
				return
			}
			expiresAt = time.Now().Add(time.Duration(req.ExpiresInDays) * 24 * time.Hour).UTC()
		}
		user, _ := auth.UserFrom(r.Context())
		created, err := s.auth.CreateRegistrationInvites(r.Context(), req.Name, req.Count, req.MaxUses, expiresAt, user.ID)
		if err != nil {
			writeInternalError(w, "create invites", err)
			return
		}
		out := make([]inviteView, 0, len(created))
		now := time.Now()
		for _, item := range created {
			out = append(out, toInviteView(item.Invite, item.Code, now))
		}
		writeJSON(w, http.StatusCreated, out)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) adminInviteByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/admin/invites/")
	if rest != "" {
		writeError(w, http.StatusNotFound, errors.New("invite not found"))
		return
	}
	inviteID, err := strconv.ParseInt(strings.TrimSpace(id), 10, 64)
	if err != nil || inviteID <= 0 {
		writeError(w, http.StatusNotFound, errors.New("invite not found"))
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req struct {
			Disabled bool `json:"disabled"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAdminBody)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		if err := s.auth.SetRegistrationInviteDisabled(r.Context(), inviteID, req.Disabled); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusNotFound, errors.New("invite not found"))
				return
			}
			writeInternalError(w, "update invite", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case http.MethodDelete:
		if err := s.auth.DeleteRegistrationInvite(r.Context(), inviteID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusNotFound, errors.New("invite not found"))
				return
			}
			writeInternalError(w, "delete invite", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		methodNotAllowed(w)
	}
}

func toInviteView(invite auth.RegistrationInvite, code string, now time.Time) inviteView {
	view := inviteView{
		ID:        invite.ID,
		Code:      code,
		CodeHint:  invite.CodeHint,
		Name:      invite.Name,
		MaxUses:   invite.MaxUses,
		UsedCount: invite.UsedCount,
		Disabled:  invite.Disabled,
		CreatedAt: invite.CreatedAt.Format(time.RFC3339),
		Status:    inviteStatus(invite, now),
	}
	if !invite.ExpiresAt.IsZero() {
		value := invite.ExpiresAt.Format(time.RFC3339)
		view.ExpiresAt = &value
	}
	if !invite.UsedAt.IsZero() {
		value := invite.UsedAt.Format(time.RFC3339)
		view.UsedAt = &value
	}
	return view
}

func inviteStatus(invite auth.RegistrationInvite, now time.Time) string {
	switch {
	case invite.Disabled:
		return "disabled"
	case !invite.ExpiresAt.IsZero() && !invite.ExpiresAt.After(now):
		return "expired"
	case invite.UsedCount >= invite.MaxUses:
		return "used"
	default:
		return "active"
	}
}
