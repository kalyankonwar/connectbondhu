const http = require("http");
const url = require("url");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const db = new Database("messenger.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY)
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT,
    to_user TEXT,
    text TEXT
  )
`);

// Add new columns for file/image sharing if this is an older database
try { db.exec("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN file_name TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN file_data TEXT"); } catch (e) {}

function renderMessageHTML(m, viewerName) {
  const mine = m.from_user === viewerName;
  const actions = mine
    ? `<span class="msgActions">${m.type === "text" ? `<button onclick="editMsg(${m.id}, this)">Edit</button>` : ""}<button onclick="deleteMsg(${m.id})">Delete</button></span>`
    : "";

  if (m.type === "image") {
    return `<div class="msgRow" data-id="${m.id}"><b>${m.from_user}:</b><br/><img src="${m.file_data}" onclick="openImageViewer('${m.file_data}')" style="max-width:220px; border-radius:6px; margin-top:4px; cursor:pointer;" />${actions}</div>`;
  } else if (m.type === "file") {
    return `<div class="msgRow" data-id="${m.id}"><b>${m.from_user}:</b><br/><a href="${m.file_data}" download="${m.file_name}">📎 ${m.file_name}</a>${actions}</div>`;
  } else {
    return `<div class="msgRow" data-id="${m.id}"><b>${m.from_user}:</b> <span class="msgText">${m.text}</span>${actions}</div>`;
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: -apple-system, Segoe UI, Roboto, sans-serif;
              background: linear-gradient(135deg, #3d0f6e 0%, #6c2bd9 45%, #9333ea 100%);
              padding: 20px;
            }
            .loginCard {
              background: rgba(255,255,255,0.06);
              backdrop-filter: blur(12px);
              border: 1px solid rgba(255,255,255,0.15);
              border-radius: 20px;
              padding: 40px 32px;
              max-width: 380px;
              width: 100%;
              text-align: center;
              color: white;
              box-shadow: 0 20px 60px rgba(0,0,0,0.35);
            }
            .logoCircle {
              width: 68px; height: 68px;
              border-radius: 50%;
              background: linear-gradient(135deg, #ffd966, #ff9d3d);
              display: flex; align-items: center; justify-content: center;
              margin: 0 auto 16px;
              font-size: 30px;
            }
            h1 {
              font-size: 24px;
              margin: 0 0 4px;
              letter-spacing: 0.3px;
            }
            .tagline {
              color: rgba(255,255,255,0.7);
              font-size: 13px;
              margin: 0 0 26px;
            }
            .nameInput {
              width: 100%;
              padding: 13px 16px;
              border-radius: 12px;
              border: 1px solid rgba(255,255,255,0.25);
              background: rgba(255,255,255,0.08);
              color: white;
              font-size: 15px;
              margin-bottom: 14px;
              outline: none;
            }
            .nameInput::placeholder { color: rgba(255,255,255,0.5); }
            .signInBtn {
              width: 100%;
              padding: 13px;
              border: none;
              border-radius: 12px;
              background: linear-gradient(135deg, #ffd966, #ff9d3d);
              color: #3d0f6e;
              font-weight: 700;
              font-size: 15px;
              cursor: pointer;
            }
            .signInBtn:active { transform: scale(0.98); }
            .featureRow {
              display: flex;
              justify-content: center;
              gap: 10px;
              margin-top: 26px;
              flex-wrap: wrap;
            }
            .featurePill {
              background: rgba(255,255,255,0.08);
              border: 1px solid rgba(255,255,255,0.15);
              border-radius: 20px;
              padding: 6px 12px;
              font-size: 11px;
              color: rgba(255,255,255,0.85);
              white-space: nowrap;
            }
          </style>
        </head>
        <body>
          <div class="loginCard">
            <div class="logoCircle">💬</div>
            <h1>ConnectBondhu</h1>
            <p class="tagline">Chat • Video Calls • Games • AI</p>

            <input id="nameBox" class="nameInput" placeholder="Enter your name" />
            <button class="signInBtn" onclick="signIn()">Sign In</button>

            <div class="featureRow">
              <span class="featurePill">📹 Video Calls</span>
              <span class="featurePill">🎮 Games</span>
              <span class="featurePill">🤖 AI Chat</span>
              <span class="featurePill">🔮 AI Astrology</span>
            </div>
          </div>

          <script>
            function signIn() {
              const name = document.getElementById("nameBox").value.trim();
              if (!name) return;
              window.location.href = "/welcome?name=" + encodeURIComponent(name);
            }
            document.getElementById("nameBox").addEventListener("keydown", (e) => {
              if (e.key === "Enter") signIn();
            });
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/welcome") {
    const name = parsedUrl.query.name;

    if (name) {
      db.prepare("INSERT OR IGNORE INTO users (name) VALUES (?)").run(name);
    }

    const allUsers = db.prepare("SELECT name FROM users").all();
    const buddyListHTML = allUsers
      .filter((u) => u.name !== name)
      .map(
        (u) => `
        <a class="buddyRow" href="/chat?me=${name}&with=${u.name}">
          <span class="buddyAvatar">${u.name.charAt(0).toUpperCase()}</span>
          <span class="buddyName">${u.name}</span>
          <span class="buddyStatus">●</span>
        </a>`
      )
      .join("");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              font-family: -apple-system, Segoe UI, Roboto, sans-serif;
              background: linear-gradient(160deg, #3d0f6e 0%, #6c2bd9 50%, #9333ea 100%);
              color: white;
              padding-bottom: 30px;
            }
            .header {
              padding: 26px 20px 18px;
              text-align: center;
            }
            .header h1 { margin: 0; font-size: 22px; }
            .header p { margin: 4px 0 0; color: rgba(255,255,255,0.7); font-size: 13px; }

            .section {
              max-width: 420px;
              margin: 0 auto 18px;
              padding: 0 16px;
            }
            .sectionTitle {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.8px;
              color: rgba(255,255,255,0.6);
              margin: 0 0 8px 4px;
            }

            .featureGrid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px;
            }
            .featureCard {
              background: rgba(255,255,255,0.07);
              border: 1px solid rgba(255,255,255,0.15);
              border-radius: 14px;
              padding: 14px 12px;
              text-decoration: none;
              color: white;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 6px;
              text-align: center;
            }
            .featureCard .icon { font-size: 22px; }
            .featureCard .label { font-size: 12.5px; font-weight: 600; }

            .buddyList {
              background: rgba(255,255,255,0.06);
              border: 1px solid rgba(255,255,255,0.14);
              border-radius: 14px;
              overflow: hidden;
            }
            .buddyRow {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 12px 14px;
              text-decoration: none;
              color: white;
              border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .buddyRow:last-child { border-bottom: none; }
            .buddyAvatar {
              width: 36px; height: 36px;
              border-radius: 50%;
              background: linear-gradient(135deg, #ffd966, #ff9d3d);
              color: #3d0f6e;
              font-weight: 700;
              display: flex; align-items: center; justify-content: center;
              flex-shrink: 0;
            }
            .buddyName { flex: 1; font-size: 14.5px; font-weight: 500; }
            .buddyStatus { color: #4ade80; font-size: 10px; }
            .emptyState { padding: 18px; text-align: center; color: rgba(255,255,255,0.5); font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Welcome, ${name}!</h1>
            <p>What would you like to do?</p>
          </div>

          <div class="section">
            <p class="sectionTitle">Quick Access</p>
            <div class="featureGrid">
              <a class="featureCard" href="/camera-test?name=${name}">
                <span class="icon">🎥</span><span class="label">Test Camera & Mic</span>
              </a>
              <a class="featureCard" href="/group-call?room=family-room&me=${name}">
                <span class="icon">👥</span><span class="label">Group Call</span>
              </a>
              <a class="featureCard" href="/ai-chat?name=${name}">
                <span class="icon">🤖</span><span class="label">AI Chat</span>
              </a>
              <a class="featureCard" href="/ai-astrology?name=${name}">
                <span class="icon">🔮</span><span class="label">AI Astrology</span>
              </a>
            </div>
          </div>

          <div class="section">
            <p class="sectionTitle">Buddies</p>
            <div class="buddyList">
              ${buddyListHTML || '<div class="emptyState">No one else is signed in yet</div>'}
            </div>
          </div>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/ai-chat") {
    const name = parsedUrl.query.name || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:linear-gradient(160deg,#3d0f6e,#9333ea); color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
          <h1>🤖 AI Chat</h1>
          <p>Coming soon \u2014 this will let you chat with an AI assistant right inside ConnectBondhu.</p>
          <a style="color:#ffd966;" href="/welcome?name=${name}">Back to Welcome</a>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/ai-astrology") {
    const name = parsedUrl.query.name || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:linear-gradient(160deg,#3d0f6e,#9333ea); color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
          <h1>🔮 AI Astrology</h1>
          <p>Coming soon \u2014 personalized horoscopes powered by AI.</p>
          <a style="color:#ffd966;" href="/welcome?name=${name}">Back to Welcome</a>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/camera-test") {
    const name = parsedUrl.query.name || "";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:60px;">
          <h2>Camera & Mic Test</h2>
          <video id="preview" autoplay playsinline muted style="width:320px; height:240px; background:black; border-radius:8px;"></video>
          <br /><br />
          <button onclick="startPreview()" style="padding:10px 20px; font-size:16px;">Start Camera & Mic</button>
          <p id="status" style="margin-top:15px;"></p>
          <br />
          <a style="color:#ffd966;" href="/welcome?name=${name}">Back to Welcome</a>
          <script>
            async function startPreview() {
              const statusEl = document.getElementById("status");
              statusEl.textContent = "Asking for permission...";
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                document.getElementById("preview").srcObject = stream;
                statusEl.textContent = "Camera and mic are working!";
              } catch (err) {
                statusEl.textContent = "Could not access camera/mic: " + err.message;
              }
            }
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/group-call") {
    const me = parsedUrl.query.me || "Guest";
    const room = parsedUrl.query.room || "family-room";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <style>
            body { background:#111; color:white; font-family:sans-serif; margin:0; padding:0; }
            #topBar { background:#5b1f9e; padding:14px; text-align:center; }
            #videoGrid {
              display:grid;
              grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
              gap:8px;
              padding:10px;
            }
            .tile { position:relative; background:#222; border-radius:8px; overflow:hidden; aspect-ratio:4/3; }
            .tile video { width:100%; height:100%; object-fit:cover; }
            .tile .label { position:absolute; bottom:4px; left:6px; background:rgba(0,0,0,0.5); padding:2px 8px; border-radius:4px; font-size:12px; }
            #controls { text-align:center; padding:14px; }
            #controls button { padding:10px 18px; margin:4px; border:none; border-radius:20px; font-size:14px; }
            #leaveBtn { background:#e33; color:white; }
            #muteBtn, #camBtn { background:#444; color:white; }
            .off { background:#e33 !important; }

            #gamePanel {
              display:none;
              position:fixed;
              bottom:0; left:0; right:0;
              background:#1a1a1a;
              padding:16px;
              text-align:center;
              border-top:2px solid #5b1f9e;
              z-index:500;
            }
            #ticTacToeBoard {
              display:grid;
              grid-template-columns: repeat(3, 60px);
              grid-template-rows: repeat(3, 60px);
              gap:4px;
              margin:10px auto;
              width:fit-content;
            }
            .ttt-cell {
              background:#333;
              color:white;
              font-size:28px;
              display:flex;
              align-items:center;
              justify-content:center;
              cursor:pointer;
              border-radius:4px;
            }
            .ttt-cell:hover { background:#444; }

            #ludoPath {
              display:flex;
              flex-wrap:wrap;
              gap:3px;
              max-width:360px;
              margin:10px auto;
              justify-content:center;
            }
            .ludo-cell {
              width:26px; height:26px;
              background:#333;
              border-radius:4px;
              display:flex;
              align-items:center;
              justify-content:center;
              font-size:10px;
              position:relative;
            }
            .ludo-token {
              width:16px; height:16px;
              border-radius:50%;
              border:2px solid white;
              position:absolute;
            }
            #diceBtn {
              font-size:28px;
              background:#333;
              border:none;
              border-radius:8px;
              padding:8px 16px;
              margin-top:10px;
              cursor:pointer;
            }
            #diceBtn:disabled { opacity:0.4; cursor:default; }
            .gamePicker button { padding:6px 12px; margin:2px; border-radius:14px; border:none; }
            .gamePicker button.active { background:#ffd966; }

            #snlBoard {
              display:grid;
              grid-template-columns: repeat(10, 28px);
              grid-template-rows: repeat(10, 28px);
              gap:2px;
              margin:10px auto;
              width:fit-content;
            }
            .snl-cell {
              background:#333;
              font-size:8px;
              color:#999;
              display:flex;
              align-items:flex-start;
              justify-content:flex-start;
              padding:1px;
              position:relative;
              border-radius:2px;
            }
            .snl-ladder { background:#2a5; }
            .snl-snake { background:#a33; }
            .snl-token {
              width:12px; height:12px;
              border-radius:50%;
              border:1px solid white;
              position:absolute;
              bottom:2px; right:2px;
            }
          </style>
        </head>
        <body>
          <div id="topBar">
            <h2 style="margin:4px;">Group Call: ${room}</h2>
            <p style="margin:4px; font-size:13px; color:#ffd966;">Share this page link with others to join the same room</p>
          </div>

          <div id="videoGrid"></div>

          <div id="controls">
            <button id="muteBtn" onclick="toggleMute()">Mute</button>
            <button id="camBtn" onclick="toggleCam()">Camera Off</button>
            <button onclick="toggleGamePanel()">Games</button>
            <button id="leaveBtn" onclick="leaveCall()">Leave</button>
          </div>

          <div id="gamePanel">
            <div class="gamePicker">
              <button id="pickTTT" class="active" onclick="switchGame('ttt')">Tic-Tac-Toe</button>
              <button id="pickLudo" onclick="switchGame('ludo')">Ludo (Race)</button>
              <button id="pickSnl" onclick="switchGame('snl')">Snakes & Ladders</button>
              <button onclick="toggleGamePanel()">Close</button>
            </div>

            <div id="tttGame">
              <h3 style="margin:4px;">Tic-Tac-Toe</h3>
              <p id="gameStatus" style="color:#ffd966;">Loading...</p>
              <div id="ticTacToeBoard"></div>
              <button onclick="resetGame()" style="padding:8px 14px; margin-top:8px;">Play Again</button>
            </div>

            <div id="ludoGame" style="display:none;">
              <h3 style="margin:4px;">Ludo (Race)</h3>
              <p id="ludoStatus" style="color:#ffd966;">Loading...</p>
              <div id="ludoPath"></div>
              <button id="diceBtn" onclick="rollDice()" disabled>🎲</button>
              <br/>
              <button onclick="resetLudo()" style="padding:8px 14px; margin-top:8px;">Play Again</button>
            </div>

            <div id="snlGame" style="display:none;">
              <h3 style="margin:4px;">Snakes & Ladders</h3>
              <p id="snlStatus" style="color:#ffd966;">Loading...</p>
              <div id="snlBoard"></div>
              <button id="snlDiceBtn" onclick="rollSnl()" disabled>🎲</button>
              <br/>
              <button onclick="resetSnl()" style="padding:8px 14px; margin-top:8px;">Play Again</button>
            </div>
          </div>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const me = "${me}";
            const room = "${room}";
            const socket = io();

            const rtcConfig = {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
              ]
            };

            let localStream = null;
            const peers = {}; // socketId -> RTCPeerConnection
            let muted = false;
            let camOff = false;

            function addTile(id, stream, name, isLocal) {
              let tile = document.getElementById("tile-" + id);
              if (!tile) {
                tile = document.createElement("div");
                tile.className = "tile";
                tile.id = "tile-" + id;
                tile.innerHTML = '<video autoplay playsinline' + (isLocal ? ' muted' : '') + '></video><div class="label">' + name + (isLocal ? " (You)" : "") + '</div>';
                document.getElementById("videoGrid").appendChild(tile);
              }
              tile.querySelector("video").srcObject = stream;
            }

            function removeTile(id) {
              const tile = document.getElementById("tile-" + id);
              if (tile) tile.remove();
            }

            function createPeerConnection(peerId, peerName) {
              const pc = new RTCPeerConnection(rtcConfig);

              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket.emit("group-ice-candidate", { to: peerId, from: socket.id, candidate: event.candidate });
                }
              };

              pc.ontrack = (event) => {
                addTile(peerId, event.streams[0], peerName, false);
              };

              if (localStream) {
                localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
              }

              peers[peerId] = pc;
              return pc;
            }

            async function start() {
              localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              addTile(socket.id || "local", localStream, me, true);

              socket.emit("join-group", { room, name: me });
            }

            socket.on("connect", () => {
              // re-label local tile with real socket id once connected
              const oldTile = document.getElementById("tile-local");
              if (oldTile) oldTile.id = "tile-" + socket.id;
            });

            // Existing people already in the room -> call each of them
            socket.on("existing-peers", async (peerList) => {
              for (const peer of peerList) {
                const pc = createPeerConnection(peer.id, peer.name);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("group-offer", { to: peer.id, from: socket.id, offer, name: me });
              }
            });

            // Someone new joined -> wait for their offer
            socket.on("new-peer", ({ id, name }) => {
              // no action needed here; they will send us an offer
            });

            socket.on("group-offer", async ({ from, offer, name }) => {
              const pc = createPeerConnection(from, name);
              await pc.setRemoteDescription(offer);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.emit("group-answer", { to: from, from: socket.id, answer });
            });

            socket.on("group-answer", async ({ from, answer }) => {
              const pc = peers[from];
              if (pc) await pc.setRemoteDescription(answer);
            });

            socket.on("group-ice-candidate", async ({ from, candidate }) => {
              const pc = peers[from];
              if (pc) {
                try { await pc.addIceCandidate(candidate); } catch (err) {}
              }
            });

            socket.on("peer-left", ({ id }) => {
              if (peers[id]) {
                peers[id].close();
                delete peers[id];
              }
              removeTile(id);
            });

            function toggleMute() {
              if (!localStream) return;
              muted = !muted;
              localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
              const btn = document.getElementById("muteBtn");
              btn.textContent = muted ? "Unmute" : "Mute";
              btn.classList.toggle("off", muted);
            }

            function toggleCam() {
              if (!localStream) return;
              camOff = !camOff;
              localStream.getVideoTracks().forEach((t) => (t.enabled = !camOff));
              const btn = document.getElementById("camBtn");
              btn.textContent = camOff ? "Camera On" : "Camera Off";
              btn.classList.toggle("off", camOff);
            }

            function leaveCall() {
              Object.values(peers).forEach((pc) => pc.close());
              if (localStream) localStream.getTracks().forEach((t) => t.stop());
              window.location.href = "/welcome?name=" + me;
            }

            // ---- Tic-Tac-Toe game ----
            let myRole = null; // "X", "O", or "spectator"
            let joinedGame = false;
            let joinedLudo = false;
            let joinedSnl = false;
            let currentGameView = "ttt";

            function toggleGamePanel() {
              const panel = document.getElementById("gamePanel");
              const isOpen = panel.style.display === "block";
              panel.style.display = isOpen ? "none" : "block";

              if (!isOpen && !joinedGame) {
                joinedGame = true;
                socket.emit("game-join", { room });
              }
            }

            function switchGame(which) {
              currentGameView = which;
              document.getElementById("tttGame").style.display = which === "ttt" ? "block" : "none";
              document.getElementById("ludoGame").style.display = which === "ludo" ? "block" : "none";
              document.getElementById("snlGame").style.display = which === "snl" ? "block" : "none";
              document.getElementById("pickTTT").classList.toggle("active", which === "ttt");
              document.getElementById("pickLudo").classList.toggle("active", which === "ludo");
              document.getElementById("pickSnl").classList.toggle("active", which === "snl");

              if (which === "ludo" && !joinedLudo) {
                joinedLudo = true;
                socket.emit("ludo-join", { room });
              }
              if (which === "snl" && !joinedSnl) {
                joinedSnl = true;
                socket.emit("snl-join", { room });
              }
            }

            function renderBoard(state) {
              const boardEl = document.getElementById("ticTacToeBoard");
              boardEl.innerHTML = "";
              state.board.forEach((cell, i) => {
                const cellEl = document.createElement("div");
                cellEl.className = "ttt-cell";
                cellEl.textContent = cell || "";
                cellEl.onclick = () => makeMove(i);
                boardEl.appendChild(cellEl);
              });

              const statusEl = document.getElementById("gameStatus");
              if (state.winner === "draw") {
                statusEl.textContent = "It's a draw!";
              } else if (state.winner) {
                statusEl.textContent = state.winner + " wins!";
              } else if (myRole === "spectator") {
                statusEl.textContent = "Watching " + state.turn + "'s turn";
              } else if (myRole === state.turn) {
                statusEl.textContent = "Your turn (" + myRole + ")";
              } else {
                statusEl.textContent = "Waiting for " + state.turn + "...";
              }
            }

            function makeMove(index) {
              if (!myRole || myRole === "spectator") return;
              socket.emit("game-move", { room, index });
            }

            function resetGame() {
              socket.emit("game-reset", { room });
            }

            socket.on("game-role", (role) => {
              myRole = role;
            });

            socket.on("game-state", (state) => {
              renderBoard(state);
            });

            // ---- Ludo (race) game ----
            const LUDO_PATH_LENGTH = 30;
            const LUDO_COLORS = { red: "#e33", blue: "#39c", green: "#3c6", yellow: "#dc3" };
            let myLudoColor = null;

            function renderLudo(state) {
              const pathEl = document.getElementById("ludoPath");
              pathEl.innerHTML = "";
              for (let i = 0; i < LUDO_PATH_LENGTH; i++) {
                const cell = document.createElement("div");
                cell.className = "ludo-cell";
                cell.textContent = i === LUDO_PATH_LENGTH - 1 ? "🏁" : "";

                Object.entries(state.players).forEach(([color, p]) => {
                  if (p.position === i) {
                    const token = document.createElement("div");
                    token.className = "ludo-token";
                    token.style.background = LUDO_COLORS[color];
                    cell.appendChild(token);
                  }
                });
                pathEl.appendChild(cell);
              }

              const statusEl = document.getElementById("ludoStatus");
              const diceBtn = document.getElementById("diceBtn");

              if (state.winner) {
                statusEl.textContent = state.winner + " wins the race!";
                diceBtn.disabled = true;
              } else if (myLudoColor === "spectator" || !myLudoColor) {
                statusEl.textContent = "Watching " + state.turn + "'s turn";
                diceBtn.disabled = true;
              } else if (myLudoColor === state.turn) {
                statusEl.textContent = "Your turn (" + myLudoColor + "). Last roll: " + (state.lastRoll || "-");
                diceBtn.disabled = false;
              } else {
                statusEl.textContent = "Waiting for " + state.turn + "...";
                diceBtn.disabled = true;
              }
            }

            function rollDice() {
              socket.emit("ludo-roll", { room });
            }

            function resetLudo() {
              socket.emit("ludo-reset", { room });
            }

            socket.on("ludo-role", (color) => {
              myLudoColor = color;
            });

            socket.on("ludo-state", (state) => {
              renderLudo(state);
            });

            // ---- Snakes & Ladders ----
            const SNL_COLORS = { red: "#e33", blue: "#39c", green: "#3c6", yellow: "#dc3" };
            const SNL_LADDERS = { 4: 14, 9: 31, 20: 38, 28: 84, 40: 59, 51: 67, 63: 81, 71: 91 };
            const SNL_SNAKES = { 17: 7, 54: 34, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 99: 78 };
            let mySnlColor = null;

            function renderSnlBoard(state) {
              const boardEl = document.getElementById("snlBoard");
              boardEl.innerHTML = "";

              // Build board visually in the classic boustrophedon (zig-zag) layout,
              // numbered 1 (bottom-left) to 100 (top-left), 10 columns wide
              for (let row = 9; row >= 0; row--) {
                const leftToRight = row % 2 === 0;
                for (let col = 0; col < 10; col++) {
                  const colIndex = leftToRight ? col : 9 - col;
                  const cellNumber = row * 10 + colIndex + 1; // 1-100

                  const cellEl = document.createElement("div");
                  cellEl.className = "snl-cell";
                  if (SNL_LADDERS[cellNumber]) cellEl.classList.add("snl-ladder");
                  if (SNL_SNAKES[cellNumber]) cellEl.classList.add("snl-snake");
                  cellEl.textContent = cellNumber;
                  cellEl.style.gridColumn = col + 1;
                  cellEl.style.gridRow = (10 - row);

                  Object.entries(state.players).forEach(([color, p]) => {
                    if (p.position === cellNumber) {
                      const token = document.createElement("div");
                      token.className = "snl-token";
                      token.style.background = SNL_COLORS[color];
                      cellEl.appendChild(token);
                    }
                  });

                  boardEl.appendChild(cellEl);
                }
              }

              const statusEl = document.getElementById("snlStatus");
              const diceBtn = document.getElementById("snlDiceBtn");

              if (state.winner) {
                statusEl.textContent = state.winner + " wins!";
                diceBtn.disabled = true;
              } else if (mySnlColor === "spectator" || !mySnlColor) {
                statusEl.textContent = "Watching " + state.turn + "'s turn";
                diceBtn.disabled = true;
              } else if (mySnlColor === state.turn) {
                statusEl.textContent = "Your turn (" + mySnlColor + "). Last roll: " + (state.lastRoll || "-");
                diceBtn.disabled = false;
              } else {
                statusEl.textContent = "Waiting for " + state.turn + "...";
                diceBtn.disabled = true;
              }
            }

            function rollSnl() {
              socket.emit("snl-roll", { room });
            }

            function resetSnl() {
              socket.emit("snl-reset", { room });
            }

            socket.on("snl-role", (color) => {
              mySnlColor = color;
            });

            socket.on("snl-state", (state) => {
              renderSnlBoard(state);
            });

            start();
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/chat") {
    const me = parsedUrl.query.me;
    const withBuddy = parsedUrl.query.with;

    const conversation = db
      .prepare(
        "SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY id ASC"
      )
      .all(me, withBuddy, withBuddy, me);

    const messagesHTML = conversation.map((m) => renderMessageHTML(m, me)).join("");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <style>
            body { background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:20px; margin:0; }

            #callArea { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:#000; z-index:999; }
            #bigVideo { width:100%; height:100%; object-fit:cover; background:#111; }
            #smallVideo { position:absolute; width:110px; height:150px; object-fit:cover; top:20px; right:20px; border-radius:10px; border:2px solid white; background:#333; box-shadow:0 2px 8px rgba(0,0,0,0.5); }
            #camOffOverlay { display:none; position:absolute; width:110px; height:150px; top:20px; right:20px; border-radius:10px; background:#222; color:white; font-size:12px; align-items:center; justify-content:center; text-align:center; }
            #callStatus { position:absolute; top:20px; left:20px; color:#ffd966; font-size:15px; background:rgba(0,0,0,0.4); padding:4px 10px; border-radius:6px; }
            #callControls { position:absolute; bottom:30px; left:50%; transform:translateX(-50%); display:flex; gap:14px; }
            .callBtn { border:none; padding:14px 22px; border-radius:30px; font-size:15px; color:white; }
            #hangUpBtn { background:#e33; }
            #muteBtn, #camBtn { background:#444; }
            .callBtn.off { background:#e33; }

            #incomingCall { display:none; background:white; color:black; padding:14px; width:250px; margin:10px auto; border-radius:8px; }

            .msgRow { position:relative; margin-bottom:10px; padding-right:70px; }
            .msgActions { display:inline-block; margin-left:6px; }
            .msgActions button { font-size:11px; padding:2px 6px; margin-left:3px; border:none; border-radius:4px; background:#eee; cursor:pointer; }

            #imageViewer { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); z-index:1000; align-items:center; justify-content:center; }
            #imageViewer img { max-width:92%; max-height:92%; border-radius:6px; }
            #imageViewer .closeViewer { position:absolute; top:20px; right:25px; color:white; font-size:28px; cursor:pointer; }

            #attachBar { display:flex; justify-content:center; gap:6px; margin-top:15px; }
            #fileInput { display:none; }
          </style>
        </head>
        <body>
          <h2>Chat with ${withBuddy}</h2>

          <div>
            <button onclick="startCall()" style="padding:8px 14px; margin:4px;">Call</button>
          </div>

          <div id="callArea">
            <video id="bigVideo" autoplay playsinline></video>
            <video id="smallVideo" autoplay playsinline muted onclick="swapVideos()"></video>
            <div id="camOffOverlay">Camera off</div>
            <p id="callStatus"></p>
            <div id="callControls">
              <button id="muteBtn" class="callBtn" onclick="toggleMute()">Mute</button>
              <button id="camBtn" class="callBtn" onclick="toggleCamera()">Camera Off</button>
              <button id="switchCamBtn" class="callBtn" onclick="switchCamera()">Switch Cam</button>
              <button id="hangUpBtn" class="callBtn" onclick="hangUp(true)">Hang Up</button>
            </div>
          </div>

          <div id="incomingCall">
            <p>Incoming call from <b id="callerName"></b></p>
            <button onclick="answerCall()">Answer</button>
            <button onclick="rejectCall()">Reject</button>
          </div>

          <div id="imageViewer" onclick="closeImageViewer()">
            <span class="closeViewer">&times;</span>
            <img id="viewerImg" src="" onclick="event.stopPropagation()" />
          </div>

          <div id="messages" style="background:white; color:black; width:300px; margin:15px auto; padding:10px; min-height:150px; text-align:left; border-radius:6px; overflow-y:auto; max-height:300px;">
            ${messagesHTML || "<i>No messages yet</i>"}
          </div>

          <div id="attachBar">
            <input id="text" placeholder="Type a message" style="padding:8px; width:130px;" />
            <button onclick="sendMessage()" style="padding:8px 10px;">Send</button>
            <button onclick="document.getElementById('backCameraInput').click()" style="padding:8px 8px;">Back Cam</button>
            <button onclick="document.getElementById('frontCameraInput').click()" style="padding:8px 8px;">Front Cam</button>
            <button onclick="document.getElementById('fileInput').click()" style="padding:8px 8px;">File</button>
            <input type="file" id="backCameraInput" accept="image/*" capture="environment" onchange="sendFile('backCameraInput')" style="display:none;" />
            <input type="file" id="frontCameraInput" accept="image/*" capture="user" onchange="sendFile('frontCameraInput')" style="display:none;" />
            <input type="file" id="fileInput" onchange="sendFile('fileInput')" style="display:none;" />
          </div>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const me = "${me}";
            const withBuddy = "${withBuddy}";
            const room = [me, withBuddy].sort().join("-");
            const socket = io();

            socket.emit("join", { room });

            // ---- Chat messaging ----
            socket.on("chat message", (msg) => {
              addMessageToBox(msg);
            });

            function actionsHTML(id, isText) {
              if (!isText === undefined) isText = true;
              let editBtn = isText ? '<button onclick="editMsg(' + id + ', this)">Edit</button>' : "";
              return '<span class="msgActions">' + editBtn + '<button onclick="deleteMsg(' + id + ')">Delete</button></span>';
            }

            function addMessageToBox(msg) {
              const box = document.getElementById("messages");
              const mine = msg.from === me;
              const actions = mine ? actionsHTML(msg.id, msg.type === "text") : "";
              let html = "";

              if (msg.type === "image") {
                html = '<div class="msgRow" data-id="' + msg.id + '"><b>' + msg.from + ':</b><br/><img src="' + msg.fileData + '" onclick="openImageViewer(this.src)" style="max-width:220px; border-radius:6px; margin-top:4px; cursor:pointer;" />' + actions + '</div>';
              } else if (msg.type === "file") {
                html = '<div class="msgRow" data-id="' + msg.id + '"><b>' + msg.from + ':</b><br/><a href="' + msg.fileData + '" download="' + msg.fileName + '">📎 ' + msg.fileName + '</a>' + actions + '</div>';
              } else {
                html = '<div class="msgRow" data-id="' + msg.id + '"><b>' + msg.from + ':</b> <span class="msgText">' + msg.text + '</span>' + actions + '</div>';
              }
              box.insertAdjacentHTML("beforeend", html);
              box.scrollTop = box.scrollHeight;
            }

            function sendMessage() {
              const textBox = document.getElementById("text");
              const text = textBox.value;
              if (!text) return;
              socket.emit("chat message", { room, from: me, to: withBuddy, type: "text", text });
              textBox.value = "";
            }

            function sendFile(inputId) {
              const input = document.getElementById(inputId);
              const file = input.files[0];
              if (!file) return;

              if (file.size > 3 * 1024 * 1024) {
                alert("Please choose a file under 3MB for now.");
                input.value = "";
                return;
              }

              const reader = new FileReader();
              reader.onload = () => {
                const fileData = reader.result; // base64 data URL
                const type = file.type.startsWith("image/") ? "image" : "file";
                socket.emit("chat message", {
                  room, from: me, to: withBuddy, type,
                  fileName: file.name, fileData
                });
              };
              reader.readAsDataURL(file);
              input.value = "";
            }

            // ---- Edit / Delete messages ----
            function editMsg(id, btn) {
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              const textSpan = row.querySelector(".msgText");
              const currentText = textSpan.textContent;

              const newText = prompt("Edit your message:", currentText);
              if (newText === null || newText.trim() === "" || newText === currentText) return;

              socket.emit("edit-message", { room, id, newText });
            }

            function deleteMsg(id) {
              if (!confirm("Delete this message for both of you?")) return;
              socket.emit("delete-message", { room, id });
            }

            socket.on("message-edited", ({ id, newText }) => {
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              if (row) {
                const textSpan = row.querySelector(".msgText");
                if (textSpan) textSpan.textContent = newText;
              }
            });

            socket.on("message-deleted", ({ id }) => {
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              if (row) row.remove();
            });

            // ---- Full screen image viewer ----
            function openImageViewer(src) {
              document.getElementById("viewerImg").src = src;
              document.getElementById("imageViewer").style.display = "flex";
            }

            function closeImageViewer() {
              document.getElementById("imageViewer").style.display = "none";
            }

            // ---- Video/audio calling ----
            let localStream = null;
            let peerConnection = null;
            let ringtone = null;
            let muted = false;
            let camOff = false;
            let currentFacingMode = "user"; // starts on front camera

            const rtcConfig = {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
              ]
            };

            function playRingtone() {
              stopRingtone();
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              const ctx = new AudioCtx();
              let stopped = false;

              function beep() {
                if (stopped) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = 480;
                osc.connect(gain);
                gain.connect(ctx.destination);
                gain.gain.setValueAtTime(0.15, ctx.currentTime);
                osc.start();
                osc.stop(ctx.currentTime + 0.4);
              }

              beep();
              const interval = setInterval(beep, 1200);
              ringtone = { stop: () => { stopped = true; clearInterval(interval); ctx.close(); } };
            }

            function stopRingtone() {
              if (ringtone) {
                ringtone.stop();
                ringtone = null;
              }
            }

            async function getLocalStream() {
              if (!localStream) {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              }
              return localStream;
            }

            function createPeerConnection() {
              const pc = new RTCPeerConnection(rtcConfig);
              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket.emit("ice-candidate", { room, candidate: event.candidate });
                }
              };
              pc.ontrack = (event) => {
                document.getElementById("bigVideo").srcObject = event.streams[0];
                stopRingtone();
                document.getElementById("callStatus").textContent = "In call with " + withBuddy;
              };
              return pc;
            }

            function showCallScreen() {
              document.getElementById("callArea").style.display = "block";
            }

            async function startCall() {
              showCallScreen();
              document.getElementById("callStatus").textContent = "Calling " + withBuddy + "...";
              playRingtone();

              const stream = await getLocalStream();
              document.getElementById("smallVideo").srcObject = stream;

              peerConnection = createPeerConnection();
              stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

              const offer = await peerConnection.createOffer();
              await peerConnection.setLocalDescription(offer);

              socket.emit("call-user", { room, from: me, offer });
            }

            socket.on("incoming-call", ({ from, offer }) => {
              window.incomingOffer = offer;
              document.getElementById("callerName").textContent = from;
              document.getElementById("incomingCall").style.display = "block";
              playRingtone();
            });

            socket.on("call-busy", () => {
              stopRingtone();
              document.getElementById("callArea").style.display = "none";
              alert(withBuddy + " is already on another call.");
            });

            async function answerCall() {
              stopRingtone();
              document.getElementById("incomingCall").style.display = "none";
              showCallScreen();
              document.getElementById("callStatus").textContent = "In call with " + withBuddy;

              const stream = await getLocalStream();
              document.getElementById("smallVideo").srcObject = stream;

              peerConnection = createPeerConnection();
              stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

              await peerConnection.setRemoteDescription(window.incomingOffer);
              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);

              socket.emit("make-answer", { room, answer });
            }

            function rejectCall() {
              stopRingtone();
              document.getElementById("incomingCall").style.display = "none";
              socket.emit("call-rejected", { room });
            }

            socket.on("call-rejected", () => {
              stopRingtone();
              document.getElementById("callArea").style.display = "none";
              alert(withBuddy + " declined the call.");
            });

            socket.on("call-answered", async ({ answer }) => {
              stopRingtone();
              document.getElementById("callStatus").textContent = "In call with " + withBuddy;
              await peerConnection.setRemoteDescription(answer);
            });

            socket.on("ice-candidate-received", async ({ candidate }) => {
              if (peerConnection) {
                try { await peerConnection.addIceCandidate(candidate); } catch (err) {}
              }
            });

            function swapVideos() {
              const big = document.getElementById("bigVideo");
              const small = document.getElementById("smallVideo");
              const bigStream = big.srcObject;
              const smallStream = small.srcObject;
              big.srcObject = smallStream;
              small.srcObject = bigStream;
            }

            function toggleMute() {
              if (!localStream) return;
              muted = !muted;
              localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
              document.getElementById("muteBtn").textContent = muted ? "Unmute" : "Mute";
              document.getElementById("muteBtn").classList.toggle("off", muted);
            }

            function toggleCamera() {
              if (!localStream) return;
              camOff = !camOff;
              localStream.getVideoTracks().forEach((t) => (t.enabled = !camOff));
              document.getElementById("camBtn").textContent = camOff ? "Camera On" : "Camera Off";
              document.getElementById("camBtn").classList.toggle("off", camOff);
              document.getElementById("camOffOverlay").style.display = camOff ? "flex" : "none";
            }

            async function switchCamera() {
              if (!localStream) return;
              currentFacingMode = currentFacingMode === "user" ? "environment" : "user";

              // Stop and release the old camera FIRST, before asking for the new one
              const oldVideoTrack = localStream.getVideoTracks()[0];
              if (oldVideoTrack) {
                oldVideoTrack.stop();
                localStream.removeTrack(oldVideoTrack);
              }

              try {
                const newVideoStream = await navigator.mediaDevices.getUserMedia({
                  video: { facingMode: currentFacingMode }
                });
                const newVideoTrack = newVideoStream.getVideoTracks()[0];
                localStream.addTrack(newVideoTrack);

                if (peerConnection) {
                  const videoSender = peerConnection.getSenders().find(
                    (s) => s.track && s.track.kind === "video"
                  );
                  if (videoSender) await videoSender.replaceTrack(newVideoTrack);
                }

                document.getElementById("smallVideo").srcObject = null;
                document.getElementById("smallVideo").srcObject = localStream;
              } catch (err) {
                alert("Could not switch camera: " + err.message);
                currentFacingMode = currentFacingMode === "user" ? "environment" : "user"; // revert
              }
            }

            function hangUp(notifyOther) {
              stopRingtone();
              if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
              }
              if (localStream) {
                localStream.getTracks().forEach((t) => t.stop());
                localStream = null;
              }
              document.getElementById("callArea").style.display = "none";
              document.getElementById("bigVideo").srcObject = null;
              document.getElementById("smallVideo").srcObject = null;
              document.getElementById("incomingCall").style.display = "none";
              muted = false;
              camOff = false;
              document.getElementById("muteBtn").textContent = "Mute";
              document.getElementById("camBtn").textContent = "Camera Off";
              if (notifyOther) {
                socket.emit("hang-up", { room });
              }
            }

            socket.on("hang-up", () => {
              hangUp(false);
            });
          </script>
        </body>
      </html>
    `);

  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Page not found");
  }
});

