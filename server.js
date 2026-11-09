/**
 * LUFFY — signaling server
 * ---------------------------------------------------------------------------
 * A tiny, dependency-light Node.js server that does three jobs:
 *
 *   1. Serves the static client (public/).
 *   2. Lets friends join named rooms via Socket.IO.
 *   3. Relays WebRTC offers / answers / ICE candidates between peers.
 *
 * Media NEVER goes through this server. Audio and screen video travel
 * peer-to-peer (or through your own TURN server when one is configured).
 *
 * Run:  npm install && npm start
 * Env:  PORT, HOST, MAX_ROOM_PEERS, STUN_URLS, TURN_URLS, TURN_USERNAME,
 *       TURN_CREDENTIAL, TURN_SECRET, TURN_TTL, ICE_SERVERS_JSON
 * ---------------------------------------------------------------------------
 */

"use strict";

const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Server } = require("socket.io");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = clampInt(process.env.PORT, 3000, 0, 65535);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PUBLIC_DIR = path.join(__dirname, "public");

/** Mesh calls get expensive fast. 8 people = 7 upstream streams per peer. */
const MAX_ROOM_PEERS = clampInt(process.env.MAX_ROOM_PEERS, 8, 2, 12);

const ROOM_MAX_LENGTH = 32;
const NAME_MAX_LENGTH = 24;
const MAX_SDP_LENGTH = 100_000;
const MAX_CANDIDATE_LENGTH = 4_096;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function log(...args) {
  if (!IS_PRODUCTION) console.log(...args);
}

/**
 * Rooms are URL friendly: lowercase, letters/numbers/dashes only.
 * "The Grand Line!" -> "the-grand-line"
 */
function normalizeRoom(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ROOM_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Strip control characters, collapse whitespace, cap the length. */
function normalizeName(raw) {
  if (typeof raw !== "string") return "Pirate";
  const clean = raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX_LENGTH);
  return clean || "Pirate";
}

/** Validate an SDP blob before forwarding it to somebody else. */
function normalizeSdp(value, expectedType) {
  if (!value || typeof value !== "object") return null;
  if (value.type !== expectedType) return null;
  if (typeof value.sdp !== "string") return null;
  if (value.sdp.length === 0 || value.sdp.length > MAX_SDP_LENGTH) return null;
  return { type: value.type, sdp: value.sdp };
}

/** Validate a trickled ICE candidate. */
function normalizeCandidate(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.candidate !== "string") return null;
  if (value.candidate.length === 0 || value.candidate.length > MAX_CANDIDATE_LENGTH) {
    return null;
  }

  const candidate = { candidate: value.candidate };

  if (typeof value.sdpMid === "string" && value.sdpMid.length <= 64) {
    candidate.sdpMid = value.sdpMid;
  }
  if (
    Number.isInteger(value.sdpMLineIndex) &&
    value.sdpMLineIndex >= 0 &&
    value.sdpMLineIndex < 64
  ) {
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (typeof value.usernameFragment === "string" && value.usernameFragment.length <= 256) {
    candidate.usernameFragment = value.usernameFragment;
  }

  return candidate;
}

function splitUrls(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Build the ICE server list handed to browsers.
 *
 * Supports:
 *   - STUN via STUN_URLS (comma separated)
 *   - static TURN credentials via TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
 *   - short-lived TURN credentials via TURN_URLS + TURN_SECRET (coturn REST API)
 *   - a complete override via ICE_SERVERS_JSON
 */
function buildIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (error) {
      console.warn("[config] ICE_SERVERS_JSON is not valid JSON:", error.message);
    }
  }

  const servers = [];

  const stunUrls = splitUrls(
    process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
  );
  if (stunUrls.length > 0) servers.push({ urls: stunUrls });

  const turnUrls = splitUrls(process.env.TURN_URLS || process.env.TURN_URL || "");
  if (turnUrls.length > 0) {
    if (process.env.TURN_SECRET) {
      // coturn "REST API" ephemeral credentials:
      // https://github.com/coturn/coturn/wiki/turnpassword
      const ttl = clampInt(process.env.TURN_TTL, 3600, 300, 86_400);
      const username = `${Math.floor(Date.now() / 1000) + ttl}:luffy`;
      const credential = crypto
        .createHmac("sha1", process.env.TURN_SECRET)
        .update(username)
        .digest("base64");

      servers.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME) {
      servers.push({
        urls: turnUrls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL || "",
      });
    } else {
      servers.push({ urls: turnUrls });
    }
  }

  return servers;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

