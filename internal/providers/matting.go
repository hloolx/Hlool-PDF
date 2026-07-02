package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// MattingClient calls the Gitee AI matting API.
type MattingClient struct {
	baseURL     string
	accessToken string
	model       string
	httpClient  *http.Client
}

// MattingConfig holds the settings for a matting API call.
type MattingConfig struct {
	Model          string // e.g. "RMBG-2.0"
	ResponseFormat string // "b64_json" or "url"
}

// MattingResult is the processed image.
type MattingResult struct {
	ImageBase64 string // populated when ResponseFormat is "b64_json"
	ImageURL    string // populated when ResponseFormat is "url"
}

var (
	ErrMattingNotConfigured = errors.New("matting service not configured")
	ErrMattingFailed        = errors.New("matting request failed")
)

// NewMattingClient creates a client for the Gitee AI matting API.
func NewMattingClient(baseURL, accessToken, model string) *MattingClient {
	if baseURL == "" {
		baseURL = "https://ai.gitee.com/v1"
	}
	if model == "" {
		model = "RMBG-2.0"
	}
	return &MattingClient{
		baseURL:     strings.TrimSuffix(baseURL, "/"),
		accessToken: accessToken,
		model:       model,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Process sends an image to the matting API and returns the result.
func (c *MattingClient) Process(ctx context.Context, imageData []byte, config MattingConfig) (MattingResult, error) {
	if c.accessToken == "" {
		return MattingResult{}, ErrMattingNotConfigured
	}

	if config.Model == "" {
		config.Model = c.model
	}
	if config.ResponseFormat == "" {
		config.ResponseFormat = "b64_json"
	}

	// Build multipart form.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	if err := w.WriteField("model", config.Model); err != nil {
		return MattingResult{}, err
	}
	if err := w.WriteField("response_format", config.ResponseFormat); err != nil {
		return MattingResult{}, err
	}

	part, err := w.CreateFormFile("image", "image.png")
	if err != nil {
		return MattingResult{}, err
	}
	if _, err := part.Write(imageData); err != nil {
		return MattingResult{}, err
	}

	if err := w.Close(); err != nil {
		return MattingResult{}, err
	}

	// Send request.
	endpoint := c.baseURL + "/images/mattings"
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, &buf)
	if err != nil {
		return MattingResult{}, err
	}

	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return MattingResult{}, fmt.Errorf("%w: %v", ErrMattingFailed, err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return MattingResult{}, fmt.Errorf("%w: HTTP %d: %s", ErrMattingFailed, resp.StatusCode, string(body))
	}

	// Parse response.
	var apiResp struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return MattingResult{}, fmt.Errorf("parse response: %w", err)
	}

	if len(apiResp.Data) == 0 {
		return MattingResult{}, fmt.Errorf("%w: no data in response", ErrMattingFailed)
	}

	result := MattingResult{
		ImageBase64: apiResp.Data[0].B64JSON,
		ImageURL:    apiResp.Data[0].URL,
	}
	return result, nil
}

// DecodeBase64Image decodes a base64-encoded image from MattingResult.
func DecodeBase64Image(b64 string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(b64)
}
