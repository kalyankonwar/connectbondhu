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

function renderMessageHTML(m) {
  if (m.type === "image") {
    return `<p><b>${m.from_user}:</b><br/><img src="${m.file_data}" style="max-width:220px; border-radius:6px; margin-top:4px;" /></p>`;
  } else if (m.type === "file") {
    return `<p><b>${m.from_user}:</b><br/><a href="${m.file_data}" download="${m.file_name}">📎 ${m.file_name}</a></p>`;
  } else {
    return `<p><b>${m.from_user}:</b> ${m.text}</p>`;
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
          <h1>ConnectBondhu Messenger</h1>
          <input id="nameBox" placeholder="Enter your name" style="padding:8px; font-size:16px;" />
          <button onclick="signIn()" style="padding:8px 16px; font-size:16px;">Sign In</button>
          <script>
            function signIn() {
              const name = document.getElementById("nameBox").value;
              window.location.href = "/welcome?name=" + name;
            }
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
      .map((u) => `<li><a style="color:#ffd966;" href="/chat?me=${name}&with=${u.name}">${u.name}</a></li>`)
      .join("");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:80px;">
          <h1>Welcome, ${name}!</h1>
          <p><a style="color:#ffd966;" href="/camera-test?name=${name}">Test my camera & mic</a></p>
          <h3>Signed-in Buddies</h3>
          <ul style="list-style:none; padding:0;">
            ${buddyListHTML || "<li>No one else is signed in yet</li>"}
          </ul>
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

  } else if (parsedUrl.pathname === "/chat") {
    const me = parsedUrl.query.me;
    const withBuddy = parsedUrl.query.with;

    const conversation = db
      .prepare(
        "SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY id ASC"
      )
      .all(me, withBuddy, withBuddy, me);

    const messagesHTML = conversation.map(renderMessageHTML).join("");

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
              <button id="hangUpBtn" class="callBtn" onclick="hangUp(true)">Hang Up</button>
            </div>
          </div>

          <div id="incomingCall">
            <p>Incoming call from <b id="callerName"></b></p>
            <button onclick="answerCall()">Answer</button>
            <button onclick="rejectCall()">Reject</button>
          </div>

          <div id="messages" style="background:white; color:black; width:300px; margin:15px auto; padding:10px; min-height:150px; text-align:left; border-radius:6px; overflow-y:auto; max-height:300px;">
            ${messagesHTML || "<i>No messages yet</i>"}
          </div>

          <div id="attachBar">
            <input id="text" placeholder="Type a message" style="padding:8px; width:170px;" />
            <button onclick="sendMessage()" style="padding:8px 12px;">Send</button>
            <button onclick="document.getElementById('fileInput').click()" style="padding:8px 12px;">📎</button>
            <input type="file" id="fileInput" onchange="sendFile()" />
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

            function addMessageToBox(msg) {
              const box = document.getElementById("messages");
              let html = "";
              if (msg.type === "image") {
                html = "<p><b>" + msg.from + ":</b><br/><img src=\\"" + msg.fileData + "\\" style=\\"max-width:220px; border-radius:6px; margin-top:4px;\\" /></p>";
              } else if (msg.type === "file") {
                html = "<p><b>" + msg.from + ":</b><br/><a href=\\"" + msg.fileData + "\\" download=\\"" + msg.fileName + "\\">\uD83D\uDCCE " + msg.fileName + "</a></p>";
              } else {
                html = "<p><b>" + msg.from + ":</b> " + msg.text + "</p>";
              }
              box.innerHTML += html;
              box.scrollTop = box.scrollHeight;
            }

            function sendMessage() {
              const textBox = document.getElementById("text");
              const text = textBox.value;
              if (!text) return;
              socket.emit("chat message", { room, from: me, to: withBuddy, type: "text", text });
              textBox.value = "";
            }

            function sendFile() {
              const input = document.getElementById("fileInput");
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

            // ---- Video/audio calling ----
            let localStream = null;
            let peerConnection = null;
            let ringtone = null;
            let muted = false;
            let camOff = false;

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

io.on("connection", (socket) => {
  socket.on("join", ({ room }) => {
    socket.join(room);
  });

  socket.on("chat message", (msg) => {
    db.prepare(
      "INSERT INTO messages (from_user, to_user, text, type, file_name, file_data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      msg.from,
      msg.to,
      msg.text || null,
      msg.type || "text",
      msg.fileName || null,
      msg.fileData || null
    );
    io.to(msg.room).emit("chat message", msg);
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