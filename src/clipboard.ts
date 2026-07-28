export async function copyText(text: string) {
  if (!text) throw new Error('没有可复制的内容')

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // LAN HTTP and embedded browsers can reject the modern Clipboard API.
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '2px',
    height: '2px',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  })
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了复制操作')
  } finally {
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
  }
}
