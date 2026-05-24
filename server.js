/**
 * LocalIEM — Server (server.js)
 * Handles WebRTC signaling between Broadcaster and Receivers via Socket.io
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const os      = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 5000,
  pingTimeout: 10000
});

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── State ───────────────────────────────────────────────────────────────────
let broadcasterSocketId  = null;
let isBroadcastActive    = false;
const receivers          = new Set();   // Set of receiver socket IDs

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const tag = socket.id.slice(0, 6);
  console.log(`[+] Connected   ${socket.id}  (${tag})`);

  // Send current state to newly connected client
  socket.emit('server-status', {
    hasBroadcaster    : broadcasterSocketId !== null,
    isBroadcastActive : isBroadcastActive,
    receiverCount     : receivers.size
  });

  // ── BROADCASTER ────────────────────────────────────────────────────────────
  socket.on('register-broadcaster', () => {
    if (broadcasterSocketId && broadcasterSocketId !== socket.id) {
      socket.emit('error-msg', { code: 'BROADCASTER_EXISTS', message: 'Another broadcaster is already active.' });
      return;
    }
    broadcasterSocketId = socket.id;
    console.log(`[B] Broadcaster online: ${socket.id}`);
    io.emit('broadcaster-online', { broadcasterId: socket.id });
    io.to(socket.id).emit('receiver-count', { count: receivers.size });
  });

  socket.on('broadcast-start', () => {
    if (socket.id !== broadcasterSocketId) return;
    isBroadcastActive = true;
    console.log('[B] Broadcast STARTED');
    io.emit('broadcast-started');
  });

  socket.on('broadcast-stop', () => {
    if (socket.id !== broadcasterSocketId) return;
    isBroadcastActive = false;
    console.log('[B] Broadcast STOPPED');
    io.emit('broadcast-stopped');
  });

  // ── RECEIVER ───────────────────────────────────────────────────────────────
  socket.on('register-receiver', () => {
    receivers.add(socket.id);
    const count = receivers.size;
    console.log(`[R] Receiver online: ${socket.id}  total=${count}`);

    if (!broadcasterSocketId) {
      socket.emit('no-broadcaster');
      return;
    }

    // Update broadcaster with new count
    io.to(broadcasterSocketId).emit('receiver-count', { count });

    // Tell broadcaster to initiate WebRTC with this receiver
    if (isBroadcastActive) {
      io.to(broadcasterSocketId).emit('new-receiver', { receiverId: socket.id });
    } else {
      socket.emit('waiting-for-broadcast');
    }
  });

  // Receiver asks broadcaster to (re-)initiate when broadcast already live
  socket.on('request-connection', () => {
    if (!broadcasterSocketId || !isBroadcastActive) {
      socket.emit('no-broadcaster');
      return;
    }
    io.to(broadcasterSocketId).emit('new-receiver', { receiverId: socket.id });
  });

  // ── WebRTC SIGNALING ───────────────────────────────────────────────────────
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc-offer', { senderId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc-answer', { senderId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', { senderId: socket.id, candidate });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[-] Disconnected ${socket.id}  reason=${reason}`);

    if (socket.id === broadcasterSocketId) {
      broadcasterSocketId = null;
      isBroadcastActive   = false;
      console.log('[B] Broadcaster went offline');
      io.emit('broadcaster-offline');
    }

    if (receivers.has(socket.id)) {
      receivers.delete(socket.id);
      const count = receivers.size;
      if (broadcasterSocketId) {
        io.to(broadcasterSocketId).emit('receiver-count', { count });
      }
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const nets   = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result.length ? result : ['localhost'];
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  const bar = '═'.repeat(46);

  console.log(`\n╔${bar}╗`);
  console.log(`║${'         LocalIEM — Server Started'.padEnd(46)}║`);
  console.log(`╠${bar}╣`);
  console.log(`║  Local    →  http://localhost:${PORT}`.padEnd(47) + '║');
  ips.forEach(ip => {
    console.log(`║  Network  →  http://${ip}:${PORT}`.padEnd(47) + '║');
  });
  console.log(`╠${bar}╣`);
  console.log(`║  Broadcaster : open Local URL on host device`.padEnd(47) + '║');
  console.log(`║  Receivers   : open Network URL on other devices`.padEnd(47) + '║');
  console.log(`╚${bar}╝\n`);
});
