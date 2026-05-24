/**
 * LocalIEM — script.js
 * Client-side logic for Broadcaster and Receiver modes.
 * Uses WebRTC (via Socket.io signaling) for real-time audio.
 */

'use strict';

// ─── WebRTC ICE Config ────────────────────────────────────────────────────────
// On a local network these STUN servers usually aren't needed,
// but including them helps with some edge-case NAT scenarios.
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ─── Application State ───────────────────────────────────────────────────────
const state = {
  mode             : null,    // 'broadcaster' | 'receiver'
  socket           : null,
  // Audio
  audioContext     : null,
  audioBuffer      : null,
  sourceNode       : null,
  gainNode         : null,
  analyserNode     : null,
  streamDest       : null,
  mediaStream      : null,
  isStreaming      : false,
  startedAt        : 0,
  pausedAt         : 0,
  audioDuration    : 0,
  loopEnabled      : true,
  monitorEnabled   : false,
  // WebRTC
  peerConnections  : new Map(),   // socketId → RTCPeerConnection  (broadcaster side)
  receiverPC       : null,        // single PC on receiver side
  broadcasterPeerId: null,
  pendingReceivers : new Set(),   // receivers who connected before broadcast started
  // UI
  progressRAF      : null,
  vizRAF           : null,
  vuRAF            : null
};

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  // Screens
  screenSelect      : $('screen-select'),
  screenBroadcaster : $('screen-broadcaster'),
  screenReceiver    : $('screen-receiver'),
  // Header
  statusDot         : $('status-dot'),
  statusLabel       : $('status-label'),
  // Mode buttons
  btnBroadcaster    : $('btn-broadcaster'),
  btnReceiver       : $('btn-receiver'),
  btnBackB          : $('back-from-broadcaster'),
  btnBackR          : $('back-from-receiver'),
  // Broadcaster
  dropZone          : $('drop-zone'),
  dropContent       : $('drop-content'),
  fileInput         : $('file-input'),
  browseBtn         : $('browse-btn'),
  fileLoaded        : $('file-loaded'),
  fileName          : $('file-name'),
  fileSize          : $('file-size'),
  changeFileBtn     : $('change-file-btn'),
  waveformCanvas    : $('waveform-canvas'),
  visualizerWrap    : $('visualizer-wrap'),
  visualizerCanvas  : $('visualizer-canvas'),
  progressWrap      : $('progress-wrap'),
  progressFill      : $('progress-fill'),
  timeCurrent       : $('time-current'),
  timeTotal         : $('time-total'),
  volBroadcaster    : $('vol-broadcaster'),
  volBroadcasterVal : $('vol-broadcaster-val'),
  monitorToggle     : $('monitor-toggle'),
  loopToggle        : $('loop-toggle'),
  btnStartBroadcast : $('btn-start-broadcast'),
  btnStopBroadcast  : $('btn-stop-broadcast'),
  listenerNum       : $('listener-num'),
  bStatusMsg        : $('b-status-msg'),
  // Receiver
  rStatusCard       : $('r-status-card'),
  rStatusTitle      : $('r-status-title'),
  rStatusSub        : $('r-status-sub'),
  vuMeterWrap       : $('vu-meter-wrap'),
  vuLeft            : $('vu-left'),
  vuRight           : $('vu-right'),
  volReceiver       : $('vol-receiver'),
  volReceiverVal    : $('vol-receiver-val'),
  btnListen         : $('btn-listen'),
  btnDisconnect     : $('btn-disconnect'),
  remoteAudio       : $('remote-audio'),
  rHintMsg          : $('r-hint-msg')
};

// ═════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $(`screen-${name}`);
  if (target) target.classList.add('active');
}

function setHeaderStatus(status, label) {
  DOM.statusDot.className = `status-dot ${status}`;
  DOM.statusLabel.textContent = label;
}

