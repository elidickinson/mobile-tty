// ttyd's --index serves exactly one document, so everything — JS, CSS, and the
// VT core's WASM (already base64 inside @wterm/core) — is inlined into one file.
import { build, context } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const OUT = 'dist/client.html'
const WTERM_CSS = 'node_modules/@wterm/dom/src/terminal.css'

const bundle = {
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'esm',
  target: 'safari17',
  minify: true,
  write: false,
  logLevel: 'info',
}

// A stable-per-build stamp the client compares against what the server serves.
const buildId = () => process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000).toString(36)

async function emit(js) {
  const [html, wtermCss, css] = await Promise.all([
    readFile('src/index.html', 'utf8'),
    readFile(WTERM_CSS, 'utf8'),
    readFile('src/style.css', 'utf8'),
  ])
  const page = html
    .replace('%BUILD_ID%', buildId())
    .replace('/*%CSS%*/', () => `${wtermCss}\n${css}`)
    .replace('/*%JS%*/', () => js)
  await mkdir('dist', { recursive: true })
  await writeFile(OUT, page)
  console.log(`${OUT}  ${(Buffer.byteLength(page) / 1024).toFixed(0)} KB`)
}

if (process.argv.includes('--watch')) {
  const ctx = await context({
    ...bundle,
    plugins: [{
      name: 'emit-html',
      setup: b => b.onEnd(r => r.outputFiles?.[0] && emit(r.outputFiles[0].text)),
    }],
  })
  await ctx.watch()
  console.log('watching…')
} else {
  const r = await build(bundle)
  await emit(r.outputFiles[0].text)
}
