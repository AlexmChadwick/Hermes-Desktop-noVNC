/**
 * Hermes noVNC — a live remote-desktop pane for the Hermes desktop app.
 *
 * Think KVM switch: a "Machines" roster in the left rail, a viewer pane in the
 * workspace. Click a machine, its screen appears. Click another, the first is
 * cleanly torn down and the second connects.
 *
 * ── HOW TO AUDIT THIS FILE ─────────────────────────────────────────────────
 * The loader evaluates this file as ESM in the renderer realm with FULL app
 * authority (see runtime-loader.ts in the app source: "this is NOT a
 * capability boundary"). So it is worth reading before you trust it. In order:
 *
 *   1. Search for `fetch(` and `new WebSocket(`. Those are the ONLY two ways
 *      this file touches the network, and both are called exclusively with a
 *      URL built by `buildWsUrl`/`buildProbeUrl` from a machine YOU configured.
 *      There is no telemetry, no analytics, no update check, no phone-home.
 *   2. Search for `eval`, `new Function`, `import(`. There is no `eval` and no
 *      `new Function`. There is exactly one dynamic `import()`, in
 *      `loadRfbClass()`, and it imports a `blob:` URL built from files read
 *      off YOUR disk under `vendor/novnc/` — never from the network. That is
 *      the only way to load an ES module here, because the plugin loader
 *      evaluates plugin.js from a blob URL and relative imports cannot resolve
 *      against a blob (see the NOVNC LOADER note below).
 *   3. Search for `storage.set`. Machine definitions and display preferences
 *      are the only things persisted. No password is ever written anywhere —
 *      see the CREDENTIALS note below.
 *
 * ── NOVNC LOADER ───────────────────────────────────────────────────────────
 * The Hermes plugin loader reads plugin.js as text, rewrites only the
 * `@hermes/plugin-sdk` and `react*` specifiers, and evaluates the result from
 * a `blob:` URL. A relative specifier inside a blob module resolves against
 * the blob URL itself and 404s, so `import { default as RFB } from
 * './vendor/novnc/core/rfb.js'` CANNOT work. Instead `loadRfbClass()` walks
 * noVNC's (acyclic, verified) module graph from disk, rewrites each module's
 * relative specifiers to the blob URL of its already-built dependency, and
 * imports the entry. The vendored files are pristine upstream copies, so you
 * can diff `vendor/novnc/core` against the noVNC v1.7.0 release tarball.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────
 * The plugin SDK exposes no secure storage: `ctx.storage` is plain JSON in
 * localStorage, and `ctx.os` offers clipboard/open/reveal but no keychain.
 * Since there is no safe place to put a password, this plugin does not offer
 * to remember one. A VNC password is held in a local variable for the life of
 * a connection and dropped on disconnect.
 *
 * There is deliberately no HTTP Basic username/password box either: a browser
 * cannot set an Authorization header on a WebSocket, and Chromium ignores
 * userinfo in a WebSocket URL, so such a box could not work. See the README.
 *
 * noVNC v1.7.0 is vendored under vendor/novnc (MPL-2.0 + BSD, see
 * vendor/novnc/LICENSE.txt).
 */

import {
  atom,
  Button,
  cn,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  GlyphSpinner,
  host,
  Input,
  PALETTE_AREA,
  PANES_AREA,
  ScrollArea,
  Switch,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useRef, useState } from 'react'

const ID = 'hermes-novnc'

/** Pinned upstream noVNC release vendored under vendor/novnc. */
export const NOVNC_VERSION = '1.7.0'

/** Entry point of the vendored noVNC module graph, relative to the plugin dir. */
const NOVNC_ENTRY = 'vendor/novnc/core/rfb.js'

// ---------------------------------------------------------------------------
// Pure logic. Everything below this line to the "noVNC module loader" heading
// is free of DOM and SDK references so it can be unit-tested under plain node
// (see test/*.test.mjs, which imports this file with the SDK stubbed).
// ---------------------------------------------------------------------------

/** websockify's conventional listen port, and its conventional path. */
export const DEFAULT_PORT = 6080
export const DEFAULT_PATH = 'websockify'

/** Ports omitted from a URL because they are that scheme's default. */
const SCHEME_DEFAULT_PORT = { ws: 80, wss: 443 }

/** A hostname we are willing to put in a URL: a bare host or a bracketed IPv6
 *  literal. Deliberately strict — a "host" containing a slash, an @, or a
 *  scheme is a config mistake that would otherwise silently retarget the
 *  connection somewhere the user did not intend. */
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/i

