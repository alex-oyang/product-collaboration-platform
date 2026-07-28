import { readFile, writeFile } from 'node:fs/promises'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff])
const HTML_TAG = /<(?:!doctype\s+html|[a-z][a-z0-9:-]*(?:\s|>|\/))/i

function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix)
}

function sniffUtf16(buffer) {
  if (startsWith(buffer, UTF16_LE_BOM)) return { encoding: 'utf-16le', offset: 2 }
  if (startsWith(buffer, UTF16_BE_BOM)) return { encoding: 'utf-16be', offset: 2 }
  const sample = buffer.subarray(0, Math.min(buffer.length, 128))
  let evenNulls = 0
  let oddNulls = 0
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue
    if (index % 2 === 0) evenNulls += 1
    else oddNulls += 1
  }
  if (oddNulls >= 4 && oddNulls > evenNulls * 2) return { encoding: 'utf-16le', offset: 0 }
  if (evenNulls >= 4 && evenNulls > oddNulls * 2) return { encoding: 'utf-16be', offset: 0 }
  return null
}

function declaredEncoding(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 16_384)).toString('latin1')
  const match = sample.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9._-]+)/i)
    ?? sample.match(/<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([a-z0-9._-]+)/i)
  if (!match) return ''
  const label = match[1].toLowerCase()
  if (['gbk', 'gb2312', 'x-gbk', 'chinese'].includes(label)) return 'gb18030'
  if (label === 'utf8') return 'utf-8'
  if (label === 'unicode') return 'utf-16le'
  return label
}

function decode(buffer, encoding, offset = 0) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset))
  } catch {
    throw new Error(`HTML 文件编码无法解析（${encoding}）`)
  }
}

export function decodeHtmlBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('HTML 文件为空')

  let content
  let encoding
  const utf16 = sniffUtf16(buffer)
  if (utf16) {
    encoding = utf16.encoding
    content = decode(buffer, utf16.encoding, utf16.offset)
  } else if (startsWith(buffer, UTF8_BOM)) {
    encoding = 'utf-8'
    content = decode(buffer, 'utf-8', UTF8_BOM.length)
  } else {
    const declared = declaredEncoding(buffer)
    if (declared) {
      encoding = declared
      content = decode(buffer, declared)
    } else {
      try {
        encoding = 'utf-8'
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        encoding = 'gb18030'
        content = decode(buffer, 'gb18030')
      }
    }
  }

  content = content.replace(/^\uFEFF/, '')
  if (!HTML_TAG.test(content)) throw new Error('HTML 文件格式不正确，未找到可渲染的 HTML 标签')
  return { content, encoding }
}

export async function readHtmlFile(filePath) {
  return decodeHtmlBuffer(await readFile(filePath)).content
}

export async function normalizeHtmlFile(sourcePath, targetPath) {
  const result = decodeHtmlBuffer(await readFile(sourcePath))
  const content = result.content
    .replace(/(\bcharset\s*=\s*)(["']?)[a-z0-9._-]+\2/gi, '$1"utf-8"')
    .replace(/(<\?xml\b[^>]*\bencoding\s*=\s*)(["'])[^"']+\2/gi, '$1"utf-8"')
  await writeFile(targetPath, content, 'utf8')
  return { ...result, content }
}
