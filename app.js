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

    // ICE + misc
    iceServers: DEFAULT_ICE,
    audioContext: null,
    silentMicTrack: null,
    silentScreenTrack: null,
    blankVideoTrack: null,
    keepAlive: [],
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

    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast("Screen sharing isn't supported in this browser.", "error");
      return;
    }

    state.screenBusy = true;
    updateScreenUI();

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // Ask for crisp 1080p at up to 60 fps. Browsers may grant less.
        video: {
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
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

      videoTrack.contentHint = "detail";

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

  /** Ask the browser encoder for a generous screen-share bitrate. */
  async function tuneScreenSender(peer) {
    const sender = peer?.tx?.video?.sender;
    if (!sender) return;

    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = 4_500_000;
      parameters.encodings[0].maxFramerate = 60;
      if ("degradationPreference" in parameters) {
        parameters.degradationPreference = "maintain-resolution";
      }
      await sender.setParameters(parameters);
    } catch {
      // Some browsers reject parameter changes before negotiation settles.
    }
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

    el.screenBtn.classList.toggle("is-active", state.sharing);
    el.screenBtn.setAttribute("aria-pressed", String(state.sharing));
    el.screenBtn.setAttribute("aria-label", "Share your screen");
    el.screenBtn.title = state.sharing ? "Stop sharing (S)" : "Share screen (S)";
    el.screenLabel.textContent = state.sharing ? "Stop share" : "Share";
    setIcon(el.screenBtn, state.sharing ? "#icon-screen-off" : "#icon-screen");
    el.screenBtn.disabled = !state.joined || !supported || state.screenBusy;
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
      await pc.setLocalDescription(offer);
      if (peer.pc !== pc || !socket.connected) return;

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
      await pc.setLocalDescription(answer);
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
  // 13. Join flow
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
    updateMicUI();
    updateScreenUI();
    updateRoomUI();
  }

  bindSocketHandlers();
  bindUiHandlers();
  bootUi();

  // Kick off ICE config + connection after handlers are attached.
  const iceConfigReady = loadIceConfig().then((servers) => {
    state.iceServers = servers;
  });

  window.setInterval(tickMeters, LEVEL_INTERVAL_MS);

  socket.connect();
})();
