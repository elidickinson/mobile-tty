// Map native tap coordinates to page clientX/clientY by watching a DOM listener.
import { remote } from 'webdriverio'

const UDID = process.env.MTTY_SIM_UDID ?? 'E9AABE3B-1541-49AF-83F4-7921C902F5E8'
const b = await remote({ hostname: '127.0.0.1', port: 4723, logLevel: 'error',
  capabilities: { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': UDID,
    'appium:bundleId': 'com.apple.mobilesafari', 'appium:noReset': true } })
const ctx = (await b.getContexts()).find(c => /WEBVIEW/.test(c))
await b.switchContext(ctx)
// Dismiss the keyboard first via the app's own key (native element, y~423).
await b.switchContext('NATIVE_APP')
const kb = (await b.$$('-ios class chain:**/XCUIElementTypeButton[`name == "keyboard"`]'))[0]
// Only toggle if the OSK is up: check for the letter keyboard keys = button "A" or "Q".
const oskUp = (await b.$$('-ios class chain:**/XCUIElementTypeButton[`name == "A"`]')).length > 0
  || (await b.$$('-ios class chain:**/XCUIElementTypeKey')).length > 10
console.log('keyboard up before:', oskUp)
if (oskUp && kb) { await kb.click(); await new Promise(r => setTimeout(r, 800)) }

await b.switchContext(ctx)
console.log('after-dismiss screen rect:', JSON.stringify(await b.execute(() => {
  const r = document.getElementById('screen').getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
})))
await b.execute(() => {
  window.__taps = []
  const s = document.getElementById('screen')
  s.addEventListener('pointerdown', e => window.__taps.push({ cx: Math.round(e.clientX), cy: Math.round(e.clientY), type: e.pointerType }), { passive: true })
  s.addEventListener('touchstart', e => window.__taps.push({ cx: Math.round(e.touches[0].clientX), cy: Math.round(e.touches[0].clientY), type: 'touch' }), { passive: true })
})
const probes = [[100, 200], [200, 300], [200, 500], [200, 800], [300, 400]]
await b.switchContext('NATIVE_APP')
for (const [x, y] of probes) {
  await b.executeScript('mobile: tap', [{ x, y }])
  await new Promise(r => setTimeout(r, 250))
  await b.switchContext(ctx)
  const t = await b.execute(() => window.__taps.splice(0))
  console.log(`native(${x},${y}) -> page:`, JSON.stringify(t))
  await b.switchContext('NATIVE_APP')
}
await b.deleteSession()