// Baseline security headers. Inline styles are required because the whole UI
// lives in index.html; scripts are still locked to same-origin files only.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "microphone=(self), display-capture=(self), fullscreen=(self), camera=(), geolocation=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  next();
});

app.get("/healthz", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    peers: io.of("/").sockets.size,
    rooms: countActiveRooms(),
    maxRoomPeers: MAX_ROOM_PEERS,
  });
});

app.get("/config.json", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers: buildIceServers() });
});

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

// Single-page fallback for deep links (/room/grand-line -> index.html).
// API and websocket routes are registered above and never reach this handler.
// Requests that clearly ask for a file (e.g. /missing.js) still 404.
app.get("*", (req, res, next) => {
  if (!req.accepts("html")) return next();
  if (path.extname(req.path)) return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((req, res) => {
  res.status(404).type("text/plain").send("Not found");
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error("[http] unhandled error:", error);
  if (res.headersSent) return next(error);
  res.status(500).type("text/plain").send("Something went wrong.");
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Socket.IO signaling
// ---------------------------------------------------------------------------

const io = new Server(server, {
  // Signaling payloads are tiny (SDP + ICE). A large buffer is never needed.
  maxHttpBufferSize: 128 * 1024,
  pingInterval: 20_000,
  pingTimeout: 10_000,
  // The browser client is served by this same process.
  serveClient: true,
});

function countActiveRooms() {
  let count = 0;
  for (const [roomName, members] of io.sockets.adapter.rooms) {
    // Socket.IO creates one private room per socket, keyed by socket id.
    if (io.sockets.sockets.has(roomName)) continue;
    if (members.size > 0) count += 1;
  }
  return count;
}

/** Snapshot of everyone already in a room (excluding the newcomer). */
function snapshotPeers(room, exceptId) {
  const peers = [];
  const members = io.sockets.adapter.rooms.get(room);
  if (!members) return peers;

  for (const id of members) {
    if (id === exceptId) continue;
    const peer = io.sockets.sockets.get(id);
    if (!peer || peer.data.room !== room) continue;
    peers.push({
      id,
      name: peer.data.name,
      muted: peer.data.muted === true,
      sharing: peer.data.sharing === true,
      sharingAudio: peer.data.sharingAudio === true,
    });
  }

  return peers;
}

/** Notify the room that a socket left, then detach the socket from it. */
function leaveRoom(socket, { notify = true } = {}) {
  const room = socket.data.room;
  if (!room) return;

  if (notify) {
    socket.to(room).emit("peer-left", { id: socket.id });
  }

  socket.leave(room);
  socket.data.room = null;
  socket.data.sharing = false;
  socket.data.sharingAudio = false;
  log(`[room ${room}] ${socket.data.name} left`);
}

/**
 * Relay a signaling payload to exactly one peer, but only when both sockets
 * are currently inside the same room. This prevents cross-room message leaks.
 */
function relayToPeer(eventName, socket, payload, makeBody) {
  const room = socket.data.room;
  if (!room) return;

  const targetId = payload && typeof payload === "object" ? payload.to : null;
  if (typeof targetId !== "string" || targetId.length > 128) return;
  if (targetId === socket.id) return;

  const target = io.sockets.sockets.get(targetId);
  if (!target || target.data.room !== room) return;

  const body = makeBody(payload);
  if (!body) return;

  target.emit(eventName, {
    from: socket.id,
    fromName: socket.data.name,
    ...body,
  });
}

io.on("connection", (socket) => {
  socket.data.room = null;
  socket.data.name = "Pirate";
  socket.data.muted = false;
  socket.data.sharing = false;
  socket.data.sharingAudio = false;
  socket.data.lastJoinAt = 0;

  // -------------------------------------------------------------------------
  // Join a room
  // -------------------------------------------------------------------------
  socket.on("join", (payload, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};

    if (!payload || typeof payload !== "object") {
      respond({ ok: false, error: "Invalid join request." });
      return;
    }

    // Very light anti-spam guard. Reconnections use a fresh socket object,
    // so this never blocks a legitimate reconnect.
    const now = Date.now();
    if (now - socket.data.lastJoinAt < 400) {
      respond({ ok: false, error: "Slow down a little and try again." });
      return;
    }
    socket.data.lastJoinAt = now;

    const room = normalizeRoom(payload.room);
    if (!room) {
      respond({ ok: false, error: "Enter a valid room name." });
      return;
    }

    const name = normalizeName(payload.name);
    const muted = payload.muted === true;
    const sharing = payload.sharing === true;
    const sharingAudio = sharing && payload.sharingAudio === true;
    const members = io.sockets.adapter.rooms.get(room);
    const currentSize = members ? members.size : 0;

    // Joining the same room again (e.g. rapid double join) is a no-op refresh.
    if (socket.data.room !== room && currentSize >= MAX_ROOM_PEERS) {
      respond({
        ok: false,
        error: `This room is full (${MAX_ROOM_PEERS} pirates max). Try another room.`,
      });
      return;
    }

    // Moving from one room to another: leave the old room cleanly first.
    if (socket.data.room && socket.data.room !== room) {
      leaveRoom(socket);
    }

    const alreadyInRoom = socket.data.room === room;

    if (!alreadyInRoom) {
      socket.join(room);
      socket.data.room = room;
    }

    socket.data.name = name;
    socket.data.muted = muted;
    socket.data.sharing = sharing;
    socket.data.sharingAudio = sharingAudio;

    if (!alreadyInRoom) {
      // Tell the existing crew about the newcomer.
      socket.to(room).emit("peer-joined", {
        id: socket.id,
        name,
        muted,
        sharing,
        sharingAudio,
      });
      log(`[room ${room}] ${name} joined (${currentSize + 1}/${MAX_ROOM_PEERS})`);
    }

    respond({
      ok: true,
      id: socket.id,
      room,
      name,
      maxRoomPeers: MAX_ROOM_PEERS,
      peers: snapshotPeers(room, socket.id),
    });
  });

  // -------------------------------------------------------------------------
  // WebRTC signaling relay
  // -------------------------------------------------------------------------
  socket.on("offer", (payload) => {
    relayToPeer("offer", socket, payload, (data) => {
      const sdp = normalizeSdp(data.sdp, "offer");
      if (!sdp) return null;
      // Include the sender's current state so the receiver can render the
      // correct mute/share UI even if the offer arrives before peer-joined.
      return {
        sdp,
        muted: socket.data.muted === true,
        sharing: socket.data.sharing === true,
        sharingAudio: socket.data.sharingAudio === true,
      };
    });
  });

  socket.on("answer", (payload) => {
    relayToPeer("answer", socket, payload, (data) => {
      const sdp = normalizeSdp(data.sdp, "answer");
      return sdp ? { sdp } : null;
    });
  });

  socket.on("ice", (payload) => {
    relayToPeer("ice", socket, payload, (data) => {
      const candidate = normalizeCandidate(data.candidate);
      return candidate ? { candidate } : null;
    });
  });

  // -------------------------------------------------------------------------
  // Share state (mute + screen sharing) so remote UI stays accurate
  // -------------------------------------------------------------------------
  socket.on("state", (payload) => {
    const room = socket.data.room;
    if (!room || !payload || typeof payload !== "object") return;

    const muted = payload.muted === true;
    const sharing = payload.sharing === true;
    const sharingAudio = sharing && payload.sharingAudio === true;

    socket.data.muted = muted;
    socket.data.sharing = sharing;
    socket.data.sharingAudio = sharingAudio;

    socket.to(room).emit("peer-state", {
      id: socket.id,
      muted,
      sharing,
      sharingAudio,
    });
  });

  // -------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------
  socket.on("leave", () => {
    leaveRoom(socket);
  });

  // `disconnecting` still has access to the room list. Without it, the socket
  // would already have been removed from its room by the time we broadcast.
  socket.on("disconnecting", () => {
    const room = socket.data.room;
    if (!room) return;
    socket.to(room).emit("peer-left", { id: socket.id });
    log(`[room ${room}] ${socket.data.name} disconnected`);
  });
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

server.on("error", (error) => {
  console.error("[server] fatal error:", error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log("");
  console.log("  ⛵  LUFFY is ready to sail");
  console.log(`      Local:   http://${shownHost}:${PORT}`);
  console.log(`      Rooms:   up to ${MAX_ROOM_PEERS} pirates each`);
  console.log(`      Mode:    ${IS_PRODUCTION ? "production" : "development"}`);
  console.log("");
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received — closing connections…`);

  // io.close() closes the HTTP server too.
  io.close(() => {
    console.log("[server] bye ⛵");
    process.exit(0);
  });

  // Never hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
