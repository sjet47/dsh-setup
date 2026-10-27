/**
 * A minimal D-Bus session-bus client: EXTERNAL authentication, one persistent
 * socket, method calls with reply matching.
 *
 * Notifications travel over the bus directly instead of through `notify-send`,
 * so the plugin has no runtime dependency on libnotify and can reuse the
 * notification id the daemon returns.
 * @module dsh-notify/dbus
 */
import { connect, type Socket } from 'node:net'
import { decodeMessage, encodeMessage, FIELD, MESSAGE_TYPE, signatureOf, type DbusValue } from './marshal.js'

/** Where the session bus listens, resolved from the standard environment. */
export interface BusTarget {
  readonly path?: string
  readonly abstract?: string
}

/**
 * Resolve the session bus address.
 *
 * `DBUS_SESSION_BUS_ADDRESS` is a `;`-separated list of transports with
 * percent-encoded values; only the `unix` transport can carry a local
 * notification, and the first usable entry wins. Without the variable the
 * per-user bus socket is the fallback, which is where both systemd and the
 * desktop session put it.
 * @param address - raw address value, defaulting to the process environment.
 * @returns the socket target, or undefined when no local bus address exists.
 */
export function resolveBusTarget(address = process.env['DBUS_SESSION_BUS_ADDRESS']): BusTarget | undefined {
  if (address !== undefined && address !== '') {
    for (const entry of address.split(';')) {
      if (!entry.startsWith('unix:')) continue
      const parameters = new Map<string, string>()
      for (const pair of entry.slice('unix:'.length).split(',')) {
        const index = pair.indexOf('=')
        if (index <= 0) continue
        parameters.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)))
      }
      const path = parameters.get('path')
      if (path !== undefined && path !== '') return { path }
      const abstract = parameters.get('abstract')
      if (abstract !== undefined && abstract !== '') return { abstract }
    }
    return undefined
  }
  const uid = process.getuid?.()
  return uid === undefined ? undefined : { path: `/run/user/${uid}/bus` }
}

/** A method call sent to the bus. */
export interface BusCall {
  readonly destination?: string
  readonly path: string
  readonly interfaceName: string
  readonly member: string
  readonly body?: readonly DbusValue[]
}

/** A pending call waiting for its reply. */
interface Pending {
  readonly resolve: (body: readonly unknown[]) => void
  readonly reject: (error: Error) => void
}

/**
 * One authenticated session-bus connection.
 *
 * Calls are matched to replies by serial. The connection is created on demand
 * and reopened after a bus restart; a socket failure rejects every call still
 * waiting on it.
 */
export class SessionBus {
  private socket: Socket | undefined
  private buffer: Buffer = Buffer.alloc(0)
  private serial = 1
  private readonly pending = new Map<number, Pending>()
  private opening: Promise<Socket> | undefined
  private closed = false

  /**
   * @param target - bus socket; unresolved addresses disable the client.
   * @param timeoutMs - per-call budget before the connection is dropped.
   */
  constructor(
    private readonly target: BusTarget | undefined = resolveBusTarget(),
    private readonly timeoutMs = 4000,
  ) {}

  /** Whether a local bus socket was found at construction time. */
  get available(): boolean {
    return this.target !== undefined && !this.closed
  }

