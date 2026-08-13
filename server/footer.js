// The status-strip relay. The mtty-footer pi extension writes its snapshot to
// $MTTY_FOOTER; this watches the file and hands each new line to the server
// for broadcast. Polled rather than fs.watch because the file exists only when
// the served program is pi — most programs never create it — and watching the
// directory for a file that may never appear means noise from every other tmp
// file on the machine. Two tiny reads a second is nothing.
import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const POLL_MS = 500

export function removeFooterFiles(path) {
  rmSync(path, { force: true })
  rmSync(`${path}.tmp`, { force: true })
}

export function watchFooter(path, onChange) {
  let stopped = false
  let last = null

  const tick = async () => {
    if (stopped) return
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return // not there yet, or the program never writes one
      throw err
    }
    if (stopped) return
    if (text === last) return
    last = text
    onChange(text)
  }

  const timer = setInterval(() => {
    tick().catch(err => {
      // A file that appeared and then could not be read is retried on the next
      // poll. It is not worth taking down the server — and the pi it owns —
      // over a status line.
      console.error('server: could not read the footer file', err)
    })
  }, POLL_MS)
  timer.unref()

  return () => {
    stopped = true
    clearInterval(timer)
    removeFooterFiles(path)
  }
}
