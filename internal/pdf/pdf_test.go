package pdf

import (
	"reflect"
	"testing"
)

// 期望值与 web/src/features/seam/slices.ts 的同种子输出逐位一致（已用 Node 交叉验证）。
func TestSliceBoundariesDeterminism(t *testing.T) {
	rng := mulberry32(123456789)
	cases := [][]int{
		{0, 118, 332, 457, 542, 694, 881, 1000},
		{0, 170, 264, 380, 537, 700, 850, 1000},
	}
	for i, want := range cases {
		if got := sliceBoundaries(1000, 7, rng); !reflect.DeepEqual(got, want) {
			t.Fatalf("round %d: got %v, want %v", i, got, want)
		}
	}
	if got, want := sliceBoundaries(637, 5, rng), []int{0, 133, 226, 381, 537, 637}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSliceBoundariesEvenMatchesLegacyIntegerMath(t *testing.T) {
	axis, n := 1003, 7
	got := sliceBoundaries(axis, n, nil)
	for i := 0; i <= n; i++ {
		if want := axis * i / n; got[i] != want {
			t.Fatalf("boundary %d: got %d, want %d", i, got[i], want)
		}
	}
}

func TestSliceBoundariesMonotonicAndPositiveWidths(t *testing.T) {
	rng := mulberry32(42)
	for round := 0; round < 50; round++ {
		bounds := sliceBoundaries(180, 20, rng)
		for i := 1; i < len(bounds); i++ {
			if bounds[i] <= bounds[i-1] {
				t.Fatalf("round %d: non-increasing boundary at %d: %v", round, i, bounds)
			}
		}
	}
}