function formatTime(secs) {
  if (!isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toast(msg, type = 'info', duration = 3500) {
  const icons = { info: 'ℹ', success: '✓', error: '✕', warning: '⚠' };
  const wrap = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO CONNECTION
// ═════════════════════════════════════════════════════════════════════════════

function connectSocket() {
  if (state.socket && state.socket.connected) return state.socket;

  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    setHeaderStatus('online', 'Connected');
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected');
    setHeaderStatus('', 'Offline');
    toast('Disconnected from server', 'error');
  });

  // Global server events
  socket.on('server-status', ({ hasBroadcaster, isBroadcastActive }) => {
    if (state.mode === 'receiver') {
      if (hasBroadcaster && isBroadcastActive) {
        updateReceiverStatus('connecting', 'Broadcast found', 'Connecting…');
      } else if (hasBroadcaster) {
        updateReceiverStatus('connecting', 'Broadcaster online', 'Waiting for broadcast to start…');
      }
    }
  });

  // ── Broadcaster-only events ──────────────────────────────────────────────
  socket.on('receiver-count', ({ count }) => {
    DOM.listenerNum.textContent = count;
  });

  socket.on('new-receiver', ({ receiverId }) => {
    if (state.mode !== 'broadcaster') return;
    console.log('[B] New receiver:', receiverId);
    if (state.isStreaming) {
      createOfferForReceiver(receiverId);
    } else {
      state.pendingReceivers.add(receiverId);
    }
  });

  socket.on('webrtc-answer', async ({ senderId, answer }) => {
    if (state.mode !== 'broadcaster') return;
    const pc = state.peerConnections.get(senderId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('[B] Answer set for', senderId);
    } catch (e) {
      console.error('[B] setRemoteDescription error:', e);
    }
  });

  // ── Receiver-only events ─────────────────────────────────────────────────
  socket.on('no-broadcaster', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('', 'No Broadcaster', 'No broadcaster found on this server. Ask them to start first.');
    toast('No broadcaster found on this server.', 'warning');
  });

  socket.on('waiting-for-broadcast', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('connecting', 'Broadcaster Online', 'Connected to server. Waiting for broadcast to start…');
    toast('Broadcaster found. Waiting for them to start.', 'info');
  });

  socket.on('broadcast-started', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('connecting', 'Broadcast Live!', 'Connecting audio stream…');
    // Request WebRTC connection
    socket.emit('request-connection');
  });

  socket.on('broadcast-stopped', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('', 'Broadcast Ended', 'The broadcaster has stopped the stream.');
    stopReceiverAudio();
    toast('Broadcast has ended.', 'warning');
  });

  socket.on('broadcaster-online', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('connecting', 'Broadcaster Online', 'Waiting for broadcast to start…');
  });

  socket.on('broadcaster-offline', () => {
    if (state.mode !== 'receiver') return;
    updateReceiverStatus('error', 'Broadcaster Offline', 'The broadcaster has disconnected.');
    stopReceiverAudio();
    toast('Broadcaster went offline.', 'error');
  });

  socket.on('webrtc-offer', async ({ senderId, offer }) => {
    if (state.mode !== 'receiver') return;
    console.log('[R] Got offer from', senderId);
    await handleIncomingOffer(senderId, offer);
  });

  // Shared ICE candidate handler
  socket.on('webrtc-ice-candidate', async ({ senderId, candidate }) => {
    let pc;
    if (state.mode === 'broadcaster') {
      pc = state.peerConnections.get(senderId);
    } else {
      pc = state.receiverPC;
    }
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // ignore benign ICE errors
      }
    }
  });

  socket.on('error-msg', ({ message }) => {
    toast(message, 'error', 5000);
  });

  state.socket = socket;
  return socket;
}

// ═════════════════════════════════════════════════════════════════════════════
//  BROADCASTER — AUDIO ENGINE
// ═════════════════════════════════════════════════════════════════════════════

async function loadAudioFile(file) {
  DOM.bStatusMsg.textContent = 'Decoding audio…';
  try {
    const arrayBuffer = await file.arrayBuffer();
    // Create or resume AudioContext
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    }
    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }
    state.audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
    state.audioDuration = state.audioBuffer.duration;

    // Show file info
    DOM.dropContent.hidden = true;
    DOM.fileLoaded.hidden = false;
    DOM.fileName.textContent = file.name;
    DOM.fileSize.textContent = `${formatBytes(file.size)}  ·  ${formatTime(state.audioDuration)}`;
    DOM.timeTotal.textContent = formatTime(state.audioDuration);

    // Draw static waveform
    drawWaveform(state.audioBuffer);

    DOM.btnStartBroadcast.disabled = false;
    DOM.bStatusMsg.textContent = 'File loaded. Press Start Broadcast to go live.';
    toast(`Loaded: ${file.name}`, 'success');
  } catch (err) {
    console.error('Audio decode error:', err);
    toast('Could not decode audio file. Try a different format.', 'error');
    DOM.bStatusMsg.textContent = 'Error decoding file.';
  }
}

