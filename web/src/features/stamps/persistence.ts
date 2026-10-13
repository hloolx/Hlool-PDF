/** 浏览器端生成跨会话、跨标签页稳定且不会泄漏文件内容的印章 id。 */
export function generateStampId(): string {
  return 'stamp_' + crypto.randomUUID().replaceAll('-', '')
}
