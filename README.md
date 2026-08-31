# Hermes noVNC

A live remote-desktop pane for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app. Think KVM switch: a **Machines** roster in the left rail, a viewer pane in the workspace. Click a machine, its screen appears. Click another, the first is torn down cleanly and the second connects.

Built on [noVNC](https://github.com/novnc/noVNC) **v1.7.0**, vendored verbatim under `vendor/novnc/` (see [Vendored noVNC](#vendored-novnc)).

## What you get

- **Machine list** — named entries with host, port, websockify path, `ws`/`wss`, an optional group, and per-machine display settings. Persisted through the SDK's plugin storage.
- **One-click switching** — selecting a machine disposes the previous connection before opening the next, so there is never a second socket in flight. The last-used machine is remembered across restarts.
- **Real connection state** — connecting / connected / reconnecting / error, with the **actual WebSocket close code and the server's close reason** surfaced rather than a generic "disconnected", plus exponential backoff with equal jitter and a cancel button.
- **Display controls** — scale-to-fit or 1:1 (with drag-to-pan), view-only toggle, fullscreen-within-pane, quality and compression.
- **Keyboard passthrough toggle** — stops Hermes' single-key shortcuts from eating keystrokes meant for the remote machine. See [the limitation](#keyboard-passthrough) below.
- **Clipboard** — remote → local automatically; local → remote on paste.
- **View-only by default** — connecting to a machine never moves someone's mouse before you ask for control.

## Install

The plugin must be installed on **the machine running the desktop app**, not on the gateway. If you are driving a remote gateway over SSH, it still goes on your laptop.

**macOS / Linux**

```bash
git clone https://github.com/alexchadwick/Hermes-noVNC ~/.hermes/desktop-plugins/hermes-novnc
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/alexchadwick/Hermes-noVNC $env:LOCALAPPDATA\hermes\desktop-plugins\hermes-novnc
```

Then reload plugins in Hermes Desktop: **Ctrl/Cmd+K → "Reload desktop plugins"**, or just restart the app. A **Machines** pane appears in the left rail and a **Remote Desktop** pane docks beside the conversation. Both are draggable, and Settings → Plugins can disable the plugin entirely.

> Copy the **whole folder**, not just `plugin.js`. The vendored noVNC files under `vendor/novnc/` are loaded from disk at connect time; without them the plugin loads but cannot connect, and says so.

Editing `plugin.js` hot-reloads it in place — the app fs-watches each plugin file.

## Setting up a machine

Add a machine and give it the **websockify** endpoint, not the noVNC web page. If you paste a full URL (`https://desk.example.net/vnc.html?autoconnect=true`), the host, port, TLS flag and path are pulled out for you and `vnc.html` is stripped, because that is the page rather than the socket.

| Field | Default | Notes |
| --- | --- | --- |
| Host | — | Bare hostname or IP. `[fd00::1]` for IPv6. |
| Port | `6080` | websockify's conventional port. |
| Path | `websockify` | Supports a query string, e.g. `websockify?token=abc`. |
| Use TLS | off | `wss://`. Required if the endpoint is served over HTTPS. |
| View only | **on** | Watch without sending input. |

`docs/remote-setup.md` covers the server side, and `machines.sample.json` shows the stored shape.

## Limitations you should know about

These are real constraints of the platform, found while building this. I would rather write them down than have you discover them at the wrong moment.

### Credentials are never stored

The plugin SDK exposes **no secure storage**. `ctx.storage` is plain JSON in `localStorage`, and `ctx.os` offers clipboard/open/reveal but no keychain and no `safeStorage`. Since there is nowhere safe to put a password, this plugin **does not offer to remember one**. A VNC password is typed at connect time, held in a variable for the life of the connection, and dropped on disconnect.

### HTTP Basic auth in front of websockify will not work

If your endpoint sits behind an HTTP auth layer (nginx `auth_basic`, a proxy login page), a browser cannot get through it on a WebSocket:

- There is no browser API to set an `Authorization` header on `new WebSocket()`.
- Chromium **ignores userinfo in a WebSocket URL** — `wss://user:pass@host/` connects with no `Authorization` header rather than failing loudly. Offering a username/password box would therefore be a promise this plugin could not keep, so there isn't one.

Workable alternatives, in order of preference:

1. Put the access control on the **tunnel** instead — an SSH tunnel or Tailscale, so websockify itself listens on loopback with no HTTP auth. This is what `docs/remote-setup.md` recommends anyway.
2. Use a **websockify token** in the path (`websockify?token=…`) with a token auth plugin.

Tick "Endpoint is behind HTTP auth" on a machine and the failure message will explain this instead of listing generic causes.

### The HTTP status of a failed handshake is not visible

When a WebSocket *handshake* fails, browsers deliberately do not expose the HTTP response to JavaScript — every such failure arrives as close code `1006` with an empty reason, whether the server said 401, 404, or nothing at all. So the plugin reports the real close code and reason it was given, and runs an unauthenticated no-cors probe to tell "the host answered but refused the upgrade" from "nothing answered at all". It does not invent a status it cannot see. Check the websockify or proxy log for the actual code.

### Keyboard passthrough

Hermes dispatches its shortcuts from a capture-phase listener on `window`, which runs before anything in the page. It skips **bare-key** shortcuts when focus is in an editable element, so the passthrough toggle marks the viewer container `contenteditable` (cancelling `beforeinput`, so nothing is ever actually edited) and single-key shortcuts stop firing.

**Cmd/Ctrl chords are deliberately global in Hermes and still reach it** — ⌘K, ⌘N and friends are documented in the app as staying global even while you type in a text field. This plugin cannot override that from the renderer, and says so rather than pretending. Use the **C-A-D** button for Ctrl+Alt+Del, which the OS would never let a browser capture anyway.

### Other things worth knowing

- **HiDPI**: noVNC does no `devicePixelRatio` handling, so a scaled-down remote framebuffer looks soft on a Retina display. The fix is server-side — run the remote desktop at a higher resolution.
- **Hidden panes**: the app mounts boot-hidden panes behind `display:none`, which collapses the container to 0×0 and would give noVNC a degenerate viewport. The plugin waits for real dimensions before connecting.
- **One connection at a time**, by design. noVNC does not throttle itself when hidden, so keeping several sessions live in the background would cost real CPU for pixels nobody is looking at.
- **CSP**: if the app's policy blocks the endpoint, that surfaces as a plain `1006` — the plugin listens for `securitypolicyviolation` so it can say "blocked by Content-Security-Policy" instead.

## How to audit this file

`plugin.js` is evaluated as ESM **in the renderer realm with full app authority**. The app's own loader is explicit that this is error isolation, not a sandbox — a plugin cannot crash the app, but it can do anything the app can. So read it before you trust it. It is one file, commented throughout, and these three greps cover the security surface:

1. **`fetch(` and `new WebSocket(`** — the only two ways this file touches the network, both called exclusively with a URL built by `buildWsUrl`/`buildProbeUrl` from a machine you configured. No telemetry, no analytics, no update check, no phone-home.
2. **`eval`, `new Function`, `import(`** — there is no `eval` and no `new Function`. There is exactly one dynamic `import()`, in `loadRfbClass()`, and it imports a `blob:` URL built from files read off your own disk under `vendor/novnc/`. Never from a URL.
3. **`storage.set`** — machine definitions and the last-used id are the only things persisted. No password is written anywhere.

To verify the vendored library is unmodified upstream code:

```bash
curl -sSL https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz | tar xz && diff -r noVNC-1.7.0/core vendor/novnc/core
```

## Vendored noVNC

The Hermes plugin loader reads `plugin.js` as text, rewrites the `@hermes/plugin-sdk` and `react` specifiers, and evaluates the result from a **blob URL**. A relative specifier inside a blob module resolves against the blob URL itself and 404s, so `import RFB from './vendor/novnc/core/rfb.js'` cannot work, and the loader's own error says as much: *"runtime plugins may only import @hermes/plugin-sdk and react"*.

So `loadRfbClass()` walks noVNC's module graph from disk, rewrites each module's relative specifiers to the blob URL of its already-built dependency, and imports the entry — the same blob mechanism the app uses for plugins. The vendored files stay **pristine upstream copies** so you can diff them against the release, and the graph (52 modules, verified acyclic, no bare specifiers, no `import.meta`, no Workers, no WASM) is checked by `test/vendor-graph.test.mjs`.

noVNC is licensed MPL-2.0 with BSD-licensed components; `vendor/novnc/LICENSE.txt` and `vendor/novnc/AUTHORS` ship alongside it as those licences require.

## Tests

```bash
node --import ./test/register.mjs --test test/*.test.mjs
```

No dependencies — the suite runs on Node's built-in test runner, and `test/loader.mjs` stubs the two specifiers the app injects at runtime so the tests exercise the **real** `plugin.js` rather than a copy.

Covered: machine config parsing and validation, endpoint pasting, WebSocket URL construction, the backoff schedule and its jitter bounds, close-code diagnosis and which failures are worth retrying, and the vendored module graph. The rendering path is not faked — it needs a real browser and a real server, so it is verified by hand instead.

## Out of scope for v1

H.264 and any transcoding path, RDP, audio, and file transfer.

## Licence

MIT for the plugin. Vendored noVNC keeps its own licences under `vendor/novnc/`.
