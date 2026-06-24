package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"hlool-pdf/internal/library"
)

const maxSettingsBody = 1 << 20 // 1 MiB of user settings is plenty

type libraryView struct {
	Version int             `json:"version"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (s *Server) settings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		lib, err := s.lib.GetLibrary(r.Context(), uid(r))
		if err != nil {
			writeInternalError(w, "get library", err)
			return
		}
		writeJSON(w, http.StatusOK, libraryView{Version: lib.Version, Data: lib.Data})
	case http.MethodPut:
		var body libraryView
		if err := readJSON(w, r, &body, maxSettingsBody); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		stored, err := s.lib.PutLibrary(r.Context(), uid(r), library.Library{Version: body.Version, Data: body.Data})
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, libraryView{Version: stored.Version, Data: stored.Data})
		case errors.Is(err, library.ErrVersionConflict):
			// Return the current document so the client can reconcile and retry.
			current, _ := s.lib.GetLibrary(r.Context(), uid(r))
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":   "settings were modified elsewhere",
				"code":    "version_conflict",
				"version": current.Version,
				"data":    current.Data,
			})
		default:
			writeInternalError(w, "put library", err)
		}
	default:
		methodNotAllowed(w)
	}
}
