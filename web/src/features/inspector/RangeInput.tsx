import { ChevronDown } from 'lucide-react'
import { emptyPageExpression, pagesToExpression, parsePageExpression, summarizePages } from '../../lib/pages'
import { activeFile, useEditorStore } from '../../state/store'
import { IconButton } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu'

/** 页面范围输入：文本表达式 ⇄ 缩略图多选 双向同步。 */
export function RangeInput() {
  const file = useEditorStore(activeFile)
  const rangeText = useEditorStore((state) => state.rangeText)
  const setRangeText = useEditorStore((state) => state.setRangeText)
  const currentPage = useEditorStore((state) => state.currentPage)
  const pageCount = file?.pageCount ?? 0
  const expr = file ? parsePageExpression(rangeText, pageCount) : emptyPageExpression()

  function pagesByParity(remainder: number) {
    const pages: number[] = []
    for (let p = 1; p <= pageCount; p++) if (p % 2 === remainder) pages.push(p)
    return pagesToExpression(pages, pageCount)
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex gap-1.5">
        <TextInput
          value={rangeText}
          placeholder="如 1,3-5 或 全部"
          disabled={!file}
          onChange={(event) => setRangeText(event.currentTarget.value)}
        />
        <Menu>
          <MenuTrigger asChild>
            <IconButton disabled={!file} title="常用范围">
              <ChevronDown size={16} />
            </IconButton>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => setRangeText('全部')}>全部页</MenuItem>
            <MenuItem onSelect={() => setRangeText(String(currentPage))}>当前页</MenuItem>
            <MenuItem onSelect={() => setRangeText(pagesByParity(1))}>奇数页</MenuItem>
            <MenuItem onSelect={() => setRangeText(pagesByParity(0))} disabled={pageCount < 2}>
              偶数页
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <p className="text-xs text-ink-muted">
        {!file
          ? '导入 PDF 后可用'
          : expr.invalidParts.length > 0
            ? `无效：${expr.invalidParts.join('、')}`
            : `${summarizePages(expr.pages, pageCount)} · 也可在左侧 Ctrl/Shift 点选缩略图`}
      </p>
    </div>
  )
}