/** Clamp to an integer in [lo, hi], falling back when the value is unusable. */
function clampInt(value, lo, hi, fallback) {
  const n = Math.trunc(Number(value))

  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/**
 * Validate and normalize one machine entry.
 *
 * Returns `{ ok, errors, machine }`. `machine` is always a complete, safe
 * object even when `ok` is false, so the editor can keep rendering the user's
 * in-progress input instead of collapsing.
 */
export function normalizeMachine(raw, { id } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const errors = []

  const name = String(input.name ?? '').trim()

  if (!name) {
    errors.push('Name is required.')
  }

  // Accept a pasted "host:port", "https://host/path" or "wss://host/path" and
  // pull it apart, because that is what people actually have on the clipboard.
  let host_ = String(input.host ?? '').trim()
  let port = input.port
  let path = input.path
  let secure = input.secure

  const asUrl = parsePastedEndpoint(host_)

  if (asUrl) {
    host_ = asUrl.host
    port ??= asUrl.port
    path ??= asUrl.path
    secure ??= asUrl.secure
  }

  if (!host_) {
    errors.push('Host is required.')
  } else if (!BARE_HOST.test(host_) && !IPV6_LITERAL.test(host_)) {
    errors.push(`"${host_}" is not a valid hostname. Use a bare host like vnc.example.com or 10.0.0.4.`)
  }

  const resolvedSecure = secure === undefined ? false : Boolean(secure)
  const resolvedPort = clampInt(port, 1, 65535, DEFAULT_PORT)

  if (port !== undefined && port !== '' && clampInt(port, 1, 65535, null) === null) {
    errors.push('Port must be a number between 1 and 65535.')
  }

  return {
    ok: errors.length === 0,
    errors,
    machine: {
      id: id ?? input.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
      name: name || 'Untitled machine',
      group: String(input.group ?? '').trim(),
      host: host_,
      port: resolvedPort,
      // A leading slash is the single most common paste artifact; normalize it
      // away here so URL building never produces a double slash.
      path: normalizePath(path),
      secure: resolvedSecure,
      // View-only by default: connecting to a machine should never be able to
      // move somebody's mouse before they have asked for control.
      viewOnly: input.viewOnly === undefined ? true : Boolean(input.viewOnly),
      shared: input.shared === undefined ? true : Boolean(input.shared),
      quality: clampInt(input.quality, 0, 9, 6),
      compression: clampInt(input.compression, 0, 9, 2),
      scale: input.scale === 'actual' ? 'actual' : 'fit',
      // Purely a diagnostic hint: when set, a failed handshake explains the
      // browser's HTTP-auth limitation instead of listing generic causes.
      httpAuth: Boolean(input.httpAuth)
    }
  }
}

/** Strip leading/trailing slashes from a websockify path, preserving any query
 *  string (`websockify?token=…` is a real and supported shape). */
export function normalizePath(value) {
  const raw = String(value ?? DEFAULT_PATH).trim()

  if (!raw) {
    return ''
  }

  return raw.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Pull a pasted endpoint apart. Accepts `host:port`, `//host/path`, and full
 * `http(s)://` / `ws(s)://` URLs. Returns null when `value` is already a bare
 * host (the common case), so the caller can leave it alone.
 */
export function parsePastedEndpoint(value) {
  const raw = String(value ?? '').trim()

  if (!raw || (!raw.includes('/') && !raw.includes(':'))) {
    return null
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw.replace(/^\/+/, '')}`

  let url

  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  if (!url.hostname) {
    return null
  }

  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  // WHATWG `hostname` already brackets an IPv6 literal, so only add brackets
  // when an engine hands one back bare. Bracketing unconditionally produced
  // `[[fd00::1]]`, which then failed validation.
  const hostname =
    url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname

  // vnc.html is the noVNC *page*, never the websocket endpoint — drop it so a
  // pasted browser URL becomes the websockify path people actually meant.
  const path = normalizePath(url.pathname.replace(/\/?vnc(_lite)?\.html$/i, '')) + (url.search || '')

  return {
    host: hostname,
    port: url.port ? Number(url.port) : secure ? 443 : undefined,
    // An empty result means the paste carried no path at all (`host:6081`), so
    // report undefined and let the websockify default stand. Only an explicitly
    // typed path can clear it.
    path: path === '' ? undefined : path,
    secure
  }
}

/**
 * Build the WebSocket URL for a machine.
 *
 * Deliberately has no way to attach HTTP credentials. A browser offers no API
 * to set an `Authorization` header on `new WebSocket()`, and Chromium ignores
 * userinfo in a WebSocket URL (`wss://user:pass@host` connects with no
 * `Authorization` header at all rather than failing loudly), so offering a
 * username/password box here would be a promise this plugin cannot keep. Put
 * the secret in the path as a websockify token instead, or terminate auth at
 * the tunnel — both are covered in docs/remote-setup.md.
 */
export function buildWsUrl(machine) {
  const scheme = machine.secure ? 'wss' : 'ws'
  const port = Number(machine.port)
  const portPart = port && port !== SCHEME_DEFAULT_PORT[scheme] ? `:${port}` : ''

  return `${scheme}://${machine.host}${portPart}/${normalizePath(machine.path)}`
}

/** The http(s) twin of the websocket URL, for the reachability probe. Carries
 *  no credentials — it exists only to tell "host unreachable" from "host up". */
export function buildProbeUrl(machine) {
  const scheme = machine.secure ? 'https' : 'http'
  const port = Number(machine.port)
  const httpDefault = machine.secure ? 443 : 80
  const portPart = port && port !== httpDefault ? `:${port}` : ''

  return `${scheme}://${machine.host}${portPart}/${normalizePath(machine.path)}`
}

/** Human label for a machine's endpoint, for tooltips and the roster. */
export function endpointLabel(machine) {
  return buildWsUrl(machine).replace(/^wss?:\/\//, '')
}

// --- Reconnect backoff -----------------------------------------------------

export const BACKOFF = {
  /** First retry lands fast — most drops are a blip. */
  baseMs: 500,
  factor: 2,
  capMs: 30_000,
  /** Give up rather than retry forever; a dead host should stop nagging. */
  maxAttempts: 8,
  /** A connection must survive this long before its success "counts" and the
   *  attempt counter resets. Without this, a server that accepts and instantly
   *  drops resets the backoff every cycle and you get a hot reconnect loop. */
  stableMs: 5_000
}

/**
 * Equal-jitter exponential backoff (half fixed, half random) — the variant
 * that keeps retries spread out without the occasional near-zero delay that
 * full jitter produces, which matters when the delay is also the user's
 * feedback that something is being retried.
 *
 * `random` is injectable so tests are deterministic.
 */
export function backoffDelay(attempt, { random = Math.random, ...opts } = {}) {
  const cfg = { ...BACKOFF, ...opts }
  const exponential = Math.min(cfg.capMs, cfg.baseMs * cfg.factor ** Math.max(0, attempt))
  const half = exponential / 2

  return Math.round(half + random() * half)
}

// --- Failure diagnosis -----------------------------------------------------

/**
 * Turn a WebSocket close into something a human can act on.
 *
 * An honest limitation, stated here and in the README: when a WebSocket
 * *handshake* fails, browsers deliberately do not expose the HTTP status to
 * JavaScript. Every such failure arrives as code 1006 with an empty reason. So
 * we report the real code and reason we were given, and use `reachable` (from
 * a no-cors probe, which can distinguish "host answered" from "host did not")
 * to narrow 1006 down instead of inventing a status we cannot see.
 */
export function describeClose({ code, reason, everConnected = false, reachable = null, httpAuth = false } = {}) {
  const trimmed = String(reason ?? '').trim()
  const suffix = trimmed ? ` Server said: "${trimmed}".` : ''

  const terminal = (title, detail) => ({ title, detail: detail + suffix, retryable: false, code, reason: trimmed })
  const transient = (title, detail) => ({ title, detail: detail + suffix, retryable: true, code, reason: trimmed })

  switch (code) {
    case 1000:
      return everConnected
        ? { title: 'Disconnected', detail: `The session ended normally.${suffix}`, retryable: false, code, reason: trimmed }
        : terminal('Rejected', 'The server closed the connection immediately, before the VNC handshake.')
    case 1001:
      return transient('Server going away', 'The server or a proxy shut the connection down.')
    case 1002:
      return terminal('Protocol error', 'The endpoint did not speak WebSocket correctly. This usually means the path points at something that is not websockify.')
    case 1003:
      return terminal('Unsupported data', 'The server rejected the data type. Check that the endpoint is a VNC websockify bridge.')
    case 1005:
      return everConnected
        ? transient('Connection closed', 'The connection closed without a status code.')
        : terminal('Closed without status', 'The server closed the connection without a status code before the session started.')
    case 1006:
      // The overwhelmingly common case, and the least self-explanatory.
      if (everConnected) {
        return transient('Connection lost', 'The connection dropped abnormally — network loss, a proxy idle timeout, or websockify exiting.')
      }

      if (reachable === true) {
        return terminal(
          'Endpoint refused the WebSocket',
          httpAuth
            ? 'The host answered but would not upgrade the connection, and this machine is marked as sitting behind HTTP authentication. That cannot work from a browser: there is no way to set an Authorization header on a WebSocket, and Chromium ignores credentials in the URL. Expose websockify without an HTTP auth layer (put the access control on an SSH tunnel or Tailscale instead), or use a websockify token in the path.'
            : 'The host answered but would not upgrade the connection. The usual causes are an auth layer in front of websockify (HTTP 401/403), a wrong path (HTTP 404), or a reverse proxy that is not forwarding the Upgrade headers. Browsers do not expose the HTTP status of a failed WebSocket handshake, so check the server log to see which.'
        )
      }

      if (reachable === false) {
        return terminal(
          'Cannot reach the host',
          'Nothing answered at that host and port. Check that websockify is running, that the port is right, and that your tunnel or Tailscale link is up.'
        )
      }

      return terminal(
        'Connection failed',
        'The connection failed before the VNC handshake. Common causes: websockify is not running, the path is wrong, an auth layer is in front of it, or (for wss://) the TLS certificate was rejected.'
      )
    case 1008:
      return terminal('Policy violation', 'The server rejected the connection on policy grounds — often an auth or origin check.')
    case 1009:
      return transient('Message too large', 'A frame exceeded the server limit.')
    case 1011:
      return transient('Server error', 'The server hit an internal error.')
    case 1012:
    case 1013:
      return transient('Server restarting', 'The server asked us to come back shortly.')
    case 1015:
      return terminal(
        'TLS failure',
        'The secure connection could not be established. For a self-signed certificate, open the https:// URL in a browser once and accept it, or use a trusted certificate.'
      )
    default:
      if (code >= 4000) {
        return transient(`Closed by server (${code})`, 'The server used an application-specific close code.')
      }

      return transient(`Disconnected (${code ?? 'unknown'})`, 'The connection closed unexpectedly.')
  }
}

/** RFB SecurityResult failure — a VNC-level rejection, not a transport one.
 *  Never retryable: retrying a wrong password just locks people out faster. */
export function describeSecurityFailure({ status, reason } = {}) {
  const trimmed = String(reason ?? '').trim()

  return {
    title: 'Authentication failed',
    detail: trimmed
      ? `The VNC server rejected the credentials: "${trimmed}".`
      : `The VNC server rejected the credentials (status ${status ?? 'unknown'}).`,
    retryable: false,
    code: status,
    reason: trimmed
  }
}

// ---------------------------------------------------------------------------
// noVNC module loader — see the NOVNC LOADER note in the file header.
// ---------------------------------------------------------------------------

/** Matches the specifier of a static/dynamic import. Same shape the app's own
 *  runtime-loader uses. It can also match `from 'x'` inside a comment, which is
 *  harmless here: we only substitute specifiers that resolved to a real
 *  vendored file, and a comment's text is not one. */
const IMPORT_SPECIFIER = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

/** Resolve `spec` (e.g. '../vendor/pako/x.js') against the directory of
 *  `fromPath` (e.g. 'vendor/novnc/core/inflator.js'). Pure string work — there
 *  is no path module in the renderer. */
export function resolveRelative(fromPath, spec) {
  const segments = fromPath.split('/').slice(0, -1).concat(spec.split('/'))
  const out = []

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      out.pop()
      continue
    }

    out.push(segment)
  }

  return out.join('/')
}

/** Memoized across the plugin's lifetime: noVNC is loaded once per app session
 *  (and again after a hot reload, which re-evaluates this module). */
let rfbPromise = null

/** Resolve the directory this plugin was installed into. The plugin loader
 *  supports two roots; check both rather than assuming the standalone one. */
async function resolvePluginDir(desktop) {
  const candidates = []
  const standalone = await desktop.desktopPluginsRoot?.()

  if (standalone) {
    candidates.push(`${standalone}/${ID}`)
  }

  const unified = await desktop.agentPluginsRoot?.()

  if (unified) {
    candidates.push(`${unified}/${ID}/desktop`)
  }

  for (const dir of candidates) {
    try {
      await desktop.readFileText(`${dir}/${NOVNC_ENTRY}`)

      return dir
    } catch {
      // Not this root — try the next.
    }
  }

  throw new Error(
    `Could not find ${NOVNC_ENTRY}. The vendored noVNC files must sit next to plugin.js — ` +
      `re-install the plugin folder in full rather than copying plugin.js on its own.`
  )
}

/**
 * Build the vendored noVNC module graph into blob URLs and import the entry.
 *
 * Post-order: a module's dependencies are built first so their blob URLs exist
 * by the time we rewrite the parent's import statements. The graph was verified
 * acyclic against noVNC v1.7.0, and a cycle would surface here as a clear error
 * rather than a hang.
 */
async function loadRfbClass() {
  rfbPromise ??= (async () => {
    const desktop = globalThis.window?.hermesDesktop

    if (!desktop?.readFileText || !desktop?.desktopPluginsRoot) {
      throw new Error(
        'This build of Hermes Desktop does not expose the file bridge this plugin needs to load noVNC. Update the desktop app.'
      )
    }

    const dir = await resolvePluginDir(desktop)
    const built = new Map()
    const created = []
    const building = new Set()

    async function build(relPath) {
      const cached = built.get(relPath)

      if (cached) {
        return cached
      }

      if (building.has(relPath)) {
        throw new Error(`Import cycle in the vendored noVNC files at ${relPath}`)
      }

      building.add(relPath)

      const { text, truncated } = await desktop.readFileText(`${dir}/${relPath}`)

      if (truncated) {
        throw new Error(`${relPath} was truncated while reading; cannot safely evaluate a partial module.`)
      }

      // Resolve every distinct relative specifier to its dependency's blob URL.
      const mapping = new Map()

      for (const match of text.matchAll(IMPORT_SPECIFIER())) {
        const spec = match[3]

        if (!spec.startsWith('.') || mapping.has(spec)) {
          continue
        }

        mapping.set(spec, await build(resolveRelative(relPath, spec)))
      }

      const rewritten = text.replace(IMPORT_SPECIFIER(), (whole, pre, quote, spec) =>
        mapping.has(spec) ? `${pre}${quote}${mapping.get(spec)}${quote}` : whole
      )

      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))

      built.set(relPath, url)
      created.push(url)
      building.delete(relPath)

      return url
    }

    const entryUrl = await build(NOVNC_ENTRY)

    try {
      const module = await import(/* @vite-ignore */ entryUrl)

      if (typeof module.default !== 'function') {
        throw new Error('vendor/novnc/core/rfb.js did not export the RFB class')
      }

      return module.default
    } finally {
      // The graph is fully instantiated by now and noVNC contains no dynamic
      // imports, so the URLs are dead weight — release them.
      created.forEach(url => URL.revokeObjectURL(url))
    }
  })().catch(error => {
    // Don't cache a failure: a user who fixes the install should be able to
    // retry without restarting the app.
    rfbPromise = null

    throw error
  })

  return rfbPromise
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Captured in register() so components can reach plugin storage. */
let pluginCtx = null