async function startBroadcast() {
  if (!state.audioBuffer) return;

  // Ensure AudioContext is running
  if (state.audioContext.state === 'suspended') {
    await state.audioContext.resume();
  }

  // Tear down any previous nodes
  stopAudioNodes();

  // Build audio graph:
  //   sourceNode → gainNode → [streamDest]
  //                         ↘ [audioContext.destination] (if monitor)
  //                         ↘ [analyserNode]
  state.gainNode      = state.audioContext.createGain();
  state.analyserNode  = state.audioContext.createAnalyser();
  state.streamDest    = state.audioContext.createMediaStreamDestination();
  state.sourceNode    = state.audioContext.createBufferSource();

  state.analyserNode.fftSize = 256;
  state.analyserNode.smoothingTimeConstant = 0.8;
  state.gainNode.gain.value = DOM.volBroadcaster.value / 100;

  state.sourceNode.buffer = state.audioBuffer;
  state.sourceNode.loop   = state.loopEnabled;

  // Connect graph
  state.sourceNode.connect(state.gainNode);
  state.gainNode.connect(state.analyserNode);
  state.gainNode.connect(state.streamDest);
  if (state.monitorEnabled) {
    state.gainNode.connect(state.audioContext.destination);
  }

  state.mediaStream = state.streamDest.stream;
  state.sourceNode.start(0);
  state.startedAt   = state.audioContext.currentTime;
  state.isStreaming  = true;

  // Handle end of track (non-loop)
  state.sourceNode.onended = () => {
    if (!state.loopEnabled && state.isStreaming) {
      handleTrackEnd();
    }
  };

  // Update UI
  DOM.btnStartBroadcast.hidden = true;
  DOM.btnStopBroadcast.hidden  = false;
  DOM.visualizerWrap.hidden    = false;
  DOM.progressWrap.hidden      = false;
  DOM.dropZone.style.pointerEvents = 'none';
  DOM.dropZone.style.opacity = '0.5';
  setHeaderStatus('live', 'LIVE');

  // Notify server
  state.socket.emit('broadcast-start');
  toast('Broadcast started! 🔴', 'success');

  // Start animations
  startVisualizerLoop();
  startProgressLoop();

  // Connect pending receivers (those who joined before broadcast)
  for (const rid of state.pendingReceivers) {
    await createOfferForReceiver(rid);
  }
  state.pendingReceivers.clear();
}

function stopBroadcast() {
  stopAudioNodes();
  state.isStreaming = false;
  state.mediaStream = null;

  // Close all peer connections
  state.peerConnections.forEach(pc => pc.close());
  state.peerConnections.clear();

  // Notify server
  if (state.socket) state.socket.emit('broadcast-stop');

  // Update UI
  DOM.btnStartBroadcast.hidden = false;
  DOM.btnStopBroadcast.hidden  = true;
  DOM.visualizerWrap.hidden    = true;
  DOM.progressWrap.hidden      = true;
  DOM.dropZone.style.pointerEvents = '';
  DOM.dropZone.style.opacity = '1';
  DOM.progressFill.style.width = '0%';
  DOM.timeCurrent.textContent = '0:00';
  setHeaderStatus('online', 'Connected');

  // Stop animation loops
  cancelAnimationFrame(state.vizRAF);
  cancelAnimationFrame(state.progressRAF);

  toast('Broadcast stopped.', 'info');
  DOM.bStatusMsg.textContent = 'Broadcast stopped. Press Start Broadcast to go live again.';
}

function stopAudioNodes() {
  try { state.sourceNode && state.sourceNode.stop(); } catch (_) {}
  try { state.sourceNode && state.sourceNode.disconnect(); } catch (_) {}
  try { state.gainNode   && state.gainNode.disconnect();   } catch (_) {}
  state.sourceNode = null;
}

function handleTrackEnd() {
  stopBroadcast();
  DOM.bStatusMsg.textContent = 'Track finished. Load a file and start again.';
}

