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

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
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

    res.writeHead(200, { "Content-Type": "text/html" });
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

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:60px;">
          <h2>Camera & Mic Test</h2>
          <p>This checks that your browser can access your camera and microphone.</p>

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
                const video = document.getElementById("preview");
                video.srcObject = stream;
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

    const messagesHTML = conversation
      .map((m) => `<p><b>${m.from_user}:</b> ${m.text}</p>`)
      .join("");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:40px;">
          <h2>Chat with ${withBuddy}</h2>

          <div>
            <button onclick="startCall()" style="padding:8px 14px; margin:4px;">Call</button>
            <button onclick="hangUp()" style="padding:8px 14px; margin:4px;">Hang Up</button>
          </div>

          <div id="callArea" style="display:none; margin-top:10px;">
            <video id="localVideo" autoplay playsinline muted style="width:140px; height:105px; background:black; border-radius:6px;"></video>
            <video id="remoteVideo" autoplay playsinline style="width:140px; height:105px; background:black; border-radius:6px;"></video>
            <p id="callStatus" style="color:#ffd966;"></p>
          </div>

          <div id="incomingCall" style="display:none; background:white; color:black; padding:10px; width:250px; margin:10px auto; border-radius:6px;">
            <p>Incoming call from <b id="callerName"></b></p>
            <button onclick="answerCall()">Answer</button>
            <button onclick="rejectCall()">Reject</button>
          </div>

          <div id="messages" style="background:white; color:black; width:300px; margin:15px auto; padding:10px; min-height:150px; text-align:left; border-radius:6px;">
            ${messagesHTML || "<i>No messages yet</i>"}
          </div>
          <div style="margin-top:15px;">
            <input id="text" placeholder="Type a message" style="padding:8px; width:200px;" />
            <button onclick="sendMessage()" style="padding:8px 12px;">Send</button>
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
              const box = document.getElementById("messages");
              box.innerHTML += "<p><b>" + msg.from + ":</b> " + msg.text + "</p>";
              box.scrollTop = box.scrollHeight;
            });

            function sendMessage() {
              const textBox = document.getElementById("text");
              const text = textBox.value;
              if (!text) return;
              socket.emit("chat message", { room, from: me, to: withBuddy, text });
              textBox.value = "";
            }

            // ---- Video/audio calling ----
            let localStream = null;
            let peerConnection = null;

            const rtcConfig = {
              iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
            };

            async function getLocalStream() {
              if (!localStream) {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                document.getElementById("localVideo").srcObject = localStream;
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
                document.getElementById("remoteVideo").srcObject = event.streams[0];
              };

              return pc;
            }

            async function startCall() {
              document.getElementById("callArea").style.display = "block";
              document.getElementById("callStatus").textContent = "Calling " + withBuddy + "...";

              const stream = await getLocalStream();
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
            });

            async function answerCall() {
              document.getElementById("incomingCall").style.display = "none";
              document.getElementById("callArea").style.display = "block";
              document.getElementById("callStatus").textContent = "In call with " + withBuddy;

              const stream = await getLocalStream();
              peerConnection = createPeerConnection();
              stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

              await peerConnection.setRemoteDescription(window.incomingOffer);
              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);

              socket.emit("make-answer", { room, answer });
            }

            function rejectCall() {
              document.getElementById("incomingCall").style.display = "none";
            }

            socket.on("call-answered", async ({ answer }) => {
              document.getElementById("callStatus").textContent = "In call with " + withBuddy;
              await peerConnection.setRemoteDescription(answer);
            });

            socket.on("ice-candidate-received", async ({ candidate }) => {
              if (peerConnection) {
                try {
                  await peerConnection.addIceCandidate(candidate);
                } catch (err) {
                  console.log("Error adding ICE candidate", err);
                }
              }
            });

            function hangUp() {
              if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
              }
              document.getElementById("callArea").style.display = "none";
              document.getElementById("remoteVideo").srcObject = null;
            }
          </script>
        </body>
      </html>
    `);

  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Page not found");
  }
});

const io = new Server(server);

io.on("connection", (socket) => {
  socket.on("join", ({ room }) => {
    socket.join(room);
  });

  socket.on("chat message", (msg) => {
    db.prepare("INSERT INTO messages (from_user, to_user, text) VALUES (?, ?, ?)").run(
      msg.from,
      msg.to,
      msg.text
    );
    io.to(msg.room).emit("chat message", msg);
  });

  // ---- Call signaling ----
  socket.on("call-user", ({ room, from, offer }) => {
    socket.to(room).emit("incoming-call", { from, offer });
  });

  socket.on("make-answer", ({ room, answer }) => {
    socket.to(room).emit("call-answered", { answer });
  });

  socket.on("ice-candidate", ({ room, candidate }) => {
    socket.to(room).emit("ice-candidate-received", { candidate });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});