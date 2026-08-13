// The status-strip relay. The mtty-footer pi extension writes its snapshot to
// $MTTY_FOOTER; this watches the file and hands each new line to the server
// for broadcast. Polled rather than fs.watch because the file exists only when
// the served program is pi — most programs never create it — and watching the
// directory for a file that may never appear means noise from every other tmp
// file on the machine. Two stats a second is nothing.
import { readFile, stat } from 'node:fs/promises'

const POLL_MS = 500

export function watchFooter(path, onChange) {
  let stopped = false
  let mtime = 0
  let last = null

  const tick = async () => {
    if (stopped) return
    let info
    try {
      info = await stat(path)
    } catch {
      return // not there yet, or the program never writes one
    }
    if (info.mtimeMs === mtime) return
    mtime = info.mtimeMs
    const text = await readFile(path, 'utf8')
    if (text === last) return
    last = text
    onChange(text)
  }

  const timer = setInterval(() => {
    tick().catch(err => {
      // The file appeared and then could not be read. The strip is not coming
      // back on its own, and it is not worth the server — and the pi it owns —
      // over a status line.
      console.error('server: could not read the footer file', err)
    })
  }, POLL_MS)
  timer.unref()

  return () => { stopped = true; clearInterval(timer) }
}