const $machines = atom([])
const $selectedId = atom(null)
/** { phase, message, detail, attempt, nextRetryAt, desktopName } */
const $status = atom({ phase: 'idle' })
const $editing = atom(null)
/** VNC credentials prompt: { types } or null. */
const $prompt = atom(null)
const $fullscreen = atom(false)

const STORAGE_KEYS = { machines: 'machines', lastUsed: 'last-used' }

function persistMachines(next) {
  $machines.set(next)

  try {
    pluginCtx?.storage?.set?.(STORAGE_KEYS.machines, next)
  } catch {
    // Storage unavailable — the roster still works for this window.
  }
}

function setStatus(patch) {
  $status.set({ ...$status.get(), ...patch })
}

// ---------------------------------------------------------------------------
// Connection controller
// ---------------------------------------------------------------------------

/**
 * Owns exactly one live VNC connection: the WebSocket, the RFB object, and the
 * reconnect timer. Switching machines constructs a new session and disposes the
 * old one, so there is never more than one socket in flight.
 *
 * We construct the WebSocket ourselves rather than handing RFB a URL string,
 * for two reasons: noVNC's `disconnect` event reports only `{ clean }` and
 * drops the close code, and a browser offers no other way to attach HTTP Basic
 * credentials to a WebSocket than the URL userinfo. `Websock.attach()` assigns
 * `onclose`/`onopen` as properties, so our `addEventListener` listeners coexist
 * with noVNC's.
 */
