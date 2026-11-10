/**
 * LUFFY — client
 * ---------------------------------------------------------------------------
 * Mesh WebRTC voice + screen sharing on top of Socket.IO signaling.
 *
 * Design notes
 * ------------
 *  • Every pairing gets ONE RTCPeerConnection with THREE pre-negotiated
 *    "sendrecv" transceivers, always in this order:
 *        0. microphone audio
 *        1. screen video
 *        2. screen / system audio
 *    Dummy silent + black tracks keep every m-line live from the first offer.
 *    Starting or stopping a screen share is therefore just `replaceTrack()`,
 *    with no renegotiation and no glare.
 *
 *  • The newer peer is always the offerer. An existing peer only ever answers.
 *    This removes offer collisions entirely.
 *
 *  • Each remote peer has:
 *        - a hidden <audio> element for their microphone
 *        - a <video> element whose srcObject also carries screen audio
 *    which allows independent volume control for voice and screen audio.
 *
 *  • If a connection fails, the peer with the lexicographically smaller socket
 *    id re-offers after a short delay; the other side answers the fresh offer.
 * ---------------------------------------------------------------------------
 */

"use strict";

(() => {
  // =========================================================================
  // 1. DOM references
  // =========================================================================
  const $ = (selector, root = document) => root.querySelector(selector);

  const el = {
    lobby: $("#lobby"),
    call: $("#call"),
    joinForm: $("#joinForm"),
    nameInput: $("#nameInput"),
    roomInput: $("#roomInput"),
    joinBtn: $("#joinBtn"),
    joinBtnLabel: $("#joinBtnLabel"),
    lobbyError: $("#lobbyError"),
    diceBtn: $("#diceBtn"),
    roomTitle: $("#roomTitle"),
    peerCount: $("#peerCount"),
    peerGrid: $("#peerGrid"),
    micBtn: $("#micBtn"),
    micLabel: $("#micLabel"),
    screenBtn: $("#screenBtn"),
    screenLabel: $("#screenLabel"),
    leaveBtn: $("#leaveBtn"),
    copyInviteBtn: $("#copyInviteBtn"),
    connectionPill: $("#connectionPill"),
    connectionText: $("#connectionText"),
    audioUnlockBtn: $("#audioUnlockBtn"),
    toasts: $("#toasts"),
    peerTemplate: $("#peerCardTemplate"),

    // Crew chat
    chatPanel: $("#chatPanel"),
    chatLog: $("#chatLog"),
    chatEmpty: $("#chatEmpty"),
    chatForm: $("#chatForm"),
    chatInput: $("#chatInput"),
    chatSendBtn: $("#chatSendBtn"),
    emojiBtn: $("#emojiBtn"),
    emojiPanel: $("#emojiPanel"),
    imageBtn: $("#imageBtn"),
    imageInput: $("#chatImageInput"),
    chatAttachment: $("#chatAttachment"),
    chatAttachmentImage: $("#chatAttachmentImage"),
    chatAttachmentName: $("#chatAttachmentName"),
    chatAttachmentSize: $("#chatAttachmentSize"),
    chatAttachmentRemove: $("#chatAttachmentRemove"),
    chatBtn: $("#chatBtn"),
    chatUnread: $("#chatUnread"),
    chatCloseBtn: $("#chatCloseBtn"),
    chatBackdrop: $("#chatBackdrop"),
    chatLightbox: $("#chatLightbox"),
    chatLightboxImage: $("#chatLightboxImage"),
    chatLightboxClose: $("#chatLightboxClose"),

    // Stream quality
    qualitySelect: $("#qualitySelect"),
    qualitySelectCall: $("#qualitySelectCall"),
    qualityHint: $("#qualityHint"),
    qualityHintCall: $("#qualityHintCall"),
  };

  // =========================================================================
  // 2. Constants + state
  // =========================================================================
  const DEFAULT_ICE = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];

  const PURPOSES = ["mic", "video", "screenAudio"];
  const ROOM_MAX_LENGTH = 32;
  const NAME_MAX_LENGTH = 24;
  const LEVEL_INTERVAL_MS = 100;

  const STORAGE_NAME = "luffy:name";
  const STORAGE_VOLUMES = "luffy:volumes:v1";
  const STORAGE_QUALITY = "luffy:quality:v1";
  const DEFAULT_QUALITY = "saver";

  /**
   * Stream-quality presets. Each preset controls three things:
   *   • capture  — constraints handed to getDisplayMedia()
   *   • video    — encoder ceiling applied through RTCRtpSender.setParameters()
   *   • opus     — Opus parameters written into the SDP (DTX is the big win:
   *                no packets at all while nobody is talking)
   *
   * `video: null` means voice-only: the video sender is deactivated and screen
   * sharing is disabled while that preset is selected.
   *
   * Figures are ceilings, not guarantees. Actual usage also depends on how much
   * the screen changes and how much people talk.
   */
  const QUALITY_PRESETS = {
    voice: {
      id: "voice",
      label: "Voice only",
      short: "Voice only",
      detail: "No screen video. Smallest possible data use.",
      audioBitrate: 16_000,
      video: null,
      capture: null,
      contentHint: "speech",
      opus: { maxaveragebitrate: 16_000, usedtx: true, useinbandfec: false },
      imageDimension: 1_000,
      imageQuality: 0.78,
    },
    saver: {
      id: "saver",
      label: "Data saver",
      short: "Saver",
      detail: "Voice-first with a small, low-motion screen stream (under ~1 MB/min).",
      audioBitrate: 16_000,
      video: { width: 640, height: 360, frameRate: 5, maxBitrate: 80_000 },
      capture: { width: 1280, height: 720, frameRate: 15 },
      contentHint: "text",
      opus: { maxaveragebitrate: 16_000, usedtx: true, useinbandfec: false },
      imageDimension: 1_000,
      imageQuality: 0.8,
    },
    low: {
      id: "low",
      label: "Low",
      short: "Low",
      detail: "480p screen at 15 fps. Good on mobile data.",
      audioBitrate: 24_000,
      video: { width: 854, height: 480, frameRate: 15, maxBitrate: 500_000 },
      capture: { width: 1920, height: 1080, frameRate: 20 },
      contentHint: "text",
      opus: { maxaveragebitrate: 24_000, usedtx: true, useinbandfec: true },
      imageDimension: 1_400,
      imageQuality: 0.82,
    },
    medium: {
      id: "medium",
      label: "Balanced",
      short: "Balanced",
      detail: "720p screen at 30 fps. A good everyday default.",
      audioBitrate: 32_000,
      video: { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_200_000 },
      capture: { width: 1920, height: 1080, frameRate: 30 },
      contentHint: "text",
      opus: { maxaveragebitrate: 32_000, usedtx: true, useinbandfec: true },
      imageDimension: 1_600,
      imageQuality: 0.85,
    },
    high: {
      id: "high",
      label: "High",
      short: "High",
      detail: "1080p screen at 60 fps. Needs a strong connection.",
      audioBitrate: 48_000,
      video: { width: 1920, height: 1080, frameRate: 60, maxBitrate: 4_000_000 },
      capture: { width: 1920, height: 1080, frameRate: 60 },
      contentHint: "detail",
      opus: { maxaveragebitrate: 48_000, usedtx: true, useinbandfec: true },
      imageDimension: 1_600,
      imageQuality: 0.86,
    },
  };
  const QUALITY_ORDER = ["voice", "saver", "low", "medium", "high"];

  // Chat
  const CHAT_MAX_LENGTH = 2_000;
  const CHAT_MAX_MESSAGES = 200;
  const CHAT_IMAGE_INPUT_MAX = 15 * 1024 * 1024;
  const CHAT_IMAGE_DATA_URL_MAX = 3_400_000;
  const CHAT_IMAGE_DIMENSION = 1_600;
  const CHAT_DRAWER_QUERY = "(max-width: 1080px)";
  const CHAT_EMOJIS = [
    "😀", "😄", "😂", "🤣", "😊", "😍", "😘", "😎",
    "🤩", "🥳", "😜", "🤔", "🤗", "🤭", "😴", "😭",
    "😤", "😡", "🥺", "😱", "🤯", "🫠", "😇", "😈",
    "💀", "👻", "🤖", "👽", "💩", "🔥", "✨", "🌟",
    "💫", "⚡", "💥", "💖", "💛", "💚", "💙", "💜",
    "🖤", "💯", "👍", "👎", "👏", "🙌", "🤝", "🙏",
    "💪", "🫶", "👋", "✌️", "🤞", "🫡", "🍻", "🍺",
    "🍕", "🍔", "🍟", "🍣", "🍰", "☕", "🧊", "⛵",
    "🌊", "🌴", "🏴‍☠️", "🗺️", "🎉", "🎮", "🎵", "🎧",
    "📸", "❤️",
  ];

  const ROOM_WORDS = [
    "grand-line",
    "straw-hat",
    "thousand-sunny",
    "wano",
    "skypiea",
    "water-7",
    "dressrosa",
    "fishman-isle",
    "whole-cake",
    "egghead",
  ];

  const state = {
    // Session
    joined: false,
    joinInFlight: false,
    room: "",
    name: "",
    rejoinAttempts: 0,
    rejoinTimer: null,

    // Local media
    micStream: null,
    micTrack: null,
    micMuted: true,
    micBusy: false,
    screenStream: null,
    screenTrack: null,
    screenAudioTrack: null,
    sharing: false,
    sharingAudio: false,
    screenBusy: false,

    // Remote peers: id -> peer object
    peers: new Map(),
    selfCard: null,
    localMeter: null,

    // Crew chat
    chatMessages: new Map(),
    chatAttachment: null,
    chatUnread: 0,
    chatOpen: false,
    chatImageBusy: false,

    // ICE + misc
    iceServers: DEFAULT_ICE,
    audioContext: null,
    silentMicTrack: null,
    silentScreenTrack: null,
    blankVideoTrack: null,
    keepAlive: [],

    // Stream quality
    quality: DEFAULT_QUALITY,
    serverDefaultQuality: "",
  };

  const rtcSupported = typeof window.RTCPeerConnection === "function";

  // =========================================================================
  // 3. Small utilities
  // =========================================================================
  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

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

  function cleanName(raw) {
    if (typeof raw !== "string") return "";
    return raw
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX_LENGTH);
  }

  function firstChar(value) {
    const chars = Array.from(value || "");
    return chars.length > 0 ? chars[0].toUpperCase() : "?";
  }

  function hueFor(value) {
    let hue = 0;
    for (let i = 0; i < value.length; i += 1) {
      hue = (hue * 31 + value.charCodeAt(i)) % 360;
    }
    return hue;
  }

  function setIcon(target, href) {
    if (!target) return;
    const use = target.matches?.("use") ? target : target.querySelector?.("use");
    if (!use) return;
    use.setAttribute("href", href);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
  }

  function setSliderFill(input, percent) {
    input.style.setProperty("--fill", `${percent}%`);
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already ended */
      }
    }
  }

  function randomRoom() {
    const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${word}-${suffix}`;
  }

  function buildInviteUrl(room) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    if (room) url.searchParams.set("room", room);
    return url.toString();
  }

  function setConnection(connectionState, text) {
    el.connectionPill.dataset.state = connectionState;
    el.connectionText.textContent = text;
  }

  function showLobbyError(message) {
    el.lobbyError.textContent = message || "";
    el.lobbyError.hidden = !message;
  }

  function setJoinBusy(busy, label) {
    el.joinBtn.disabled = busy;
    el.joinBtn.classList.toggle("is-busy", busy);
    el.joinBtnLabel.textContent = label || "Join the call";
  }

  function toast(message, tone = "info", duration = 4200) {
    while (el.toasts.children.length >= 4) {
      el.toasts.firstElementChild?.remove();
    }

    const node = document.createElement("div");
    node.className = `toast toast-${tone}`;
    node.setAttribute("role", "status");

    const dot = document.createElement("span");
    dot.className = "toast-dot";
    dot.setAttribute("aria-hidden", "true");

    const text = document.createElement("p");
    text.textContent = message;

    node.append(dot, text);
    el.toasts.append(node);

    requestAnimationFrame(() => node.classList.add("is-visible"));
    window.setTimeout(() => {
      node.classList.remove("is-visible");
      window.setTimeout(() => node.remove(), 320);
    }, duration);
  }

  function playMedia(mediaEl) {
    if (!mediaEl) return;
    const promise = mediaEl.play?.();
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {
        if (state.joined) el.audioUnlockBtn.hidden = false;
      });
    }
  }

  // =========================================================================
  // 4. Local storage (name + per-friend volume preferences)
  // =========================================================================
  function readSavedName() {
    try {
      return cleanName(window.localStorage.getItem(STORAGE_NAME) || "");
    } catch {
      return "";
    }
  }

  function saveName(name) {
    try {
      window.localStorage.setItem(STORAGE_NAME, name);
    } catch {
      /* private mode */
    }
  }

  function readVolumeStore() {
    try {
      const raw = window.localStorage.getItem(STORAGE_VOLUMES);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function loadVolumePrefs(name) {
    const store = readVolumeStore();
    const saved = store[name.trim().toLowerCase()] || {};
    return {
      mic: clampNumber(saved.mic, 0, 100, 100),
      micMuted: saved.micMuted === true,
      screen: clampNumber(saved.screen, 0, 100, 100),
      screenMuted: saved.screenMuted === true,
    };
  }

  function saveVolumePrefs(peer) {
    try {
      const store = readVolumeStore();
      const keys = Object.keys(store);
      if (keys.length > 150 && !store[peer.name.toLowerCase()]) {
        delete store[keys[0]];
      }
      store[peer.name.trim().toLowerCase()] = {
        mic: peer.prefs.mic,
        micMuted: peer.prefs.micMuted,
        screen: peer.prefs.screen,
        screenMuted: peer.prefs.screenMuted,
      };
      window.localStorage.setItem(STORAGE_VOLUMES, JSON.stringify(store));
    } catch {
      /* storage unavailable */
    }
  }

  // =========================================================================
  // 4b. Stream quality / bandwidth presets
  // =========================================================================
  function getQualityPreset(id = state.quality) {
    return QUALITY_PRESETS[id] || QUALITY_PRESETS[DEFAULT_QUALITY];
  }

  function readSavedQuality() {
    try {
      const saved = window.localStorage.getItem(STORAGE_QUALITY) || "";
      return QUALITY_PRESETS[saved] ? saved : "";
    } catch {
      return "";
    }
  }

  function saveQuality(id) {
    try {
      window.localStorage.setItem(STORAGE_QUALITY, id);
    } catch {
      /* private mode */
    }
  }

  /**
   * Rough "how much will this use per minute" figure. Covers the media
   * ceilings only, not signaling (a few KB/min) or chat.
   */
  function qualityMegabytesPerMinute(preset) {
    const shareAudio = preset.video ? Math.max(preset.audioBitrate, 24_000) : 0;
    const bitsPerSecond = preset.audioBitrate + shareAudio + (preset.video?.maxBitrate || 0);
    return (bitsPerSecond * 60) / 8 / 1_000_000;
  }

  function qualityBandwidthLabel(preset) {
    const mb = qualityMegabytesPerMinute(preset);
    if (mb < 0.1) return "< 0.1 MB/min out";
    if (mb < 1) return `~${mb.toFixed(2)} MB/min out`;
    return `~${mb.toFixed(1)} MB/min out`;
  }

  function qualitySummary(preset) {
    if (!preset.video) {
      return `${preset.label}: no screen video, ${qualityBandwidthLabel(preset)} (less while quiet).`;
    }
    return `${preset.label}: ${preset.video.width}×${preset.video.height} at ${preset.video.frameRate} fps, ${qualityBandwidthLabel(preset)}.`;
  }

  function populateQualitySelects() {
    for (const select of [el.qualitySelect, el.qualitySelectCall]) {
      if (!select) continue;
      const fragment = document.createDocumentFragment();
      for (const id of QUALITY_ORDER) {
        const preset = QUALITY_PRESETS[id];
        const option = document.createElement("option");
        option.value = id;
        option.textContent = `${preset.label} — ${qualityBandwidthLabel(preset)}`;
        fragment.append(option);
      }
      select.replaceChildren(fragment);
    }
  }

  function updateQualityUi() {
    const preset = getQualityPreset();

    if (el.qualitySelect) el.qualitySelect.value = preset.id;
    if (el.qualitySelectCall) el.qualitySelectCall.value = preset.id;

    if (el.qualityHint) el.qualityHint.textContent = qualitySummary(preset);
    if (el.qualityHintCall) el.qualityHintCall.textContent = qualitySummary(preset);

    updateScreenUI();
  }

  /**
   * Change presets live: re-tune every active peer, stop an existing screen
   * share if the new preset is voice-only, and remember the choice.
   */
  function setQuality(id, { silent = false, apply = true, persist = true } = {}) {
    const next = QUALITY_PRESETS[id] ? id : DEFAULT_QUALITY;
    const changed = state.quality !== next;

    state.quality = next;
    if (persist) saveQuality(next);
    updateQualityUi();

    if (!changed) return;

    const preset = getQualityPreset();

    if (apply) {
      if (!preset.video && (state.sharing || state.screenStream)) {
        void stopScreenShare({ silent: true });
      }
      for (const peer of state.peers.values()) {
        void applyQualityToPeer(peer);
      }
    }

    if (!silent) {
      toast(`Quality set to ${preset.label.toLowerCase()}.`, "success", 2600);
    }
  }

  /** Apply the active preset to one peer's audio + video senders. */
  async function applyQualityToPeer(peer) {
    const preset = getQualityPreset();
    const jobs = [];

    if (peer?.tx?.video?.sender) {
      jobs.push(tuneVideoSender(peer.tx.video.sender, preset));
    }
    if (peer?.tx?.mic?.sender) {
      jobs.push(tuneAudioSender(peer.tx.mic.sender, preset, "mic"));
    }
    if (peer?.tx?.screenAudio?.sender) {
      jobs.push(tuneAudioSender(peer.tx.screenAudio.sender, preset, "screenAudio"));
    }

    await Promise.allSettled(jobs);
  }

  async function tuneVideoSender(sender, preset) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      for (const encoding of parameters.encodings) {
        if (!preset.video) {
          encoding.active = false;
          continue;
        }

        // Only transmit while a screen is actually being shared. This keeps
        // the negotiated m-line alive without sending the blank placeholder.
        encoding.active = Boolean(state.sharing);
        encoding.maxBitrate = preset.video.maxBitrate;
        encoding.maxFramerate = preset.video.frameRate;

        // Scale the captured screen down to the preset's output size. Chrome
        // accepts fractional values, so 1920 -> 854 becomes x2.25, not x3.
        const settings = state.screenTrack?.getSettings?.() || {};
        const sourceWidth = Number(settings.width) || 0;
        if (sourceWidth > preset.video.width) {
          const scale = sourceWidth / preset.video.width;
          encoding.scaleResolutionDownBy = Math.max(1, Math.min(8, Number(scale.toFixed(2))));
        } else {
          encoding.scaleResolutionDownBy = 1;
        }
      }

      if ("degradationPreference" in parameters) {
        parameters.degradationPreference = "maintain-resolution";
      }

      await sender.setParameters(parameters);
    } catch {
      // Browsers can reject parameter changes before negotiation settles.
    }
  }

  async function tuneAudioSender(sender, preset, kind) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      for (const encoding of parameters.encodings) {
        // Stop paying for packets we do not need: muted mics and shares with
        // no captured audio are deactivated entirely until they come back.
        encoding.active =
          kind === "screenAudio"
            ? Boolean(state.sharingAudio)
            : Boolean(state.micTrack && !state.micMuted);

        // Voice gets the full preset budget; share audio stays a touch higher
        // so music/system sounds do not turn to mush in saver mode.
        encoding.maxBitrate =
          kind === "screenAudio"
            ? Math.max(preset.audioBitrate, 24_000)
            : preset.audioBitrate;
        if ("networkPriority" in encoding) {
          encoding.networkPriority = kind === "mic" ? "high" : "low";
        }
      }

      await sender.setParameters(parameters);
    } catch {
      // Older browsers may ignore audio bitrate ceilings.
    }
  }

  /**
   * Write Opus preferences into an SDP blob. `usedtx=1` lets the encoder stop
   * sending packets during silence, which is where the biggest savings come
   * from on a voice call. Munging is wrapped so a browser that dislikes it
   * still negotiates with the original description.
   */
  function tuneOpusSdp(sdp, preset) {
    if (typeof sdp !== "string" || !preset?.opus) return sdp;

    const lines = sdp.split("\r\n");
    const opusPayloads = new Set();

    for (const line of lines) {
      const match = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?$/i.exec(line);
      if (match) opusPayloads.add(match[1]);
    }
    if (opusPayloads.size === 0) return sdp;

    for (const payload of opusPayloads) {
      const fmtpPrefix = `a=fmtp:${payload} `;
      const fmtpIndexes = [];
      const rtpmapIndexes = [];

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith(fmtpPrefix)) fmtpIndexes.push(index);

        const match = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?$/i.exec(lines[index]);
        if (match && match[1] === payload) rtpmapIndexes.push(index);
      }

      const parameters = new Map();

      // Preserve unknown/optional parameters Chrome may have added.
      if (fmtpIndexes.length > 0) {
        const existing = lines[fmtpIndexes[0]].slice(fmtpPrefix.length);
        for (const part of existing.split(";")) {
          const [key, ...rest] = part.split("=");
          const name = key.trim();
          if (name) parameters.set(name, rest.join("=").trim());
        }
      }

      parameters.set("maxaveragebitrate", String(preset.opus.maxaveragebitrate));
      parameters.set("stereo", "0");
      parameters.set("sprop-stereo", "0");
      parameters.set("usedtx", preset.opus.usedtx ? "1" : "0");
      parameters.set("useinbandfec", preset.opus.useinbandfec ? "1" : "0");
      parameters.set("minptime", "10");

      const fmtp = `${fmtpPrefix}${[...parameters]
        .map(([key, value]) => (value ? `${key}=${value}` : key))
        .join(";")}`;

      if (fmtpIndexes.length > 0) {
        for (const index of fmtpIndexes) lines[index] = fmtp;
      }

      // Make sure every Opus m-line (mic, screen audio, ...) carries the
      // parameters, including sections that had no fmtp line to begin with.
      // Insert back-to-front so earlier indexes stay valid.
      for (const index of rtpmapIndexes.reverse()) {
        const next = lines[index + 1] || "";
        if (!next.startsWith(fmtpPrefix)) {
          lines.splice(index + 1, 0, fmtp);
        }
      }
    }

    return lines.join("\r\n");
  }

  function tuneDescription(description, preset) {
    try {
      return { type: description.type, sdp: tuneOpusSdp(description.sdp, preset) };
    } catch {
      return description;
    }
  }

  // =========================================================================
  // 5. Audio helpers: AudioContext, silent/black placeholder tracks, meters
  // =========================================================================
  function getAudioContext() {
    if (!state.audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      try {
        state.audioContext = new AudioCtor();
      } catch {
        return null;
      }
    }

    if (state.audioContext.state === "suspended") {
      state.audioContext.resume().catch(() => {});
    }

    return state.audioContext;
  }

  /**
   * A permanently silent audio track is used as a placeholder so every audio
   * transceiver is negotiated in the very first offer/answer. A real
   * microphone or system-audio track later replaces it with replaceTrack().
   */
  function makeSilentTrack() {
    const context = getAudioContext();
    if (!context) return null;

    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();

      oscillator.frequency.value = 20;
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();

      state.keepAlive.push(oscillator, gain, destination);
      return destination.stream.getAudioTracks()[0] || null;
    } catch {
      return null;
    }
  }

  function getSilentMicTrack() {
    if (!state.silentMicTrack || state.silentMicTrack.readyState === "ended") {
      state.silentMicTrack = makeSilentTrack();
    }
    return state.silentMicTrack;
  }

  function getSilentScreenTrack() {
    if (!state.silentScreenTrack || state.silentScreenTrack.readyState === "ended") {
      state.silentScreenTrack = makeSilentTrack();
    }
    return state.silentScreenTrack;
  }

  /**
   * A tiny black canvas track keeps the video m-line "sendrecv" from the start.
   * Screen video replaces it on demand.
   */
  function getBlankVideoTrack() {
    if (state.blankVideoTrack && state.blankVideoTrack.readyState === "live") {
      return state.blankVideoTrack;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#000";
      context.fillRect(0, 0, 16, 16);

      if (typeof canvas.captureStream !== "function") return null;
      const stream = canvas.captureStream(1);
      state.keepAlive.push(canvas, stream);
      state.blankVideoTrack = stream.getVideoTracks()[0] || null;
      return state.blankVideoTrack;
    } catch {
      return null;
    }
  }

  function addMediaTransceiver(pc, kind, track) {
    if (track) {
      return pc.addTransceiver(track, { direction: "sendrecv" });
    }
    return pc.addTransceiver(kind, { direction: "sendrecv" });
  }

  /**
   * Taps a MediaStream for level metering without producing audible output.
   * The analyser is connected to a zero-gain node so the graph stays active.
   */
  function createMeter(stream) {
    if (!stream || stream.getAudioTracks().length === 0) return null;
    const context = getAudioContext();
    if (!context) return null;

    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      const sink = context.createGain();

      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      sink.gain.value = 0;

      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(context.destination);

      return {
        source,
        analyser,
        sink,
        data: new Uint8Array(analyser.frequencyBinCount),
        level: 0,
        lastVoice: 0,
      };
    } catch {
      return null;
    }
  }

  function destroyMeter(meter) {
    if (!meter) return;
    try {
      meter.source.disconnect();
    } catch {}
    try {
      meter.analyser.disconnect();
    } catch {}
    try {
      meter.sink.disconnect();
    } catch {}
  }

  function readLevel(meter) {
    if (!meter) return 0;

    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (let i = 0; i < meter.data.length; i += 1) {
      const value = (meter.data[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / meter.data.length);
    const target = Math.min(1, rms * 3.2);
    meter.level = meter.level * 0.55 + target * 0.45;
    return meter.level;
  }

  function paintMeter(card, level, meter) {
    if (!card) return;
    const bar = card.querySelector(".level-meter i");
    if (bar) bar.style.width = `${Math.min(100, Math.round(level * 120))}%`;

    if (!meter) return;
    const now = performance.now();
    if (level > 0.055) meter.lastVoice = now;
    card.classList.toggle("is-speaking", now - meter.lastVoice < 420);
  }

  function tickMeters() {
    if (!state.joined || document.hidden) return;

    if (state.selfCard) {
      if (state.micMuted || !state.localMeter) {
        const bar = state.selfCard.querySelector(".level-meter i");
        if (bar) bar.style.width = "0%";
        state.selfCard.classList.remove("is-speaking");
      } else {
        paintMeter(state.selfCard, readLevel(state.localMeter), state.localMeter);
      }
    }

    for (const peer of state.peers.values()) {
      if (!peer.meter) continue;
      paintMeter(peer.els.card, readLevel(peer.meter), peer.meter);
    }
  }

  function refreshLocalMeter() {
    if (state.localMeter) {
      destroyMeter(state.localMeter);
      state.localMeter = null;
    }
    if (state.selfCard && state.micStream) {
      state.localMeter = createMeter(state.micStream);
    }
  }

  // =========================================================================
  // 6. Camera / microphone / screen capture
  // =========================================================================
  async function ensureMic({ silent = false } = {}) {
    if (state.micTrack && state.micTrack.readyState === "live") {
      if (state.micMuted) {
        state.micMuted = false;
        state.micTrack.enabled = true;
        updateMicUI();
        emitState();
      }
      return true;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      if (!silent) {
        toast("This browser can't access a microphone.", "error");
      }
      state.micMuted = true;
      updateMicUI();
      return false;
    }

    if (state.micBusy) return false;
    state.micBusy = true;

    try {
      getAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });

      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("No microphone track was returned.");

      stopStream(state.micStream);
      state.micStream = stream;
      state.micTrack = track;
      state.micMuted = false;
      track.enabled = true;
      track.contentHint = "speech";
      track.addEventListener("ended", handleMicEnded);

      // Replace the silent placeholder on every active peer connection.
      await replaceTrackOnAllPeers("mic", track);
      refreshLocalMeter();
      updateMicUI();
      updateSelfCard();
      emitState();
      return true;
    } catch (error) {
      if (!silent) {
        let message = "No microphone was found. Check your device and try again.";
        if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
          message = "Microphone permission was denied. Allow it in your browser settings.";
        } else if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
          message = "No microphone is connected.";
        } else if (!window.isSecureContext) {
          message = "Microphone access needs HTTPS (or localhost).";
        }
        toast(message, "error", 6000);
      }
      state.micMuted = true;
      updateMicUI();
      return false;
    } finally {
      state.micBusy = false;
    }
  }

  function releaseMic() {
    if (state.micTrack) {
      state.micTrack.removeEventListener("ended", handleMicEnded);
    }
    stopStream(state.micStream);
    state.micStream = null;
    state.micTrack = null;
    state.micMuted = true;

    if (state.localMeter) {
      destroyMeter(state.localMeter);
      state.localMeter = null;
    }

    updateMicUI();
    updateSelfCard();
  }

  function handleMicEnded() {
    state.micTrack = null;
    state.micStream = null;
    state.micMuted = true;
    void replaceTrackOnAllPeers("mic", getSilentMicTrack());
    refreshLocalMeter();
    updateMicUI();
    emitState();
    toast("Your microphone disconnected.", "warning");
  }

  async function toggleMic() {
    if (!state.joined) return;

    if (state.micMuted) {
      const ok = await ensureMic();
      if (ok) toast("Microphone is live.", "success", 2400);
      return;
    }

    state.micMuted = true;
    if (state.micTrack) state.micTrack.enabled = false;
    updateMicUI();
    emitState();
  }

  function releaseScreenStream() {
    if (state.screenStream) {
      stopStream(state.screenStream);
    }
    state.screenStream = null;
    state.screenTrack = null;
    state.screenAudioTrack = null;
  }

  async function startScreenShare() {
    if (!state.joined || state.sharing || state.screenBusy) return;

    const preset = getQualityPreset();

    if (!preset.video) {
      toast(
        "Voice-only quality is on. Pick Data saver or higher to share your screen.",
        "warning",
        5200
      );
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast("Screen sharing isn't supported in this browser.", "error");
      return;
    }

    state.screenBusy = true;
    updateScreenUI();

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // Capture at the preset's ceiling; the encoder then scales the output
        // down to the smaller target without sending extra pixels.
        video: {
          frameRate: { ideal: preset.capture.frameRate, max: preset.capture.frameRate },
          width: { ideal: preset.capture.width, max: preset.capture.width },
          height: { ideal: preset.capture.height, max: preset.capture.height },
        },
        audio: true,
        // Chromium display-capture hints (ignored elsewhere).
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stopStream(stream);
        throw new Error("No screen video track was returned.");
      }

      videoTrack.contentHint = preset.contentHint;

      state.screenStream = stream;
      state.screenTrack = videoTrack;
      state.screenAudioTrack = stream.getAudioTracks()[0] || null;
      state.sharing = true;
      state.sharingAudio = Boolean(state.screenAudioTrack);

      videoTrack.addEventListener("ended", onScreenShareEnded);

      await replaceTrackOnAllPeers("video", videoTrack);
      await replaceTrackOnAllPeers(
        "screenAudio",
        state.screenAudioTrack || getSilentScreenTrack()
      );

      for (const peer of state.peers.values()) tuneScreenSender(peer);

      updateScreenUI();
      updateSelfCard();
      emitState();

      if (state.sharingAudio) {
        toast("Screen + system audio are live.", "success");
      } else {
        toast("Screen is live. No system audio was captured.", "info");
      }
    } catch (error) {
      if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
        console.error("[screen] failed to start:", error);
        toast("Couldn't start screen sharing.", "error");
      }

      // Roll back a partial start.
      if (state.screenStream) {
        if (state.screenTrack) {
          state.screenTrack.removeEventListener("ended", onScreenShareEnded);
        }
        state.sharing = false;
        state.sharingAudio = false;
        releaseScreenStream();
        await replaceTrackOnAllPeers("video", getBlankVideoTrack());
        await replaceTrackOnAllPeers("screenAudio", getSilentScreenTrack());
        emitState();
      }

      updateScreenUI();
      updateSelfCard();
    } finally {
      state.screenBusy = false;
      updateScreenUI();
    }
  }

  async function stopScreenShare({ silent = false } = {}) {
    if (!state.sharing && !state.screenStream) return;

    if (state.screenTrack) {
      state.screenTrack.removeEventListener("ended", onScreenShareEnded);
    }

    state.sharing = false;
    state.sharingAudio = false;
    releaseScreenStream();

    await replaceTrackOnAllPeers("video", getBlankVideoTrack());
    await replaceTrackOnAllPeers("screenAudio", getSilentScreenTrack());

    updateScreenUI();
    updateSelfCard();
    emitState();

    if (!silent) toast("Screen share stopped.", "info");
  }

  function onScreenShareEnded() {
    if (!state.sharing) return;
    toast("Screen share ended.", "info");
    void stopScreenShare({ silent: true });
  }

  function toggleScreenShare() {
    if (!state.joined) return;
    if (state.sharing) {
      void stopScreenShare();
    } else {
      void startScreenShare();
    }
  }

  async function replaceTrackOnAllPeers(kind, track) {
    const jobs = [];
    for (const peer of state.peers.values()) {
      const transceiver = peer.tx?.[kind];
      if (!transceiver) continue;
      jobs.push(
        transceiver.sender.replaceTrack(track).catch((error) => {
          console.warn(`[webrtc] replaceTrack(${kind}) failed:`, error);
        })
      );
    }
    await Promise.all(jobs);
  }

  /** Apply the active quality preset to every active peer. */
  async function tuneScreenSender(peer) {
    await applyQualityToPeer(peer);
  }

  // =========================================================================
  // 7. UI updates
  // =========================================================================
  function updateMicUI() {
    const muted = state.micMuted || !state.micTrack;

    el.micBtn.classList.toggle("is-off", muted);
    el.micBtn.setAttribute("aria-pressed", String(muted));
    el.micBtn.setAttribute("aria-label", "Mute microphone");
    el.micBtn.title = muted ? "Unmute microphone (M)" : "Mute microphone (M)";
    el.micLabel.textContent = muted ? "Unmute" : "Mute";
    setIcon(el.micBtn, muted ? "#icon-mic-off" : "#icon-mic");

    updateSelfCard();
  }

  function updateScreenUI() {
    const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const preset = getQualityPreset();
    const qualityAllowsVideo = Boolean(preset.video);

    el.screenBtn.classList.toggle("is-active", state.sharing);
    el.screenBtn.setAttribute("aria-pressed", String(state.sharing));
    el.screenBtn.setAttribute("aria-label", "Share your screen");
    el.screenBtn.title = !qualityAllowsVideo
      ? "Screen sharing is off in Voice only quality"
      : state.sharing
        ? "Stop sharing (S)"
        : "Share screen (S)";
    el.screenLabel.textContent = state.sharing ? "Stop share" : "Share";
    setIcon(el.screenBtn, state.sharing ? "#icon-screen-off" : "#icon-screen");
    el.screenBtn.disabled =
      !state.joined || !supported || state.screenBusy || !qualityAllowsVideo;
  }

  function updateRoomUI() {
    if (!state.joined) {
      el.roomTitle.textContent = "—";
      el.peerCount.textContent = "";
      return;
    }

    el.roomTitle.textContent = `#${state.room}`;
    const count = state.peers.size + 1;
    el.peerCount.textContent = count === 1 ? "Just you aboard" : `${count} pirates aboard`;
  }

  function setCallVisible(visible) {
    el.lobby.hidden = visible;
    el.call.hidden = !visible;
    document.body.classList.toggle("in-call", visible);
  }

  function ensureSelfCard() {
    if (state.selfCard) return;

    const card = el.peerTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.peerId = "self";
    card.classList.add("is-self", "is-connected");

    card.querySelector(".you-tag").hidden = false;
    card.querySelector(".peer-status").hidden = true;
    card.querySelector(".volume-group").hidden = true;
    card.querySelector(".peer-audio").hidden = true;
    card.querySelector(".placeholder-hint").textContent = "This is you";

    const name = state.name || "You";
    card.querySelector(".initial").textContent = firstChar(name);
    card.querySelector(".peer-title .name").textContent = name;
    card.querySelector(".peer-placeholder .peer-name").textContent = name;

    wireFullscreenButton(card);

    el.peerGrid.prepend(card);
    state.selfCard = card;
    updateSelfCard();
  }

  function updateSelfCard() {
    const card = state.selfCard;
    if (!card) return;

    const name = state.name || "You";
    card.querySelector(".peer-title .name").textContent = name;
    card.querySelector(".peer-placeholder .peer-name").textContent = name;
    card.querySelector(".initial").textContent = firstChar(name);

    const hasPreview = state.sharing && Boolean(state.screenStream);
    const video = card.querySelector(".peer-video");
    const liveBadge = card.querySelector(".live-badge");
    const hint = card.querySelector(".placeholder-hint");

    card.classList.toggle("has-video", hasPreview);
    liveBadge.hidden = !hasPreview;
    hint.textContent = state.sharing ? "Sharing your screen" : "This is you";

    if (hasPreview) {
      if (video.srcObject !== state.screenStream) {
        video.srcObject = state.screenStream;
      }
      video.muted = true;
      playMedia(video);
    } else if (video.srcObject) {
      video.pause?.();
      video.srcObject = null;
    }

    card.querySelector(".muted-flag").hidden = !(state.micMuted || !state.micTrack);
  }

  function wireFullscreenButton(card) {
    card.querySelector(".fullscreen-btn")?.addEventListener("click", () => {
      const stage = card.querySelector(".peer-stage");
      if (!stage) return;

      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
        return;
      }

      if (typeof stage.requestFullscreen !== "function") {
        toast("Fullscreen isn't available in this browser.", "warning");
        return;
      }

      stage.requestFullscreen().catch(() => {
        toast("Couldn't open fullscreen.", "warning");
      });
    });
  }

  // =========================================================================
  // 8. Peer cards + volume controls
  // =========================================================================
  function addPeer(info) {
    const id = typeof info?.id === "string" ? info.id : "";
    if (!id) return null;

    const existing = state.peers.get(id);
    if (existing) {
      if (info.name) existing.name = cleanName(info.name) || existing.name;
      // Partial updates (e.g. a recovery offer with no state fields) must not
      // wipe flags we already learned from peer-joined / peer-state.
      if (typeof info.muted === "boolean") existing.muted = info.muted;
      if (typeof info.sharing === "boolean") {
        existing.sharing = info.sharing;
        existing.sharingAudio = info.sharing && info.sharingAudio === true;
      }
      setPeerName(existing);
      updatePeerFlags(existing);
      updatePeerMedia(existing);
      updateRoomUI();
      return existing;
    }

    const name = cleanName(info?.name) || "A crewmate";
    const card = el.peerTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.peerId = id;
    card.style.setProperty("--avatar-hue", String(hueFor(name)));

    const els = {
      card,
      status: card.querySelector(".peer-status"),
      liveBadge: card.querySelector(".live-badge"),
      placeholderHint: card.querySelector(".placeholder-hint"),
      initial: card.querySelector(".initial"),
      titleName: card.querySelector(".peer-title .name"),
      stageName: card.querySelector(".peer-placeholder .peer-name"),
      mutedFlag: card.querySelector(".muted-flag"),
      screenRow: card.querySelector(".screen-row"),
      micSlider: card.querySelector('.vol-slider[data-kind="mic"]'),
      screenSlider: card.querySelector('.vol-slider[data-kind="screen"]'),
      micMuteBtn: card.querySelector('.vol-mute[data-kind="mic"]'),
      screenMuteBtn: card.querySelector('.vol-mute[data-kind="screen"]'),
      micValue: card.querySelector('.volume-row:not(.screen-row) .vol-val'),
      screenValue: card.querySelector(".screen-row .vol-val"),
    };

    const peer = {
      id,
      name,
      muted: info?.muted === true,
      sharing: info?.sharing === true,
      sharingAudio: info?.sharing === true && info?.sharingAudio === true,
      pc: null,
      tx: null,
      pendingCandidates: [],
      remoteMicStream: null,
      remoteVideoTrack: null,
      remoteScreenAudioTrack: null,
      remoteVideoStream: null,
      micAudioEl: card.querySelector(".peer-audio"),
      videoEl: card.querySelector(".peer-video"),
      els,
      prefs: loadVolumePrefs(name),
      meter: null,
      recoveryTimer: null,
      connectedOnce: false,
    };

    setPeerName(peer);
    updatePeerFlags(peer);
    wireVolumeControls(peer);
    wireFullscreenButton(card);
    updateVolumeUI(peer);
    updatePeerMedia(peer);
    updatePeerConnectionState(peer);

    state.peers.set(id, peer);
    el.peerGrid.append(card);
    updateRoomUI();

    return peer;
  }

  function setPeerName(peer) {
    peer.els.initial.textContent = firstChar(peer.name);
    peer.els.titleName.textContent = peer.name;
    peer.els.stageName.textContent = peer.name;
    peer.els.card.style.setProperty("--avatar-hue", String(hueFor(peer.name)));

    peer.els.micSlider.setAttribute("aria-label", `Voice volume for ${peer.name}`);
    peer.els.screenSlider.setAttribute("aria-label", `Screen share volume for ${peer.name}`);
    peer.els.micMuteBtn.setAttribute("aria-label", `Mute ${peer.name}'s microphone`);
    peer.els.screenMuteBtn.setAttribute("aria-label", `Mute ${peer.name}'s screen audio`);
  }

  function wireVolumeControls(peer) {
    peer.els.micSlider.addEventListener("input", () => {
      peer.prefs.mic = clampNumber(peer.els.micSlider.value, 0, 100, 100);
      if (peer.prefs.mic > 0) peer.prefs.micMuted = false;
      updateVolumeUI(peer);
      saveVolumePrefs(peer);
    });

    peer.els.screenSlider.addEventListener("input", () => {
      peer.prefs.screen = clampNumber(peer.els.screenSlider.value, 0, 100, 100);
      if (peer.prefs.screen > 0) peer.prefs.screenMuted = false;
      updateVolumeUI(peer);
      saveVolumePrefs(peer);
    });

    peer.els.micMuteBtn.addEventListener("click", () => {
      peer.prefs.micMuted = !peer.prefs.micMuted;
      updateVolumeUI(peer);
      saveVolumePrefs(peer);
    });

    peer.els.screenMuteBtn.addEventListener("click", () => {
      peer.prefs.screenMuted = !peer.prefs.screenMuted;
      updateVolumeUI(peer);
      saveVolumePrefs(peer);
    });
  }

  function updateVolumeUI(peer) {
    const { prefs, els } = peer;

    peer.micAudioEl.volume = prefs.micMuted ? 0 : prefs.mic / 100;
    peer.videoEl.volume = prefs.screenMuted ? 0 : prefs.screen / 100;

    // Friend microphone row
    els.micSlider.value = String(prefs.mic);
    setSliderFill(els.micSlider, prefs.mic);
    els.micSlider.setAttribute(
      "aria-valuetext",
      prefs.micMuted ? `Muted (${prefs.mic}%)` : `${prefs.mic}%`
    );
    els.micValue.textContent = prefs.micMuted ? "Muted" : `${prefs.mic}%`;
    els.micMuteBtn.classList.toggle("is-muted", prefs.micMuted);
    els.micMuteBtn.setAttribute("aria-pressed", String(prefs.micMuted));
    els.micMuteBtn.title = prefs.micMuted ? "Unmute friend" : "Mute friend";
    setIcon(els.micMuteBtn, prefs.micMuted ? "#icon-volume-x" : "#icon-volume");

    // Screen share audio row
    els.screenSlider.value = String(prefs.screen);
    setSliderFill(els.screenSlider, prefs.screen);
    els.screenRow.hidden = !peer.sharing;
    els.screenRow.classList.toggle("is-disabled", !peer.sharingAudio);
    els.screenSlider.disabled = !peer.sharingAudio;
    els.screenMuteBtn.disabled = !peer.sharingAudio;

    let screenLabel = `${prefs.screen}%`;
    if (peer.sharing && !peer.sharingAudio) screenLabel = "No audio";
    else if (prefs.screenMuted) screenLabel = "Muted";
    els.screenValue.textContent = screenLabel;
    els.screenSlider.setAttribute(
      "aria-valuetext",
      !peer.sharing
        ? `${prefs.screen}%`
        : !peer.sharingAudio
          ? "This share has no audio"
          : prefs.screenMuted
            ? `Muted (${prefs.screen}%)`
            : `${prefs.screen}%`
    );
    els.screenMuteBtn.classList.toggle("is-muted", prefs.screenMuted);
    els.screenMuteBtn.setAttribute("aria-pressed", String(prefs.screenMuted));
    els.screenMuteBtn.title = prefs.screenMuted ? "Unmute screen audio" : "Mute screen audio";
    setIcon(els.screenMuteBtn, prefs.screenMuted ? "#icon-volume-x" : "#icon-volume");
  }

  function updatePeerFlags(peer) {
    peer.els.mutedFlag.hidden = !peer.muted;
    peer.els.card.classList.toggle("is-remote-muted", peer.muted);
  }

  function updatePeerConnectionState(peer) {
    if (!peer) return;

    const card = peer.els.card;
    const status = peer.els.status;
    const pc = peer.pc;

    if (!pc) {
      card.classList.remove("is-connected", "is-failed");
      status.hidden = false;
      status.textContent = "Waiting for signal…";
      return;
    }

    const connectionState = pc.connectionState;

    if (connectionState === "connected") {
      card.classList.add("is-connected");
      card.classList.remove("is-failed");
      status.hidden = true;

      if (!peer.connectedOnce) {
        peer.connectedOnce = true;
        peer.els.placeholderHint.textContent = "Voice ready";
        tuneScreenSender(peer);
      }
      return;
    }

    card.classList.remove("is-connected");
    card.classList.toggle("is-failed", connectionState === "failed");
    status.hidden = false;

    if (connectionState === "failed") {
      status.textContent = "Link lost";
      schedulePeerRecovery(peer);
    } else if (connectionState === "disconnected") {
      status.textContent = "Reconnecting…";
    } else {
      status.textContent = "Linking…";
    }
  }

  function schedulePeerRecovery(peer) {
    if (peer.recoveryTimer || !state.joined) return;

    // Deterministic tie-break: smaller socket id re-offers first.
    const delay = (socket.id || "") < peer.id ? 1_200 : 5_000;

    peer.recoveryTimer = window.setTimeout(() => {
      peer.recoveryTimer = null;
      if (!state.joined || !state.peers.has(peer.id)) return;

      const pc = peer.pc;
      if (!pc) return;
      if (pc.connectionState !== "failed" && pc.iceConnectionState !== "failed") return;

      void initiateOffer(peer.id);
    }, delay);
  }

  function updatePeerMedia(peer) {
    const { els } = peer;
    const canShowVideo = peer.sharing && Boolean(peer.remoteVideoTrack);

    els.card.classList.toggle("has-video", canShowVideo);
    els.liveBadge.hidden = !peer.sharing;

    if (canShowVideo) {
      const current = peer.remoteVideoStream;
      const currentVideo = current?.getVideoTracks()[0];
      const currentAudio = current?.getAudioTracks()[0];
      const nextAudio = peer.remoteScreenAudioTrack || undefined;

      if (!current || currentVideo !== peer.remoteVideoTrack || currentAudio !== nextAudio) {
        const stream = new MediaStream([peer.remoteVideoTrack]);
        if (nextAudio) stream.addTrack(nextAudio);
        peer.remoteVideoStream = stream;
        peer.videoEl.srcObject = stream;
        playMedia(peer.videoEl);
      }

      peer.videoEl.volume = peer.prefs.screenMuted ? 0 : peer.prefs.screen / 100;
    } else if (peer.videoEl.srcObject) {
      peer.videoEl.pause?.();
      peer.videoEl.srcObject = null;
      peer.remoteVideoStream = null;
    }

    if (!canShowVideo && peer.sharing) {
      els.placeholderHint.textContent = "Screen incoming…";
    } else if (peer.connectedOnce) {
      els.placeholderHint.textContent = "Voice ready";
    }

    updateVolumeUI(peer);
  }

  // =========================================================================
  // 9. WebRTC: peer connections + signaling
  // =========================================================================
  function createPeerConnection(peer, initiator) {
    const pc = new RTCPeerConnection({
      iceServers: state.iceServers,
      bundlePolicy: "max-bundle",
      iceCandidatePoolSize: 2,
    });

    peer.pc = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socket.connected) return;
      const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      socket.emit("ice", { to: peer.id, candidate });
    };

    pc.ontrack = (event) => handleRemoteTrack(peer, event);

    pc.onconnectionstatechange = () => updatePeerConnectionState(peer);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        schedulePeerRecovery(peer);
      }
    };

    if (initiator) {
      const micTx = addMediaTransceiver(
        pc,
        "audio",
        state.micTrack || getSilentMicTrack()
      );
      const videoTx = addMediaTransceiver(
        pc,
        "video",
        state.screenTrack || getBlankVideoTrack()
      );
      const screenAudioTx = addMediaTransceiver(
        pc,
        "audio",
        state.screenAudioTrack || getSilentScreenTrack()
      );

      micTx.__luffyPurpose = "mic";
      videoTx.__luffyPurpose = "video";
      screenAudioTx.__luffyPurpose = "screenAudio";

      peer.tx = { mic: micTx, video: videoTx, screenAudio: screenAudioTx };

      if (state.micTrack) state.micTrack.contentHint = "speech";
      if (state.screenTrack) state.screenTrack.contentHint = "detail";
    }

    updatePeerConnectionState(peer);
    return pc;
  }

  function transceiverPurpose(pc, transceiver) {
    if (transceiver.__luffyPurpose) return transceiver.__luffyPurpose;

    const index = pc.getTransceivers().indexOf(transceiver);
    if (index >= 0 && index < PURPOSES.length) return PURPOSES[index];

    const mid = Number(transceiver.mid);
    if (Number.isInteger(mid) && mid >= 0 && mid < PURPOSES.length) {
      return PURPOSES[mid];
    }

    return transceiver.receiver?.track?.kind === "video" ? "video" : "mic";
  }

  function handleRemoteTrack(peer, event) {
    const purpose = transceiverPurpose(peer.pc, event.transceiver);
    const track = event.track;

    track.addEventListener?.("unmute", () => {
      if (purpose === "video") updatePeerMedia(peer);
    });

    if (purpose === "video") {
      peer.remoteVideoTrack = track;
      updatePeerMedia(peer);
      return;
    }

    if (purpose === "screenAudio") {
      peer.remoteScreenAudioTrack = track;
      updatePeerMedia(peer);
      return;
    }

    // Microphone audio
    peer.remoteMicStream = new MediaStream([track]);
    peer.micAudioEl.srcObject = peer.remoteMicStream;
    peer.micAudioEl.volume = peer.prefs.micMuted ? 0 : peer.prefs.mic / 100;
    playMedia(peer.micAudioEl);

    if (peer.meter) destroyMeter(peer.meter);
    peer.meter = createMeter(peer.remoteMicStream);
  }

  async function setupAnswerTransceivers(peer) {
    const txs = peer.pc.getTransceivers();

    txs.forEach((transceiver, index) => {
      if (index < PURPOSES.length) transceiver.__luffyPurpose = PURPOSES[index];
      try {
        transceiver.direction = "sendrecv";
      } catch {
        /* ignore unsupported direction changes */
      }
    });

    peer.tx = {
      mic: txs[0] || null,
      video: txs[1] || null,
      screenAudio: txs[2] || null,
    };

    // Attach our local tracks before creating the answer so the m-lines carry
    // msid/SSRC information from the beginning.
    const jobs = [];
    if (peer.tx.mic) {
      jobs.push(peer.tx.mic.sender.replaceTrack(state.micTrack || getSilentMicTrack()));
    }
    if (peer.tx.video) {
      jobs.push(peer.tx.video.sender.replaceTrack(state.screenTrack || getBlankVideoTrack()));
    }
    if (peer.tx.screenAudio) {
      jobs.push(
        peer.tx.screenAudio.sender.replaceTrack(
          state.screenAudioTrack || getSilentScreenTrack()
        )
      );
    }
    await Promise.allSettled(jobs);
  }

  function closePeerConnection(peer) {
    if (!peer) return;

    if (peer.recoveryTimer) {
      window.clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }

    if (peer.pc) {
      const pc = peer.pc;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      peer.pc = null;
    }

    peer.tx = null;
    peer.pendingCandidates = [];
    peer.connectedOnce = false;
    peer.remoteMicStream = null;
    peer.remoteVideoTrack = null;
    peer.remoteScreenAudioTrack = null;
    peer.remoteVideoStream = null;

    if (peer.meter) {
      destroyMeter(peer.meter);
      peer.meter = null;
    }

    if (peer.micAudioEl) {
      peer.micAudioEl.pause?.();
      peer.micAudioEl.srcObject = null;
    }
    if (peer.videoEl) {
      peer.videoEl.pause?.();
      peer.videoEl.srcObject = null;
    }

    if (peer.els) {
      peer.els.card.classList.remove("is-connected", "is-failed", "has-video");
      peer.els.liveBadge.hidden = true;
      peer.els.status.hidden = false;
      peer.els.status.textContent = "Linking…";
    }
  }

  function closeAllPeers() {
    for (const peer of state.peers.values()) {
      closePeerConnection(peer);
      peer.els.card.remove();
    }
    state.peers.clear();
    el.peerGrid.replaceChildren();
    state.selfCard = null;

    if (state.localMeter) {
      destroyMeter(state.localMeter);
      state.localMeter = null;
    }

    updateRoomUI();
  }

  async function flushCandidates(peer) {
    const pc = peer.pc;
    if (!pc) return;

    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      if (peer.pc !== pc) return;
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* a candidate may arrive after its m-line was removed */
      }
    }
  }

  async function initiateOffer(peerId) {
    if (!state.joined || !socket.connected) return;

    const peer = state.peers.get(peerId);
    if (!peer) return;

    closePeerConnection(peer);
    const pc = createPeerConnection(peer, true);

    try {
      const offer = await pc.createOffer();
      if (peer.pc !== pc) return;
      await pc.setLocalDescription(tuneDescription(offer, getQualityPreset()));
      if (peer.pc !== pc || !socket.connected) return;

      await applyQualityToPeer(peer);

      socket.emit("offer", {
        to: peerId,
        sdp: {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
        },
      });
    } catch (error) {
      console.error("[webrtc] failed to create offer:", error);
      if (peer.pc === pc) {
        peer.els.card.classList.add("is-failed");
        peer.els.status.hidden = false;
        peer.els.status.textContent = "Link failed";
      }
      if (socket.connected) toast(`Couldn't link with ${peer.name}.`, "error");
    }
  }

  async function handleOffer(payload) {
    if (!state.joined || !payload?.from || !payload?.sdp) return;

    const peer = addPeer({
      id: payload.from,
      name: payload.fromName || "A crewmate",
      muted: payload.muted,
      sharing: payload.sharing,
      sharingAudio: payload.sharingAudio,
    });
    if (!peer) return;

    closePeerConnection(peer);
    const pc = createPeerConnection(peer, false);

    try {
      await pc.setRemoteDescription(payload.sdp);
      if (peer.pc !== pc) return;

      await setupAnswerTransceivers(peer);
      await flushCandidates(peer);
      if (peer.pc !== pc) return;

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(tuneDescription(answer, getQualityPreset()));
      if (peer.pc !== pc || !socket.connected) return;

      socket.emit("answer", {
        to: peer.id,
        sdp: {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
        },
      });

      tuneScreenSender(peer);
    } catch (error) {
      console.error("[webrtc] failed to answer offer:", error);
      if (peer.pc === pc) {
        closePeerConnection(peer);
        peer.els.card.classList.add("is-failed");
        peer.els.status.hidden = false;
        peer.els.status.textContent = "Link failed";
      }
    }
  }

  async function handleAnswer(payload) {
    if (!state.joined || !payload?.from || !payload?.sdp) return;

    const peer = state.peers.get(payload.from);
    if (!peer?.pc) return;

    const pc = peer.pc;
    try {
      await pc.setRemoteDescription(payload.sdp);
      if (peer.pc !== pc) return;
      await flushCandidates(peer);
      tuneScreenSender(peer);
    } catch (error) {
      console.warn("[webrtc] failed to apply answer:", error);
    }
  }

  async function handleIce(payload) {
    if (!state.joined || !payload?.from || !payload?.candidate) return;

    const peer = state.peers.get(payload.from);
    if (!peer?.pc) return;

    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(payload.candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(payload.candidate);
    } catch {
      /* candidates can race with a freshly recreated connection */
    }
  }

  // =========================================================================
  // 10. Room lifecycle
  // =========================================================================
  function emitState() {
    if (!state.joined || !socket.connected) return;
    socket.emit("state", {
      muted: state.micMuted || !state.micTrack,
      sharing: state.sharing,
      sharingAudio: state.sharingAudio,
    });

    // Mute/share changes also change which encodings should be active, so
    // re-apply the current quality preset to every peer right away.
    for (const peer of state.peers.values()) {
      void applyQualityToPeer(peer);
    }
  }

  function waitForSocket(timeoutMs = 12_000) {
    if (socket.connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        socket.off("connect", onConnect);
        reject(new Error("Cannot reach the signaling server. Try again in a moment."));
      }, timeoutMs);

      function onConnect() {
        window.clearTimeout(timer);
        resolve();
      }

      socket.once("connect", onConnect);
      socket.connect();
    });
  }

  function emitWithAck(eventName, payload, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) {
        reject(new Error("Not connected to the server."));
        return;
      }

      const timer = window.setTimeout(() => {
        reject(new Error("The server took too long to respond."));
      }, timeoutMs);

      socket.emit(eventName, payload, (result) => {
        window.clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async function enterRoom(rawRoom, rawName, { reconnect = false, quiet = false } = {}) {
    if (state.joinInFlight) return null;

    state.joinInFlight = true;

    try {
      await waitForSocket();
      // Make sure STUN/TURN configuration is ready before the first offer.
      await iceConfigReady;

      const result = await emitWithAck("join", {
        room: rawRoom,
        name: rawName,
        muted: state.micMuted || !state.micTrack,
        sharing: state.sharing,
        sharingAudio: state.sharingAudio,
      });

      if (!result?.ok) {
        throw new Error(result?.error || "Couldn't join this room.");
      }

      state.joined = true;
      state.room = result.room;
      state.name = result.name || cleanName(rawName) || "Pirate";
      state.rejoinAttempts = 0;

      closeAllPeers();
      ensureSelfCard();
      refreshLocalMeter();
      setCallVisible(true);
      updateRoomUI();
      updateMicUI();
      updateScreenUI();
      updateChatSendState();

      if (!reconnect) {
        el.roomInput.value = state.room;
        saveName(state.name);
        history.replaceState(null, "", buildInviteUrl(state.room));
        showLobbyError("");
      }

      for (const peerInfo of result.peers || []) {
        addPeer(peerInfo);
        void initiateOffer(peerInfo.id);
      }

      emitState();

      if (reconnect) {
        toast("Back aboard — reconnecting the crew.", "success");
      }

      return result;
    } catch (error) {
      if (reconnect && state.joined) {
        setConnection("reconnecting", "Reconnecting…");
        if (!quiet) {
          toast(`Rejoin failed: ${error.message}`, "error", 6000);
        }
      }
      throw error;
    } finally {
      state.joinInFlight = false;
    }
  }

  async function rejoinAfterReconnect() {
    if (!state.joined || !state.room || state.joinInFlight) return;

    if (state.rejoinTimer) {
      window.clearTimeout(state.rejoinTimer);
      state.rejoinTimer = null;
    }

    state.rejoinAttempts += 1;

    try {
      await enterRoom(state.room, state.name, {
        reconnect: true,
        quiet: state.rejoinAttempts > 1,
      });
      state.rejoinAttempts = 0;
    } catch {
      if (state.joined && socket.connected && state.rejoinAttempts < 4) {
        const attempt = state.rejoinAttempts;
        state.rejoinTimer = window.setTimeout(() => {
          state.rejoinTimer = null;
          if (state.joined && socket.connected) void rejoinAfterReconnect();
        }, 2_000 * attempt);
      }
    }
  }

  function leaveCall({ silent = false } = {}) {
    if (!state.joined && !state.room) {
      setCallVisible(false);
      return;
    }

    if (socket.connected) {
      socket.emit("leave");
    }

    state.joined = false;
    state.rejoinAttempts = 0;

    if (state.rejoinTimer) {
      window.clearTimeout(state.rejoinTimer);
      state.rejoinTimer = null;
    }

    const previousRoom = state.room;
    state.room = "";

    closeAllPeers();
    resetChat();

    if (state.screenTrack) {
      state.screenTrack.removeEventListener("ended", onScreenShareEnded);
    }
    state.sharing = false;
    state.sharingAudio = false;
    releaseScreenStream();

    releaseMic();

    setCallVisible(false);
    updateScreenUI();
    updateMicUI();
    updateRoomUI();
    el.audioUnlockBtn.hidden = true;

    if (previousRoom) {
      el.roomInput.value = previousRoom;
      history.replaceState(null, "", buildInviteUrl(previousRoom));
    }

    setConnection(socket.connected ? "online" : "offline", socket.connected ? "Connected" : "Offline");

    if (!silent) {
      toast("You left the call. The ship waits for your return.", "info");
    }

    requestAnimationFrame(() => el.roomInput.focus());
  }

  // =========================================================================
  // 11. Socket.IO handlers
  // =========================================================================
  function bindSocketHandlers() {
    socket.on("connect", () => {
      setConnection("online", "Connected");

      if (state.joined) {
        void rejoinAfterReconnect();
      }
    });

    socket.on("disconnect", (reason) => {
      if (state.joined) {
        setConnection("reconnecting", "Reconnecting…");
        for (const peer of state.peers.values()) {
          peer.els.card.classList.remove("is-connected");
          peer.els.status.hidden = false;
          peer.els.status.textContent = "Reconnecting…";
        }
      } else if (reason !== "io client disconnect") {
        setConnection("offline", "Offline");
      }
    });

    socket.on("connect_error", () => {
      setConnection("offline", "Can't reach server");
    });

    socket.on("peer-joined", (info) => {
      if (!state.joined || !info?.id) return;
      addPeer(info);
      toast(`${cleanName(info.name) || "A pirate"} boarded the ship.`, "success", 3000);
    });

    socket.on("peer-left", (payload) => {
      if (!state.joined || !payload?.id) return;

      const peer = state.peers.get(payload.id);
      if (!peer) return;

      const leftName = peer.name;
      closePeerConnection(peer);
      peer.els.card.remove();
      state.peers.delete(payload.id);
      updateRoomUI();
      toast(`${leftName} left the call.`, "info", 3000);
    });

    socket.on("peer-state", (payload) => {
      if (!state.joined || !payload?.id) return;

      const peer = state.peers.get(payload.id);
      if (!peer) return;

      peer.muted = payload.muted === true;
      peer.sharing = payload.sharing === true;
      peer.sharingAudio = peer.sharing && payload.sharingAudio === true;

      updatePeerFlags(peer);
      updatePeerMedia(peer);
    });

    socket.on("chat", (payload) => {
      receiveChatMessage(payload);
    });

    socket.on("offer", (payload) => {
      void handleOffer(payload);
    });

    socket.on("answer", (payload) => {
      void handleAnswer(payload);
    });

    socket.on("ice", (payload) => {
      void handleIce(payload);
    });
  }

  // =========================================================================
  // 12. Clipboard
  // =========================================================================
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to execCommand */
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }

  async function copyInviteLink() {
    if (!state.room) return;

    const url = buildInviteUrl(state.room);
    const copied = await copyText(url);

    if (copied) {
      toast("Invite link copied — send it to your crew.", "success");
    } else {
      toast(`Invite link: ${url}`, "info", 8000);
    }
  }

  async function unlockAllAudio() {
    getAudioContext();

    const attempts = [];
    for (const peer of state.peers.values()) {
      if (peer.micAudioEl) attempts.push(peer.micAudioEl.play());
      if (peer.videoEl?.srcObject) attempts.push(peer.videoEl.play());
    }

    const results = await Promise.allSettled(attempts);
    const failed = results.some((result) => result.status === "rejected");

    el.audioUnlockBtn.hidden = !failed;
    if (!failed) toast("Sound is on.", "success", 2000);
  }

  // =========================================================================
  // 13. Crew chat (text, emoji, pictures)
  // =========================================================================
  const CHAT_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  let chatLightboxReturnFocus = null;

  function chatUsesDrawer() {
    return window.matchMedia(CHAT_DRAWER_QUERY).matches;
  }

  /** True when the crew can see new messages without opening anything. */
  function isChatVisible() {
    return (!chatUsesDrawer() || state.chatOpen) && document.visibilityState === "visible";
  }

  function updateChatUnread() {
    el.chatUnread.textContent = state.chatUnread > 99 ? "99+" : String(state.chatUnread);
    el.chatUnread.hidden = state.chatUnread <= 0;
  }

  function clearChatUnread() {
    state.chatUnread = 0;
    updateChatUnread();
  }

  function setChatOpen(open) {
    const drawer = chatUsesDrawer();
    state.chatOpen = Boolean(open) && drawer;
    document.body.classList.toggle("chat-open", state.chatOpen);
    el.chatBackdrop.hidden = !state.chatOpen;
    el.chatBtn.setAttribute("aria-pressed", String(state.chatOpen));

    if (state.chatOpen) {
      clearChatUnread();
      window.setTimeout(() => {
        autoGrowChatInput();
        el.chatInput.focus();
      }, 140);
    } else if (!drawer) {
      clearChatUnread();
    }
  }

  function updateChatEmpty() {
    el.chatEmpty.hidden = state.chatMessages.size > 0;
  }

  function formatChatTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return CHAT_TIME_FORMAT.format(date);
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0 KB";
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function dataUrlBytes(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return 0;
    return Math.round(((dataUrl.length - comma - 1) * 3) / 4);
  }

  function newMessageId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function updateChatMessageNode(node, message) {
    node.classList.toggle("is-pending", message.pending === true);
    node.classList.toggle("is-failed", message.failed === true);

    const status = node.querySelector(".chat-msg-status");
    if (status) {
      status.textContent = message.failed
        ? message.failReason || "Not sent"
        : message.pending
          ? "Sending…"
          : "";
      status.hidden = !message.pending && !message.failed;
    }

    const time = node.querySelector(".chat-msg-time");
    const date = new Date(message.at);
    if (time && !Number.isNaN(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = formatChatTime(message.at);
      time.title = date.toLocaleString();
    }
  }

  function renderChatMessage(message) {
    const article = document.createElement("article");
    article.className = "chat-msg";
    article.dataset.chatId = message.id;
    article.classList.toggle("is-mine", message.mine === true);
    article.classList.toggle("has-image", Boolean(message.image));
    article.classList.toggle("is-pending", message.pending === true);
    article.classList.toggle("is-failed", message.failed === true);

    const meta = document.createElement("div");
    meta.className = "chat-msg-meta";

    const name = document.createElement("span");
    name.className = "chat-msg-name";
    name.textContent = message.mine ? "You" : message.fromName;

    const time = document.createElement("time");
    time.className = "chat-msg-time";
    const date = new Date(message.at);
    if (!Number.isNaN(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = formatChatTime(message.at);
      time.title = date.toLocaleString();
    }

    meta.append(name, time);
    article.append(meta);

    const body = document.createElement("div");
    body.className = "chat-msg-body";

    if (message.image) {
      const imageButton = document.createElement("button");
      imageButton.type = "button";
      imageButton.className = "chat-msg-image";
      imageButton.setAttribute(
        "aria-label",
        `Open picture shared by ${message.mine ? "you" : message.fromName}`
      );

      const image = document.createElement("img");
      image.src = message.image;
      image.alt = `Picture shared by ${message.mine ? "you" : message.fromName}`;
      image.loading = "lazy";
      image.decoding = "async";

      imageButton.append(image);
      imageButton.addEventListener("click", () => {
        openChatLightbox(message.image, image.alt);
      });
      body.append(imageButton);
    }

    if (message.text) {
      const text = document.createElement("p");
      text.className = "chat-msg-text";
      text.textContent = message.text;
      body.append(text);
    }

    article.append(body);

    if (message.mine) {
      const status = document.createElement("span");
      status.className = "chat-msg-status";
      article.append(status);
      updateChatMessageNode(article, message);
    }

    return article;
  }

  /**
   * Add a message or update the optimistic copy with the server echo.
   * Returns the stored record so callers can keep any local metadata.
   */
  function addChatMessage(message, { announce = false } = {}) {
    const existing = state.chatMessages.get(message.id);
    if (existing) {
      if (existing.pendingTimer) {
        window.clearTimeout(existing.pendingTimer);
        existing.pendingTimer = null;
      }
      existing.pending = message.pending === true;
      existing.failed = message.failed === true;
      existing.failReason = message.failReason || "";
      if (Number.isFinite(message.at)) existing.at = message.at;

      const node = el.chatLog.querySelector(`[data-chat-id="${message.id}"]`);
      if (node) updateChatMessageNode(node, existing);
      return existing;
    }

    const nearBottom =
      el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 80;

    const record = {
      ...message,
      pending: message.pending === true,
      failed: message.failed === true,
    };

    state.chatMessages.set(record.id, record);
    el.chatLog.append(renderChatMessage(record));

    // Keep the DOM and the map from growing without bound during long calls.
    const nodes = el.chatLog.querySelectorAll(".chat-msg");
    for (let index = 0; index < nodes.length - CHAT_MAX_MESSAGES; index += 1) {
      const node = nodes[index];
      state.chatMessages.delete(node.dataset.chatId);
      node.remove();
    }

    updateChatEmpty();

    if (nearBottom) {
      window.requestAnimationFrame(() => {
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
      });
    }

    if (announce && !record.mine && !isChatVisible()) {
      state.chatUnread += 1;
      updateChatUnread();
    }

    return record;
  }

  function markChatMessage(id, patch) {
    const message = state.chatMessages.get(id);
    if (!message) return;
    Object.assign(message, patch);
    const node = el.chatLog.querySelector(`[data-chat-id="${id}"]`);
    if (node) updateChatMessageNode(node, message);
  }

  function receiveChatMessage(payload) {
    if (!state.joined || !payload || typeof payload !== "object") return;

    const id = typeof payload.id === "string" ? payload.id : "";
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return;

    const text =
      typeof payload.text === "string" ? payload.text.slice(0, CHAT_MAX_LENGTH) : "";
    const image =
      typeof payload.image === "string" && payload.image.startsWith("data:image/")
        ? payload.image
        : "";

    if (!text && !image) return;

    const existing = state.chatMessages.get(id);
    addChatMessage(
      {
        id,
        from: typeof payload.from === "string" ? payload.from : "",
        fromName: cleanName(payload.fromName) || "Crewmate",
        at: Number(payload.at) || Date.now(),
        text,
        image,
        mine: existing ? existing.mine : payload.from === socket.id,
        pending: false,
        failed: false,
      },
      { announce: true }
    );
  }

  function updateChatSendState() {
    const hasText = el.chatInput.value.trim().length > 0;
    const hasImage = Boolean(state.chatAttachment);
    el.chatSendBtn.disabled =
      !state.joined || state.chatImageBusy || (!hasText && !hasImage);
  }

  function autoGrowChatInput() {
    el.chatInput.style.height = "auto";
    el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 112)}px`;
  }

  function buildEmojiPanel() {
    const fragment = document.createDocumentFragment();
    for (const emoji of CHAT_EMOJIS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-btn";
      button.textContent = emoji;
      button.setAttribute("aria-label", `Insert ${emoji}`);
      button.addEventListener("click", () => insertEmoji(emoji));
      fragment.append(button);
    }
    el.emojiPanel.replaceChildren(fragment);
  }

  function toggleEmojiPanel(force) {
    const open = typeof force === "boolean" ? force : el.emojiPanel.hidden;
    el.emojiPanel.hidden = !open;
    el.emojiBtn.setAttribute("aria-expanded", String(open));
    el.emojiBtn.classList.toggle("is-active", open);
    if (open) el.emojiPanel.scrollTop = 0;
  }

  function insertEmoji(emoji) {
    const input = el.chatInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(emoji, start, end, "end");
    input.focus();
    autoGrowChatInput();
    updateChatSendState();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(typeof reader.result === "string" ? reader.result : "");
      };
      reader.onerror = () => reject(new Error("Couldn't read that picture."));
      reader.readAsDataURL(file);
    });
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That picture couldn't be opened."));
      };
      image.src = url;
    });
  }

  /**
   * Downscale + re-encode big photos so they stay under the server's 3 MB
   * limit. Small GIFs pass through untouched to preserve their animation.
   */
  async function prepareChatImage(file) {
    if (!file || !file.type.startsWith("image/")) {
      throw new Error("Choose a picture file.");
    }
    if (file.size > CHAT_IMAGE_INPUT_MAX) {
      throw new Error("That picture is too large. Pick one under 15 MB.");
    }

    if (file.type === "image/gif") {
      const dataUrl = await readFileAsDataUrl(file);
      if (dataUrl.length > CHAT_IMAGE_DATA_URL_MAX) {
        throw new Error("That GIF is too large after encoding. Try a smaller one.");
      }
      return {
        dataUrl,
        name: file.name || "picture.gif",
        bytes: dataUrlBytes(dataUrl),
      };
    }

    const image = await loadImageFile(file);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("That picture couldn't be opened.");

    const imagePreset = getQualityPreset();
    const maxDimension = imagePreset.imageDimension || CHAT_IMAGE_DIMENSION;
    let scale = Math.min(1, maxDimension / Math.max(width, height));
    let quality = imagePreset.imageQuality || 0.85;
    let dataUrl = "";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser couldn't prepare that picture.");

      // JPEG has no alpha channel; a soft white backdrop keeps screenshots
      // looking clean instead of turning transparent areas black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/jpeg", quality);

      if (dataUrl.length <= CHAT_IMAGE_DATA_URL_MAX) break;
      if (quality > 0.72) {
        quality = Math.max(0.68, quality - 0.12);
      } else {
        scale *= 0.72;
      }
    }

    if (!dataUrl || dataUrl.length > CHAT_IMAGE_DATA_URL_MAX) {
      throw new Error("That picture is still too large after resizing. Try a smaller one.");
    }

    const stem = (file.name || "picture").replace(/\.[^.]+$/, "");
    return {
      dataUrl,
      name: `${stem || "picture"}.jpg`,
      bytes: dataUrlBytes(dataUrl),
    };
  }

  function setChatAttachment(attachment) {
    state.chatAttachment = attachment || null;
    const hasAttachment = Boolean(attachment);

    el.chatAttachment.hidden = !hasAttachment;
    if (hasAttachment) {
      el.chatAttachmentImage.src = attachment.dataUrl;
      el.chatAttachmentName.textContent = attachment.name;
      el.chatAttachmentSize.textContent = `${formatBytes(attachment.bytes)} · ready to send`;
    } else {
      el.chatAttachmentImage.removeAttribute("src");
      el.chatAttachmentName.textContent = "picture.jpg";
      el.chatAttachmentSize.textContent = "0 KB";
    }

    updateChatSendState();
  }

  function clearChatAttachment() {
    setChatAttachment(null);
  }

  async function attachChatImage(file) {
    if (!file || state.chatImageBusy) return;

    state.chatImageBusy = true;
    el.imageBtn.classList.add("is-busy");
    el.imageBtn.disabled = true;
    updateChatSendState();

    try {
      const prepared = await prepareChatImage(file);
      if (!state.joined) return;
      setChatAttachment(prepared);
      el.chatInput.focus();
    } catch (error) {
      toast(error?.message || "Couldn't add that picture.", "error", 5000);
    } finally {
      state.chatImageBusy = false;
      el.imageBtn.classList.remove("is-busy");
      el.imageBtn.disabled = false;
      updateChatSendState();
    }
  }

  function sendChat() {
    if (!state.joined || state.chatImageBusy) return;

    const text = el.chatInput.value.replace(/\r\n?/g, "\n").trim().slice(0, CHAT_MAX_LENGTH);
    const attachment = state.chatAttachment;
    if (!text && !attachment) return;

    if (!socket.connected) {
      toast("You're offline — try again once the connection is back.", "warning", 5000);
      return;
    }

    const id = newMessageId();
    const message = {
      id,
      from: socket.id,
      fromName: state.name || "You",
      at: Date.now(),
      text,
      image: attachment ? attachment.dataUrl : "",
      mine: true,
      pending: true,
    };

    message.pendingTimer = window.setTimeout(() => {
      const current = state.chatMessages.get(id);
      if (!current || !current.pending) return;
      current.pendingTimer = null;
      markChatMessage(id, {
        pending: false,
        failed: true,
        failReason: "Timed out — check your connection",
      });
    }, 20_000);

    addChatMessage(message);

    el.chatInput.value = "";
    clearChatAttachment();
    autoGrowChatInput();
    updateChatSendState();
    toggleEmojiPanel(false);

    socket.emit("chat", { id, text, image: message.image }, (result) => {
      const current = state.chatMessages.get(id);
      if (!current) return;
      if (current.pendingTimer) {
        window.clearTimeout(current.pendingTimer);
        current.pendingTimer = null;
      }

      if (result?.ok) {
        markChatMessage(id, {
          pending: false,
          failed: false,
          at: Number(result.at) || current.at,
        });
      } else {
        markChatMessage(id, {
          pending: false,
          failed: true,
          failReason: result?.error || "Not delivered",
        });
        toast(result?.error || "Your message wasn't delivered.", "error", 5000);
      }
    });
  }

  function openChatLightbox(src, alt) {
    if (!src) return;
    chatLightboxReturnFocus = document.activeElement;
    el.chatLightboxImage.src = src;
    el.chatLightboxImage.alt = alt || "Shared picture";
    el.chatLightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    el.chatLightboxClose.focus();
  }

  function closeChatLightbox() {
    if (el.chatLightbox.hidden) return;
    el.chatLightbox.hidden = true;
    el.chatLightboxImage.removeAttribute("src");
    el.chatLightboxImage.alt = "Shared picture";
    document.body.classList.remove("lightbox-open");
    if (chatLightboxReturnFocus && typeof chatLightboxReturnFocus.focus === "function") {
      chatLightboxReturnFocus.focus();
    }
    chatLightboxReturnFocus = null;
  }

  function resetChat() {
    state.chatMessages.clear();
    el.chatLog.querySelectorAll(".chat-msg").forEach((node) => node.remove());
    updateChatEmpty();
    clearChatAttachment();
    el.chatInput.value = "";
    autoGrowChatInput();
    updateChatSendState();
    toggleEmojiPanel(false);
    closeChatLightbox();
    clearChatUnread();
    setChatOpen(false);
  }

  // =========================================================================
  // 14. Join flow
  // =========================================================================
  async function handleJoin(event) {
    event.preventDefault();

    if (state.joined || state.joinInFlight) return;

    if (!rtcSupported) {
      showLobbyError("Your browser doesn't support WebRTC. Try the latest Chrome, Edge, Firefox, or Safari.");
      return;
    }

    const name = cleanName(el.nameInput.value);
    const room = normalizeRoom(el.roomInput.value);

    if (!name) {
      showLobbyError("Give your crew a name to call you by.");
      el.nameInput.focus();
      return;
    }

    if (!room || room.length < 2) {
      showLobbyError("Choose a room name with at least 2 letters or numbers.");
      el.roomInput.focus();
      return;
    }

    showLobbyError("");
    el.nameInput.value = name;
    el.roomInput.value = room;
    state.name = name;

    setJoinBusy(true, "Requesting mic…");
    const micOk = await ensureMic({ silent: true });

    setJoinBusy(true, "Hoisting the sails…");

    try {
      await enterRoom(room, name);

      if (!micOk) {
        const message = window.isSecureContext
          ? "You're in listen-only mode. Tap the mic button to try again."
          : "Microphone access needs HTTPS or localhost. You're in listen-only mode.";
        toast(message, "warning", 7000);
      }
    } catch (error) {
      // If the ack timed out after the server had already put us in a room,
      // leave it before returning to the lobby.
      if (socket.connected) socket.emit("leave");
      releaseMic();
      showLobbyError(error?.message || "Couldn't join the call.");
      setConnection(
        socket.connected ? "online" : "offline",
        socket.connected ? "Connected" : "Offline"
      );
    } finally {
      setJoinBusy(false);
    }
  }

  // =========================================================================
  // 14. Boot
  // =========================================================================
  const socket = io({
    autoConnect: false,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 5_000,
    timeout: 15_000,
  });

  async function loadIceConfig() {
    try {
      const response = await fetch("/config.json", { cache: "no-store" });
      if (!response.ok) return DEFAULT_ICE;
      const data = await response.json();
      if (typeof data.defaultQuality === "string" && QUALITY_PRESETS[data.defaultQuality]) {
        state.serverDefaultQuality = data.defaultQuality;
      }
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers;
      }
    } catch {
      /* use the built-in STUN defaults */
    }
    return DEFAULT_ICE;
  }

  function bindUiHandlers() {
    el.joinForm.addEventListener("submit", (event) => {
      void handleJoin(event);
    });

    el.diceBtn.addEventListener("click", () => {
      el.roomInput.value = randomRoom();
      el.roomInput.focus();
      el.roomInput.select();
    });

    for (const select of [el.qualitySelect, el.qualitySelectCall]) {
      select?.addEventListener("change", () => {
        setQuality(select.value, { silent: !state.joined });
      });
    }

    el.micBtn.addEventListener("click", () => {
      void toggleMic();
    });

    el.screenBtn.addEventListener("click", toggleScreenShare);
    el.leaveBtn.addEventListener("click", () => leaveCall());
    el.copyInviteBtn.addEventListener("click", () => {
      void copyInviteLink();
    });
    el.audioUnlockBtn.addEventListener("click", () => {
      void unlockAllAudio();
    });

    // Crew chat -------------------------------------------------------------
    el.chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendChat();
    });

    el.chatInput.addEventListener("input", () => {
      autoGrowChatInput();
      updateChatSendState();
    });

    el.chatInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      sendChat();
    });

    // Paste a screenshot straight from the clipboard.
    el.chatInput.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      const image = files.find((file) => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      void attachChatImage(image);
    });

    el.emojiBtn.addEventListener("click", () => toggleEmojiPanel());
    el.imageBtn.addEventListener("click", () => {
      toggleEmojiPanel(false);
      el.imageInput.click();
    });

    el.imageInput.addEventListener("change", () => {
      const file = el.imageInput.files?.[0] || null;
      el.imageInput.value = "";
      if (file) void attachChatImage(file);
    });

    el.chatAttachmentRemove.addEventListener("click", () => {
      clearChatAttachment();
      el.chatInput.focus();
    });

    el.chatBtn.addEventListener("click", () => setChatOpen(!state.chatOpen));
    el.chatCloseBtn.addEventListener("click", () => setChatOpen(false));
    el.chatBackdrop.addEventListener("click", () => setChatOpen(false));
    el.chatLightboxClose.addEventListener("click", closeChatLightbox);
    el.chatLightbox.addEventListener("click", (event) => {
      if (event.target === el.chatLightbox) closeChatLightbox();
    });

    document.addEventListener("pointerdown", (event) => {
      if (el.emojiPanel.hidden) return;
      if (el.emojiPanel.contains(event.target) || el.emojiBtn.contains(event.target)) return;
      toggleEmojiPanel(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!el.chatLightbox.hidden) {
        closeChatLightbox();
      } else if (!el.emojiPanel.hidden) {
        toggleEmojiPanel(false);
        el.chatInput.focus();
      } else if (state.chatOpen) {
        setChatOpen(false);
      }
    });

    // Drag a picture anywhere onto the chat panel.
    const setChatDragging = (active) => {
      el.chatPanel.classList.toggle("is-dragging", active);
    };
    for (const eventName of ["dragenter", "dragover"]) {
      el.chatPanel.addEventListener(eventName, (event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setChatDragging(true);
      });
    }
    el.chatPanel.addEventListener("dragleave", (event) => {
      if (!el.chatPanel.contains(event.relatedTarget)) setChatDragging(false);
    });
    el.chatPanel.addEventListener("drop", (event) => {
      event.preventDefault();
      setChatDragging(false);
      const files = Array.from(event.dataTransfer?.files || []);
      const image = files.find((file) => file.type.startsWith("image/"));
      if (image) void attachChatImage(image);
    });

    const chatDrawerMedia = window.matchMedia(CHAT_DRAWER_QUERY);
    const handleChatDrawerChange = () => {
      if (!chatDrawerMedia.matches) {
        setChatOpen(false);
        clearChatUnread();
      }
    };
    if (typeof chatDrawerMedia.addEventListener === "function") {
      chatDrawerMedia.addEventListener("change", handleChatDrawerChange);
    } else if (typeof chatDrawerMedia.addListener === "function") {
      chatDrawerMedia.addListener(handleChatDrawerChange);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && isChatVisible()) {
        clearChatUnread();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (!state.joined || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const target = event.target;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }

      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        void toggleMic();
      } else if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        toggleScreenShare();
      }
    });

    document.addEventListener(
      "pointerdown",
      () => {
        getAudioContext();
      },
      { once: true }
    );

    window.addEventListener("pagehide", () => {
      if (socket.connected) socket.emit("leave");
      if (state.screenTrack) {
        try {
          state.screenTrack.stop();
        } catch {
          /* already stopped */
        }
      }
    });
  }

  function bootUi() {
    const savedName = readSavedName();
    const urlRoom = normalizeRoom(new URLSearchParams(window.location.search).get("room") || "");

    el.nameInput.value = savedName;
    el.roomInput.value = urlRoom || randomRoom();

    if (!savedName) {
      el.nameInput.focus();
    } else {
      el.roomInput.focus();
      el.roomInput.select();
    }

    if (!rtcSupported) {
      showLobbyError("This browser doesn't support WebRTC. Please use a recent Chrome, Edge, Firefox, or Safari.");
      el.joinBtn.disabled = true;
    }

    if (!window.isSecureContext) {
      // Not fatal: listen-only still works when the browser blocks getUserMedia.
      el.roomInput.title = "Tip: microphone and screen capture require HTTPS or localhost.";
    }

    setConnection("connecting", "Connecting…");
    buildEmojiPanel();
    populateQualitySelects();
    state.quality = readSavedQuality() || DEFAULT_QUALITY;
    updateChatEmpty();
    updateChatUnread();
    updateChatSendState();
    updateMicUI();
    updateQualityUi();
    updateRoomUI();
  }

  bindSocketHandlers();
  bindUiHandlers();
  bootUi();

  // Kick off ICE config + connection after handlers are attached.
  const iceConfigReady = loadIceConfig().then((servers) => {
    state.iceServers = servers;
    if (!readSavedQuality() && state.serverDefaultQuality) {
      setQuality(state.serverDefaultQuality, { silent: true, apply: false, persist: false });
    }
  });

  window.setInterval(tickMeters, LEVEL_INTERVAL_MS);

  socket.connect();
})();
