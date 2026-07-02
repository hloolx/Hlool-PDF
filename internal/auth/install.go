package auth

import (
	"context"
	"database/sql"
	"errors"
)

// HasAdmin 报告实例里是否已存在管理员账号 —— 这是「已完成首次初始化」的判定依据:
// 首个管理员既可由环境变量引导(EnsureAdmin),也可由首次安装向导创建。
func (s *Service) HasAdmin(ctx context.Context) (bool, error) {
	var one int
	err := s.db.db.QueryRowContext(ctx, `SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
