package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"hlool-pdf/internal/providers"
)

// adminProviders handles listing all providers.
func (s *Server) adminProviders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	list, err := s.providerStore.List(r.Context(), "")
	if err != nil {
		writeInternalError(w, "list providers", err)
		return
	}

	// Mask secrets before sending to frontend.
	masked := make([]providers.Provider, len(list))
	for i, p := range list {
		masked[i] = providers.MaskSecrets(p)
	}

	writeJSON(w, http.StatusOK, masked)
}

// adminProviderByID handles CRUD operations on a single provider.
func (s *Server) adminProviderByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/admin/providers/")
	if rest != "" {
		writeError(w, http.StatusNotFound, errors.New("provider not found"))
		return
	}

	switch r.Method {
	case http.MethodGet:
		p, err := s.providerStore.Get(r.Context(), id)
		if errors.Is(err, providers.ErrProviderNotFound) {
			writeError(w, http.StatusNotFound, errors.New("provider not found"))
			return
		}
		if err != nil {
			writeInternalError(w, "get provider", err)
			return
		}
		writeJSON(w, http.StatusOK, providers.MaskSecrets(p))

	case http.MethodPut:
		var req providers.Provider
		if err := readJSON(w, r, &req, maxAdminBody); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
			return
		}
		req.ID = id
		// 前端编辑表单只提交改动的字段(不带 kind/name),这里和既有记录合并成完整
		// provider 再落库,否则空 kind 会被校验拒绝、空 publicConfig 会清掉原配置。
		existing, err := s.providerStore.Get(r.Context(), id)
		if errors.Is(err, providers.ErrProviderNotFound) {
			writeError(w, http.StatusNotFound, errors.New("provider not found"))
			return
		}
		if err != nil {
			writeInternalError(w, "get provider", err)
			return
		}
		if req.Kind == "" {
			req.Kind = existing.Kind
		}
		if req.Name == "" {
			req.Name = existing.Name
		}
		if req.BaseURL == "" {
			req.BaseURL = existing.BaseURL
		}
		if req.Model == "" {
			req.Model = existing.Model
		}
		if req.PublicConfig == nil {
			req.PublicConfig = existing.PublicConfig
		}
		if err := providers.ValidateKind(req.Kind); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := s.providerStore.Update(r.Context(), req); err != nil {
			if errors.Is(err, providers.ErrProviderNotFound) {
				writeError(w, http.StatusNotFound, errors.New("provider not found"))
				return
			}
			writeInternalError(w, "update provider", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	case http.MethodDelete:
		if err := s.providerStore.Delete(r.Context(), id); err != nil {
			writeInternalError(w, "delete provider", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})

	default:
		methodNotAllowed(w)
	}
}

// adminProviderCreate handles POST /api/admin/providers to create a new provider.
func (s *Server) adminProviderCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var req providers.Provider
	if err := readJSON(w, r, &req, maxAdminBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}

	if err := providers.ValidateKind(req.Kind); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if req.ID == "" {
		req.ID = providers.GenerateID(req.Kind, req.Name)
	}

	if err := s.providerStore.Create(r.Context(), req); err != nil {
		writeInternalError(w, "create provider", err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": req.ID})
}

// adminProviderTest handles POST /api/admin/providers/:id/test to test a provider connection.
func (s *Server) adminProviderTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/admin/providers/"), "/test")
	p, err := s.providerStore.Get(r.Context(), id)
	if errors.Is(err, providers.ErrProviderNotFound) {
		writeError(w, http.StatusNotFound, errors.New("provider not found"))
		return
	}
	if err != nil {
		writeInternalError(w, "get provider", err)
		return
	}

	switch p.Kind {
	case providers.KindMatting:
		if err := s.testMattingProvider(r.Context(), p); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"success": false,
				"error":   err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
		})

	case providers.KindMail:
		// 只握手 + 认证,不真的发信;测试永远直连真实配置(绕开测试注入的假发信器)。
		client := providers.NewMailClient(
			configString(p.PublicConfig, "host"),
			configString(p.SecretConfig, "username"),
			configString(p.SecretConfig, "password"),
			configString(p.PublicConfig, "from"),
			configInt(p.PublicConfig, "port"),
			configBool(p.PublicConfig, "use_tls"),
		)
		if err := client.TestConnection(); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})

	default:
		writeError(w, http.StatusBadRequest, fmt.Errorf("testing not implemented for kind %s", p.Kind))
	}
}

// testMattingProvider sends a minimal test request to the matting API.
func (s *Server) testMattingProvider(ctx context.Context, p providers.Provider) error {
	token, _ := p.SecretConfig["access_token"].(string)
	if token == "" {
		return errors.New("access_token not configured")
	}

	client := providers.NewMattingClient(p.BaseURL, token, p.Model)

	// Create a 1x1 white PNG as test image.
	testImage := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
		0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
		0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
		0xAE, 0x42, 0x60, 0x82,
	}

	_, err := client.Process(ctx, testImage, providers.MattingConfig{
		Model:          p.Model,
		ResponseFormat: "b64_json",
	})
	return err
}

// aiMatting handles POST /api/ai/matting to process a stamp image.
func (s *Server) aiMatting(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	// Find enabled matting provider.
	list, err := s.providerStore.List(r.Context(), providers.KindMatting)
	if err != nil {
		writeInternalError(w, "list matting providers", err)
		return
	}

	var mattingProvider *providers.Provider
	for i := range list {
		if list[i].Enabled {
			mattingProvider = &list[i]
			break
		}
	}

	if mattingProvider == nil {
		writeCodedError(w, http.StatusServiceUnavailable, "matting_not_configured",
			errors.New("AI matting service is not configured"))
		return
	}

	// Parse multipart form.
	if err := r.ParseMultipartForm(s.opts.MaxStampBytes); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("failed to parse multipart form"))
		return
	}

	file, _, err := r.FormFile("image")
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("image field is required"))
		return
	}
	defer file.Close()

	imageData, err := io.ReadAll(io.LimitReader(file, s.opts.MaxStampBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("failed to read image"))
		return
	}

	// Call matting API.
	token, _ := mattingProvider.SecretConfig["access_token"].(string)
	client := providers.NewMattingClient(mattingProvider.BaseURL, token, mattingProvider.Model)

	result, err := client.Process(r.Context(), imageData, providers.MattingConfig{
		Model:          mattingProvider.Model,
		ResponseFormat: "b64_json",
	})
	if err != nil {
		if errors.Is(err, providers.ErrMattingNotConfigured) {
			writeCodedError(w, http.StatusServiceUnavailable, "matting_not_configured", err)
			return
		}
		writeCodedError(w, http.StatusBadGateway, "matting_failed", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"b64_json": result.ImageBase64,
	})
}
