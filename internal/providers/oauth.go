package providers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OAuthProvider handles OAuth 2.0 authentication flow.
type OAuthProvider struct {
	kind         string // "github", "google", "linuxdo"
	clientID     string
	clientSecret string
	authURL      string
	tokenURL     string
	userInfoURL  string
	scopes       []string
	httpClient   *http.Client
}

// OAuthConfig holds OAuth provider configuration.
type OAuthConfig struct {
	Kind         string
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	UserInfoURL  string
	Scopes       []string
}

// OAuthUserInfo is the user information from OAuth provider.
type OAuthUserInfo struct {
	Subject string // Unique user identifier from provider
	Email   string
	Name    string
}

var ErrOAuthNotConfigured = errors.New("OAuth provider not configured")

// NewOAuthProvider creates an OAuth provider client.
func NewOAuthProvider(config OAuthConfig) *OAuthProvider {
	return &OAuthProvider{
		kind:         config.Kind,
		clientID:     config.ClientID,
		clientSecret: config.ClientSecret,
		authURL:      config.AuthURL,
		tokenURL:     config.TokenURL,
		userInfoURL:  config.UserInfoURL,
		scopes:       config.Scopes,
		httpClient:   &http.Client{Timeout: 15 * time.Second},
	}
}

// GenerateState creates a cryptographically secure state token.
func GenerateState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// AuthorizationURL builds the OAuth authorization URL.
func (p *OAuthProvider) AuthorizationURL(redirectURI, state string) string {
	params := url.Values{}
	params.Set("client_id", p.clientID)
	params.Set("redirect_uri", redirectURI)
	params.Set("response_type", "code")
	params.Set("state", state)
	if len(p.scopes) > 0 {
		params.Set("scope", joinScopes(p.scopes))
	}
	return p.authURL + "?" + params.Encode()
}

// ExchangeCode exchanges authorization code for access token.
// 凭据必须放在表单体里:Google 等提供方拒绝 query 传参,且 query 会进访问日志。
func (p *OAuthProvider) ExchangeCode(ctx context.Context, code, redirectURI string) (string, error) {
	data := url.Values{}
	data.Set("client_id", p.clientID)
	data.Set("client_secret", p.clientSecret)
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)
	data.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(ctx, "POST", p.tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token exchange failed: %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	if result.AccessToken == "" {
		return "", errors.New("no access token in response")
	}

	return result.AccessToken, nil
}

// GetUserInfo fetches user information using access token.
func (p *OAuthProvider) GetUserInfo(ctx context.Context, accessToken string) (OAuthUserInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", p.userInfoURL, nil)
	if err != nil {
		return OAuthUserInfo{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return OAuthUserInfo{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return OAuthUserInfo{}, fmt.Errorf("user info failed: %d", resp.StatusCode)
	}

	var data map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return OAuthUserInfo{}, err
	}

	return p.parseUserInfo(data)
}

func (p *OAuthProvider) parseUserInfo(data map[string]interface{}) (OAuthUserInfo, error) {
	info := OAuthUserInfo{}

	switch p.kind {
	case "github":
		if id, ok := data["id"].(float64); ok {
			info.Subject = fmt.Sprintf("%d", int64(id))
		}
		if email, ok := data["email"].(string); ok {
			info.Email = email
		}
		if name, ok := data["name"].(string); ok {
			info.Name = name
		} else if login, ok := data["login"].(string); ok {
			info.Name = login
		}

	case "google":
		if sub, ok := data["sub"].(string); ok {
			info.Subject = sub
		}
		if email, ok := data["email"].(string); ok {
			info.Email = email
		}
		if name, ok := data["name"].(string); ok {
			info.Name = name
		}

	case "linuxdo":
		if id, ok := data["id"].(float64); ok {
			info.Subject = fmt.Sprintf("%d", int64(id))
		} else if id, ok := data["id"].(string); ok {
			info.Subject = id
		}
		if email, ok := data["email"].(string); ok {
			info.Email = email
		}
		if name, ok := data["name"].(string); ok {
			info.Name = name
		} else if username, ok := data["username"].(string); ok {
			info.Name = username
		}

	default:
		return OAuthUserInfo{}, fmt.Errorf("unsupported provider: %s", p.kind)
	}

	if info.Subject == "" {
		return OAuthUserInfo{}, errors.New("no subject in user info")
	}

	return info, nil
}

// HashState creates a SHA-256 hash of the state token for storage.
func HashState(state string) string {
	h := sha256.Sum256([]byte(state))
	return base64.URLEncoding.EncodeToString(h[:])
}

func joinScopes(scopes []string) string {
	result := ""
	for i, scope := range scopes {
		if i > 0 {
			result += " "
		}
		result += scope
	}
	return result
}