  /**
   * Send one method call and wait for its reply.
   * @param call - destination, path, interface, member and tagged body.
   * @returns the reply body values.
   * @throws when no bus is reachable, the call times out, or the daemon replies with an error.
   */
  async call(call: BusCall): Promise<readonly unknown[]> {
    const socket = await this.ensureConnected()
    const serial = this.serial++
    const fields: Array<readonly [number, DbusValue]> = [
      [FIELD.path, { type: 'object-path', value: call.path }],
      [FIELD.interface, { type: 'string', value: call.interfaceName }],
      [FIELD.member, { type: 'string', value: call.member }],
    ]
    if (call.destination !== undefined) fields.push([FIELD.destination, { type: 'string', value: call.destination }])
    const body = call.body ?? []
    if (body.length > 0) fields.push([FIELD.signature, { type: 'signature', value: body.map(signatureOf).join('') }])

    return await new Promise<readonly unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(new Error(`dsh-notify: ${call.interfaceName}.${call.member} timed out after ${this.timeoutMs}ms`))
        this.destroy(new Error('dsh-notify: bus connection dropped after a timeout'))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(serial, {
        resolve: (values) => {
          clearTimeout(timer)
          resolve(values)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      socket.write(encodeMessage(MESSAGE_TYPE.methodCall, serial, fields, body))
    })
  }

  /** Shut the client down for good; a failed call, by contrast, reconnects. */
  close(): void {
    this.closed = true
    this.destroy(new Error('dsh-notify: bus connection closed'))
  }

  private destroy(error: Error): void {
    const socket = this.socket
    this.socket = undefined
    this.opening = undefined
    this.buffer = Buffer.alloc(0)
    if (socket !== undefined) socket.destroy()
    for (const [serial, pending] of this.pending) {
      this.pending.delete(serial)
      pending.reject(error)
    }
  }

  private async ensureConnected(): Promise<Socket> {
    if (!this.available) throw new Error('dsh-notify: no D-Bus session bus address is available')
    if (this.socket !== undefined) return this.socket
    this.opening ??= this.open()
    try {
      return await this.opening
    } finally {
      this.opening = undefined
    }
  }

  /** Connect, authenticate, and introduce the connection with `Hello`. */
  private async open(): Promise<Socket> {
    const socket = await this.openSocket()
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    socket.on('error', (error: Error) => {
      if (this.socket === socket) this.destroy(error)
    })
    socket.on('close', () => {
      if (this.socket === socket) this.destroy(new Error('dsh-notify: the session bus closed the connection'))
    })
    // The bus only routes messages after Hello names the connection.
    await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interfaceName: 'org.freedesktop.DBus',
      member: 'Hello',
    })
    return socket
  }

  private async openSocket(): Promise<Socket> {
    const target = this.target
    if (target === undefined) throw new Error('dsh-notify: no D-Bus session bus address is available')
    const socket = connect(target.path !== undefined ? { path: target.path } : { path: `\0${target.abstract ?? ''}` })
    socket.setNoDelay(true)
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        socket.off('connect', onConnect)
        reject(error)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
    const leftover = await authenticate(socket)
    if (leftover.length > 0) {
      this.buffer = Buffer.concat([this.buffer, leftover])
    }
    return socket
  }

  /** Consume every complete message in the buffer and settle its waiter. */
  private drain(): void {
    for (;;) {
      let message
      try {
        message = decodeMessage(this.buffer)
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (message === undefined) return
      this.buffer = this.buffer.subarray(message.length)
      if (message.type !== MESSAGE_TYPE.methodReturn && message.type !== MESSAGE_TYPE.error) continue
      const serial = message.replySerial
      if (serial === undefined) continue
      const pending = this.pending.get(serial)
      if (pending === undefined) continue
      this.pending.delete(serial)
      if (message.type === MESSAGE_TYPE.error) {
        const name = message.errorName ?? 'org.freedesktop.DBus.Error.Failed'
        const detail = typeof message.body[0] === 'string' ? message.body[0] : ''
        pending.reject(new Error(detail === '' ? name : `${name}: ${detail}`))
      } else {
        pending.resolve(message.body)
      }
    }
  }
}

/**
 * Authenticate the socket with the EXTERNAL mechanism: the kernel already
 * proved our uid to the bus, so the uid is the whole credential.
 * @param socket - freshly connected socket.
 * @returns bytes received after the `OK` line, which begin the message stream.
 */
function authenticate(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const index = buffer.indexOf(0x0a)
        if (index === -1) return
        const line = buffer.subarray(0, index).toString('utf8').replaceAll('\r', '')
        buffer = buffer.subarray(index + 1)
        if (line.startsWith('OK')) {
          cleanup()
          socket.write('BEGIN\r\n')
          resolve(buffer)
          return
        }
        if (line.startsWith('REJECTED') || line.startsWith('ERROR')) {
          cleanup()
          reject(new Error(`dsh-notify: bus authentication failed: ${line}`))
          return
        }
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('dsh-notify: the session bus closed during authentication'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    const uid = process.getuid?.() ?? 0
    socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`)]))
  })
}
