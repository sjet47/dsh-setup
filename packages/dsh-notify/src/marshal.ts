/**
 * The slice of the D-Bus wire format this plugin needs: little-endian value
 * marshalling for method calls and enough unmarshalling to read the reply.
 *
 * Only the types used by `org.freedesktop.Notifications.Notify` and by message
 * header fields are implemented; an unsupported signature fails loudly instead
 * of being silently misread.
 * @module dsh-notify/marshal
 */

/** One marshalled value, tagged with its D-Bus type. */
export type DbusValue =
  | { readonly type: 'byte'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'int32'; readonly value: number }
  | { readonly type: 'uint32'; readonly value: number }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'object-path'; readonly value: string }
  | { readonly type: 'signature'; readonly value: string }
  | { readonly type: 'variant'; readonly value: DbusValue }
  | { readonly type: 'string-array'; readonly values: readonly string[] }
  | { readonly type: 'dict'; readonly entries: readonly (readonly [string, DbusValue])[] }

/** Byte alignment per D-Bus type code. */
const ALIGNMENT: Record<string, number> = {
  y: 1,
  b: 4,
  n: 2,
  q: 8,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  s: 4,
  o: 4,
  g: 1,
  a: 4,
  h: 4,
  v: 1,
  '(': 8,
  '{': 8,
}

/** The signature character of one tagged value. */
export function signatureOf(value: DbusValue): string {
  switch (value.type) {
    case 'byte':
      return 'y'
    case 'boolean':
      return 'b'
    case 'int32':
      return 'i'
    case 'uint32':
      return 'u'
    case 'string':
      return 's'
    case 'object-path':
      return 'o'
    case 'signature':
      return 'g'
    case 'variant':
      return 'v'
    case 'string-array':
      return 'as'
    case 'dict':
      return 'a{sv}'
  }
}

/** Appends little-endian values while tracking absolute alignment. */
class Writer {
  private readonly bytes: number[] = []

  /**
   * @param origin - absolute message offset of the first written byte; D-Bus
   * aligns against the start of the enclosing message, not the field buffer.
   */
  constructor(private readonly origin = 0) {}

  get length(): number {
    return this.bytes.length
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes)
  }

  align(alignment: number): void {
    while ((this.origin + this.bytes.length) % alignment !== 0) this.bytes.push(0)
  }

  u8(value: number): void {
    this.bytes.push(value & 0xff)
  }

  u32(value: number): void {
    this.align(4)
    this.reserved32(value)
  }

  i32(value: number): void {
    this.reserved32(value >>> 0)
  }

  /** Reserve a 4-byte slot and return its offset, for lengths patched later. */
  reserve32(): number {
    this.align(4)
    const at = this.bytes.length
    this.bytes.push(0, 0, 0, 0)
    return at
  }

  patch32(at: number, value: number): void {
    this.bytes[at] = value & 0xff
    this.bytes[at + 1] = (value >>> 8) & 0xff
    this.bytes[at + 2] = (value >>> 16) & 0xff
    this.bytes[at + 3] = (value >>> 24) & 0xff
  }

  string(value: string): void {
    this.align(ALIGNMENT['s'] ?? 4)
    const raw = Buffer.from(value, 'utf8')
    this.reserved32(raw.length)
    this.raw(raw)
    this.bytes.push(0)
  }

  signature(value: string): void {
    const raw = Buffer.from(value, 'utf8')
    this.bytes.push(raw.length)
    this.raw(raw)
    this.bytes.push(0)
  }

  raw(raw: Uint8Array): void {
    for (const byte of raw) this.bytes.push(byte)
  }

  /** Write a fixed 4-byte value without re-aligning (callers already did). */
  private reserved32(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }
}

/** Marshal one tagged value at the writer's current position. */
export function writeValue(writer: Writer, value: DbusValue): void {
  switch (value.type) {
    case 'byte':
      writer.u8(value.value)
      return
    case 'boolean':
      writer.u32(value.value ? 1 : 0)
      return
    case 'int32':
      writer.align(ALIGNMENT['i'] ?? 4)
      writer.i32(value.value)
      return
    case 'uint32':
      writer.u32(value.value)
      return
    case 'string':
    case 'object-path':
      writer.string(value.value)
      return
    case 'signature':
      writer.signature(value.value)
      return
    case 'variant':
      writer.signature(signatureOf(value.value))
      writeValue(writer, value.value)
      return
    case 'string-array': {
      writer.align(ALIGNMENT['a'] ?? 4)
      const lengthAt = writer.reserve32()
      writer.align(ALIGNMENT['s'] ?? 4)
      const start = writer.length
      for (const entry of value.values) writer.string(entry)
      writer.patch32(lengthAt, writer.length - start)
      return
    }
    case 'dict': {
      writer.align(ALIGNMENT['a'] ?? 4)
      const lengthAt = writer.reserve32()
      writer.align(ALIGNMENT['{'] ?? 8)
      const start = writer.length
      for (const [key, entry] of value.entries) {
        writer.align(ALIGNMENT['{'] ?? 8)
        writer.string(key)
        writeValue(writer, { type: 'variant', value: entry })
      }
      writer.patch32(lengthAt, writer.length - start)
      return
    }
  }
}

