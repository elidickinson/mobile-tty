// The client is built once for the whole run; each test gets its own server.
import { execFileSync } from 'node:child_process'

export default () => execFileSync('node', ['scripts/build.js'], { stdio: 'inherit' })
