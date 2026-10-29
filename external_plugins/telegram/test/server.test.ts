import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
