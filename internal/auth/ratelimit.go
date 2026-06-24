package auth

import (
	"sync"
	"time"
)

// limiter throttles repeated attempts per key (e.g. "ip|username"). After max
// failures inside window the key is locked for lockout. It is safe for
// concurrent use and prunes stale entries lazily.
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	max     int
	window  time.Duration
	lockout time.Duration
	now     func() time.Time
}

type bucket struct {
	count       int
	windowStart time.Time
	lockedUntil time.Time
}

func newLimiter(max int, window, lockout time.Duration) *limiter {
	return &limiter{
		buckets: map[string]*bucket{},
		max:     max,
		window:  window,
		lockout: lockout,
		now:     time.Now,
	}
}

// locked reports whether key is currently locked, and until when.
func (l *limiter) locked(key string) (bool, time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		return false, time.Time{}
	}
	now := l.now()
	if b.lockedUntil.After(now) {
		return true, b.lockedUntil
	}
	return false, time.Time{}
}

// fail records a failed attempt, locking the key once max is exceeded within the
// rolling window.
func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[key]
	if b == nil || now.Sub(b.windowStart) > l.window {
		b = &bucket{windowStart: now}
		l.buckets[key] = b
	}
	b.count++
	if b.count >= l.max {
		b.lockedUntil = now.Add(l.lockout)
	}
	l.pruneLocked(now)
}

// reset clears a key's failure state (call on success).
func (l *limiter) reset(key string) {
	l.mu.Lock()
	delete(l.buckets, key)
	l.mu.Unlock()
}

func (l *limiter) pruneLocked(now time.Time) {
	for k, b := range l.buckets {
		if b.lockedUntil.Before(now) && now.Sub(b.windowStart) > l.window {
			delete(l.buckets, k)
		}
	}
}
