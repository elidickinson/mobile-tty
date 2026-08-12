// Command line for the server, so `mobile-tty serve` can start it the same way
// it started ttyd.
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

createTerminalServer({
  port: Number(arg('--port') ?? 7681),
  bind: arg('--bind') ?? '127.0.0.1',
  index: arg('--index') ?? 'dist/client.html',
  command,
  args,
  onListen: ({ port, bind }) => console.log(`listening on http://${bind}:${port}`),
})
