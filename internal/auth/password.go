package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2Params are the Argon2id cost parameters. They are encoded into every
// hash (PHC string) so they can be tuned later without invalidating old hashes.
type argon2Params struct {
	memoryKiB   uint32
	iterations  uint32
	parallelism uint8
	saltLen     uint32
	keyLen      uint32
}

var defaultArgon2 = argon2Params{
	memoryKiB:   64 * 1024, // 64 MiB
	iterations:  2,
	parallelism: 4,
	saltLen:     16,
	keyLen:      32,
}

// hashPassword returns an Argon2id PHC-formatted hash string for password.
func hashPassword(password string) (string, error) {
	p := defaultArgon2
	salt := make([]byte, p.saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, p.iterations, p.memoryKiB, p.parallelism, p.keyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		p.memoryKiB, p.iterations, p.parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// verifyPassword reports whether password matches the encoded Argon2id hash,
// using a constant-time comparison.
func verifyPassword(password, encoded string) (bool, error) {
	p, salt, key, err := decodeArgon2(encoded)
	if err != nil {
		return false, err
	}
	computed := argon2.IDKey([]byte(password), salt, p.iterations, p.memoryKiB, p.parallelism, uint32(len(key)))
	return subtle.ConstantTimeCompare(computed, key) == 1, nil
}

func decodeArgon2(encoded string) (argon2Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return argon2Params{}, nil, nil, errors.New("invalid argon2 hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return argon2Params{}, nil, nil, errors.New("unsupported argon2 version")
	}
	var p argon2Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memoryKiB, &p.iterations, &p.parallelism); err != nil {
		return argon2Params{}, nil, nil, errors.New("invalid argon2 parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argon2Params{}, nil, nil, errors.New("invalid argon2 salt")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argon2Params{}, nil, nil, errors.New("invalid argon2 hash")
	}
	return p, salt, key, nil
}
