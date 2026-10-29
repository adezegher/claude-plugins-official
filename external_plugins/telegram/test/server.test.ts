import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHarness, textMessage, type Harness } from './harness'

const ALEC = '111'
const STRANGER = '222'
const GROUP = '-100500'

const access = {
  dmPolicy: 'allowlist',
  allowFrom: [ALEC],
  groups: { [GROUP]: { requireMention: false, allowFrom: [] } },
  pending: {},
}

const scratch = mkdtempSync(join(tmpdir(), 'tg-files-'))
const PNG = join(scratch, 'pic.png')
writeFileSync(PNG, Buffer.from('89504e470d0a1a0a', 'hex'))

let h: Harness

beforeAll(async () => {
  h = await startHarness({ access })
})
afterAll(async () => {
  await h.close()
})
beforeEach(() => {
  h.api.reset()
  h.notifications.length = 0
})

describe('upstream behaviour (unchanged)', () => {
  test('reply sends text to an allowlisted chat', async () => {
    const res = await h.call('reply', { chat_id: ALEC, text: 'hello' })
    expect(res.isError).toBe(false)
    const [send] = h.api.callsTo('sendMessage')
    expect(String(send.params.chat_id)).toBe(ALEC)
    expect(send.params.text).toBe('hello')
  })

  test('reply refuses a chat outside the allowlist without calling the API', async () => {
    const res = await h.call('reply', { chat_id: STRANGER, text: 'hello' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not allowlisted')
    expect(h.api.sends()).toHaveLength(0)
  })

  test('inbound DM from an allowlisted user reaches the session', async () => {
    h.api.push(textMessage({ chat: { id: Number(ALEC), type: 'private' }, text: 'hi James' }))
    const n = await h.waitFor(() => h.notifications.find(n => n.method === 'notifications/claude/channel'))
    expect(n.params.content).toBe('hi James')
    expect(n.params.meta.chat_id).toBe(ALEC)
    expect(n.params.meta.user).toBe('alec')
  })

  test('inbound DM from a stranger is dropped under allowlist policy', async () => {
    h.api.push(textMessage({ chat: { id: Number(STRANGER), type: 'private' }, text: 'let me in' }))
    h.api.push(textMessage({ chat: { id: Number(ALEC), type: 'private' }, text: 'marker' }))
    await h.waitFor(() => h.notifications.find(n => n.params?.content === 'marker'))
    expect(h.notifications.find(n => n.params?.content === 'let me in')).toBeUndefined()
  })

  test('permission buttons still relay allow/deny', async () => {
    h.api.push({
      callback_query: {
        id: 'cb-perm',
        from: { id: Number(ALEC), is_bot: false, first_name: 'Alec' },
        chat_instance: 'x',
        data: 'perm:allow:abcde',
        message: { message_id: 7, date: 0, chat: { id: Number(ALEC), type: 'private' }, text: 'Permission' },
      },
    })
    const n = await h.waitFor(() =>
      h.notifications.find(n => n.method === 'notifications/claude/channel/permission'),
    )
    expect(n.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
    await h.waitFor(() => h.api.callsTo('answerCallbackQuery').length > 0)
  })
})

describe('forum topics', () => {
  test('inbound topic message carries message_thread_id and is_topic_message', async () => {
    h.api.push(textMessage({
      chat: { id: Number(GROUP), type: 'supergroup', is_forum: true },
      from: { id: Number(ALEC), is_bot: false, first_name: 'Alec', username: 'alec' },
      text: 'in travel',
      extra: { message_thread_id: 42, is_topic_message: true },
    }))
    const n = await h.waitFor(() => h.notifications.find(n => n.params?.content === 'in travel'))
    expect(n.params.meta.chat_id).toBe(GROUP)
    expect(n.params.meta.message_thread_id).toBe('42')
    expect(n.params.meta.is_topic_message).toBe('true')
  })

  test('inbound message in General or a DM has no thread meta', async () => {
    h.api.push(textMessage({ chat: { id: Number(ALEC), type: 'private' }, text: 'plain' }))
    const n = await h.waitFor(() => h.notifications.find(n => n.params?.content === 'plain'))
    expect(n.params.meta.message_thread_id).toBeUndefined()
    expect(n.params.meta.is_topic_message).toBeUndefined()
  })

  test('reply passes message_thread_id on every chunk and file', async () => {
    const res = await h.call('reply', {
      chat_id: GROUP,
      text: 'x'.repeat(5000),
      message_thread_id: '42',
      files: [PNG],
    })
    expect(res.isError).toBe(false)
    const msgs = h.api.callsTo('sendMessage')
    expect(msgs).toHaveLength(2)
    for (const m of msgs) expect(m.params.message_thread_id).toBe(42)
    const [photo] = h.api.callsTo('sendPhoto')
    expect(photo.params.message_thread_id).toBe(42)
    expect(photo.files.photo.size).toBe(8)
  })

  test('reply without message_thread_id sends none', async () => {
    await h.call('reply', { chat_id: GROUP, text: 'general' })
    expect(h.api.callsTo('sendMessage')[0].params.message_thread_id).toBeUndefined()
  })

  test('reply rejects a non-numeric message_thread_id', async () => {
    const res = await h.call('reply', { chat_id: GROUP, text: 'x', message_thread_id: 'travel' })
    expect(res.isError).toBe(true)
    expect(h.api.sends()).toHaveLength(0)
  })

  test('a thread id does not open a chat outside the allowlist', async () => {
    const res = await h.call('reply', { chat_id: '-100999', text: 'x', message_thread_id: '42' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not allowlisted')
    expect(h.api.sends()).toHaveLength(0)
  })
})

describe('silent delivery', () => {
  test('disable_notification reaches every chunk and file', async () => {
    const res = await h.call('reply', {
      chat_id: ALEC,
      text: 'y'.repeat(5000),
      disable_notification: true,
      files: [PNG],
    })
    expect(res.isError).toBe(false)
    const sends = h.api.sends()
    expect(sends).toHaveLength(3)
    for (const s of sends) expect(s.params.disable_notification).toBe(true)
  })

  test('sends notify by default', async () => {
    await h.call('reply', { chat_id: ALEC, text: 'loud' })
    expect(h.api.callsTo('sendMessage')[0].params.disable_notification).toBeUndefined()
  })
})
