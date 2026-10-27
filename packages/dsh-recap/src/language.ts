/**
 * Language detection for dsh-recap.
 *
 * The recap must be written in the language the *human* writes. Deciding that
 * inside the recap request itself is unreliable: the conversation block mixes
 * User and Assistant turns, so a short Chinese question answered by a long
 * English analysis reads as English. This module asks a separate model call
 * that sees only the user's own words, and falls back to a script heuristic
 * when that call cannot answer.
 *
 * Detection is advisory. It never fails a recap: with no usable answer the
 * recap request keeps its own soft rule.
 * @module dsh-recap/language
 */
import type { Message } from '@deepseek-ai/dsh-llm'

/** How many trailing user messages a detection call reads. */
export const LANGUAGE_USER_MESSAGE_LIMIT = 12
/** Cap on the user text sent for detection; the tail wins, it is the freshest. */
export const LANGUAGE_USER_TEXT_LIMIT = 4_000
/**
 * Detection output is one word, but a reasoning route spends most of a small
 * budget thinking before it emits that word — measured runs spent 20 to well
 * over 128 tokens on `deepseek-flash`. The headroom is what keeps a thinking
 * model from truncating the answer away entirely.
 */
export const LANGUAGE_MAX_TOKENS = 512

/**
 * Codes the detector may answer with, mapped to the phrase injected into the
 * recap prompt. Keeping the list closed is what makes a hallucinated answer
 * rejectable instead of silently shaping the prompt.
 */
const LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'zh-Hans', name: 'Simplified Chinese' },
  { code: 'zh-Hant', name: 'Traditional Chinese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
]

/** Case-insensitive lookup: a model may answer `zh-hans` or `ZH-HANS`. */
const BY_LOWERCASE_CODE: ReadonlyMap<string, { code: string; name: string }> = new Map(
  LANGUAGES.map((language) => [language.code.toLowerCase(), language]),
)

/** The code set named in the detection prompt, in the order the model reads it. */
const LANGUAGE_CODES = [...LANGUAGES.map((language) => language.code), 'unknown']

export const LANGUAGE_DETECTION_SYSTEM_PROMPT = `You detect the language a person writes in.

You receive only that person's own messages, never a model's replies. Answer with exactly one code and nothing else: ${LANGUAGE_CODES.join(', ')}.
Use zh-Hans for Simplified Chinese and zh-Hant for Traditional Chinese; use plain zh only when the script is unclear.
Judge by the language the person writes, not by code, file paths, command names, logs, or quoted text they include.
If the text is too short, too mixed, or carries no language signal, answer unknown.`

/**
 * Whether one message is something the human typed, as opposed to a model
 * reply, a tool result, or injected context.
 * @param message - one derived message.
 * @returns true when the user typed it.
 */
function isHumanMessage(message: Message): boolean {
  return message.role === 'user' && message.source?.kind === 'user'
}

/**
 * Flatten one message to its text blocks, ignoring tool calls and attachments.
 * @param message - one derived message.
 * @returns the text, or an empty string.
 */
