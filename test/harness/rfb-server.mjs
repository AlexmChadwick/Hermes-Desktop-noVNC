/**
 * A dependency-free RFB 3.8 server that speaks WebSocket directly, for
 * verifying the plugin's connection path end to end without installing
 * websockify, Docker, or a real VNC server.
 *
 * It is deliberately minimal but genuinely correct on the wire: real noVNC
 * performs the real handshake against it and decodes real Raw-encoded
 * framebuffer updates. It also reports the input it receives, so a mouse move
 * in the viewer can be observed arriving on the server side.
 *
 *   node test/harness/rfb-server.mjs [--port 6080] [--fail-auth] [--drop-after N]
 *
 * Flags exist to force the failure paths the plugin claims to diagnose:
 *   --fail-auth     reject the security handshake (RFB-level auth failure)
 *   --drop-after N  close abruptly N ms after connecting, with code 1011
 *   --refuse        accept the TCP connection but never upgrade (HTTP 404)
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)

  return index === -1 ? fallback : args[index + 1]
}
const has = name => args.includes(`--${name}`)

const PORT = Number(flag('port', 6080))
const WIDTH = 640
const HEIGHT = 400
const DESKTOP_NAME = 'Hermes noVNC harness'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// --- WebSocket framing (RFC 6455) -----------------------------------------

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Encode one unfragmented binary frame (server frames are never masked). */
function encodeFrame(payload) {
  const length = payload.length
  let header

  if (length < 126) {
    header = Buffer.from([0x82, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x82
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }

  return Buffer.concat([header, payload])
}

function encodeClose(code, reason = '') {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2)

  return Buffer.concat([Buffer.from([0x88, body.length]), body])
}

/**
 * Pull complete frames out of a buffer. Returns the decoded payloads and the
 * remaining bytes, so a frame split across TCP reads is handled.
 */
function decodeFrames(buffer) {
  const payloads = []
  let offset = 0

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let cursor = offset + 2

    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }

    let mask = null

    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }

    if (cursor + length > buffer.length) break

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))

    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4]
      }
    }

    offset = cursor + length

    if (opcode === 0x8) {
      payloads.push({ close: true })
    } else if (opcode === 0x2 || opcode === 0x1 || opcode === 0x0) {
      payloads.push({ data: payload })
    }
    // Ping/pong are ignored; noVNC does not send them.
  }

  return { payloads, rest: buffer.subarray(offset) }
}

// --- Framebuffer ----------------------------------------------------------

/** A recognisable moving pattern, so "pixels arrived" is visible at a glance.
 *  Pixel order is B,G,R,x — 32bpp, little-endian, shifts R=16 G=8 B=0. */
function renderFrame(tick, cursor) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4
      // Big diagonal bands that march, so motion is obvious.
      const band = Math.floor((x + y + tick * 8) / 40) % 2
      const nearCursor = Math.abs(x - cursor.x) < 12 && Math.abs(y - cursor.y) < 12

      if (nearCursor) {
        pixels[i] = 40
        pixels[i + 1] = 220
        pixels[i + 2] = 255
      } else if (band) {
        pixels[i] = 90
        pixels[i + 1] = 40
        pixels[i + 2] = 30
      } else {
        pixels[i] = 140
        pixels[i + 1] = 80
        pixels[i + 2] = 50
      }
    }
  }

  return pixels
}

function framebufferUpdate(pixels) {
  const header = Buffer.alloc(16)
  header.writeUInt8(0, 0) // FramebufferUpdate
  header.writeUInt8(0, 1) // padding
  header.writeUInt16BE(1, 2) // one rectangle
  header.writeUInt16BE(0, 4) // x
  header.writeUInt16BE(0, 6) // y
  header.writeUInt16BE(WIDTH, 8)
  header.writeUInt16BE(HEIGHT, 10)
  header.writeInt32BE(0, 12) // Raw encoding

  return Buffer.concat([header, pixels])
}

