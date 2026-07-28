const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomSegment(length: number) {
  const values = new Uint8Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => ACCESS_CODE_ALPHABET[value % ACCESS_CODE_ALPHABET.length]).join('')
}

export function generateAccessCode(existingCodes: Iterable<string> = []) {
  const existing = new Set(Array.from(existingCodes, (code) => code.toUpperCase()))
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `PXC-${randomSegment(4)}-${randomSegment(4)}`
    if (!existing.has(code)) return code
  }
  return `PXC-${randomSegment(4)}-${Date.now().toString(36).slice(-4).toUpperCase()}`
}