/** Marshal a value sequence into one body buffer starting at offset 0. */
export function marshalBody(values: readonly DbusValue[]): Buffer {
  const writer = new Writer(0)
  for (const value of values) writeValue(writer, value)
  return writer.toBuffer()
}

/** D-Bus message types. */
export const MESSAGE_TYPE = {
  methodCall: 1,
  methodReturn: 2,
  error: 3,
  signal: 4,
} as const

/** Header field codes this plugin reads or writes. */
export const FIELD = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8,
  unixFds: 9,
} as const

/** Fixed header size of every D-Bus message. */
const FIXED_HEADER = 16

/** Pad an offset up to the next 8-byte boundary. */
function alignUp(offset: number): number {
  return offset + ((8 - (offset % 8)) % 8)
}

/** Marshal one complete message: fixed header, header fields, then body. */
export function encodeMessage(
  type: number,
  serial: number,
  fields: readonly (readonly [number, DbusValue])[],
  body: readonly DbusValue[] = [],
): Buffer {
  const bodyBuffer = marshalBody(body)
  // Header field array elements begin at absolute offset 16, so the writer's
  // origin is 16 rather than 0.
  const fieldWriter = new Writer(FIXED_HEADER)
  for (const [code, value] of fields) {
    fieldWriter.align(8)
    fieldWriter.u8(code)
    writeValue(fieldWriter, { type: 'variant', value })
  }
  const fieldBuffer = fieldWriter.toBuffer()

  const header = Buffer.alloc(FIXED_HEADER)
  header[0] = 0x6c // 'l': little-endian
  header[1] = type
  header[2] = 0
  header[3] = 1 // protocol version
  header.writeUInt32LE(bodyBuffer.length, 4)
  header.writeUInt32LE(serial, 8)
  header.writeUInt32LE(fieldBuffer.length, 12)

  const padding = Buffer.alloc(alignUp(FIXED_HEADER + fieldBuffer.length) - (FIXED_HEADER + fieldBuffer.length))
  return Buffer.concat([header, fieldBuffer, padding, bodyBuffer])
}

/** Decoded content of one D-Bus message. */
export interface ParsedMessage {
  readonly type: number
  readonly serial: number
  readonly replySerial?: number
  readonly member?: string
  readonly errorName?: string
  readonly signature: string
  readonly body: readonly unknown[]
  /** Bytes this message occupies, so a stream reader knows where to resume. */
  readonly length: number
}

/** Reads primitive values out of one message buffer. */
class Reader {
  constructor(
    private readonly data: Buffer,
    private readonly origin = 0,
    public pos = 0,
  ) {}

  get remaining(): number {
    return this.data.length - this.pos
  }

  align(alignment: number): void {
    while ((this.origin + this.pos) % alignment !== 0) this.pos += 1
  }

  u8(): number {
    const value = this.data.readUInt8(this.pos)
    this.pos += 1
    return value
  }

  u32(): number {
    this.align(4)
    const value = this.data.readUInt32LE(this.pos)
    this.pos += 4
    return value
  }

  u16(): number {
    this.align(2)
    const value = this.data.readUInt16LE(this.pos)
    this.pos += 2
    return value
  }

  string(): string {
    this.align(4)
    const length = this.u32At()
    const value = this.data.toString('utf8', this.pos, this.pos + length)
    this.pos += length + 1
    return value
  }

  signature(): string {
    const length = this.u8()
    const value = this.data.toString('utf8', this.pos, this.pos + length)
    this.pos += length + 1
    return value
  }

  private u32At(): number {
    const value = this.data.readUInt32LE(this.pos)
    this.pos += 4
    return value
  }
}

/** Alignment of a value of the given complete type. */
function alignmentOf(type: string): number {
  if (type.startsWith('(') || type.startsWith('{')) return 8
  if (type.startsWith('a')) return 4
  return ALIGNMENT[type] ?? 4
}