class VncSession {
  constructor(machine, container) {
    this.machine = machine
    this.container = container
    this.rfb = null
    this.socket = null
    this.timer = null
    this.attempt = 0
    this.connectedAt = 0
    this.everConnected = false
    this.stopped = false
    this.lastClose = null
    this.cspBlocked = null
    this.credentials = {}
    this.disposers = []
  }

  /** Start (or restart) the connection. */
  async connect() {
    if (this.stopped) {
      return
    }

    this.teardownSocket()
    setStatus({
      phase: 'connecting',
      message: this.attempt > 0 ? `Reconnecting (attempt ${this.attempt + 1})…` : 'Connecting…',
      detail: '',
      nextRetryAt: 0
    })

    let RFB

    try {
      RFB = await loadRfbClass()
    } catch (error) {
      setStatus({ phase: 'error', message: 'Could not load noVNC', detail: String(error?.message ?? error) })

      return
    }

    if (this.stopped) {
      return
    }

    const url = buildWsUrl(this.machine)
    this.lastClose = null
    this.cspBlocked = null

    // A Content-Security-Policy block on connect-src reaches JavaScript as an
    // ordinary 1006 with no reason, indistinguishable from the host being down.
    // The violation event is the only way to tell them apart, so listen for it
    // across the attempt and let handleDisconnect prefer it.
    const onViolation = event => {
      if (
        String(event.effectiveDirective ?? event.violatedDirective ?? '').includes('connect-src') &&
        String(event.blockedURI ?? '').includes(this.machine.host)
      ) {
        this.cspBlocked = event.blockedURI
      }
    }

    document.addEventListener('securitypolicyviolation', onViolation)
    this.disposers.push(() => document.removeEventListener('securitypolicyviolation', onViolation))

    let socket

    try {
      socket = new WebSocket(url)
    } catch (error) {
      // Thrown synchronously for a malformed URL, or a CSP connect-src block.
      setStatus({
        phase: 'error',
        message: 'Could not open the connection',
        detail: `${String(error?.message ?? error)} — check the host, port and path.`
      })

      return
    }

    this.socket = socket

    // Capture the true close code/reason. noVNC will also assign `.onclose`;
    // an addEventListener listener is independent of that property.
    socket.addEventListener('close', event => {
      this.lastClose = { code: event.code, reason: event.reason, wasClean: event.wasClean }
    })

    try {
      this.rfb = new RFB(this.container, socket, {
        shared: this.machine.shared,
        credentials: this.credentials
      })
    } catch (error) {
      setStatus({ phase: 'error', message: 'noVNC failed to start', detail: String(error?.message ?? error) })
      this.teardownSocket()

      return
    }

    this.applyDisplaySettings()

    const on = (type, handler) => {
      this.rfb.addEventListener(type, handler)
      this.disposers.push(() => this.rfb?.removeEventListener(type, handler))
    }

    on('connect', () => {
      this.everConnected = true
      this.connectedAt = Date.now()
      setStatus({ phase: 'connected', message: 'Connected', detail: '', attempt: 0, nextRetryAt: 0 })
    })

    on('disconnect', () => this.handleDisconnect())

    on('securityfailure', event => {
      // Terminal by construction — stop before handleDisconnect can retry.
      this.stopped = true
      const described = describeSecurityFailure(event.detail ?? {})
      setStatus({ phase: 'error', message: described.title, detail: described.detail })
    })

    on('credentialsrequired', event => {
      $prompt.set({ kind: 'vnc', types: event.detail?.types ?? ['password'] })
      setStatus({ phase: 'connecting', message: 'Waiting for credentials…', detail: '' })
    })

    on('desktopname', event => setStatus({ desktopName: event.detail?.name ?? '' }))

    on('clipboard', event => {
      const text = event.detail?.text

      if (typeof text === 'string' && text.length > 0) {
        // The sanctioned SDK door; resolves false rather than throwing when the
        // shell cannot do it.
        void pluginCtx?.os?.writeClipboard?.(text)
      }
    })
  }

