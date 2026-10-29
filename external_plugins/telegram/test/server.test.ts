import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs'
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

// send_file roots: ROOT holds sendable files; scratch (PNG) is outside it.
const ROOT = join(scratch, 'root')
mkdirSync(join(ROOT, 'out'), { recursive: true })
const ROOT_PNG = join(ROOT, 'out', 'folio.png')
const ROOT_PDF = join(ROOT, 'out', 'folio.pdf')
writeFileSync(ROOT_PNG, Buffer.from('89504e470d0a1a0a', 'hex'))
writeFileSync(ROOT_PDF, '%PDF-1.4 test')
symlinkSync(PNG, join(ROOT, 'escape.png'))

let h: Harness

beforeAll(async () => {
  h = await startHarness({ access, env: { TELEGRAM_FILE_ROOTS: `${ROOT}:/nonexistent-root` } })
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

describe('send_file', () => {
  test('sends an image under a root as a photo with caption, topic, silence and buttons', async () => {
    const buttons = [[{ text: 'File it', callback_data: 'file:folio' }]]
    const res = await h.call('send_file', {
      chat_id: GROUP,
      path: ROOT_PNG,
      caption: 'Marriott folio',
      message_thread_id: '9',
      disable_notification: true,
      buttons,
    })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('sent photo')
    const [photo] = h.api.callsTo('sendPhoto')
    expect(photo.files.photo).toEqual({ filename: 'folio.png', size: 8 })
    expect(photo.params).toMatchObject({
      chat_id: Number(GROUP),
      caption: 'Marriott folio',
      message_thread_id: 9,
      disable_notification: true,
      reply_markup: { inline_keyboard: buttons },
    })
  })

  test('sends other files as documents', async () => {
    const res = await h.call('send_file', { chat_id: ALEC, path: ROOT_PDF, caption: 'pdf' })
    expect(res.text).toContain('sent document')
    const [doc] = h.api.callsTo('sendDocument')
    expect(doc.files.document.filename).toBe('folio.pdf')
    expect(doc.params.caption).toBe('pdf')
    expect(doc.params.message_thread_id).toBeUndefined()
    expect(doc.params.disable_notification).toBeUndefined()
  })

  test('as: document keeps an image as the original file', async () => {
    await h.call('send_file', { chat_id: ALEC, path: ROOT_PNG, as: 'document' })
    expect(h.api.callsTo('sendDocument')).toHaveLength(1)
    expect(h.api.callsTo('sendPhoto')).toHaveLength(0)
  })

  test('refuses paths outside the roots, traversal, symlink escapes and relative paths', async () => {
    for (const path of [PNG, join(ROOT, '..', 'pic.png'), join(ROOT, 'escape.png'), 'root/out/folio.png', join(ROOT, 'nope.png')]) {
      const res = await h.call('send_file', { chat_id: ALEC, path })
      expect(res.isError).toBe(true)
    }
    expect(h.api.sends()).toHaveLength(0)
  })

  test('refuses a chat outside the allowlist even for an allowed file', async () => {
    const res = await h.call('send_file', { chat_id: STRANGER, path: ROOT_PNG })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not allowlisted')
    expect(h.api.sends()).toHaveLength(0)
  })

  test('refuses an over-long caption', async () => {
    const res = await h.call('send_file', { chat_id: ALEC, path: ROOT_PDF, caption: 'c'.repeat(1025) })
    expect(res.isError).toBe(true)
    expect(h.api.sends()).toHaveLength(0)
  })
})

describe('send_file default root', () => {
  let d: Harness
  const home = mkdtempSync(join(tmpdir(), 'tg-home-'))
  const jamesFile = join(home, '.james', 'outbox', 'note.txt')

  beforeAll(async () => {
    mkdirSync(join(home, '.james', 'outbox'), { recursive: true })
    writeFileSync(jamesFile, 'hello')
    d = await startHarness({ access, env: { HOME: home } })
  })
  afterAll(async () => {
    await d.close()
  })

  test('allows ~/.james and nothing else when TELEGRAM_FILE_ROOTS is unset', async () => {
    const ok = await d.call('send_file', { chat_id: ALEC, path: jamesFile })
    expect(ok.isError).toBe(false)
    const bad = await d.call('send_file', { chat_id: ALEC, path: ROOT_PDF })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('.james')
    expect(d.api.sends()).toHaveLength(1)
  })
})

describe('tool schemas', () => {
  test('list the new parameters and the send_file tool', async () => {
    const { tools } = await h.client.listTools()
    const byName = Object.fromEntries(tools.map(t => [t.name, t.inputSchema as any]))
    expect(Object.keys(byName).sort()).toEqual(['download_attachment', 'edit_message', 'react', 'reply', 'send_file'])
    expect(Object.keys(byName.reply.properties)).toEqual(
      expect.arrayContaining(['message_thread_id', 'disable_notification', 'buttons']),
    )
    expect(byName.reply.required).toEqual(['chat_id', 'text'])
    expect(byName.edit_message.properties.buttons).toBeDefined()
    expect(byName.send_file.required).toEqual(['chat_id', 'path'])
  })
})
