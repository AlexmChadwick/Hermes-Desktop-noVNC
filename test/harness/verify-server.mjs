/**
 * Serves the browser-side verification page. Together with rfb-server.mjs this
 * exercises the parts of the plugin that unit tests cannot reach: building
 * noVNC's module graph into blob URLs inside a real Chromium, completing a real
 * RFB handshake, decoding real framebuffer updates, and capturing a real
 * WebSocket close code.
 *
 *   node test/harness/rfb-server.mjs            # terminal 1 (port 6080)
 *   node test/harness/verify-server.mjs         # terminal 2 (port 6099)
 *   open http://127.0.0.1:6099/
 *
 * Serves only from the repo directory, and only to loopback.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = 6099

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const rel = url.pathname === '/' ? '/test/harness/verify.html' : url.pathname
  const target = path.join(ROOT, path.normalize(rel))

  // Never serve outside the repo.
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')

    return
  }

  try {
    const info = await stat(target)

    if (!info.isFile()) {
      throw new Error('not a file')
    }

    res.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    createReadStream(target).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${rel}\n`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[verify] http://127.0.0.1:${PORT}/`)
})