  /** Push the machine's display preferences onto the live RFB object. */
  applyDisplaySettings() {
    if (!this.rfb) {
      return
    }

    const m = this.machine

    this.rfb.viewOnly = m.viewOnly
    this.rfb.qualityLevel = m.quality
    this.rfb.compressionLevel = m.compression
    // "Fit" scales the remote framebuffer down to the pane. "Actual" shows it
    // 1:1 and clips to the pane, with drag-to-pan so the rest stays reachable.
    this.rfb.scaleViewport = m.scale === 'fit'
    this.rfb.clipViewport = m.scale === 'actual'
    this.rfb.dragViewport = m.scale === 'actual' && m.viewOnly
    this.rfb.focusOnClick = !m.viewOnly
  }

  handleDisconnect() {
    if (this.stopped) {
      setStatus({ phase: 'idle', message: '', detail: '' })

      return
    }

    const reachableProbe = this.everConnected ? Promise.resolve(null) : probeReachable(this.machine)

    void reachableProbe.then(reachable => {
      if (this.stopped) {
        return
      }

      const described = this.cspBlocked
        ? {
            title: 'Blocked by Content-Security-Policy',
            detail: `The app's security policy refused a connection to ${this.cspBlocked}. Its connect-src directive has to allow this endpoint.`,
            retryable: false,
            code: this.lastClose?.code
          }
        : describeClose({
            code: this.lastClose?.code,
            reason: this.lastClose?.reason,
            everConnected: this.everConnected,
            reachable,
            httpAuth: this.machine.httpAuth
          })

      if (!described.retryable) {
        setStatus({ phase: 'error', message: described.title, detail: described.detail })

        return
      }

      // Only a connection that lasted counts as success; otherwise an
      // accept-then-drop server would reset the backoff on every cycle.
      if (this.everConnected && Date.now() - this.connectedAt >= BACKOFF.stableMs) {
        this.attempt = 0
      }

      if (this.attempt >= BACKOFF.maxAttempts) {
        setStatus({
          phase: 'error',
          message: 'Gave up reconnecting',
          detail: `${described.detail} Stopped after ${BACKOFF.maxAttempts} attempts.`
        })

        return
      }

      const delay = backoffDelay(this.attempt)
      this.attempt += 1

      setStatus({
        phase: 'reconnecting',
        message: described.title,
        detail: described.detail,
        attempt: this.attempt,
        nextRetryAt: Date.now() + delay
      })

      this.timer = setTimeout(() => {
        this.timer = null
        void this.connect()
      }, delay)
    })
  }

  /** Supply credentials the server asked for mid-handshake. */
  sendCredentials(values) {
    this.credentials = { ...this.credentials, ...values }
    this.rfb?.sendCredentials(this.credentials)
  }

  /** Retry now, cancelling any pending backoff timer. */
  retryNow() {
    this.cancelTimer()
    this.attempt = 0
    void this.connect()
  }

  cancelTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  teardownSocket() {
    this.disposers.forEach(dispose => {
      try {
        dispose()
      } catch {
        // Listener already gone.
      }
    })
    this.disposers = []

    if (this.rfb) {
      try {
        this.rfb.disconnect()
      } catch {
        // Already disconnected.
      }

      this.rfb = null
    }

    if (this.socket) {
      try {
        // RFB.disconnect() normally closes this; belt and braces so a failed
        // constructor can never leave a socket open.
        if (this.socket.readyState <= WebSocket.OPEN) {
          this.socket.close()
        }
      } catch {
        // Already closed.
      }

      this.socket = null
    }
  }

  /** User-initiated stop: no reconnect, no error state. */
  dispose() {
    this.stopped = true
    this.cancelTimer()
    this.teardownSocket()
  }
}

/**
 * Coarse reachability probe used only to narrow down close code 1006.
 *
 * A no-cors fetch cannot read the status (that is the whole point of an opaque
 * response), but resolving vs rejecting still distinguishes "something answered
 * at this host and port" from "nothing did", which is the difference between
 * "your auth/path is wrong" and "your tunnel is down". Never sends credentials.
 */
async function probeReachable(machine) {
  try {
    // Deliberately NOT `redirect: 'manual'`: combined with `mode: 'no-cors'`
    // Chromium rejects the promise even when the host answered perfectly well,
    // which would report every failure as "cannot reach the host". Verified
    // against a live endpoint — see the verification table in the README.
    await fetch(buildProbeUrl(machine), { mode: 'no-cors', cache: 'no-store' })

    return true
  } catch {
    return false
  }
}

/** The single live session. */
let session = null

function disconnectCurrent() {
  session?.dispose()
  session = null
  $status.set({ phase: 'idle' })
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const PHASE_TONE = {
  idle: 'text-(--ui-text-quaternary)',
  connecting: 'text-(--ui-accent)',
  reconnecting: 'text-(--ui-accent)',
  connected: 'text-emerald-500',
  error: 'text-red-500'
}

const PHASE_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  connected: 'Connected',
  error: 'Error'
}

function StatusPill() {
  const status = useValue($status)
  const phase = status.phase ?? 'idle'

  return h(
    'span',
    { className: cn('inline-flex items-center gap-1.5 text-[0.7rem]', PHASE_TONE[phase]) },
    phase === 'connecting' || phase === 'reconnecting'
      ? h(GlyphSpinner, { spinner: 'breathe', className: 'text-[0.7rem]' })
      : h('span', {
          className: cn(
            'size-1.5 rounded-full',
            phase === 'connected' ? 'bg-emerald-500' : phase === 'error' ? 'bg-red-500' : 'bg-current opacity-50'
          )
        }),
    status.message || PHASE_LABEL[phase]
  )
}

/** The machines roster — the KVM switch itself. */
function MachinesPane() {
  const machines = useValue($machines)
  const selectedId = useValue($selectedId)
  const status = useValue($status)

  return h(
    'div',
    { className: 'flex h-full flex-col' },
    h(
      'div',
      { className: 'flex items-center justify-between gap-2 px-2 py-1.5' },
      h('span', { className: 'text-[0.7rem] font-medium text-(--ui-text-secondary)' }, 'Machines'),
      h(
        Tip,
        { content: 'Add a machine' },
        h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            className: 'h-6 px-1.5',
            onClick: () => $editing.set(normalizeMachine({}).machine)
          },
          h(Codicon, { name: 'add', className: 'text-[0.8rem]' })
        )
      )
    ),
    machines.length === 0
      ? h(EmptyState, {
          title: 'No machines yet',
          description: 'Add a machine with its websockify host, port and path to start watching it.'
        })
      : h(
          ScrollArea,
          { className: 'min-h-0 flex-1' },
          h(
            'div',
            { className: 'flex flex-col gap-px px-1 pb-2' },
            ...machines.map(machine =>
              h(MachineRow, {
                key: machine.id,
                machine,
                selected: machine.id === selectedId,
                phase: machine.id === selectedId ? status.phase : 'idle'
              })
            )
          )
        )
  )
}

