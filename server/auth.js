// An opt-in password, for a network you trust rather than the open internet.
//
// It has to be a cookie. Basic auth cannot work here whatever the server does:
// Safari puts no Authorization header on a WebSocket handshake and the page has
// no way to add one, so the terminal would never connect. A cookie is the one
// credential a browser carries onto a handshake.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE = 'mtty'
const A_MONTH = 60 * 60 * 24 * 30
// A login form is a few hundred bytes. Anything larger is not one.
const MAX_BODY = 1024

const digest = value => createHash('sha256').update(value).digest()

export class Auth {
  // In memory only. A restart invalidates every token, and a restart has
  // already killed the program, so a login outliving the session was never
  // worth anything to keep.
  #tokens = new Set()
  #password

  constructor(password) {
    this.#password = password
  }

  get required() {
    return Boolean(this.#password)
  }

  admits(req) {
    if (!this.required) return true
    const token = req.headers.cookie?.split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1)
    return Boolean(token) && this.#tokens.has(token)
  }

  // Hashed before comparing so both sides are the same length, which is what
  // timingSafeEqual needs and what keeps the length of the real one quiet.
  accepts(attempt) {
    return timingSafeEqual(digest(attempt), digest(this.#password))
  }

  /** A new token, and the Set-Cookie that carries it. */
  grant({ secure }) {
    const token = randomBytes(32).toString('hex')
    this.#tokens.add(token)
    // Strict: this cookie exists to open a shell, and no other site has any
    // business causing a request that carries it.
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${A_MONTH}` +
      (secure ? '; Secure' : '')
  }
}

/** The submitted password, or null if the body is not a login. */
export async function submittedPassword(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) return null
  }
  return new URLSearchParams(body).get('password')
}

export const loginPage = (refused = false) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mobile-tty</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#0b0b0d">
<style>
  html { color-scheme: dark }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0b0b0d; color: #e8e8ea;
         font: 16px/1.4 ui-sans-serif, system-ui, sans-serif }
  form { display: grid; gap: 12px; width: min(20rem, 82vw) }
  input, button { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #303036 }
  input { background: #17171b; color: inherit }
  button { background: #2b6cb0; color: #fff; border-color: transparent }
  p { margin: 0; color: #ff6b6b; font-size: 14px }
</style>
</head>
<body>
<form method="post" action="/login">
  ${refused ? '<p>Not that one.</p>' : ''}
  <input type="password" name="password" autocomplete="current-password"
         placeholder="password" aria-label="password" autofocus>
  <button type="submit">Open terminal</button>
</form>
</body>
</html>
`
