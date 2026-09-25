// The conversation a pi has open, reported by the mtty-session extension as a
// JSON file it replaces by rename. Polled rather than fs.watch because the file
// exists only when the served program is pi -- most programs never write one --
// and watching a directory for a file that may never appear means noise from
// every other tmp file on the machine. Two tiny reads a second is nothing.
// Removing the file is the supervisor's job: it seeds the first one, and it
// needs the last one to outlive the program that reported through it.
import { readFile } from 'node:fs/promises'

const POLL_MS = 500

export function watchIdentity(path, onChange) {
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
      // poll. It is not worth taking down the server -- and the pi it owns --
      // over which conversation is open.
      console.error('server: could not read the identity file', err)
    })
  }, POLL_MS)
  timer.unref()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
