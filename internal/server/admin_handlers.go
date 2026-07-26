package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
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

/* ---------------- user management ---------------- */

type adminUserView struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	IsGuest      bool   `json:"isGuest"`
	IsAdmin      bool   `json:"isAdmin"`
	CreatedAt    string `json:"createdAt"`
	StampCount   int    `json:"stampCount"`
	LibraryBytes int64  `json:"libraryBytes"`
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	users, err := s.auth.ListUsers(r.Context(), 1000)
	if err != nil {
		writeInternalError(w, "list users", err)
		return
	}
	views := make([]adminUserView, 0, len(users))
	for _, u := range users {
		view := adminUserView{
			ID:        u.ID,
			Username:  u.Username,
			IsGuest:   u.IsGuest,
			IsAdmin:   u.IsAdmin,
			CreatedAt: u.CreatedAt.Format(time.RFC3339),
		}
		// 库用量按用户逐个统计;单个用户读不出来只记日志显示 0,不拖垮整页。
		if metas, err := s.lib.ListStamps(r.Context(), u.ID); err == nil {
			view.StampCount = len(metas)
			for _, m := range metas {
				view.LibraryBytes += m.Size
			}
		} else {
			log.Printf("admin users: list stamps for %s: %v", u.ID, err)
		}
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) adminUserByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/admin/users/")
	requester, _ := auth.UserFrom(r.Context())
	target, err := s.auth.UserByID(r.Context(), id)
	if errors.Is(err, auth.ErrUserNotFound) {
		writeError(w, http.StatusNotFound, errors.New("user not found"))
		return
	}
	if err != nil {
		writeInternalError(w, "load user", err)
		return
	}
	switch {
	case rest == "" && r.Method == http.MethodDelete:
		if target.ID == requester.ID {
			writeError(w, http.StatusBadRequest, errors.New("cannot delete your own account"))
			return
		}
		// 与游客清扫同序:先焚库再删账号,库删失败时保留账号行以便重试,
		// 绝不留下无主的印章数据。
		if err := s.lib.PurgeUser(r.Context(), target.ID); err != nil {
			writeInternalError(w, "purge user library", err)
			return
		}
		if err := s.auth.DeleteUserAccount(r.Context(), target.ID); err != nil {
			writeInternalError(w, "delete user", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	case rest == "reset-password" && r.Method == http.MethodPost:
		if target.ID == requester.ID {
			writeError(w, http.StatusBadRequest, errors.New("cannot reset your own password here"))
			return
		}
		if target.IsGuest {
			writeError(w, http.StatusBadRequest, errors.New("guest accounts have no password"))
			return
		}
		var body struct {
			Password string `json:"password"`
		}
		if err := readJSON(w, r, &body, maxAdminBody); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		if err := s.auth.AdminResetPassword(r.Context(), target.ID, body.Password); err != nil {
			if errors.Is(err, auth.ErrWeakPassword) {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeInternalError(w, "reset password", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	default:
		methodNotAllowed(w)
	}
}

// adminGuestCleanup 立即清理游客。默认只清过期游客(与后台清扫同款);
// all=true 时连活跃游客一起焚毁,用于处置滥用。
func (s *Server) adminGuestCleanup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		All bool `json:"all"`
	}
	if err := readJSON(w, r, &body, maxAdminBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	cutoff := time.Now().Add(-auth.GuestTTL)
	if body.All {
		cutoff = time.Now()
	}
	ids, err := s.auth.GuestIDs(r.Context(), cutoff)
	if err != nil {
		writeInternalError(w, "list guests", err)
		return
	}
	burned, failed := 0, 0
	for _, id := range ids {
		if err := s.lib.PurgeUser(r.Context(), id); err != nil {
			log.Printf("guest cleanup: purge library %s: %v", id, err)
			failed++
			continue
		}
		if err := s.auth.DeleteUserAccount(r.Context(), id); err != nil {
			log.Printf("guest cleanup: delete account %s: %v", id, err)
			failed++
			continue
		}
		burned++
	}
	writeJSON(w, http.StatusOK, map[string]int{"burned": burned, "failed": failed})
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
