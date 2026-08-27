# iOS touch-physics PoC (Simulator Safari + Appium XCUITest)

Runs mobile-tty in the iOS Simulator's Safari with **real touch physics** -- the
three behaviors Playwright WebKit cannot reach (momentum deceleration, the
programmatic-write wedge, and the held-finger quiet window) become observable.

Route chosen: **Appium 3 + the XCUITest driver over WebDriverAgent**, one
session with two contexts used alternately:

- `NATIVE_APP`: UIKit-level gestures (`performActions` pointer streams with real
  finger-down / stroke velocity / finger-up -- this is what the W3C actions API
  becomes on iOS). Any WebKit "this is a user gesture" state that the app checks
  (`navigator.userActivation`, `e.isTrusted`) is genuinely true.
- `WEBVIEW_…`: the same simulator Safari as a WebKit remote-inspection target.
  `executeScript` into this context is real JS in the page: `window.mtty`,
  `#screen.scrollTop`, and DOM state all read back faithfully.

Why this route (alternatives considered):

- safaridriver cannot inject touch -- no gesture axis.
- idb/applesimutils gestures go through a separate, sim-level channel: momentum
  exists, but there is no JS readback from the same session.
- A homemade XCUITest project needs an Xcode target just to wrap WDA, which
  already has one. Appium is that target, without the project.
- WebKit's WebDriver on sim is remote-debug only, no UIKit gestures. Appium
  covers this too.

## Setup (verified on this machine, Xcode 26.6 / iOS 26.5)

```sh
# One-time: driver + runtime deps (kept out of the repo -- Appium lives in /tmp).
npm install --prefix /tmp/appium-root appium                # ~274 pkgs, ~1 min
env PATH=/tmp/appium-root/node_modules/.bin:$PATH appium driver install xcuitest

# This folder only: webdriverio client for the PoC script.
cd tests/ios && npm install
```

## Run

```sh
cd /path/to/mobile-tty
bash tests/ios/run.sh            # boots server + sim + appium if needed, then the PoC
node tests/ios/momentum-poc.mjs momentum
node tests/ios/momentum-poc.mjs wedge
node tests/ios/momentum-poc.mjs all
```

`run.sh` starts the dev server on **8199** (so a concurrently running Playwright
on 7681 is undisturbed), reuses any booted simulator or boots "iPhone 17 Pro",
and starts Appium on 4723. The PoC targets `MTTY_SIM_UDID` when set. Results go
to `tests/ios/trace-results.json`.

## What the PoC does

1. Reloads the app, types `/lines 400` through the **on-screen keyboard** (real
   OSK taps into the focused textarea -> WebSocket -> fake-pi) until scrollback
   is ~400 rows deep. Dismisses the OSK via the app's own key-bar button so the
   page is full-height.
2. **Momentum flick**: parks `scrollTop` off the bottom, samples
   `screen.scrollTop` into a page-side array every 20ms (fire-and-forget: Node
   polls the array, nothing in the page awaits), flicks 0→100ms through the
   center of `#screen` at a distance equal to 62% of its height.
   Pass: **111+ distinct scrollTop values**, velocity decaying to tail values of
   1px, ~150 scroll events across the gesture. This is UIKit's decelerator --
   Playwright `mouse.wheel` produces none of this.
3. **Wedge attempt**: same park/flick, but as soon as the trace shows movement
   a separate `execute` writes `scrollTop = scrollTop - 1` mid-flight. Then a
   slow, deliberate second drag probes whether the scroller still follows.
   On this simulator, the write lands AND the scroller keeps responding -- the
   wedge class is **not reproducible here** (see below).

## Held finger (manual step)

The `pointerdown` guard was verified indirectly (scroll events stay at 0 while
a finger rests mid-drag, the state that used to gate the app's per-visit
rebuild; the rebuild is gone with virtualized scrollback, but the same held
finger matters to any programmatic scrollTop during a gesture). Codifying the
held-drag-then-release cycle as a scenario costs more runs than it's worth; to
check by hand: hold in the simulator, watch
`window.__trace` / `document.querySelectorAll('.term-scrollback-row')` stay
frozen until release.

## Simulator caveats (why wedge did not show)

- The wedge (UIKit scroller unresponsive to gestures after a programmatic
  scrollTop write mid-deceleration) has only been seen on **physical iPhone**.
  The sim's runloop is not throttled the same way, and the panic that wedges on
  device does not bite. A physical-device run of this script (same Appium
  session, `xcodeOrgId`/`xcodeSigningId` added to caps) is the honest next step.
- Remote-inspection sessions make UIKit throttle `requestAnimationFrame` on
  parts of the page not being painted, so do not trust a rAF tail as proof of
  rest -- the `setInterval` sampler's flat tail plus `scrollEvents` count are
  the signal here.
- Safari chrome offset: a native `(x, y)` maps to page `(x, y-62)` on iPhone 17
  Pro / iOS 26.5 with the address bar tucked. `map-touches.mjs` re-measures
  this if the device or chrome state changes.

## Files

- `momentum-poc.mjs` -- the PoC (momentum and wedge scenarios).
- `map-touches.mjs` -- calibrate native->page coordinates (the `-62` above).
- `run.sh` -- server on 8199 + booted sim + Appium on 4723 + the PoC.
- `trace-results.json` -- last run's full trace and verdicts (gitignored).