const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024 // allow larger messages for file sharing
});

const ringingRooms = new Set();
const activeCallRooms = new Set();
const groupRoomMembers = {}; // room -> { socketId: name }
const ticTacToeGames = {}; // room -> { board, turn, winner, players }
const ludoGames = {}; // room -> { players: {color: {socketId, position}}, turnOrder: [], turnIndex, winner, lastRoll }
const LUDO_PATH_LENGTH = 30;
const LUDO_COLOR_ORDER = ["red", "blue", "green", "yellow"];

const snlGames = {}; // room -> { players: {color: {socketId, position}}, turnOrder: [], turnIndex, winner, lastRoll }
const SNL_LADDERS = { 4: 14, 9: 31, 20: 38, 28: 84, 40: 59, 51: 67, 63: 81, 71: 91 };
const SNL_SNAKES = { 17: 7, 54: 34, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 99: 78 };

function emitSnlState(room) {
  const game = snlGames[room];
  if (!game) return;
  game.turn = game.turnOrder[game.turnIndex] || null;
  io.to("snl-" + room).emit("snl-state", game);
}

function emitLudoState(room) {
  const game = ludoGames[room];
  if (!game) return;
  game.turn = game.turnOrder[game.turnIndex] || null;
  io.to("ludo-" + room).emit("ludo-state", game);
}