// ─── WebRTC: Broadcaster creates offer for a receiver ────────────────────────
async function createOfferForReceiver(receiverId) {
  if (!state.mediaStream) return;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peerConnections.set(receiverId, pc);

  // Add audio tracks to the peer connection
  state.mediaStream.getAudioTracks().forEach(track => {
    pc.addTrack(track, state.mediaStream);
  });

  // ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit('webrtc-ice-candidate', { targetId: receiverId, candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[B] Peer ${receiverId.slice(0,6)} state: ${s}`);
    if (s === 'failed' || s === 'closed') {
      state.peerConnections.delete(receiverId);
    }
  };

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    state.socket.emit('webrtc-offer', { targetId: receiverId, offer: pc.localDescription });
    console.log('[B] Offer sent to', receiverId.slice(0, 6));
  } catch (err) {
    console.error('[B] createOffer error:', err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  RECEIVER — WebRTC + AUDIO
// ═════════════════════════════════════════════════════════════════════════════

async function handleIncomingOffer(senderId, offer) {
  state.broadcasterPeerId = senderId;

  // Close old connection if any
  if (state.receiverPC) {
    state.receiverPC.close();
    state.receiverPC = null;
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.receiverPC = pc;

  // Receive audio track
  pc.ontrack = (event) => {
    console.log('[R] Got remote track!');
    DOM.remoteAudio.srcObject = event.streams[0];
    DOM.remoteAudio.volume = DOM.volReceiver.value / 100;
    DOM.remoteAudio.play().catch(err => {
      console.warn('[R] Autoplay blocked:', err);
      toast('Tap/click anywhere to enable audio playback.', 'warning', 5000);
    });
    updateReceiverStatus('connected', 'Receiving Audio', 'Audio stream is live. Enjoy the monitor!');
    setHeaderStatus('live', 'RECEIVING');
    startVUMeter();
    DOM.vuMeterWrap.hidden = false;
    DOM.btnListen.hidden = true;
    DOM.btnDisconnect.hidden = false;
    DOM.rHintMsg.innerHTML = 'Stream is live. Adjust volume above.';
    toast('Audio connected! 🎧', 'success');
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit('webrtc-ice-candidate', { targetId: senderId, candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[R] Connection state:', s);
    if (s === 'failed') {
      updateReceiverStatus('error', 'Connection Failed', 'Could not establish audio link. Try again.');
      toast('Connection failed. Try pressing Listen again.', 'error');
      DOM.btnListen.hidden = false;
      DOM.btnDisconnect.hidden = true;
    } else if (s === 'disconnected') {
      updateReceiverStatus('error', 'Disconnected', 'Lost connection to broadcaster.');
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('webrtc-answer', { targetId: senderId, answer: pc.localDescription });
    console.log('[R] Answer sent');
    updateReceiverStatus('connecting', 'Connecting…', 'Establishing audio stream…');
  } catch (err) {
    console.error('[R] handleOffer error:', err);
    updateReceiverStatus('error', 'Error', 'Failed to connect. Check console.');
    toast('WebRTC negotiation failed.', 'error');
  }
}

function stopReceiverAudio() {
  cancelAnimationFrame(state.vuRAF);
  DOM.remoteAudio.srcObject = null;
  DOM.vuMeterWrap.hidden = true;
  DOM.btnListen.hidden = false;
  DOM.btnDisconnect.hidden = true;
  if (state.receiverPC) {
    state.receiverPC.close();
    state.receiverPC = null;
  }
  setHeaderStatus('online', 'Connected');
}

function disconnectReceiver() {
  stopReceiverAudio();
  updateReceiverStatus('', 'Disconnected', 'You have disconnected. Press Listen to reconnect.');
  DOM.rHintMsg.innerHTML = 'Press <strong>Listen</strong> to reconnect.';
}

function updateReceiverStatus(cssClass, title, sub) {
  DOM.rStatusCard.className = `receiver-status-card${cssClass ? ' status-' + cssClass : ''}`;
  DOM.rStatusTitle.textContent = title;
  DOM.rStatusSub.textContent = sub;
}

// ─── VU Meter ─────────────────────────────────────────────────────────────────
function startVUMeter() {
  cancelAnimationFrame(state.vuRAF);

  const audio = DOM.remoteAudio;
  if (!audio.srcObject) return;

  let analyser, bufferLength, dataArray;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(audio.srcObject);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser);
    bufferLength = analyser.frequencyBinCount;
    dataArray    = new Uint8Array(bufferLength);
  } catch (e) {
    console.warn('[VU] Could not create analyser:', e);
    return;
  }

  function tick() {
    state.vuRAF = requestAnimationFrame(tick);
    analyser.getByteFrequencyData(dataArray);
    // Simple L/R simulation from frequency bins
    const half  = bufferLength / 2;
    let sumL = 0, sumR = 0;
    for (let i = 0; i < half; i++) sumL += dataArray[i];
    for (let i = half; i < bufferLength; i++) sumR += dataArray[i];
    const avgL = (sumL / half / 255) * 100;
    const avgR = (sumR / half / 255) * 100;
    DOM.vuLeft.style.width  = `${Math.min(100, avgL * 2.5)}%`;
    DOM.vuRight.style.width = `${Math.min(100, avgR * 2.5)}%`;
  }
  tick();
}

// ═════════════════════════════════════════════════════════════════════════════
//  CANVAS VISUALIZATIONS
// ═════════════════════════════════════════════════════════════════════════════

function drawWaveform(audioBuffer) {
  const canvas = DOM.waveformCanvas;
  const ctx    = canvas.getContext('2d');
  const data   = audioBuffer.getChannelData(0);
  const W      = canvas.offsetWidth || 600;
  const H      = canvas.height;
  canvas.width = W;

  const step     = Math.ceil(data.length / W);
  const accentC  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e5ff';

  ctx.clearRect(0, 0, W, H);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,   'rgba(0,229,255,0.6)');
  grad.addColorStop(0.5, 'rgba(0,229,255,1)');
  grad.addColorStop(1,   'rgba(0,229,255,0.6)');
  ctx.fillStyle = grad;

  for (let i = 0; i < W; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const val = data[i * step + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const yMin = ((1 + min) / 2) * H;
    const yMax = ((1 + max) / 2) * H;
    ctx.fillRect(i, yMax, 1, Math.max(1, yMin - yMax));
  }
}

function startVisualizerLoop() {
  const canvas  = DOM.visualizerCanvas;
  const ctx     = canvas.getContext('2d');
  const bufLen  = state.analyserNode.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  canvas.width  = canvas.offsetWidth || 600;
  canvas.height = 60;
  const W = canvas.width;
  const H = canvas.height;

  function draw() {
    state.vizRAF = requestAnimationFrame(draw);
    state.analyserNode.getByteFrequencyData(dataArr);

    ctx.fillStyle = 'rgba(17,17,22,0.6)';
    ctx.fillRect(0, 0, W, H);

    const barW   = (W / bufLen) * 2;
    let x = 0;

    for (let i = 0; i < bufLen; i++) {
      const barH = (dataArr[i] / 255) * H;
      const hue  = 180 + (dataArr[i] / 255) * 60;
      ctx.fillStyle = `hsl(${hue}, 100%, 60%)`;
      ctx.fillRect(x, H - barH, barW - 1, barH);
      x += barW;
    }
  }
  draw();
}

function startProgressLoop() {
  function tick() {
    state.progressRAF = requestAnimationFrame(tick);
    if (!state.isStreaming || !state.audioContext) return;

    const elapsed = state.audioContext.currentTime - state.startedAt;
    const looped  = state.loopEnabled ? elapsed % state.audioDuration : elapsed;
    const pct     = Math.min(100, (looped / state.audioDuration) * 100);

    DOM.progressFill.style.width = `${pct}%`;
    DOM.timeCurrent.textContent  = formatTime(looped);
  }
  tick();
}

// ═════════════════════════════════════════════════════════════════════════════
//  UI EVENT HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

function initModeSelect() {
  DOM.btnBroadcaster.addEventListener('click', () => enterMode('broadcaster'));
  DOM.btnReceiver.addEventListener('click',    () => enterMode('receiver'));
}

function enterMode(mode) {
  state.mode = mode;
  const socket = connectSocket();

  if (mode === 'broadcaster') {
    showScreen('broadcaster');
    setHeaderStatus('online', 'Broadcaster');
    socket.emit('register-broadcaster');
    toast('Registered as Broadcaster', 'success');
  } else {
    showScreen('receiver');
    setHeaderStatus('online', 'Receiver');
    updateReceiverStatus('', 'Waiting', 'Press Listen to connect to the broadcaster.');
  }
}

function initBroadcasterUI() {
  // Back button
  DOM.btnBackB.addEventListener('click', () => {
    if (state.isStreaming) stopBroadcast();
    state.mode = null;
    showScreen('select');
    setHeaderStatus('', 'Offline');
  });

  // File drop zone
  DOM.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    DOM.dropZone.classList.add('drag-over');
  });
  DOM.dropZone.addEventListener('dragleave', () => DOM.dropZone.classList.remove('drag-over'));
  DOM.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    DOM.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) loadAudioFile(file);
    else toast('Please drop an audio file.', 'warning');
  });
  DOM.dropZone.addEventListener('click', (e) => {
    if (e.target !== DOM.browseBtn) DOM.fileInput.click();
  });
  DOM.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); DOM.fileInput.click(); });
  DOM.fileInput.addEventListener('change', () => {
    const file = DOM.fileInput.files[0];
    if (file) loadAudioFile(file);
  });

  // Change file
  DOM.changeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.isStreaming) stopBroadcast();
    DOM.dropContent.hidden = false;
    DOM.fileLoaded.hidden  = true;
    DOM.btnStartBroadcast.disabled = true;
    DOM.bStatusMsg.textContent = 'Load an audio file to get started.';
    state.audioBuffer = null;
    DOM.fileInput.value = '';
  });

  // Volume slider
  DOM.volBroadcaster.addEventListener('input', () => {
    const v = DOM.volBroadcaster.value;
    DOM.volBroadcasterVal.textContent = v;
    if (state.gainNode) state.gainNode.gain.value = v / 100;
  });

  // Monitor toggle
  DOM.monitorToggle.addEventListener('change', () => {
    state.monitorEnabled = DOM.monitorToggle.checked;
    if (state.isStreaming && state.gainNode && state.audioContext) {
      if (state.monitorEnabled) {
        state.gainNode.connect(state.audioContext.destination);
      } else {
        try { state.gainNode.disconnect(state.audioContext.destination); } catch (_) {}
      }
    }
  });

  // Loop toggle
  DOM.loopToggle.addEventListener('change', () => {
    state.loopEnabled = DOM.loopToggle.checked;
    if (state.sourceNode) state.sourceNode.loop = state.loopEnabled;
  });

  // Start / Stop buttons
  DOM.btnStartBroadcast.addEventListener('click', () => startBroadcast());
  DOM.btnStopBroadcast.addEventListener('click',  () => stopBroadcast());
}

