// Who is allowed to open a socket to the terminal.
//
// A WebSocket handshake is exempt from the same-origin policy and has no
// preflight, so any page in any tab can open one to `ws://127.0.0.1:7681/ws`
// and start typing into pi. Binding to loopback does not help — the browser is
// on this machine. `Origin` is the only thing that separates the real client
// from a hostile page, and browsers cannot set it themselves.

// A rebound name is still a name, and a browser sends a literal address as Host
// only when the page it came from was loaded from that address. `localhost`
// resolves locally rather than through DNS, so it cannot be rebound either.
const LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i

const withoutPort = value =>
  value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0]

/** An address, unlike a name, is not something DNS can be made to lie about. */
export const isAddress = host => {
  const name = withoutPort(host)
  return name === 'localhost' || LITERAL.test(name)
}

/**
 * `hostname` is the one name a proxy is allowed to present, given with
 * `--hostname`. It has to be declared rather than discovered: a hostname is
 * trustworthy exactly when the operator asserted it, because producing a
 * plausible-looking name is the whole of the DNS rebinding trick.
 */
export function originAllowed({ origin, host, hostname }) {
  // Nothing but a browser sends Origin, and nothing but a browser is bound by
  // it — attach, curl and the tests send none, and an attacker who is not a
  // browser forges whatever it likes. Refusing a missing one costs attach and
  // buys nothing.
  if (!origin) return true
  if (!host) return false

  // Host is attacker-controlled, so Origin matching it is not enough on its
  // own: rebinding makes both of them say evil.com.
  if (!isAddress(host) && withoutPort(host) !== hostname) return false

  // Scheme is deliberately not compared. `URL.host` drops default ports, so
  // http://name and https://name both reduce to `name`; a page on plain http
  // could then pass a wss:// handshake to the terminal. That needs an
  // attacker-controlled http endpoint on the same declared hostname, which the
  // threat this check addresses (a page on some other site) does not have.
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
