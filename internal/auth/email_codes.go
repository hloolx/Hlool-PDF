package auth

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"time"
)

// 邮箱验证码登录的持久化操作。表结构见 migrations.go 的 email_verification_codes;
// 这里只暴露 Service 级别的最小操作面,不向包外泄露 *sql.DB。
//
// 设计约定:同一邮箱可能存在多条历史记录(频控要按条数统计,不能删旧行),
// 但校验永远只看「最新一条」,旧验证码天然作废。

const emailCodePurposeLogin = "login"

// StoreEmailLoginCode 记录一条新验证码(只存哈希),返回过期时间。
// 顺带清理早已过期的历史行,防止表无限增长。
func (s *Service) StoreEmailLoginCode(ctx context.Context, email, codeHash, ip string, ttl time.Duration) (time.Time, error) {
	now := s.now()
	expires := now.Add(ttl)
	// 过期超过 24 小时的行对频控统计已无意义,顺手清掉。
	_, _ = s.db.db.ExecContext(ctx,
		`DELETE FROM email_verification_codes WHERE expires_at < ?`,
		now.Add(-24*time.Hour).Unix(),
	)
	_, err := s.db.db.ExecContext(ctx,
		`INSERT INTO email_verification_codes (email, code_hash, purpose, expires_at, attempts, consumed_at, created_ip, created_at)
		 VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
		email, codeHash, emailCodePurposeLogin, expires.Unix(), ip, now.Unix(),
	)
	if err != nil {
		return time.Time{}, err
	}
	return expires, nil
}

// CountRecentEmailLoginCodes 分别统计频控窗口内「该邮箱」与「该 IP」生成过的验证
// 码条数。两个维度必须分开计:合并成 OR 会让一个 NAT 出口 IP 上的 5 次发送封锁
// 全办公室所有邮箱,也让针对单一邮箱的骚扰顺带波及无关 IP 的额度。
func (s *Service) CountRecentEmailLoginCodes(ctx context.Context, email, ip string, window time.Duration) (byEmail, byIP int, err error) {
	cutoff := s.now().Add(-window).Unix()
	err = s.db.db.QueryRowContext(ctx,
		`SELECT
		    COUNT(CASE WHEN email = ? THEN 1 END),
		    COUNT(CASE WHEN created_ip = ? THEN 1 END)
		   FROM email_verification_codes
		  WHERE purpose = ? AND created_at > ?`,
		email, ip, emailCodePurposeLogin, cutoff,
	).Scan(&byEmail, &byIP)
	return byEmail, byIP, err
}

// ConsumeEmailLoginCode 校验并单次消费该邮箱最新一条验证码。
// 返回 true 仅当:存在、未过期、未消费、错误尝试未超限、哈希恒定时间比较相等。
// 比较失败会累计 attempts,达到 maxAttempts 后该验证码作废(须重新发送)。
func (s *Service) ConsumeEmailLoginCode(ctx context.Context, email, codeHash string, maxAttempts int) (bool, error) {
	now := s.now().Unix()
	var id int64
	var stored string
	var attempts int
	err := s.db.db.QueryRowContext(ctx,
		`SELECT id, code_hash, attempts FROM email_verification_codes
		  WHERE email = ? AND purpose = ? AND consumed_at = 0 AND expires_at > ?
		  ORDER BY created_at DESC, id DESC LIMIT 1`,
		email, emailCodePurposeLogin, now,
	).Scan(&id, &stored, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if attempts >= maxAttempts {
		return false, nil
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(codeHash)) != 1 {
		_, err := s.db.db.ExecContext(ctx,
			`UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?`, id)
		return false, err
	}
	// consumed_at = 0 条件保证并发提交同一验证码时只有一个请求消费成功。
	res, err := s.db.db.ExecContext(ctx,
		`UPDATE email_verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at = 0`, now, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
