package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type fileEnv map[string]string

func loadEnvFiles() (fileEnv, error) {
	if explicit := strings.TrimSpace(os.Getenv("HLOOL_ENV_FILE")); explicit != "" {
		envs := make(fileEnv)
		if err := readEnvFile(explicit, envs, true); err != nil {
			return nil, err
		}
		return envs, nil
	}

	paths := []string{
		"hlool-pdf.env",
		".env",
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		paths = append(paths, filepath.Join(exeDir, "hlool-pdf.env"), filepath.Join(exeDir, ".env"))
	}

	envs := make(fileEnv)
	seen := map[string]bool{}
	for _, path := range paths {
		abs, err := filepath.Abs(path)
		if err != nil {
			abs = path
		}
		if seen[abs] {
			continue
		}
		seen[abs] = true
		if err := readEnvFile(abs, envs, false); err != nil {
			return nil, err
		}
	}
	return envs, nil
}

func readEnvFile(path string, envs fileEnv, required bool) error {
	f, err := os.Open(path)
	if err != nil {
		if !required && os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read env file %s: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("read env file %s:%d: expected KEY=VALUE", path, lineNo)
		}
		key = strings.TrimSpace(key)
		if !validEnvKey(key) {
			return fmt.Errorf("read env file %s:%d: invalid env key %q", path, lineNo, key)
		}
		if _, exists := envs[key]; exists {
			continue
		}
		envs[key] = parseEnvValue(strings.TrimSpace(value))
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read env file %s: %w", path, err)
	}
	return nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if r == '_' || ('A' <= r && r <= 'Z') || ('a' <= r && r <= 'z') || (i > 0 && '0' <= r && r <= '9') {
			continue
		}
		return false
	}
	return true
}

func parseEnvValue(value string) string {
	if len(value) >= 2 {
		if unquoted, err := strconv.Unquote(value); err == nil {
			return unquoted
		}
		if strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			return strings.TrimSuffix(strings.TrimPrefix(value, "'"), "'")
		}
	}
	return value
}

func envValue(envs fileEnv, key string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return envs[key]
}
