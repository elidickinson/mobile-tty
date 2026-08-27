// Shared setup for the e2e specs: a session per test, page readiness, socket
// spying, and the scroll measurements that need a settled baseline.
import { test as base, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { expect }

/**
 * One server, and so one program, per test.
 *
 * The server is the session now, so a shared one would carry typing and history
 * from every earlier test into the next. Port 0 lets the OS pick, which is what
 * keeps tests from colliding on a port still in TIME_WAIT.
 */
export const test = base.extend({
  // Off unless a spec asks for it with test.use({ password }).
  password: [undefined, { option: true }],
  // Folders the picker should offer, named by a spec with test.use({ folders }).
  folders: [[], { option: true }],
  /**
   * A session store shaped like pi's, holding history for folders made here.
   *
   * Every test gets one, empty by default. The point is as much what it keeps
   * out: without it the picker would enumerate the real ~/.pi store, so an e2e
   * run would depend on which projects the machine happens to have.
   */
  store: async ({ folders }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'mtty-e2e-store-'))
    const sessionDir = join(root, 'sessions')
    await mkdir(sessionDir)
    for (const name of folders) {
      const cwd = join(root, name)
      const slug = join(sessionDir, `-${cwd.replaceAll('/', '-')}-`)
      await mkdir(cwd)
      await mkdir(slug)
      await writeFile(join(slug, 'a.jsonl'), `${JSON.stringify({ type: 'session', version: 3, cwd })}\n`)
    }
    await use({ root, sessionDir, at: name => join(root, name) })
    await rm(root, { recursive: true, force: true })
  },
  baseURL: async ({ password, store }, use) => {
    const server = spawn('node',
      ['server/cli.js', '--port', '0', '--', 'tests/fixtures/fake-pi.js'],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          PI_CODING_AGENT_SESSION_DIR: store.sessionDir,
          ...(password ? { MTTY_PASSWORD: password } : {}),
        },
      })
    const port = await new Promise((resolve, reject) => {
      server.stdout.on('data', d => {
        const found = String(d).match(/:(\d+)/)
        if (found) resolve(Number(found[1]))
      })
      server.on('exit', code => reject(new Error(`server exited (${code}) before listening`)))
    })
    await use(`http://127.0.0.1:${port}`)
    server.kill('SIGKILL')
  },
})

export const screenText = page => page.locator('#screen').innerText()

/** Rows of the live grid, excluding the scrollback rendered above it. */
export const liveRows = page => page.locator('#screen .term-row:not(.term-scrollback-row)')

/** Record every frame the client puts on the wire, decoded. */
export const spySocket = page => page.evaluate(() => {
  window.__sent = []
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { window.__sent.push(new TextDecoder().decode(d)); return send.call(this, d) }
})
export const sentFrames = page => page.evaluate(() => window.__sent)
export const ready = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect.poll(() => page.evaluate(() => Boolean(window.mtty?.term?.bridge))).toBe(true)
  // The server decides the grid, so the client is not settled until it has said
  // so. Alone in a test, what we asked for is always what we get.
  await expect.poll(() => page.evaluate(() =>
    window.mtty.state.cols === window.mtty.state.wanted.cols &&
    window.mtty.state.rows === window.mtty.state.wanted.rows)).toBe(true)
}

export const scrollTop = page => page.evaluate(() => document.getElementById('screen').scrollTop)

export const distanceFromBottom = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  return s.scrollHeight - s.scrollTop - s.clientHeight
})

// The view stays pinned to the bottom while wterm renders, so scrollTop climbs
// until the content stops growing. Every scroll assertion needs that baseline.
export const settled = async page => {
  let last = -1
  await expect.poll(async () => {
    const now = await scrollTop(page)
    const stable = now === last
    last = now
    return stable
  }, { intervals: Array(14).fill(150) }).toBe(true)
  return last
}

export const scrollbackCount = page => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount())

/**
 * Sample the scroller and the line under a fixed eye-point, every frame.
 *
 * A reading position is two facts: where the box is (scrollTop) and which line
 * sits at the top of it. The squirm being chased can move either while no
 * finger is down, and it lasts a frame or two — so nothing that asserts after
 * the fact can see it. The trace makes it countable instead.
 *
 * `eye` is the row under a fixed point 60px into the screen: literally the line
 * the reader is looking at, independent of how scrollTop or row indices move.
 * The fixture numbers every line uniquely, so `head` is an identity — content
 * sliding under a still box shows up as an identity change even when the row
 * count, the scrollHeight and the scrollTop are all unchanged (the rebuild's
 * signature). `height` separates the other suspect: growing geometry is the
 * below-cap append path, frozen geometry with moving content is the rebuild.
 *
 * `parkAt` sets scrollTop in the same turn the sampler starts, so the first
 * sample is taken before app.js's scrollback-rebuild timer can fire.
 */
export const startScrollTrace = (page, { parkAt } = {}) => page.evaluate(fraction => {
  cancelAnimationFrame(window.__traceRaf)
  const screen = document.getElementById('screen')
  if (fraction !== undefined) {
    const max = screen.scrollHeight - screen.clientHeight
    screen.scrollTop = Math.round(max * fraction)
  }
  const rect = screen.getBoundingClientRect()
  const eyeX = rect.left + Math.min(200, rect.width / 2)
  const eyeY = rect.top + 60
  window.__trace = []
  const sample = () => {
    // A sample whose eye-point hits nothing is recorded as null, never
    // synthesized from scrollTop: mid-rebuild is exactly when the point can
    // go missing, and a synthesized identity would launder whatever moved the
    // box into a matching trace. Consumers skip nulls.
    const el = document.elementFromPoint(eyeX, eyeY)?.closest('.term-row') ?? null
    window.__trace.push({
      t: Math.round(performance.now()),
      top: Math.round(screen.scrollTop),
      height: screen.scrollHeight,
      head: el?.textContent.slice(0, 24) ?? null,
    })
    window.__traceRaf = requestAnimationFrame(sample)
  }
  window.__traceRaf = requestAnimationFrame(sample)
}, parkAt)

/** Stop sampling and hand back the trace; samples carry test-local time. */
export const stopScrollTrace = page => page.evaluate(() => {
  cancelAnimationFrame(window.__traceRaf)
  const trace = window.__trace ?? []
  window.__trace = null
  return trace
})

/** The line number in a traced head; NaN when the row is not fixture-numbered. */
export const lineNo = head => Number(/(?:scrollback|stream) line (\d+)/.exec(head)?.[1] ?? NaN)

/** Widest swing in line identity over the trace, from its first content sample. */
export const maxHeadShift = trace => {
  const base = lineNo(trace.find(s => s.head != null)?.head)
  if (Number.isNaN(base)) return NaN
  return trace.reduce((m, s) => s.head == null ? m : Math.max(m, Math.abs(lineNo(s.head) - base)), 0)
}

// Push real history above the fold. `/lines` makes the fixture scroll a fixed
// block off the top, so the depth does not depend on the grid or on how many
// keystrokes survive a busy machine.
export const fillScrollback = async page => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines')
  await ta.press('Enter')
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(10)
  return settled(page)
}