function textOf(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Collect the human's own words for detection.
 *
 * Only user turns are considered: a model's own replies are exactly the signal
 * that made in-request detection pick English for Chinese sessions.
 * @param messages - model-visible history.
 * @returns the bounded user text; empty when the human has not written yet.
 */
export function collectUserText(messages: readonly Message[]): string {
  const human = messages.filter(isHumanMessage)
  // A session whose human turns are recorded under another source kind (a
  // subagent's delegated task, for one) still deserves a language guess.
  const candidates = human.length > 0 ? human : messages.filter((message) => message.role === 'user')
  const texts = candidates
    .map(textOf)
    .filter((text) => text !== '')
    .slice(-LANGUAGE_USER_MESSAGE_LIMIT)
  const joined = texts.join('\n\n')
  return joined.length > LANGUAGE_USER_TEXT_LIMIT ? joined.slice(joined.length - LANGUAGE_USER_TEXT_LIMIT) : joined
}

/**
 * Normalize one model answer into a known code.
 *
 * Models wrap short answers in prose or fences even when told not to, so the
 * first plausible token decides and anything outside the list is rejected.
 * @param reply - raw detector output.
 * @returns the code, or undefined when the answer carries no usable signal.
 */
export function parseLanguageReply(reply: string): string | undefined {
  const normalized = reply
    .toLowerCase()
    .replace(/[`'"*_]/g, ' ')
    .trim()
  for (const token of normalized.split(/[^a-z-]+/)) {
    if (token === '') continue
    if (token === 'unknown' || token === 'und' || token === 'none') return undefined
    // `zh-cn` / `zh-hans` must resolve to the canonical spelling, so look the
    // token up lowercased and fall back to its language subtag.
    const exact = BY_LOWERCASE_CODE.get(token)
    if (exact !== undefined) return exact.code
    const base = token.split('-')[0]
    const prefix = base === undefined || base === token ? undefined : BY_LOWERCASE_CODE.get(base)
    if (prefix !== undefined) return prefix.code
  }
  return undefined
}

/**
 * The line appended to the recap prompt once a language is known.
 *
 * It is stated as an override, because the recap prompt's own soft rule is
 * exactly what the model got wrong.
 * @param code - a code accepted by the detector prompt.
 * @returns the instruction, or an empty string when the code is unknown.
 */
export function languageInstruction(code: string): string {
  const name = BY_LOWERCASE_CODE.get(code.replace(/[^A-Za-z-]/g, '').toLowerCase())?.name
  if (name === undefined) return ''
  return `\n\n## Output language\n\nThe user writes in ${name}. Write the recap in ${name} (${code}), even when the session context is mostly in another language. Keep file paths, code identifiers, and command names verbatim.`
}

/** Script ranges a text count cares about, as inclusive code-point bounds. */
const SCRIPTS: readonly { name: string; from: number; to: number }[] = [
  { name: 'han', from: 0x3400, to: 0x4dbf },
  { name: 'han', from: 0x4e00, to: 0x9fff },
  { name: 'han', from: 0xf900, to: 0xfaff },
  { name: 'kana', from: 0x3041, to: 0x30ff },
  { name: 'hangul', from: 0x1100, to: 0x11ff },
  { name: 'hangul', from: 0xac00, to: 0xd7af },
  { name: 'cyrillic', from: 0x0400, to: 0x04ff },
  { name: 'arabic', from: 0x0600, to: 0x06ff },
  { name: 'devanagari', from: 0x0900, to: 0x097f },
  { name: 'latin', from: 0x0041, to: 0x005a },
  { name: 'latin', from: 0x0061, to: 0x007a },
]

/**
 * Drop the parts of a message that name things rather than express language:
 * fenced code, inline code, URLs, and paths. A Chinese message that mentions
 * `packages/dsh-recap/src/index.ts` is still a Chinese message.
 * @param text - one user message.
 * @returns the prose that carries the language signal.
 */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.-]*\/[\w./-]+/g, ' ')
}

/**
 * Judge the language from the script a text is written in.
 *
 * This is the fallback for a detection call that could not answer. It reports
 * only what a script can prove: `zh` rather than a script variant, and nothing
 * at all for text too short or too mixed to mean anything.
 * @param text - the collected user text.
 * @returns a coarse language code, or undefined when the script is unclear.
 */
export function heuristicLanguage(text: string): string | undefined {
  const counts = new Map<string, number>()
  for (const character of proseOnly(text)) {
    const point = character.codePointAt(0)
    if (point === undefined) continue
    for (const script of SCRIPTS) {
      if (point >= script.from && point <= script.to) {
        counts.set(script.name, (counts.get(script.name) ?? 0) + 1)
        break
      }
    }
  }
  const count = (name: string): number => counts.get(name) ?? 0
  const han = count('han')
  const kana = count('kana')
  const hangul = count('hangul')
  const latin = count('latin')

  // Japanese mixes kana into Han text; kana is what decides it.
  if (kana >= 3 && kana * 4 >= han) return 'ja'
  if (hangul >= 3) return 'ko'
  // CJK carries more meaning per character than Latin script, so a Chinese
  // sentence reaches far fewer characters than an English one of equal content.
  if (han >= 4 && han * 3 >= latin) return 'zh'
  if (count('cyrillic') >= 10 && count('cyrillic') >= latin) return 'ru'
  if (count('arabic') >= 10 && count('arabic') >= latin) return 'ar'
  if (count('devanagari') >= 10 && count('devanagari') >= latin) return 'hi'
  if (latin >= 10) return 'en'
  return undefined
}
