package server

import (
	"sync"
	"time"
)

// rateCounter 是按 key 的固定窗口计数器(满即拒),给昂贵端点(如调用付费外部
// API 的 AI 抠图)做每用户限流。窗口翻转时惰性清理过期条目,map 不会无限增长。
type rateCounter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	m      map[string]*rateWindow
}

type rateWindow struct {
	start time.Time
	count int
}

func newRateCounter(max int, window time.Duration) *rateCounter {
	return &rateCounter{max: max, window: window, m: map[string]*rateWindow{}}
}

// allow 记录一次请求并报告是否放行。
func (c *rateCounter) allow(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	wdw := c.m[key]
	if wdw == nil || now.Sub(wdw.start) > c.window {
		for k, v := range c.m {
			if now.Sub(v.start) > c.window {
				delete(c.m, k)
			}
		}
		wdw = &rateWindow{start: now}
		c.m[key] = wdw
	}
	if wdw.count >= c.max {
		return false
	}
	wdw.count++
	return true
}
