export function isEditingField(element: Element | null) {
  if (!element) return false
  const tag = element.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (element as HTMLElement).isContentEditable
  )
}
