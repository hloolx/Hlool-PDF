package pdf

import (
	"strings"
	"testing"
)

// 前端(CSS/画布,y 轴向下,正角 = 屏幕顺时针)与 pdfcpu(标准数学矩阵,正角 =
// 纸面逆时针)的旋转方向相反:desc 必须取负,否则预览与产物互为镜像。
func TestWatermarkDescFlipsRotationDirection(t *testing.T) {
	if desc := watermarkDesc(10, 20, 1, 30, 1); !strings.Contains(desc, "rot:-30.000") {
		t.Fatalf("positive rotation should be negated for pdfcpu, got %q", desc)
	}
	if desc := watermarkDesc(0, 0, 1, -45, 1); !strings.Contains(desc, "rot:45.000") {
		t.Fatalf("negative rotation should flip positive, got %q", desc)
	}
	if desc := watermarkDesc(0, 0, 1, 0, 1); !strings.Contains(desc, "rot:0.000") {
		t.Fatalf("zero rotation must not become -0, got %q", desc)
	}
}

// 校验层与执行层共用的页码解析器:范围倒序自动交换、去重排序、越界/非数字拒绝。
func TestParsePageScope(t *testing.T) {
	pages, err := ParsePageScope("2-1,4,4", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 3 || pages[0] != 1 || pages[1] != 2 || pages[2] != 4 {
		t.Fatalf("unexpected pages: %v", pages)
	}
	if _, err := ParsePageScope("0", 5); err == nil {
		t.Fatal("page 0 must be rejected")
	}
	if _, err := ParsePageScope("6", 5); err == nil {
		t.Fatal("page beyond count must be rejected")
	}
	if _, err := ParsePageScope("abc", 5); err == nil {
		t.Fatal("non-numeric must be rejected")
	}
	if _, err := ParsePageScope("99999999", 5); err == nil {
		t.Fatal("overlong number must be rejected")
	}
	if all, err := ParsePageScope("all", 3); err != nil || len(all) != 3 {
		t.Fatalf("all = %v, %v", all, err)
	}
	if empty, err := ParsePageScope("  ", 2); err != nil || len(empty) != 2 {
		t.Fatalf("blank = %v, %v", empty, err)
	}
}