function serverInit() {
  const name = Buffer.from(DESKTOP_NAME, 'utf8')
  const message = Buffer.alloc(24 + name.length)

  message.writeUInt16BE(WIDTH, 0)
  message.writeUInt16BE(HEIGHT, 2)
  // PixelFormat: 32bpp, depth 24, little-endian, true colour.
  message.writeUInt8(32, 4)
  message.writeUInt8(24, 5)
  message.writeUInt8(0, 6) // big-endian flag
  message.writeUInt8(1, 7) // true-colour flag
  message.writeUInt16BE(255, 8) // red max
  message.writeUInt16BE(255, 10) // green max
  message.writeUInt16BE(255, 12) // blue max
  message.writeUInt8(16, 14) // red shift
  message.writeUInt8(8, 15) // green shift
  message.writeUInt8(0, 16) // blue shift
  message.writeUInt32BE(name.length, 20)
  name.copy(message, 24)

  return message
}

// --- Server ---------------------------------------------------------------

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('rfb harness: connect a WebSocket to this port\n')
})

let connections = 0

server.on('upgrade', (req, socket) => {
  if (has('refuse')) {
    // Answer the handshake with a non-101 so the browser reports 1006 with no
    // detail — exactly the case the plugin's reachability probe disambiguates.
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    console.log('[harness] refused the upgrade with HTTP 404')

    return
  }

  const key = req.headers['sec-websocket-key']

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  )

  const id = ++connections
  console.log(`[harness] #${id} websocket open`)

  const send = payload => socket.write(encodeFrame(payload))

  let stage = 'version'
  let pending = Buffer.alloc(0)
  let frames = Buffer.alloc(0)
  let tick = 0
  let updateRequests = 0
  const cursor = { x: WIDTH / 2, y: HEIGHT / 2 }
  let timer = null

  send(Buffer.from('RFB 003.008\n', 'ascii'))

  const finish = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  socket.on('close', () => {
    finish()
    console.log(`[harness] #${id} websocket closed`)
  })
  socket.on('error', () => finish())

  /** Consume `pending` according to the handshake stage. */
  const pump = () => {
    for (;;) {
      if (stage === 'version') {
        if (pending.length < 12) return
        console.log(`[harness] #${id} client version ${JSON.stringify(pending.subarray(0, 11).toString())}`)
        pending = pending.subarray(12)
        // Always offer exactly one type: None (1). A forced failure is
        // expressed through SecurityResult below, which is the RFB 3.8 shape
        // real servers use for a rejected password.
        send(Buffer.from([1, 1]))
        stage = 'security'
        continue
      }

      if (stage === 'security') {
        if (pending.length < 1) return
        pending = pending.subarray(1)

        if (has('fail-auth')) {
          // SecurityResult = failed, plus an RFB 3.8 reason string.
          const reason = Buffer.from('harness: authentication rejected', 'utf8')
          const body = Buffer.alloc(8 + reason.length)
          body.writeUInt32BE(1, 0)
          body.writeUInt32BE(reason.length, 4)
          reason.copy(body, 8)
          send(body)
          console.log(`[harness] #${id} rejected authentication`)
          stage = 'done'
          setTimeout(() => socket.end(), 50)

          return
        }

        const ok = Buffer.alloc(4)
        ok.writeUInt32BE(0, 0)
        send(ok)
        stage = 'clientinit'
        continue
      }

      if (stage === 'clientinit') {
        if (pending.length < 1) return
        pending = pending.subarray(1)
        send(serverInit())
        console.log(`[harness] #${id} handshake complete — ${WIDTH}x${HEIGHT} "${DESKTOP_NAME}"`)
        stage = 'ready'

        const dropAfter = Number(flag('drop-after', 0))

        if (dropAfter > 0) {
          setTimeout(() => {
            console.log(`[harness] #${id} dropping with close code 1011`)
            finish()
            socket.write(encodeClose(1011, 'harness forced drop'))
            // Do NOT end() immediately: the browser only reports the code when
            // the closing handshake completes. Ending the TCP connection here
            // races the client's echoed close frame and it degrades to 1006.
            // The data handler ends the socket once that echo arrives; this is
            // only the backstop for a client that never replies.
            setTimeout(() => socket.destroyed || socket.end(), 3000)
          }, dropAfter)
        }

        continue
      }

      // Client-to-server messages.
      if (pending.length < 1) return

      const type = pending[0]

      if (type === 0) {
        if (pending.length < 20) return
        pending = pending.subarray(20)
        console.log(`[harness] #${id} SetPixelFormat`)
      } else if (type === 2) {
        if (pending.length < 4) return
        const count = pending.readUInt16BE(2)
        if (pending.length < 4 + count * 4) return
        const encodings = []
        for (let i = 0; i < count; i += 1) encodings.push(pending.readInt32BE(4 + i * 4))
        pending = pending.subarray(4 + count * 4)
        console.log(`[harness] #${id} SetEncodings ${encodings.join(',')}`)
      } else if (type === 3) {
        if (pending.length < 10) return
        const incremental = pending[1]
        pending = pending.subarray(10)
        updateRequests += 1

        if (has('no-stream')) {
          if (updateRequests === 1) console.log(`[harness] #${id} --no-stream: ignoring update requests`)
          continue
        }

        if (updateRequests === 1) {
          console.log(`[harness] #${id} FramebufferUpdateRequest (incremental=${incremental}) — streaming updates`)
        }

        // Serve one update now, then keep animating so motion is visible.
        send(framebufferUpdate(renderFrame(tick++, cursor)))

        if (!timer) {
          timer = setInterval(() => {
            if (socket.destroyed) return finish()

            // Backpressure: a full 640x400 Raw update is ~1 MB, so queueing one
            // unconditionally every tick buries anything sent afterwards —
            // including the close frame, which then degrades to a 1006 abrupt
            // close instead of delivering its real code. Skip a tick whenever
            // the socket has not drained.
            if (socket.writableLength > 0) return

            send(framebufferUpdate(renderFrame(tick++, cursor)))
          }, 250)
        }
      } else if (type === 4) {
        if (pending.length < 8) return
        const down = pending[1]
        const keysym = pending.readUInt32BE(4)
        pending = pending.subarray(8)
        console.log(`[harness] #${id} KeyEvent keysym=0x${keysym.toString(16)} down=${down}`)
      } else if (type === 5) {
        if (pending.length < 6) return
        const mask = pending[1]
        cursor.x = pending.readUInt16BE(2)
        cursor.y = pending.readUInt16BE(4)
        pending = pending.subarray(6)
        console.log(`[harness] #${id} PointerEvent x=${cursor.x} y=${cursor.y} buttons=${mask}`)
      } else if (type === 6) {
        if (pending.length < 8) return
        const length = pending.readUInt32BE(4)
        if (pending.length < 8 + length) return
        const text = pending.subarray(8, 8 + length).toString('latin1')
        pending = pending.subarray(8 + length)
        console.log(`[harness] #${id} ClientCutText ${JSON.stringify(text)}`)
      } else {
        console.log(`[harness] #${id} unknown message type ${type}; dropping connection`)
        socket.end()

        return
      }
    }
  }

  socket.on('data', chunk => {
    frames = Buffer.concat([frames, chunk])
    const { payloads, rest } = decodeFrames(frames)
    frames = rest

    for (const payload of payloads) {
      if (payload.close) {
        socket.end()

        return
      }

      pending = Buffer.concat([pending, payload.data])
    }

    pump()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[harness] RFB-over-WebSocket on ws://127.0.0.1:${PORT}/`)
  console.log(`[harness] flags: ${args.length ? args.join(' ') : '(none)'}`)
})