function MachineRow({ machine, selected, phase }) {
  return h(
    'div',
    {
      className: cn(
        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs',
        selected ? 'bg-(--ui-stroke-secondary)' : 'hover:bg-(--ui-stroke-secondary)/50'
      ),
      onClick: () => selectMachine(machine.id),
      title: endpointLabel(machine)
    },
    h('span', {
      className: cn(
        'size-1.5 shrink-0 rounded-full',
        phase === 'connected'
          ? 'bg-emerald-500'
          : phase === 'error'
            ? 'bg-red-500'
            : phase === 'connecting' || phase === 'reconnecting'
              ? 'bg-(--ui-accent)'
              : 'bg-(--ui-text-quaternary)'
      )
    }),
    h(
      'div',
      { className: 'min-w-0 flex-1' },
      h('div', { className: 'truncate' }, machine.name),
      h('div', { className: 'truncate text-[0.65rem] text-(--ui-text-quaternary)' }, endpointLabel(machine))
    ),
    machine.viewOnly ? h(Codicon, { name: 'eye', className: 'text-[0.7rem] text-(--ui-text-quaternary)' }) : null,
    h(
      Button,
      {
        type: 'button',
        variant: 'ghost',
        size: 'sm',
        className: 'h-5 px-1 opacity-0 group-hover:opacity-100',
        onClick: event => {
          event.stopPropagation()
          $editing.set(machine)
        }
      },
      h(Codicon, { name: 'settings-gear', className: 'text-[0.7rem]' })
    )
  )
}

/** The viewer: toolbar plus the element noVNC attaches its canvas to. */
function ViewerPane() {
  const machines = useValue($machines)
  const selectedId = useValue($selectedId)
  const status = useValue($status)
  const fullscreen = useValue($fullscreen)
  const containerRef = useRef(null)
  const [passthrough, setPassthrough] = useState(false)

  const machine = machines.find(m => m.id === selectedId) ?? null

  // Mount/unmount the connection with the selected machine. The cleanup runs
  // before the next effect, so switching machines always disposes first.
  useEffect(() => {
    if (!machine || !containerRef.current) {
      return undefined
    }

    const node = containerRef.current
    let started = null
    let cancelled = false

    const start = () => {
      if (cancelled || started) {
        return
      }

      started = new VncSession(machine, node)
      session = started
      void started.connect()
    }

    // The app mounts boot-hidden panes behind display:none, which collapses the
    // container to 0x0. noVNC scales and clips against that box, so connecting
    // while hidden yields a degenerate viewport. Wait for real dimensions.
    const hasSize = () => {
      const rect = node.getBoundingClientRect()

      return rect.width > 0 && rect.height > 0
    }

    let observer = null

    if (hasSize()) {
      start()
    } else {
      observer = new ResizeObserver(() => {
        if (hasSize()) {
          observer.disconnect()
          observer = null
          start()
        }
      })
      observer.observe(node)
    }

    return () => {
      cancelled = true
      observer?.disconnect()
      started?.dispose()

      if (session === started) {
        session = null
      }
    }
    // Reconnect only when the machine identity or its transport changes;
    // display-only edits are pushed live by the effect below.
  }, [machine?.id, machine?.host, machine?.port, machine?.path, machine?.secure, machine?.shared])

  // Display preferences apply to the live connection without a reconnect.
  useEffect(() => {
    session?.applyDisplaySettings()
  }, [machine?.viewOnly, machine?.scale, machine?.quality, machine?.compression])

  /**
   * Keyboard passthrough.
   *
   * The app dispatches its shortcuts from a capture-phase listener on `window`
   * that skips bare keys when `event.target` is an editable element. noVNC
   * focuses a `tabindex=-1` canvas, which is not editable, so without this the
   * app's single-key shortcuts fire while you type into the remote machine.
   * Marking the container contenteditable makes the canvas inherit
   * `isContentEditable`, which is the signal that dispatcher already honours;
   * `beforeinput` is cancelled so the browser never actually edits anything.
   *
   * Cmd/Ctrl chords are deliberately global in this app and still reach it —
   * see the README for that limitation.
   */
  useEffect(() => {
    const node = containerRef.current

    if (!node) {
      return undefined
    }

    const blockInput = event => event.preventDefault()

    if (passthrough) {
      node.setAttribute('contenteditable', 'true')
      node.setAttribute('spellcheck', 'false')
      node.addEventListener('beforeinput', blockInput)
    }

    return () => {
      node.removeAttribute('contenteditable')
      node.removeAttribute('spellcheck')
      node.removeEventListener('beforeinput', blockInput)
    }
  }, [passthrough])

  // Local -> remote clipboard. A paste event carries the text directly, so this
  // needs no clipboard permission and no polling.
  useEffect(() => {
    const node = containerRef.current

    if (!node) {
      return undefined
    }

    const onPaste = event => {
      const text = event.clipboardData?.getData('text')

      if (text && session?.rfb && !session.machine.viewOnly) {
        session.rfb.clipboardPasteFrom(text)
      }
    }

    node.addEventListener('paste', onPaste)

    return () => node.removeEventListener('paste', onPaste)
  }, [])

  if (!machine) {
    return h(EmptyState, {
      title: 'No machine selected',
      description: 'Pick a machine from the Machines pane to bring its screen up here.'
    })
  }

  return h(
    'div',
    {
      className: cn(
        'flex h-full min-h-0 flex-col',
        fullscreen && 'fixed inset-0 z-50 bg-(--ui-bg)'
      )
    },
    h(ViewerToolbar, { machine, status, passthrough, setPassthrough, fullscreen }),
    h(
      'div',
      { className: 'relative min-h-0 flex-1' },
      // noVNC attaches its canvas here. It leaves existing children alone, so
      // the overlay below can share the box.
      h('div', {
        ref: containerRef,
        className: 'size-full outline-none',
        // A focusable container means a click can hand keyboard focus to the
        // remote session even before noVNC's canvas takes it.
        tabIndex: -1
      }),
      status.phase === 'connected' ? null : h(ViewerOverlay, { status })
    )
  )
}

