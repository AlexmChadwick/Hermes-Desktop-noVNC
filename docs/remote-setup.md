# Exposing a machine to the Remote Desktop pane

The plugin talks to **websockify**, which bridges a WebSocket to a normal VNC (RFB) server. So a target machine needs two things: a VNC server, and websockify in front of it.

The guiding rule throughout: **bind everything to loopback and reach it over an SSH tunnel or Tailscale.** Do not open a VNC or websockify port to the internet. VNC's own authentication is a DES-based challenge capped at 8 characters, and there is a constant background scan for ports 5900 and 6080.

---

## 1. A VNC server

### TigerVNC — a new, headless desktop

Best when you want a session that exists whether or not anyone is logged in at the console.

```bash
sudo apt install tigervnc-standalone-server tigervnc-common
```

Set the VNC password (this is a VNC password, not your account password):

```bash
vncpasswd
```

Start a display bound to loopback:

```bash
vncserver :1 -localhost yes -geometry 1920x1080 -depth 24
```

That listens on `127.0.0.1:5901` (display `:1` = port `5900 + 1`). To stop it:

```bash
vncserver -kill :1
```

Pick the desktop it launches by editing `~/.vnc/xstartup` — for XFCE:

```bash
cat > ~/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
chmod +x ~/.vnc/xstartup
```

### x11vnc — share the physical screen

Best when you want to see the desktop that is actually on the monitor.

```bash
sudo apt install x11vnc
x11vnc -storepasswd            # writes ~/.vnc/passwd
x11vnc -display :0 -rfbauth ~/.vnc/passwd -localhost -forever -shared -rfbport 5900
```

`-localhost` is the important flag: it refuses connections that do not come from the machine itself, which is what makes the tunnel mandatory rather than optional.

### macOS

macOS has a VNC server built in: **System Settings → General → Sharing → Screen Sharing**. It listens on port 5900 and authenticates against macOS accounts, so treat the tunnel as the real access control and enable it only while you need it.

---

## 2. websockify in front

```bash
pip install websockify        # or: sudo apt install websockify
```

Bridge loopback-only, from port 6080 to the VNC server:

```bash
websockify 127.0.0.1:6080 127.0.0.1:5901
```

Both ends on `127.0.0.1`: nothing is reachable off-box, and the tunnel is the only way in. Check it locally:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6080/
```

Anything other than a connection error means websockify is listening. The plugin's endpoint is then host `127.0.0.1`, port `6080`, path `websockify`.

> The path is a convention, not a requirement — websockify accepts any path when it is not serving files. Leaving it as `websockify` matches what everything else expects.

### Keep it running (systemd)

```ini
# /etc/systemd/system/websockify.service
[Unit]
Description=websockify bridge for VNC
After=network.target

[Service]
User=YOUR_USER
ExecStart=/usr/bin/websockify 127.0.0.1:6080 127.0.0.1:5901
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now websockify
```

---

## 3. Reaching it from your laptop

### SSH tunnel

Forward the remote websockify port to the same port locally:

```bash
ssh -N -L 6080:127.0.0.1:6080 you@remote-host
```

Leave it running, and add a machine in the plugin with host `127.0.0.1`, port `6080`, path `websockify`, TLS **off**. The traffic is encrypted by SSH; `wss://` would be a second, pointless layer over a loopback hop.

To keep it up across flaky links, use `autossh`:

```bash
autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 6080:127.0.0.1:6080 you@remote-host
```

Several machines at once — give each its own local port:

```bash
ssh -N -L 6080:127.0.0.1:6080 you@desktop -L 6081:127.0.0.1:6080 you@builder
```

### Tailscale

If both machines are on a tailnet, bind websockify to the Tailscale address instead of forwarding anything:

```bash
websockify "$(tailscale ip -4):6080" 127.0.0.1:5901
```

Add the machine with the remote's Tailscale IP (or its MagicDNS name), port `6080`, TLS off. Tailscale handles the encryption and the identity; the VNC server still stays on loopback.

Tighten it further with an ACL that only lets your laptop reach port 6080:

```jsonc
{
  "acls": [
    { "action": "accept", "src": ["you@example.com"], "dst": ["desktop:6080"] }
  ]
}
```

---

## 4. If you really must use TLS directly

Only when the endpoint is genuinely public-facing and you are not tunnelling.

```bash
websockify --cert=/etc/letsencrypt/live/HOST/fullchain.pem \
           --key=/etc/letsencrypt/live/HOST/privkey.pem \
           --ssl-only 0.0.0.0:6080 127.0.0.1:5901
```

Then tick **Use TLS** on the machine. Two warnings:

- **A self-signed certificate will fail with close code 1015** and no useful detail, because the browser rejects it before any VNC traffic. Use a real certificate.
- **HTTP Basic auth in front of it is fine.** Tick "Endpoint is behind HTTP auth" on the machine and you will be asked to sign in at connect time; the credentials ride the WebSocket handshake as an `Authorization` header. A websockify token in the path works too, if you prefer a secret over a login.

---

## 5. Checking your work

Run these on the target before blaming the plugin.

```bash
ss -ltnp | grep -E '5900|5901|6080'
```

Expect `127.0.0.1:5901` and `127.0.0.1:6080`. If either shows `0.0.0.0`, it is listening on every interface — fix that first.

```bash
# From your laptop, with the tunnel up:
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6080/
```

| Symptom in the pane | Where to look |
| --- | --- |
| "No answer from the endpoint" | Nothing is listening, or the port is firewalled. A closed port refuses instantly, so silence means filtered. Check the port, and whether the endpoint is actually TLS on 443 rather than plain `ws://` on 6080. |
| "Cannot reach the host" | websockify is not running, or the tunnel is down. |
| "Endpoint refused the WebSocket" | The host answered but would not upgrade — wrong path, or an HTTP auth layer in front. If it is auth, click **Sign in…** on the error. |
| "Protocol error" (1002) | The path points at something that is not websockify. |
| "TLS failure" (1015) | Certificate is self-signed, expired, or for the wrong hostname. |
| "Authentication failed" | Wrong VNC password — an RFB-level rejection, not a transport one. |
| Connects, then drops after a minute | A proxy or NAT idle timeout between you and websockify. |

Browsers do not expose the HTTP status of a failed WebSocket handshake, so when the pane says the endpoint refused the upgrade, the websockify log is where the actual 401/404 will be.