/** Read one complete type from a signature, returning it and the next offset. */
function readType(signature: string, index: number): [string, number] {
  const character = signature[index] ?? ''
  if (character === 'a') {
    const [inner, next] = readType(signature, index + 1)
    return [`a${inner}`, next]
  }
  if (character === '(') {
    let depth = 0
    let cursor = index
    for (; cursor < signature.length; cursor += 1) {
      if (signature[cursor] === '(') depth += 1
      if (signature[cursor] === ')') {
        depth -= 1
        if (depth === 0) return [signature.slice(index, cursor + 1), cursor + 1]
      }
    }
    throw new Error(`dsh-notify: unbalanced struct in signature "${signature}"`)
  }
  if (character === '{') {
    const [key, afterKey] = readType(signature, index + 1)
    const [value, afterValue] = readType(signature, afterKey)
    if (signature[afterValue] !== '}') throw new Error(`dsh-notify: unbalanced dict entry in signature "${signature}"`)
    return [`{${key}${value}}`, afterValue + 1]
  }
  return [character, index + 1]
}

/** Split one signature string into its complete types. */
export function splitSignature(signature: string): string[] {
  const types: string[] = []
  let index = 0
  while (index < signature.length) {
    const [type, next] = readType(signature, index)
    types.push(type)
    index = next
  }
  return types
}

/** Read one value of the given complete type. */
function readValue(reader: Reader, type: string): unknown {
  switch (type) {
    case 'y':
      return reader.u8()
    case 'n':
      reader.align(2)
      return reader.u16()
    case 'b':
      return reader.u32() !== 0
    case 'u':
      return reader.u32()
    case 'i':
      return reader.u32() | 0
    case 's':
    case 'o':
      return reader.string()
    case 'g':
      return reader.signature()
    case 'v': {
      const inner = reader.signature()
      return readValue(reader, inner)
    }
    default:
      break
  }
  if (type.startsWith('a')) {
    const element = type.slice(1)
    reader.align(4)
    const length = reader.u32()
    reader.align(alignmentOf(element))
    const end = reader.pos + length
    const values: unknown[] = []
    while (reader.pos < end) values.push(readValue(reader, element))
    return values
  }
  if (type.startsWith('{')) {
    const [key, value] = splitSignature(type.slice(1, -1)) as [string, string]
    reader.align(8)
    const entry: [unknown, unknown] = [readValue(reader, key), readValue(reader, value)]
    return entry
  }
  throw new Error(`dsh-notify: unsupported D-Bus signature "${type}"`)
}

/** Read a complete value sequence for one signature string. */
function readAll(reader: Reader, signature: string): unknown[] {
  const values: unknown[] = []
  for (const type of splitSignature(signature)) values.push(readValue(reader, type))
  return values
}

/**
 * Decode one message from the front of `data`.
 * @param data - buffered socket bytes.
 * @returns the decoded message, or undefined when more bytes are needed.
 */
export function decodeMessage(data: Buffer): ParsedMessage | undefined {
  if (data.length < FIXED_HEADER) return undefined
  if (data[0] !== 0x6c) throw new Error('dsh-notify: the message bus replied in big-endian, which this client does not speak')
  const type = data.readUInt8(1)
  const bodyLength = data.readUInt32LE(4)
  const serial = data.readUInt32LE(8)
  const fieldsLength = data.readUInt32LE(12)
  const bodyStart = alignUp(FIXED_HEADER + fieldsLength)
  const total = bodyStart + bodyLength
  if (data.length < total) return undefined

  const reader = new Reader(data.subarray(0, total), 0, FIXED_HEADER)
  const fieldsEnd = FIXED_HEADER + fieldsLength
  let replySerial: number | undefined
  let member: string | undefined
  let errorName: string | undefined
  let signature = ''
  while (reader.pos < fieldsEnd) {
    reader.align(8)
    if (reader.pos >= fieldsEnd) break
    const code = reader.u8()
    const value = readValue(reader, reader.signature())
    switch (code) {
      case FIELD.replySerial:
        replySerial = typeof value === 'number' ? value : undefined
        break
      case FIELD.member:
        member = typeof value === 'string' ? value : undefined
        break
      case FIELD.errorName:
        errorName = typeof value === 'string' ? value : undefined
        break
      case FIELD.signature:
        signature = typeof value === 'string' ? value : ''
        break
      default:
        break
    }
  }

  const bodyReader = new Reader(data.subarray(0, total), 0, bodyStart)
  const body = bodyLength > 0 ? readAll(bodyReader, signature) : []

  return { type, serial, replySerial, member, errorName, signature, body, length: total }
}