function initReceiverUI() {
  // Back button
  DOM.btnBackR.addEventListener('click', () => {
    disconnectReceiver();
    state.mode = null;
    showScreen('select');
    setHeaderStatus('', 'Offline');
  });

  // Listen button
  DOM.btnListen.addEventListener('click', () => {
    if (!state.socket || !state.socket.connected) {
      connectSocket();
    }
    DOM.rHintMsg.textContent = 'Connecting…';
    state.socket.emit('register-receiver');
    updateReceiverStatus('connecting', 'Connecting…', 'Reaching out to broadcaster…');
  });

  // Disconnect button
  DOM.btnDisconnect.addEventListener('click', () => {
    disconnectReceiver();
    toast('Disconnected.', 'info');
  });

  // Volume control
  DOM.volReceiver.addEventListener('input', () => {
    const v = DOM.volReceiver.value;
    DOM.volReceiverVal.textContent = v;
    DOM.remoteAudio.volume = v / 100;
  });

  // Unlock audio on first interaction (iOS / strict autoplay policy)
  document.addEventListener('click', () => {
    if (DOM.remoteAudio.paused && DOM.remoteAudio.srcObject) {
      DOM.remoteAudio.play().catch(() => {});
    }
  }, { once: true });
}

// ═════════════════════════════════════════════════════════════════════════════
//  BOOT
// ═════════════════════════════════════════════════════════════════════════════

function init() {
  initModeSelect();
  initBroadcasterUI();
  initReceiverUI();

  // Resize waveform canvas on window resize
  window.addEventListener('resize', () => {
    if (state.audioBuffer) drawWaveform(state.audioBuffer);
    if (state.isStreaming) {
      DOM.visualizerCanvas.width = DOM.visualizerCanvas.offsetWidth || 600;
    }
  });

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  console.log('%cLocalIEM v1.0', 'color:#00e5ff;font-family:monospace;font-size:1.2rem;font-weight:bold');
  console.log('%cWebRTC In-Ear Monitor over LAN', 'color:#8a8a9f;font-family:monospace');
}

document.addEventListener('DOMContentLoaded', init);
