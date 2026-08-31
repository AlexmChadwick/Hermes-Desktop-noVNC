# Hermes noVNC

A live remote-desktop pane for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app. Think KVM switch: a **Machines** roster in the left rail, a viewer pane in the workspace. Click a machine, its screen appears. Click another, the first is torn down cleanly and the second connects.

Built on [noVNC](https://github.com/novnc/noVNC) **v1.7.0**, vendored verbatim under `vendor/novnc/` (see [Vendored noVNC](#vendored-novnc)).

## What you get

- **Machine list** — named entries with host, port, websockify path, `ws`/`wss`, an optional group, and per-machine display settings. Edit with the gear on the row or right-click for Edit / Duplicate / Remove. Persisted through the SDK's plugin storage.
- **One-click switching** — selecting a machine disposes the previous connection before opening the next, so there is never a second socket in flight. The last-used machine is remembered across restarts.
- **HTTP Basic auth** — endpoints behind an nginx `auth_basic` work: credentials are asked for at connect time and ride the handshake. Never stored.
- **Real connection state** — connecting / connected / reconnecting / error, with the **actual WebSocket close code and the server's close reason** surfaced rather than a generic "disconnected", plus exponential backoff with equal jitter and a cancel button. An attempt that gets no answer within 12 seconds fails with a diagnosis instead of hanging: a filtered port never refuses a connection, so without that the pane would wait out Chromium's own TCP timeout. Where the diagnosis implies a specific correction — a plain `ws://` attempt that went silent is usually an https endpoint — the error offers a button that applies it.
- **Display controls** — scale-to-fit or 1:1 (with drag-to-pan), view-only toggle, fullscreen-within-pane, quality and compression.
- **Keyboard passthrough toggle** — stops Hermes' single-key shortcuts from eating keystrokes meant for the remote machine. See [the limitation](#keyboard-passthrough) below.
- **Clipboard** — remote → local automatically; local → remote on paste.
- **View-only by default** — connecting to a machine never moves someone's mouse before you ask for control.

## Install

The plugin must be installed on **the machine running the desktop app**, not on the gateway. If you are driving a remote gateway over SSH, it still goes on your laptop.

**macOS / Linux**

```bash
git clone https://github.com/AlexmChadwick/Hermes-Desktop-noVNC ~/.hermes/desktop-plugins/hermes-novnc
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/AlexmChadwick/Hermes-Desktop-noVNC $env:LOCALAPPDATA\hermes\desktop-plugins\hermes-novnc
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

### How credentials are stored

By default nothing is stored: a VNC password or an HTTP sign-in is typed at connect time, held for the life of the connection, and dropped on disconnect.

For an endpoint behind HTTP auth you can tick **Remember this sign-in**. What happens then, precisely:

- A 256-bit AES-GCM key is generated with `extractable: false` and kept in IndexedDB. The raw key bytes never exist in JavaScript — not for this plugin, not for any other.
- Your credentials are sealed with it and the **ciphertext** goes into plugin storage. Reading that storage, a settings backup, or a synced JSON file yields ciphertext.
- A sign-in that gets refused is deleted rather than retried, so a stale password does not lock you into a retry loop.
- Removing a machine deletes its sealed credentials.

What this does **not** protect against, said plainly: someone who already has your OS account and this app's profile directory can ask the app to decrypt. No renderer-side scheme can beat that. The app's own `safeStorage`/OS-keychain path is used for gateway tokens but is not exposed to plugins — I checked the preload bridge, which offers only the encryption *policy* toggle. If that ever changes, it is the better backend and this should move to it.

A **VNC** password is still never stored: it is a short DES-based secret shared with whoever else can reach the display, and the tunnel is the real access control.

### HTTP Basic auth in front of websockify

This **is** supported. If your endpoint sits behind an nginx `auth_basic` or similar, tick **Endpoint is behind HTTP auth** on the machine (or click **Sign in…** on the error). You are asked for a username and password at connect time, they travel as the WebSocket URL's userinfo, and Chromium turns that into an `Authorization: Basic` header on the opening handshake.

There is no browser API to set that header directly, which is why this route is the one that works. It is verified rather than assumed: `test/harness/rfb-server.mjs --basic user:pass` rejects an unauthenticated upgrade with a 401 and logs the header it receives, and the browser check completes a full RFB session through it.

Credentials are **never stored** — see above — and never logged: `endpointLabel` and `buildProbeUrl` build their strings without them, and `redactUrl` masks the userinfo anywhere a URL is displayed.

> An earlier version of this plugin claimed the opposite and shipped without the feature, on the strength of a plausible-sounding reading of Chromium's source. Testing it took ten minutes and showed it was wrong.

### The HTTP status of a failed handshake is not visible

When a WebSocket *handshake* fails, browsers deliberately do not expose the HTTP response to JavaScript — every such failure arrives as close code `1006` with an empty reason, whether the server said 401, 404, or nothing at all. So the plugin reports the real close code and reason it was given, and runs an unauthenticated no-cors probe to tell "the host answered but refused the upgrade" from "nothing answered at all". It does not invent a status it cannot see. Check the websockify or proxy log for the actual code.

### Keyboard passthrough

Hermes dispatches its shortcuts from a capture-phase listener on `window`, which runs before anything in the page. It skips **bare-key** shortcuts when focus is in an editable element, so the passthrough toggle marks the viewer container `contenteditable` (cancelling `beforeinput`, so nothing is ever actually edited) and single-key shortcuts stop firing.

**Cmd/Ctrl chords are deliberately global in Hermes and still reach it** — ⌘K, ⌘N and friends are documented in the app as staying global even while you type in a text field. This plugin cannot override that from the renderer, and says so rather than pretending. Use the **C-A-D** button for Ctrl+Alt+Del, which the OS would never let a browser capture anyway.

### Other things worth knowing

- **HiDPI**: noVNC does no `devicePixelRatio` handling, so a scaled-down remote framebuffer looks soft on a Retina display. The fix is server-side — run the remote desktop at a higher resolution.
- **Hidden panes**: the app mounts boot-hidden panes behind `display:none`, which collapses the container to 0×0 and would give noVNC a degenerate viewport. The plugin waits for real dimensions before connecting.
- **One connection at a time**, by design. noVNC does not throttle itself when hidden, so keeping several sessions live in the background would cost real CPU for pixels nobody is looking at.
- **CSP**: the desktop app sets no Content-Security-Policy on its main window today, so nothing blocks `connect-src`. The plugin still listens for `securitypolicyviolation` as defence in depth, because if one is ever added a block would otherwise be indistinguishable from a `1006`.

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

## A loader gotcha worth knowing

If you write a Hermes desktop plugin, this one will cost you an afternoon.

Before evaluating `plugin.js` the loader scans it as **text** for import
specifiers, and rejects the whole plugin if it finds one it cannot resolve. The
regex is neither comment-aware nor string-aware:

```js
/(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
```

So an ordinary English sentence in a comment — the word *from* followed by a
quoted phrase — is read as an import. This plugin was rejected on first install
with:

```
unsupported imports: host up, host did not, x, nothing did
  — runtime plugins may only import @hermes/plugin-sdk and react
```

All four were prose. One of them was the comment explaining this very hazard.
The file parsed, imported and ran correctly; it simply never got that far.

The same regex also drives the **rewrite** step, which substitutes matched
specifiers with blob URLs anywhere in the text. A stray `from 'react'` inside a
user-facing string would be silently replaced with a `blob:` URL at load time.

`test/loader-contract.test.mjs` replicates the loader's check verbatim, asserts
each resolvable specifier appears exactly once, and asserts the check still
fails when the offending prose is reintroduced, so it cannot pass vacuously.
The rule for this file: **never write the word "from" directly before a quoted
string.**

## Tests

```bash
node --import ./test/register.mjs --test test/*.test.mjs
```

No dependencies — the suite runs on Node's built-in test runner, and `test/loader.mjs` stubs the two specifiers the app injects at runtime so the tests exercise the **real** `plugin.js` rather than a copy.

Covered: machine config parsing and validation, endpoint pasting, WebSocket URL construction, the backoff schedule and its jitter bounds, close-code diagnosis and which failures are worth retrying, and the vendored module graph. The rendering path is not faked — it needs a real browser and a real server, so it is verified by hand instead.

## What was actually verified

The unit tests cover the logic; the parts that need a real browser and a real
server were verified by hand against `test/harness/`, a dependency-free RFB 3.8
server that speaks WebSocket directly. Run it yourself:

```bash
node test/harness/rfb-server.mjs --port 6080
```

```bash
node test/harness/verify-server.mjs
```

Then open `http://127.0.0.1:6099/` (connection path) and
`http://127.0.0.1:6099/test/harness/verify-plugin.html` (plugin load path).

Observed in Chromium:

| Step | Result |
| --- | --- |
| Vendored module graph | noVNC's 52 modules built into blob URLs and imported in ~100–230 ms |
| RFB handshake | Completed against the harness; desktop name `Hermes noVNC harness` received |
| Framebuffer | Canvas created at 640×400, Raw updates decoded and rendered |
| Mouse input | `PointerEvent x=160 y=119`, `x=448 y=259`, and a click (`buttons=1` → `0`) arrived server-side with correct coordinates |
| Clipboard → remote | `ClientCutText "hermes-novnc verification"` received |
| Server-initiated close | Surfaced as **code 1011, reason "harness forced drop"**, through noVNC — the close code really is recoverable |
| Bad VNC credentials | `securityfailure` fired with `status=1` and the server's reason string, distinct from the transport close |
| Refused upgrade (HTTP 404) | Surfaced as **1006 with an empty reason** — confirming that the handshake's HTTP status is genuinely invisible, exactly as documented above |
| Plugin load | `plugin.js` evaluated in a browser and registered 2 panes (`left`, `main`), 2 palette entries, and an `onDispose` cleanup; both `render()` calls returned elements |
| Host loader acceptance | The loader's own text scan run verbatim over `plugin.js` — see [the gotcha](#a-loader-gotcha-worth-knowing), which is how the first install failed |
| SDK/UI contracts | Every SDK import, component prop, CSS custom property and Codicon name checked against the installed app source; the CSS and icon checks run against it on every test run |
| Session lifecycle | `VncSession` display-setting and credential-ownership rules unit-tested directly, after a review found live toggles never reached the connection |
| Reachability probe | A live host resolves opaque (`type=opaque status=0`); a dead port throws `TypeError: Failed to fetch` — so the two really are distinguishable |

Nine bugs were caught this way rather than by reading the code — one only by
the real app, which is why its check is now replicated in the suite. The two
worst were silent: every tooltip passed `content` where the component wants
`label`, so no tooltip ever rendered; and the View only toggle re-applied the
machine object captured when the session was built, so the toolbar could read
"View only" while input still reached the remote machine. Neither produced an
error anywhere. Pasting a bare
`host:port` silently wiped the default websockify path. And the reachability
probe used `redirect: 'manual'`, which makes Chromium reject the promise even
when the host answered — every failure would have been reported as "cannot
reach the host". The third was the loader rejecting prose in comments as
imports. All three are fixed and covered by tests.

One further finding worth recording: a server that floods uncompressed Raw updates can
bury its own close frame, and the close then degrades to `1006`. That was the
harness being naive rather than anything in the plugin — real servers negotiate
Tight or ZRLE — but it is why `test/harness/rfb-server.mjs` applies write
backpressure.

**Not** verified by me: the panes rendering inside Hermes Desktop itself, and a
connection to a real VNC server over websockify. The plugin is installed and
ready for that.

## Out of scope for v1

H.264 and any transcoding path, RDP, audio, and file transfer.

## Licence

MIT for the plugin. Vendored noVNC keeps its own licences under `vendor/novnc/`.
