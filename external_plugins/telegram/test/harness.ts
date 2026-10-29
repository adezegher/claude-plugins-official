/**
 * Test harness: a fake Telegram Bot API (in-process HTTP server) plus a real
 * MCP client that spawns server.ts over stdio, pointed at the fake through
 * TELEGRAM_API_ROOT. Nothing here talks to api.telegram.org.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const PLUGIN_DIR = join(import.meta.dir, '..')
// Fake token — the fake API accepts anything. Never a real bot token.
export const FAKE_TOKEN = '123456:TEST-fake-token'
export const BOT = { id: 999, is_bot: true, first_name: 'Test', username: 'test_bot' }

export type ApiCall = {
  method: string
  /** JSON body fields, or multipart text fields (objects are JSON-decoded). */
  params: Record<string, any>
  /** Uploaded files keyed by the parameter that attaches them (photo, document). */
  files: Record<string, { filename: string; size: number }>
}

type Update = Record<string, any> & { update_id: number }

export class FakeTelegram {
  calls: ApiCall[] = []
  private updates: Update[] = []
  private nextUpdateId = 1
  private nextMessageId = 1000
  private server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: req => this.handle(req),
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.server.stop(true)
  }

  /** Queue an update for the next getUpdates poll. */
  push(update: Record<string, any>): void {
    this.updates.push({ ...update, update_id: this.nextUpdateId++ })
  }

  callsTo(method: string): ApiCall[] {
    return this.calls.filter(c => c.method === method)
  }

  /** Calls that put something in a chat (excludes polling and bookkeeping). */
  sends(): ApiCall[] {
    return this.calls.filter(c => /^(send|edit)/.test(c.method) && c.method !== 'sendChatAction')
  }

  reset(): void {
    this.calls = []
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const m = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const method = m[1]
    const { params, files } = await parseBody(req)

    if (method === 'getUpdates') {
      const offset = Number(params.offset ?? 0)
      // Short long-poll: hold up to 200ms so the server's loop stays cheap.
      for (let i = 0; i < 20; i++) {
        const ready = this.updates.filter(u => u.update_id >= offset)
        if (ready.length) return ok(ready)
        await Bun.sleep(10)
      }
      return ok([])
    }

    this.calls.push({ method, params, files })
    const chat = { id: Number(params.chat_id ?? 0), type: 'private' }
    const date = Math.floor(Date.now() / 1000)
    switch (method) {
      case 'getMe':
        return ok(BOT)
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
        return ok({ message_id: this.nextMessageId++, date, chat, text: params.text, caption: params.caption })
      case 'editMessageText':
        return ok({ message_id: Number(params.message_id), date, chat, text: params.text })
      default:
        return ok(true)
    }
  }
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result })
}

async function parseBody(req: Request): Promise<Pick<ApiCall, 'params' | 'files'>> {
  const type = req.headers.get('content-type') ?? ''
  const params: Record<string, any> = {}
  const files: ApiCall['files'] = {}
  if (type.includes('multipart/form-data')) {
    const form = await req.formData()
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') {
        params[k] = decode(v)
      } else {
        files[k] = { filename: (v as File).name, size: (v as File).size }
      }
    }
  } else if (type.includes('json')) {
    Object.assign(params, await req.json())
  }
  // grammy uploads as `photo: "attach://<id>"` plus a part named <id>;
  // key the file by the parameter that references it.
  const byParam: ApiCall['files'] = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.startsWith('attach://') && files[v.slice(9)]) {
      byParam[k] = files[v.slice(9)]
    }
  }
  return { params, files: byParam }
}

// Multipart fields arrive as strings; objects/arrays/numbers/booleans are JSON.
function decode(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

export type Notification = { method: string; params: any }

export type Harness = {
  api: FakeTelegram
  client: Client
  stateDir: string
  notifications: Notification[]
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  waitFor<T>(fn: () => T | undefined | false, ms?: number): Promise<T>
  close(): Promise<void>
}

export async function startHarness(opts: {
  access: Record<string, unknown>
  env?: Record<string, string>
}): Promise<Harness> {
  const api = new FakeTelegram()
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-test-'))
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify(opts.access))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.ts'],
    cwd: PLUGIN_DIR,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_API_ROOT: api.url,
      ...opts.env,
    },
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const notifications: Notification[] = []
  client.fallbackNotificationHandler = async n => {
    notifications.push(n as Notification)
  }
  await client.connect(transport)

  const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) throw new Error('waitFor: timed out')
      await Bun.sleep(10)
    }
  }

  // Polling has started once the server has asked who it is.
  await waitFor(() => api.callsTo('getMe').length > 0)

  return {
    api,
    client,
    stateDir,
    notifications,
    waitFor,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args })
      const content = res.content as { type: string; text: string }[]
      return { text: content.map(c => c.text).join('\n'), isError: res.isError === true }
    },
    async close() {
      await client.close()
      api.stop()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

let msgSeq = 1
export function textMessage(o: {
  chat: Record<string, any>
  from?: Record<string, any>
  text: string
  extra?: Record<string, any>
}): Record<string, any> {
  return {
    message: {
      message_id: msgSeq++,
      date: Math.floor(Date.now() / 1000),
      chat: o.chat,
      from: o.from ?? { id: Number(o.chat.id), is_bot: false, first_name: 'Alec', username: 'alec' },
      text: o.text,
      ...o.extra,
    },
  }
}
