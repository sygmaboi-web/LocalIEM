# LocalIEM 🎧
**Wireless In-Ear Monitor System over Local Wi-Fi via WebRTC**

Stream audio in real-time from one device (Broadcaster) to many devices (Receivers)
on the same local network — with sub-100ms latency thanks to WebRTC.

---

## 📁 File Structure

```
localiem/
├── server.js          ← Node.js signaling server
├── package.json
└── public/
    ├── index.html     ← Main UI (single-page app)
    ├── style.css      ← Styles (dark industrial theme)
    ├── script.js      ← Client-side logic (WebRTC + Audio)
    ├── manifest.json  ← PWA manifest
    └── sw.js          ← Service worker (offline shell)
```

---

## 🚀 Step-by-Step Setup

### Step 1 — Install Node.js
- Download from https://nodejs.org (LTS version)
- Or on Android via Termux: `pkg install nodejs`

### Step 2 — Install dependencies
Open a terminal in the `localiem/` folder:
```bash
npm install
```
This installs `express` and `socket.io`.

### Step 3 — Enable Wi-Fi Hotspot / Tethering
- **On Android**: Settings → Network → Hotspot & Tethering → Wi-Fi Hotspot → ON
- **On iPhone**: Settings → Personal Hotspot → ON
- **On Windows/Mac**: Share your internet connection or use an existing Wi-Fi router

Connect ALL devices (broadcaster + receivers) to this same Wi-Fi/hotspot network.

### Step 4 — Start the server
```bash
node server.js
```

You'll see output like:
```
╔══════════════════════════════════════════════╗
║         LocalIEM — Server Started           ║
╠══════════════════════════════════════════════╣
║  Local    →  http://localhost:3000          ║
║  Network  →  http://192.168.43.1:3000       ║
╚══════════════════════════════════════════════╝
```

> 💡 Note your **Network IP** (e.g. `192.168.43.1`) — receivers will need it.

### Step 5 — Open the app

| Device       | URL to open                          |
|--------------|--------------------------------------|
| Broadcaster  | `http://localhost:3000`              |
| Each Receiver| `http://192.168.43.1:3000` (use your actual IP) |

---

## 🎛️ Using the App

### Broadcaster
1. Open app → tap **Broadcaster**
2. Drop or browse an audio file (MP3, WAV, FLAC, OGG, AAC)
3. Wait for waveform to appear
4. Optionally toggle **Monitor** (hear audio on this device too)
5. Tap **Start Broadcast** → audio streams live to all receivers

### Receiver
1. Open `http://<broadcaster-ip>:3000` on any device on the same network
2. Tap **Receiver**
3. Tap **Listen** → audio plays automatically after WebRTC connects
4. Adjust volume with the slider

---

## 🔧 Troubleshooting

| Problem | Solution |
|---|---|
| Receivers can't connect | Make sure all devices are on the **same** Wi-Fi/hotspot |
| "No broadcaster found" | Start the broadcaster first, then press Listen again |
| Audio doesn't play on receiver | Tap anywhere on the page (browser autoplay policy) |
| High latency | Use 5GHz Wi-Fi instead of 2.4GHz; close other browser tabs |
| `EACCES` error on port 3000 | Run `PORT=8080 node server.js` and use port 8080 |
| WebRTC fails on some browsers | Use Chrome or Firefox; Safari needs iOS 14+ |

---

## ⚙️ Technical Notes

- **Audio pipeline**: File → Web Audio API → `MediaStreamDestinationNode` → WebRTC track
- **Signaling**: Socket.io (runs on the Node.js server)
- **Transport**: WebRTC `RTCPeerConnection` (P2P audio after handshake)
- **Latency**: Typically 20–80ms on a good local network
- **Max receivers**: Limited only by the broadcaster device's CPU/RAM
- **No internet required**: Everything runs 100% locally

---

## 📱 PWA Installation

On mobile browsers, you can install LocalIEM as a home screen app:
- **Android Chrome**: Menu → "Add to Home Screen"
- **iOS Safari**: Share → "Add to Home Screen"

---

## 🔑 Supported Audio Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| MP3    | .mp3      | Universal support |
| WAV    | .wav      | Uncompressed, large files |
| FLAC   | .flac     | Lossless, may vary by browser |
| OGG    | .ogg      | Good for Chrome/Firefox |
| AAC    | .aac, .m4a | Good for Safari |
