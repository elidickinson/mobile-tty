// Command line for the server, so `mobile-tty serve` can start it the way it
// started ttyd. The server owns the session, so this process ending ends pi.
import { createTerminalServer } from './index.js'

const arg = name => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const rest = () => {
  const i = process.argv.indexOf('--')
  return i === -1 ? [] : process.argv.slice(i + 1)
}

// A flag given no value, or a typo, would otherwise reach node-pty or xterm as
// NaN and fail somewhere far from the mistake.
const number = (name, fallback) => {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} needs a whole number, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return n
}

const [command, ...args] = rest()
if (!command) {
  console.error('usage: node server/cli.js --port N --bind ADDR --scrollback N -- <command...>')
  process.exit(2)
}

const server = createTerminalServer({
  port: number('--port', 7681),
  bind: arg('--bind') ?? '127.0.0.1',
  scrollback: number('--scrollback', 500),
  command,
  args,
  onListen: ({ port, bind }) => console.log(`listening on http://${bind}:${port}`),
  // pi exiting is the session ending, and the session is what this process is
  // for. Anything else would leave a server serving a terminal that is gone.
  onExit: ({ exitCode }) => server.close().then(() => process.exit(exitCode ?? 0)),
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close().then(() => process.exit(0)))
}