function ViewerToolbar({ machine, status, passthrough, setPassthrough, fullscreen }) {
  const toggle = patch => updateMachine({ ...machine, ...patch })

  return h(
    'div',
    { className: 'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1' },
    h('span', { className: 'truncate text-xs font-medium' }, status.desktopName || machine.name),
    h(StatusPill),
    h('div', { className: 'flex-1' }),

    h(
      Tip,
      { content: machine.viewOnly ? 'View only — click to take control' : 'You have control — click for view only' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 gap-1 px-1.5 text-[0.7rem]',
          onClick: () => toggle({ viewOnly: !machine.viewOnly })
        },
        h(Codicon, { name: machine.viewOnly ? 'eye' : 'edit', className: 'text-[0.75rem]' }),
        machine.viewOnly ? 'View only' : 'Control'
      )
    ),

    h(
      Tip,
      { content: machine.scale === 'fit' ? 'Scaled to fit — click for 1:1' : '1:1 — click to scale to fit' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 gap-1 px-1.5 text-[0.7rem]',
          onClick: () => toggle({ scale: machine.scale === 'fit' ? 'actual' : 'fit' })
        },
        h(Codicon, { name: machine.scale === 'fit' ? 'screen-normal' : 'screen-full', className: 'text-[0.75rem]' }),
        machine.scale === 'fit' ? 'Fit' : '1:1'
      )
    ),

    h(
      Tip,
      {
        content: passthrough
          ? 'Keys go to the remote machine (Cmd/Ctrl shortcuts still reach Hermes)'
          : 'Keys are handled by Hermes'
      },
      h(
        'span',
        { className: 'flex items-center gap-1.5 text-[0.7rem] text-(--ui-text-tertiary)' },
        h(Codicon, { name: 'keyboard', className: 'text-[0.75rem]' }),
        h(Switch, { checked: passthrough, onCheckedChange: setPassthrough })
      )
    ),

    h(
      Tip,
      { content: 'Send Ctrl+Alt+Del' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 px-1.5 text-[0.7rem]',
          disabled: machine.viewOnly || status.phase !== 'connected',
          onClick: () => session?.rfb?.sendCtrlAltDel()
        },
        'C-A-D'
      )
    ),

    h(
      Tip,
      { content: fullscreen ? 'Exit fullscreen' : 'Fullscreen' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 px-1.5',
          onClick: () => $fullscreen.set(!fullscreen)
        },
        h(Codicon, { name: fullscreen ? 'screen-normal' : 'screen-full', className: 'text-[0.75rem]' })
      )
    ),

    h(
      Tip,
      { content: 'Disconnect' },
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 px-1.5',
          disabled: status.phase === 'idle',
          onClick: () => $selectedId.set(null)
        },
        h(Codicon, { name: 'debug-disconnect', className: 'text-[0.75rem]' })
      )
    )
  )
}

/** Covers the canvas whenever we are not showing live pixels. */
function ViewerOverlay({ status }) {
  const [now, setNow] = useState(Date.now())

  // Only ticks while a retry is actually pending.
  useEffect(() => {
    if (!status.nextRetryAt) {
      return undefined
    }

    const timer = setInterval(() => setNow(Date.now()), 250)

    return () => clearInterval(timer)
  }, [status.nextRetryAt])

  const secondsLeft = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0

  return h(
    'div',
    { className: 'absolute inset-0 flex flex-col items-center justify-center gap-2 bg-(--ui-bg)/85 p-6 text-center' },
    status.phase === 'connecting'
      ? h(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
      : h(Codicon, {
          name: status.phase === 'error' ? 'warning' : 'vm',
          className: cn('text-lg', status.phase === 'error' ? 'text-red-500' : 'text-(--ui-text-quaternary)')
        }),
    h('div', { className: 'text-xs font-medium' }, status.message || PHASE_LABEL[status.phase ?? 'idle']),
    status.detail
      ? h('div', { className: 'max-w-md text-[0.7rem] leading-relaxed text-(--ui-text-tertiary)' }, status.detail)
      : null,
    status.code !== undefined && status.code !== null
      ? h('div', { className: 'text-[0.65rem] text-(--ui-text-quaternary)' }, `Close code ${status.code}`)
      : null,
    status.phase === 'reconnecting'
      ? h(
          'div',
          { className: 'flex items-center gap-2' },
          h(
            'span',
            { className: 'text-[0.7rem] text-(--ui-text-tertiary)' },
            secondsLeft > 0 ? `Retrying in ${secondsLeft}s…` : 'Retrying…'
          ),
          h(
            Button,
            { type: 'button', variant: 'ghost', size: 'sm', className: 'h-6 px-2 text-[0.7rem]', onClick: () => disconnectCurrent() },
            'Cancel'
          )
        )
      : null,
    status.phase === 'error'
      ? h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            className: 'h-6 px-2 text-[0.7rem]',
            onClick: () => session?.retryNow()
          },
          'Try again'
        )
      : null
  )
}

/** Add/edit a machine. */
function MachineEditor() {
  const editing = useValue($editing)
  const [draft, setDraft] = useState(null)

  useEffect(() => setDraft(editing), [editing])

  if (!editing || !draft) {
    return null
  }

  const result = normalizeMachine(draft, { id: draft.id })
  const known = $machines.get().some(m => m.id === draft.id)
  const field = (label, key, props = {}) =>
    h(
      'label',
      { className: 'flex flex-col gap-1' },
      h('span', { className: 'text-[0.7rem] text-(--ui-text-tertiary)' }, label),
      h(Input, {
        className: 'h-8 text-xs',
        value: draft[key] ?? '',
        onChange: event => setDraft({ ...draft, [key]: event.target.value }),
        ...props
      })
    )

  const toggle = (label, key, hint) =>
    h(
      'label',
      { className: 'flex items-center justify-between gap-3' },
      h(
        'span',
        { className: 'flex flex-col' },
        h('span', { className: 'text-xs' }, label),
        hint ? h('span', { className: 'text-[0.65rem] text-(--ui-text-quaternary)' }, hint) : null
      ),
      h(Switch, { checked: Boolean(draft[key]), onCheckedChange: value => setDraft({ ...draft, [key]: value }) })
    )

  return h(
    Dialog,
    { open: true, onOpenChange: open => (open ? null : $editing.set(null)) },
    h(
      DialogContent,
      { className: 'max-w-md' },
      h(
        DialogHeader,
        null,
        h(DialogTitle, null, known ? 'Edit machine' : 'Add machine'),
        h(
          DialogDescription,
          null,
          'Point this at a websockify endpoint in front of your VNC server. See docs/remote-setup.md for the server side.'
        )
      ),
      h(
        'div',
        { className: 'flex flex-col gap-3' },
        field('Name', 'name', { placeholder: 'Workshop desktop' }),
        field('Group (optional)', 'group', { placeholder: 'Home lab' }),
        field('Host', 'host', { placeholder: 'vnc.example.com — or paste a full URL' }),
        h(
          'div',
          { className: 'grid grid-cols-2 gap-3' },
          field('Port', 'port', { placeholder: String(DEFAULT_PORT), inputMode: 'numeric' }),
          field('Path', 'path', { placeholder: DEFAULT_PATH })
        ),
        toggle('Use TLS (wss://)', 'secure', 'Required when the endpoint is served over https.'),
        toggle('View only', 'viewOnly', 'Watch without sending mouse or keyboard.'),
        toggle(
          'Endpoint is behind HTTP auth',
          'httpAuth',
          'Browsers cannot sign in to HTTP auth over a WebSocket. Ticking this only improves the error message.'
        ),
        result.errors.length > 0
          ? h(
              'ul',
              { className: 'flex flex-col gap-1 text-[0.7rem] text-red-500' },
              ...result.errors.map(error => h('li', { key: error }, error))
            )
          : h(
              'div',
              { className: 'truncate text-[0.65rem] text-(--ui-text-quaternary)' },
              buildWsUrl(result.machine)
            )
      ),
      h(
        DialogFooter,
        null,
        known
          ? h(
              Button,
              {
                type: 'button',
                variant: 'ghost',
                size: 'sm',
                className: 'mr-auto text-red-500',
                onClick: () => {
                  removeMachine(draft.id)
                  $editing.set(null)
                }
              },
              'Remove'
            )
          : null,
        h(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => $editing.set(null) }, 'Cancel'),
        h(
          Button,
          {
            type: 'button',
            size: 'sm',
            disabled: !result.ok,
            onClick: () => {
              upsertMachine(result.machine)
              $editing.set(null)
            }
          },
          'Save'
        )
      )
    )
  )
}