io.on("connection", (socket) => {
  socket.on("join", ({ room }) => {
    socket.join(room);
  });

  // ---- Group call signaling ----
  socket.on("join-group", ({ room, name }) => {
    socket.join("group-" + room);
    socket.data.groupRoom = room;
    socket.data.name = name;

    if (!groupRoomMembers[room]) groupRoomMembers[room] = {};

    // Tell the new person who is already here
    const existingPeers = Object.entries(groupRoomMembers[room]).map(([id, n]) => ({ id, name: n }));
    socket.emit("existing-peers", existingPeers);

    // Add them to the room, then tell everyone else
    groupRoomMembers[room][socket.id] = name;
    socket.to("group-" + room).emit("new-peer", { id: socket.id, name });
  });

  socket.on("group-offer", ({ to, from, offer, name }) => {
    io.to(to).emit("group-offer", { from, offer, name });
  });

  socket.on("group-answer", ({ to, from, answer }) => {
    io.to(to).emit("group-answer", { from, answer });
  });

  socket.on("group-ice-candidate", ({ to, from, candidate }) => {
    io.to(to).emit("group-ice-candidate", { from, candidate });
  });

  // ---- Tic-Tac-Toe ----
  socket.on("game-join", ({ room }) => {
    socket.join("game-" + room);
    socket.data.gameRoom = room;

    if (!ticTacToeGames[room]) {
      ticTacToeGames[room] = { board: Array(9).fill(null), turn: "X", winner: null, players: {} };
    }
    const game = ticTacToeGames[room];

    let role = "spectator";
    if (!game.players.X) {
      game.players.X = socket.id;
      role = "X";
    } else if (!game.players.O && game.players.X !== socket.id) {
      game.players.O = socket.id;
      role = "O";
    } else if (game.players.X === socket.id) {
      role = "X";
    } else if (game.players.O === socket.id) {
      role = "O";
    }

    socket.emit("game-role", role);
    io.to("game-" + room).emit("game-state", game);
  });

  function checkWinner(board) {
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6]
    ];
    for (const [a,b,c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    if (board.every((cell) => cell)) return "draw";
    return null;
  }

  socket.on("game-move", ({ room, index }) => {
    const game = ticTacToeGames[room];
    if (!game || game.winner) return;

    const role = game.players.X === socket.id ? "X" : (game.players.O === socket.id ? "O" : null);
    if (!role || role !== game.turn || game.board[index]) return;

    game.board[index] = role;
    game.winner = checkWinner(game.board);
    game.turn = role === "X" ? "O" : "X";

    io.to("game-" + room).emit("game-state", game);
  });

  socket.on("game-reset", ({ room }) => {
    const game = ticTacToeGames[room];
    if (!game) return;
    game.board = Array(9).fill(null);
    game.winner = null;
    game.turn = "X";
    io.to("game-" + room).emit("game-state", game);
  });

  // ---- Ludo (race) ----
  socket.on("ludo-join", ({ room }) => {
    socket.join("ludo-" + room);
    socket.data.ludoRoom = room;

    if (!ludoGames[room]) {
      ludoGames[room] = { players: {}, turnOrder: [], turnIndex: 0, winner: null, lastRoll: null };
    }
    const game = ludoGames[room];

    // Reconnecting player who already has a color
    let myColor = Object.keys(game.players).find((c) => game.players[c].socketId === socket.id);

    if (!myColor && game.turnOrder.length < LUDO_COLOR_ORDER.length) {
      myColor = LUDO_COLOR_ORDER[game.turnOrder.length];
      game.players[myColor] = { socketId: socket.id, position: 0 };
      game.turnOrder.push(myColor);
    }

    socket.emit("ludo-role", myColor || "spectator");
    emitLudoState(room);
  });

  socket.on("ludo-roll", ({ room }) => {
    const game = ludoGames[room];
    if (!game || game.winner) return;

    const currentColor = game.turnOrder[game.turnIndex];
    const player = game.players[currentColor];
    if (!player || player.socketId !== socket.id) return;

    const roll = Math.floor(Math.random() * 6) + 1;
    game.lastRoll = roll;
    player.position = Math.min(player.position + roll, LUDO_PATH_LENGTH - 1);

    if (player.position === LUDO_PATH_LENGTH - 1) {
      game.winner = currentColor;
    } else {
      game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
    }

    emitLudoState(room);
  });

  socket.on("ludo-reset", ({ room }) => {
    const game = ludoGames[room];
    if (!game) return;
    Object.values(game.players).forEach((p) => (p.position = 0));
    game.winner = null;
    game.turnIndex = 0;
    game.lastRoll = null;
    emitLudoState(room);
  });

  // ---- Snakes & Ladders ----
  socket.on("snl-join", ({ room }) => {
    socket.join("snl-" + room);
    socket.data.snlRoom = room;

    if (!snlGames[room]) {
      snlGames[room] = { players: {}, turnOrder: [], turnIndex: 0, winner: null, lastRoll: null };
    }
    const game = snlGames[room];

    let myColor = Object.keys(game.players).find((c) => game.players[c].socketId === socket.id);

    if (!myColor && game.turnOrder.length < LUDO_COLOR_ORDER.length) {
      myColor = LUDO_COLOR_ORDER[game.turnOrder.length];
      game.players[myColor] = { socketId: socket.id, position: 1 };
      game.turnOrder.push(myColor);
    }

    socket.emit("snl-role", myColor || "spectator");
    emitSnlState(room);
  });

  socket.on("snl-roll", ({ room }) => {
    const game = snlGames[room];
    if (!game || game.winner) return;

    const currentColor = game.turnOrder[game.turnIndex];
    const player = game.players[currentColor];
    if (!player || player.socketId !== socket.id) return;

    const roll = Math.floor(Math.random() * 6) + 1;
    game.lastRoll = roll;

    let newPos = player.position + roll;
    if (newPos > 100) newPos = player.position; // must land exactly on 100
    if (SNL_LADDERS[newPos]) newPos = SNL_LADDERS[newPos];
    else if (SNL_SNAKES[newPos]) newPos = SNL_SNAKES[newPos];

    player.position = newPos;

    if (player.position === 100) {
      game.winner = currentColor;
    } else {
      game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
    }

    emitSnlState(room);
  });

  socket.on("snl-reset", ({ room }) => {
    const game = snlGames[room];
    if (!game) return;
    Object.values(game.players).forEach((p) => (p.position = 1));
    game.winner = null;
    game.turnIndex = 0;
    game.lastRoll = null;
    emitSnlState(room);
  });

  socket.on("disconnect", () => {
    const room = socket.data.groupRoom;
    if (room && groupRoomMembers[room]) {
      delete groupRoomMembers[room][socket.id];
      socket.to("group-" + room).emit("peer-left", { id: socket.id });
    }

    const gameRoom = socket.data.gameRoom;
    if (gameRoom && ticTacToeGames[gameRoom]) {
      const game = ticTacToeGames[gameRoom];
      if (game.players.X === socket.id) delete game.players.X;
      if (game.players.O === socket.id) delete game.players.O;
      io.to("game-" + gameRoom).emit("game-state", game);
    }

    const ludoRoom = socket.data.ludoRoom;
    if (ludoRoom && ludoGames[ludoRoom]) {
      const game = ludoGames[ludoRoom];
      const color = Object.keys(game.players).find((c) => game.players[c].socketId === socket.id);
      if (color) {
        delete game.players[color];
        game.turnOrder = game.turnOrder.filter((c) => c !== color);
        if (game.turnIndex >= game.turnOrder.length) game.turnIndex = 0;
        io.to("ludo-" + ludoRoom).emit("ludo-state", game);
      }
    }

    const snlRoom = socket.data.snlRoom;
    if (snlRoom && snlGames[snlRoom]) {
      const game = snlGames[snlRoom];
      const color = Object.keys(game.players).find((c) => game.players[c].socketId === socket.id);
      if (color) {
        delete game.players[color];
        game.turnOrder = game.turnOrder.filter((c) => c !== color);
        if (game.turnIndex >= game.turnOrder.length) game.turnIndex = 0;
        emitSnlState(snlRoom);
      }
    }
  });

  socket.on("chat message", (msg) => {
    const result = db.prepare(
      "INSERT INTO messages (from_user, to_user, text, type, file_name, file_data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      msg.from,
      msg.to,
      msg.text || null,
      msg.type || "text",
      msg.fileName || null,
      msg.fileData || null
    );
    msg.id = result.lastInsertRowid;
    io.to(msg.room).emit("chat message", msg);
  });

  socket.on("edit-message", ({ room, id, newText }) => {
    db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(newText, id);
    io.to(room).emit("message-edited", { id, newText });
  });

  socket.on("delete-message", ({ room, id }) => {
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    io.to(room).emit("message-deleted", { id });
  });

  // ---- Call signaling ----
  socket.on("call-user", ({ room, from, offer }) => {
    if (ringingRooms.has(room) || activeCallRooms.has(room)) {
      socket.emit("call-busy");
      return;
    }
    ringingRooms.add(room);
    socket.to(room).emit("incoming-call", { from, offer });
  });

  socket.on("make-answer", ({ room, answer }) => {
    ringingRooms.delete(room);
    activeCallRooms.add(room);
    socket.to(room).emit("call-answered", { answer });
  });

  socket.on("call-rejected", ({ room }) => {
    ringingRooms.delete(room);
    socket.to(room).emit("call-rejected");
  });

  socket.on("ice-candidate", ({ room, candidate }) => {
    socket.to(room).emit("ice-candidate-received", { candidate });
  });

  socket.on("hang-up", ({ room }) => {
    ringingRooms.delete(room);
    activeCallRooms.delete(room);
    socket.to(room).emit("hang-up");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});