/** 浏览器端生成跨会话稳定的印章 id（与后端 stampIDPattern 对应）。 */
export function generateStampId(): string {
  return 'stamp_' + crypto.randomUUID().replaceAll('-', '')
}
