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

const [command, ...args] = rest()
if (!command) {
  console.error('usage: node server/cli.js --port N --bind ADDR --index FILE -- <command...>')
  process.exit(2)
}

const server = createTerminalServer({
  port: Number(arg('--port') ?? 7681),
  bind: arg('--bind') ?? '127.0.0.1',
  index: arg('--index') ?? 'dist/client.html',
  command,
  args,
  onListen: ({ port, bind }) => console.log(`listening on http://${bind}:${port}`),
  // pi exiting is the session ending, and the session is what this process is
  // for. Anything else would leave a server serving a terminal that is gone.
  onExit: ({ exitCode }) => server.close().then(() => process.exit(exitCode ?? 0)),
})

// A viewer must never be able to take the session down with it, so the last
// line of defence is here rather than in the connection handler.
process.on('uncaughtException', err => {
  console.error('server: uncaught', err)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close().then(() => process.exit(0)))
}
