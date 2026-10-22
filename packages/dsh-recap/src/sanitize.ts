export const MAX_SAFE_RECAP_CHARS = 320

const ESC = 0x1b
const BEL = 0x07
const ST = 0x9c

function isControlCharacter(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
}

function isWhitespaceControl(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d
  )
}

function skipCsiSequence(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }

  return text.length
}

function skipStringControl(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === BEL || code === ST) return index + 1
    if (code === ESC && text.charCodeAt(index + 1) === 0x5c) {
      return index + 2
    }
  }

  return text.length
}

function skipEscapeSequence(text: string, escapeIndex: number): number {
  const nextCode = text.charCodeAt(escapeIndex + 1)
  if (Number.isNaN(nextCode)) return escapeIndex + 1

  switch (nextCode) {
    case 0x5b:
      return skipCsiSequence(text, escapeIndex + 2)
    case 0x5d:
    case 0x50:
    case 0x58:
    case 0x5e:
    case 0x5f:
      return skipStringControl(text, escapeIndex + 2)
    default:
      if (
        nextCode === 0x20 ||
        nextCode === 0x23 ||
        nextCode === 0x25 ||
        (nextCode >= 0x28 && nextCode <= 0x2f)
      ) {
        return Math.min(text.length, escapeIndex + 3)
      }

      return Math.min(text.length, escapeIndex + 2)
  }
}

function truncatePrintableText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""

  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  if (maxChars === 1) return "…"
  return `${chars.slice(0, maxChars - 1).join("")}…`
}

export function sanitizeRecapText(
  text: string,
  maxChars = MAX_SAFE_RECAP_CHARS,
): string {
  let stripped = ""

  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index)

    if (code === ESC) {
      index = skipEscapeSequence(text, index)
      continue
    }

    if (code === 0x9b) {
      index = skipCsiSequence(text, index + 1)
      continue
    }

    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = skipStringControl(text, index + 1)
      continue
    }

    if (isControlCharacter(code)) {
      if (isWhitespaceControl(code)) stripped += " "
      index++
      continue
    }

    stripped += text[index]
    index++
  }

  return truncatePrintableText(stripped.replace(/\s+/gu, " ").trim(), maxChars)
}
