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

describe('inline buttons', () => {
  const buttons = [
    [{ text: 'Approve', callback_data: 'appr:17:yes' }, { text: 'Decline', callback_data: 'appr:17:no' }],
    [{ text: 'Later', callback_data: 'appr:17:later' }],
  ]

  test('reply renders buttons as inline_keyboard on the last chunk only', async () => {
    const res = await h.call('reply', { chat_id: ALEC, text: 'z'.repeat(5000), buttons })
    expect(res.isError).toBe(false)
    const [first, last] = h.api.callsTo('sendMessage')
    expect(first.params.reply_markup).toBeUndefined()
    expect(last.params.reply_markup).toEqual({ inline_keyboard: buttons })
  })

  test('edit_message can replace buttons, and omitting them sends no markup', async () => {
    await h.call('edit_message', { chat_id: ALEC, message_id: '5', text: 'v2', buttons: [[buttons[1][0]]] })
    await h.call('edit_message', { chat_id: ALEC, message_id: '5', text: 'done' })
    const [withButtons, without] = h.api.callsTo('editMessageText')
    expect(withButtons.params.reply_markup).toEqual({ inline_keyboard: [[buttons[1][0]]] })
    expect(without.params.reply_markup).toBeUndefined()
  })

  test('invalid buttons are rejected before anything is sent', async () => {
    const cases = [
      [[{ text: 'x', callback_data: 'd'.repeat(65) }]],
      [[{ text: 'x', callback_data: 'perm:allow:abcde' }]],
      [[{ text: '', callback_data: 'ok' }]],
      [[]],
      'not-an-array',
    ]
    for (const b of cases) {
      const res = await h.call('reply', { chat_id: ALEC, text: 'x', buttons: b })
      expect(res.isError).toBe(true)
    }
    expect(h.api.sends()).toHaveLength(0)
  })

  test('buttons do not open a chat outside the allowlist', async () => {
    const res = await h.call('reply', { chat_id: STRANGER, text: 'x', buttons })
    expect(res.isError).toBe(true)
    expect(h.api.sends()).toHaveLength(0)
  })

  test('a press in a topic reaches the session and is answered', async () => {
    h.api.push({
      callback_query: {
        id: 'cb-1',
        from: { id: Number(ALEC), is_bot: false, first_name: 'Alec', username: 'alec' },
        chat_instance: 'x',
        data: 'appr:17:yes',
        message: {
          message_id: 321,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(GROUP), type: 'supergroup', is_forum: true },
          message_thread_id: 7,
          is_topic_message: true,
          text: 'Pay the Marriott folio?',
          reply_markup: { inline_keyboard: buttons },
        },
      },
    })
    const n = await h.waitFor(() => h.notifications.find(n => n.params?.meta?.callback_data))
    expect(n.method).toBe('notifications/claude/channel')
    expect(n.params.content).toBe('(button: Approve)')
    expect(n.params.meta).toMatchObject({
      chat_id: GROUP,
      message_id: '321',
      message_thread_id: '7',
      is_topic_message: 'true',
      user: 'alec',
      user_id: ALEC,
      callback_data: 'appr:17:yes',
      button_text: 'Approve',
    })
    const [answer] = await h.waitFor(() => {
      const a = h.api.callsTo('answerCallbackQuery')
      return a.length ? a : undefined
    })
    expect(answer.params.callback_query_id).toBe('cb-1')
    expect(answer.params.text).toBeUndefined()
  })

  test('a press in a DM from an allowlisted user is delivered', async () => {
    h.api.push({
      callback_query: {
        id: 'cb-2',
        from: { id: Number(ALEC), is_bot: false, first_name: 'Alec', username: 'alec' },
        chat_instance: 'x',
        data: 'brief:more',
        message: { message_id: 9, date: 1, chat: { id: Number(ALEC), type: 'private' }, text: 'Brief' },
      },
    })
    const n = await h.waitFor(() => h.notifications.find(n => n.params?.meta?.callback_data === 'brief:more'))
    expect(n.params.content).toBe('(button: brief:more)')
    expect(n.params.meta.message_thread_id).toBeUndefined()
  })

  test('a press from someone outside the allowlist is answered but not delivered', async () => {
    h.api.push({
      callback_query: {
        id: 'cb-3',
        from: { id: Number(STRANGER), is_bot: false, first_name: 'Eve' },
        chat_instance: 'x',
        data: 'appr:17:yes',
        message: { message_id: 10, date: 1, chat: { id: Number(STRANGER), type: 'private' }, text: 'x' },
      },
    })
    const [answer] = await h.waitFor(() => {
      const a = h.api.callsTo('answerCallbackQuery')
      return a.length ? a : undefined
    })
    expect(answer.params.text).toBe('Not authorized.')
    await Bun.sleep(100)
    expect(h.notifications.find(n => n.params?.meta?.callback_data)).toBeUndefined()
  })

  test('a press in a group that is not enabled is not delivered', async () => {
    h.api.push({
      callback_query: {
        id: 'cb-4',
        from: { id: Number(ALEC), is_bot: false, first_name: 'Alec' },
        chat_instance: 'x',
        data: 'appr:17:yes',
        message: { message_id: 11, date: 1, chat: { id: -100999, type: 'supergroup' }, text: 'x' },
      },
    })
    await h.waitFor(() => h.api.callsTo('answerCallbackQuery').length > 0)
    await Bun.sleep(100)
    expect(h.notifications.find(n => n.params?.meta?.callback_data)).toBeUndefined()
  })
})
