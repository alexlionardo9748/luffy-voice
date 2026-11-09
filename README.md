# LUFFY ⛵

Cozy, high-quality **voice calls + screen sharing + crew chat** for friends. One
Node.js process, one package, no accounts, no database. Audio and screen video
travel peer-to-peer over WebRTC; the server only handles room membership,
signaling, and ephemeral chat relay.

## Features

- **Named rooms** — type any room name, share the invite link, done.
- **Crystal voice** — echo cancellation, noise suppression, automatic gain.
- **Screen sharing** — up to 1080p60 with optional system/tab audio.
- **Independent volume controls** — separate volume sliders and mute buttons for
  each friend's microphone *and* their incoming screen-share audio.
- **Crew chat** — text, emoji, and picture messages with inline previews, a
  fullscreen lightbox, drag-and-drop, and clipboard paste. Pictures are
  downscaled in the browser before sending.
- **Talk detection** — live level meters and a glowing ring around whoever is speaking.
- **Robust reconnects** — Socket.IO reconnect + automatic room re-join and peer re-linking.
- **Privacy first** — no recording, no analytics, no third-party fonts or scripts.
  Chat is relayed in memory and disappears when everyone leaves.
- **Mobile friendly** — responsive layout, touch targets, fullscreen screen view,
  and the chat opens as a bottom sheet on small screens.

## Requirements

- Node.js **18.17+** (Node 20 or 22 recommended)
- A modern browser with WebRTC
- **HTTPS** in production. Browsers only allow microphone and screen capture on
  `https://` origins (or `http://localhost`).

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>, enter a name + room, and join. To test with
yourself, open a second tab (or a second browser profile) and join the same room.

Development mode with auto-restart:

```bash
npm run dev
```

## Production

```bash
NODE_ENV=production PORT=3000 npm start
```

Put the app behind a TLS-terminating reverse proxy (Caddy, Nginx, Cloudflare
Tunnel, etc.). WebSocket upgrade requests for `/socket.io/` must be forwarded.

### STUN / TURN

The app works on the same LAN or on friendly networks with the default public
STUN servers. For reliable calls across restrictive NATs/firewalls **you should
run a TURN server** (e.g. [coturn](https://github.com/coturn/coturn)).

Configuration is read from environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `MAX_ROOM_PEERS` | Mesh size limit, `2`–`12` (default `8`) |
| `STUN_URLS` | Comma-separated STUN URLs |
| `TURN_URLS` | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Static TURN credentials |
| `TURN_SECRET` | coturn REST secret → generates **short-lived** credentials |
| `TURN_TTL` | Lifetime of ephemeral TURN credentials in seconds (default `3600`) |
| `ICE_SERVERS_JSON` | Full JSON array override for `iceServers` |

Example with coturn ephemeral credentials:

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp \
TURN_SECRET=super-secret \
NODE_ENV=production \
npm start
```

The browser fetches `/config.json` (never cached) to get the current ICE config.
TURN credentials are intentionally exposed to clients — that is how WebRTC works.
Use short-lived credentials in production and make sure your TURN server is
rate-limited.

## How it works

```
Browser A ──┐                        ┌── Browser B
            │  Socket.IO signaling   │
            └──────► server.js ◄─────┘
   │                                    │
   └──────── WebRTC media (P2P) ────────┘
```

- Mesh topology: each participant connects directly to every other participant.
- Each peer connection has **three pre-negotiated transceivers**: mic audio,
  screen video, and screen/system audio. Switching screen sharing on or off uses
  `RTCRtpSender.replaceTrack()` — no renegotiation, no glare.
- The newest participant always creates the offers; existing participants answer.

Keep rooms small (≤ 8 people) — mesh upload bandwidth grows linearly.

## HTTP endpoints

- `GET /` — the app
- `GET /healthz` — health/uptime/room count (handy for load balancers)
- `GET /config.json` — ICE server configuration for the browser
- `GET /socket.io/…` — Socket.IO signaling (WebSocket + polling fallback)

## Security notes

- Strict CSP, `X-Frame-Options: DENY`, `nosniff`, restrictive Permissions-Policy.
- Room names and display names are sanitized and length-limited server-side.
- Signaling payloads (SDP/ICE) are validated and only relayed to peers in the
  same room.
- Chat messages are length-limited and rate-limited per socket. Pictures must be
  PNG/JPEG/GIF/WebP data URLs under 3 MB whose bytes match the claimed type.
- Audio/video never touches the server; a TURN server only relays encrypted
  packets. Chat text and pictures are relayed through the signaling server in
  memory and are never written to disk.

## License

MIT — sail freely.
