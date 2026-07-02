package providers

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// MailClient sends emails via SMTP.
type MailClient struct {
	host     string
	port     int
	username string
	password string
	from     string
	useTLS   bool
}

// MailConfig holds SMTP configuration.
type MailConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	UseTLS   bool
}

var ErrMailNotConfigured = errors.New("mail service not configured")

// smtpDialTimeout 防止对无响应的 SMTP 服务器无限等待拖死请求协程。
const smtpDialTimeout = 10 * time.Second

// NewMailClient creates an SMTP client.
func NewMailClient(host, username, password, from string, port int, useTLS bool) *MailClient {
	if port == 0 {
		if useTLS {
			port = 465
		} else {
			port = 587
		}
	}
	return &MailClient{
		host:     host,
		port:     port,
		username: username,
		password: password,
		from:     from,
		useTLS:   useTLS,
	}
}

// dial 建立带超时的 SMTP 连接:useTLS 走隐式 TLS(465),否则明文连接后尽量升级 STARTTLS(587)。
func (c *MailClient) dial() (*smtp.Client, error) {
	addr := net.JoinHostPort(c.host, strconv.Itoa(c.port))
	dialer := &net.Dialer{Timeout: smtpDialTimeout}

	if c.useTLS {
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: c.host})
		if err != nil {
			return nil, fmt.Errorf("tls dial: %w", err)
		}
		client, err := smtp.NewClient(conn, c.host)
		if err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("smtp client: %w", err)
		}
		return client, nil
	}

	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	client, err := smtp.NewClient(conn, c.host)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("smtp client: %w", err)
	}
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: c.host}); err != nil {
			_ = client.Close()
			return nil, fmt.Errorf("starttls: %w", err)
		}
	}
	return client, nil
}

// SendEmail sends a plain text email.
// 主题走 RFC 2047 B 编码、正文声明 UTF-8:中文主题/正文在严格的邮件服务器上才不会乱码。
func (c *MailClient) SendEmail(to, subject, body string) error {
	if c.host == "" || c.username == "" || c.password == "" {
		return ErrMailNotConfigured
	}
	from := c.from
	if from == "" {
		from = c.username
	}

	headers := []string{
		"From: " + from,
		"To: " + to,
		"Subject: " + mime.BEncoding.Encode("UTF-8", subject),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
	}
	msg := strings.Join(headers, "\r\n") + "\r\n\r\n" + wrapBase64([]byte(body))

	client, err := c.dial()
	if err != nil {
		return err
	}
	defer client.Close()

	if err := client.Auth(smtp.PlainAuth("", c.username, c.password, c.host)); err != nil {
		return fmt.Errorf("auth: %w", err)
	}
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("rcpt to: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	return client.Quit()
}

// TestConnection 只做握手 + 登录认证,不发送任何邮件。
func (c *MailClient) TestConnection() error {
	if c.host == "" || c.username == "" || c.password == "" {
		return ErrMailNotConfigured
	}
	client, err := c.dial()
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Auth(smtp.PlainAuth("", c.username, c.password, c.host)); err != nil {
		return fmt.Errorf("auth: %w", err)
	}
	return client.Quit()
}

// SendVerificationCode sends a 6-digit verification code email.
func (c *MailClient) SendVerificationCode(to, code string) error {
	subject := "hlool pdf 登录验证码"
	body := fmt.Sprintf(`您的验证码是：%s

此验证码 10 分钟内有效，请勿泄露给他人。

如果这不是您的操作，请忽略此邮件。

---
hlool pdf
`, code)

	return c.SendEmail(to, subject, body)
}

// NormalizeEmail normalizes an email address for comparison.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// wrapBase64 按 RFC 2045 把 base64 正文折行到 76 列。
func wrapBase64(data []byte) string {
	encoded := base64.StdEncoding.EncodeToString(data)
	var b strings.Builder
	for len(encoded) > 76 {
		b.WriteString(encoded[:76])
		b.WriteString("\r\n")
		encoded = encoded[76:]
	}
	b.WriteString(encoded)
	return b.String()
}