/**
 * Credentials prompt. Deliberately has no "remember this" checkbox: there is no
 * secure store to remember it in (see the file header).
 */
function CredentialsDialog() {
  const prompt = useValue($prompt)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    setUsername('')
    setPassword('')
  }, [prompt])

  if (!prompt) {
    return null
  }

  const needsUsername = Boolean(prompt.types?.includes('username'))

  const submit = () => {
    session?.sendCredentials(needsUsername ? { username, password } : { password })
    $prompt.set(null)
  }

  return h(
    Dialog,
    {
      open: true,
      onOpenChange: open => {
        if (!open) {
          $prompt.set(null)
          disconnectCurrent()
        }
      }
    },
    h(
      DialogContent,
      { className: 'max-w-sm' },
      h(
        DialogHeader,
        null,
        h(DialogTitle, null, 'VNC password'),
        h(
          DialogDescription,
          null,
          'The VNC server asked for credentials. They are used for this connection only and are never saved.'
        )
      ),
      h(
        'div',
        { className: 'flex flex-col gap-3' },
        needsUsername
          ? h(Input, {
              className: 'h-8 text-xs',
              placeholder: 'Username',
              autoFocus: true,
              value: username,
              onChange: event => setUsername(event.target.value)
            })
          : null,
        h(Input, {
          className: 'h-8 text-xs',
          type: 'password',
          placeholder: 'Password',
          autoFocus: !needsUsername,
          value: password,
          onChange: event => setPassword(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              submit()
            }
          }
        })
      ),
      h(
        DialogFooter,
        null,
        h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            onClick: () => {
              $prompt.set(null)
              disconnectCurrent()
            }
          },
          'Cancel'
        ),
        h(Button, { type: 'button', size: 'sm', onClick: submit }, 'Connect')
      )
    )
  )
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function selectMachine(id) {
  const machine = $machines.get().find(m => m.id === id)

  if (!machine) {
    return
  }

  $selectedId.set(id)

  try {
    pluginCtx?.storage?.set?.(STORAGE_KEYS.lastUsed, id)
  } catch {
    // Non-fatal.
  }

}

function upsertMachine(machine) {
  const existing = $machines.get()
  const index = existing.findIndex(m => m.id === machine.id)
  const next = index >= 0 ? existing.map(m => (m.id === machine.id ? machine : m)) : [...existing, machine]

  persistMachines(next)
}

function updateMachine(machine) {
  upsertMachine(machine)
}

function removeMachine(id) {
  if ($selectedId.get() === id) {
    $selectedId.set(null)
  }

  persistMachines($machines.get().filter(m => m.id !== id))
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'Remote Desktop',
  description: 'Watch and control remote machines over noVNC without leaving Hermes.',
  register(ctx) {
    pluginCtx = ctx

    // Hydrate the roster. ctx.storage is synchronous with a fallback, but stay
    // defensive: a storage quirk must never fail the plugin load.
    try {
      const stored = ctx.storage?.get?.(STORAGE_KEYS.machines, [])

      if (Array.isArray(stored)) {
        // Re-normalize on load so a hand-edited entry can't reach the connector
        // in a shape it doesn't expect.
        $machines.set(stored.map(entry => normalizeMachine(entry, { id: entry?.id }).machine))
      }

      const lastUsed = ctx.storage?.get?.(STORAGE_KEYS.lastUsed, null)

      if (lastUsed && $machines.get().some(m => m.id === lastUsed)) {
        $selectedId.set(lastUsed)
      }
    } catch {
      // No storage on this shell — start empty.
    }

    // Tear the live connection down when the plugin is disabled or reloaded,
    // otherwise a hot edit would leave an orphaned socket behind.
    ctx.onDispose(() => disconnectCurrent())

    ctx.register({
      id: 'machines',
      area: PANES_AREA,
      title: 'Machines',
      data: { placement: 'left', width: '240px' },
      render: () => h(MachinesPane)
    })

    ctx.register({
      id: 'viewer',
      area: PANES_AREA,
      title: 'Remote Desktop',
      // 'main' splits the workspace beside the chat. ('right' is the
      // collapsible sidebar's role and would hide the pane until the user
      // shows that sidebar.)
      data: { placement: 'main', dock: { pane: 'workspace', pos: 'right' }, width: '520px' },
      render: () =>
        h('div', { className: 'flex h-full min-h-0 flex-col' }, h(ViewerPane), h(MachineEditor), h(CredentialsDialog))
    })

    ctx.register({
      id: 'add-machine',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.add-machine`,
        label: 'Remote Desktop: Add machine…',
        keywords: ['vnc', 'novnc', 'remote', 'desktop', 'kvm', 'screen'],
        run: () => $editing.set(normalizeMachine({}).machine)
      }
    })

    ctx.register({
      id: 'disconnect',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.disconnect`,
        label: 'Remote Desktop: Disconnect',
        keywords: ['vnc', 'novnc', 'remote', 'desktop', 'disconnect'],
        run: () => {
          $selectedId.set(null)
          host.notify({ kind: 'info', message: 'Remote desktop disconnected.' })
        }
      }
    })
  }
}
