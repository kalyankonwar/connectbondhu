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
try { db.exec("ALTER TABLE users ADD COLUMN gender TEXT"); } catch (e) {}

function genderBadge(gender) {
  if (gender === "Male") return '<span style="color:#5aa9ff;">♂</span>';
  if (gender === "Female") return '<span style="color:#ff8fc7;">♀</span>';
  if (gender === "Other") return '<span style="color:#c58fff;">⚧</span>';
  return "";
}

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT UNIQUE,
    display_name TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_name TEXT,
    blocked_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_name, blocked_name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter TEXT,
    reported TEXT,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

function isBlockedEitherWay(userA, userB) {
  const row = db
    .prepare(
      "SELECT 1 FROM blocks WHERE (blocker_name = ? AND blocked_name = ?) OR (blocker_name = ? AND blocked_name = ?)"
    )
    .get(userA, userB, userB, userA);
  return !!row;
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy(); // 2MB safety limit
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function callClaude(messages, system) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      system: system || undefined,
      messages
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "AI request failed");
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "Sorry, I couldn't generate a response.";
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // ---- AI API endpoints ----
  if (req.method === "POST" && parsedUrl.pathname === "/api/ai-chat") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const history = body.history || []; // [{role: "user"/"assistant", content: "..."}]

      const reply = await callClaude(
        history,
        "You are a friendly, helpful assistant inside a messenger app called ConnectBondhu. Keep replies conversational and reasonably concise."
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/ai-astrology") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { zodiacSign, question } = body;

      const reply = await callClaude(
        [{ role: "user", content: question || "Give me today's horoscope." }],
        `You are a warm, insightful astrology guide inside a messenger app. The user's zodiac sign is ${zodiacSign}. Give a short, positive, well-written horoscope-style reading (3-5 sentences) relevant to their sign and question. Keep it light and fun, not overly mystical or preachy.`
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/report") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { reporter, reported, reason } = body;
      if (!reporter || !reported) throw new Error("Missing required fields");

      db.prepare("INSERT INTO reports (reporter, reported, reason) VALUES (?, ?, ?)").run(
        reporter,
        reported,
        (reason || "").slice(0, 500)
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsedUrl.pathname === "/block-user") {
    const blocker = parsedUrl.query.blocker;
    const blocked = parsedUrl.query.blocked;

    if (blocker && blocked) {
      try {
        db.prepare("INSERT OR IGNORE INTO blocks (blocker_name, blocked_name) VALUES (?, ?)").run(
          blocker,
          blocked
        );
      } catch (e) {}
    }

    res.writeHead(302, { Location: `/welcome?name=${encodeURIComponent(blocker || "")}` });
    res.end();
    return;
  }

  if (parsedUrl.pathname === "/unblock-user") {
    const blocker = parsedUrl.query.blocker;
    const blocked = parsedUrl.query.blocked;

    if (blocker && blocked) {
      db.prepare("DELETE FROM blocks WHERE blocker_name = ? AND blocked_name = ?").run(blocker, blocked);
    }

    res.writeHead(302, { Location: `/blocked-users?me=${encodeURIComponent(blocker || "")}` });
    res.end();
    return;
  }

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
            <select id="genderBox" class="nameInput">
              <option value="">Gender (optional)</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
            <button class="signInBtn" onclick="signIn()">Sign In</button>

            <div class="featureRow">
              <span class="featurePill">📹 Video Calls</span>
              <span class="featurePill">🎮 Games</span>
              <span class="featurePill">🤖 AI Chat</span>
              <span class="featurePill">🔮 AI Astrology</span>
            </div>

            <p style="margin-top:22px; font-size:11.5px;"><a href="/privacy-policy" style="color:rgba(255,255,255,0.5); text-decoration:underline;">Privacy Policy</a></p>
          </div>

          <script>
            function signIn() {
              const name = document.getElementById("nameBox").value.trim();
              const gender = document.getElementById("genderBox").value;
              if (!name) return;
              window.location.href = "/welcome?name=" + encodeURIComponent(name) + "&gender=" + encodeURIComponent(gender);
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
    const gender = parsedUrl.query.gender || "";

    if (name) {
      db.prepare("INSERT INTO users (name, gender) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET gender = excluded.gender").run(name, gender || null);
    }

    const allUsers = db.prepare("SELECT name, gender FROM users").all();
    const buddyListHTML = allUsers
      .filter((u) => u.name !== name && !isBlockedEitherWay(name, u.name))
      .map(
        (u) => `
        <a class="buddyRow" data-name="${u.name}" href="/chat?me=${name}&with=${u.name}">
          <span class="buddyAvatar">${u.name.charAt(0).toUpperCase()}</span>
          <span class="buddyName">${u.name} ${genderBadge(u.gender)}</span>
          <span class="unreadDot" style="display:none;"></span>
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
          <div class="header" style="position:relative;">
            <a href="/welcome?name=${name}" style="position:absolute; top:16px; right:16px; color:#ffd966; font-size:20px; text-decoration:none;" title="Refresh">⟳</a>
            <h1>Welcome, ${name}!</h1>
            <p>What would you like to do?</p>
          </div>

          <div class="section">
            <p class="sectionTitle">Quick Access</p>
            <div class="featureGrid">
              <a class="featureCard" href="/camera-test?name=${name}">
                <span class="icon">🎥</span><span class="label">Test Camera & Mic</span>
              </a>
              <a class="featureCard" href="/rooms?me=${name}&gender=${gender}">
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

          <div class="section">
            <p class="sectionTitle">Safety & Privacy</p>
            <div class="buddyList">
              <a class="buddyRow" href="/blocked-users?me=${name}">
                <span class="buddyAvatar" style="background:#e33; color:white;">🚫</span>
                <span class="buddyName">Blocked Users</span>
              </a>
              <a class="buddyRow" href="/privacy-policy">
                <span class="buddyAvatar" style="background:#444; color:white;">📄</span>
                <span class="buddyName">Privacy Policy</span>
              </a>
            </div>
          </div>

          <div id="incomingCallBanner" style="display:none; position:fixed; top:16px; left:16px; right:16px; background:white; color:black; border-radius:14px; padding:14px; box-shadow:0 8px 24px rgba(0,0,0,0.4); z-index:999; text-align:center;">
            <p id="incomingCallBannerText" style="margin:0 0 10px; font-weight:600;"></p>
            <button onclick="answerFromBanner()" style="padding:9px 18px; margin-right:8px; border:none; border-radius:18px; background:#4ade80; font-weight:700; cursor:pointer;">Answer</button>
            <button onclick="declineFromBanner()" style="padding:9px 18px; border:none; border-radius:18px; background:#e33; color:white; font-weight:700; cursor:pointer;">Decline</button>
          </div>

          <style>
            .unreadDot {
              width:9px; height:9px; border-radius:50%; background:#e33;
              display:inline-block; margin-left:4px;
            }
            @keyframes buzzShake {
              0%, 100% { transform: translateX(0); }
              10%, 30%, 50%, 70%, 90% { transform: translateX(-8px); }
              20%, 40%, 60%, 80% { transform: translateX(8px); }
            }
            body.buzzing { animation: buzzShake 0.5s; }
          </style>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const myName = "${name}";
            const socket = io();
            socket.emit("register-user", { name: myName });

            if ("Notification" in window && Notification.permission === "default") {
              Notification.requestPermission();
            }

            function playNotifySound() {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              const ctx = new AudioCtx();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.frequency.value = 700;
              osc.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.1, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.15);
              setTimeout(() => ctx.close(), 300);
            }

            socket.on("message-notification", ({ from, preview }) => {
              playNotifySound();
              if (navigator.vibrate) navigator.vibrate(150);

              const row = document.querySelector('.buddyRow[data-name="' + from + '"]');
              if (row) {
                const dot = row.querySelector(".unreadDot");
                if (dot) dot.style.display = "inline-block";
              }

              if ("Notification" in window && Notification.permission === "granted") {
                const n = new Notification(from + " sent a message", { body: preview });
                n.onclick = () => { window.location.href = "/chat?me=" + encodeURIComponent(myName) + "&with=" + encodeURIComponent(from); };
              }
            });

            let currentIncomingCall = null;

            socket.on("incoming-call-request", ({ from, mode }) => {
              currentIncomingCall = { from, mode };
              playNotifySound();
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
              document.body.classList.remove("buzzing");
              void document.body.offsetWidth;
              document.body.classList.add("buzzing");

              document.getElementById("incomingCallBannerText").textContent =
                (mode === "audio" ? "📞 " : "📹 ") + from + " is calling you";
              document.getElementById("incomingCallBanner").style.display = "block";

              if ("Notification" in window && Notification.permission === "granted") {
                const n = new Notification((mode === "audio" ? "📞 " : "📹 ") + from + " is calling you", { body: "Tap to answer" });
                n.onclick = () => answerFromBanner();
              }
            });

            function answerFromBanner() {
              if (!currentIncomingCall) return;
              window.location.href = "/chat?me=" + encodeURIComponent(myName) + "&with=" + encodeURIComponent(currentIncomingCall.from) + "&autoAnswer=1";
            }

            function declineFromBanner() {
              document.getElementById("incomingCallBanner").style.display = "none";
              currentIncomingCall = null;
            }

            socket.on("buzz", () => {
              playNotifySound();
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
              document.body.classList.remove("buzzing");
              void document.body.offsetWidth;
              document.body.classList.add("buzzing");
            });
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/ai-chat") {
    const name = parsedUrl.query.name || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              margin:0; min-height:100vh;
              background:linear-gradient(160deg,#3d0f6e,#9333ea);
              color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif;
              display:flex; flex-direction:column;
            }
            .topBar { padding:16px; text-align:center; }
            .topBar a { color:#ffd966; font-size:13px; text-decoration:none; }
            #chatLog {
              flex:1; overflow-y:auto; padding:14px;
              max-width:480px; width:100%; margin:0 auto;
            }
            .bubble { max-width:80%; padding:10px 14px; border-radius:14px; margin-bottom:10px; font-size:14.5px; line-height:1.4; }
            .userBubble { background:#ffd966; color:#3d0f6e; margin-left:auto; border-bottom-right-radius:4px; }
            .aiBubble { background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.15); margin-right:auto; border-bottom-left-radius:4px; }
            .inputBar { display:flex; gap:8px; padding:14px; max-width:480px; width:100%; margin:0 auto; }
            #chatInput { flex:1; padding:12px 14px; border-radius:20px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08); color:white; font-size:14.5px; outline:none; }
            #chatInput::placeholder { color:rgba(255,255,255,0.5); }
            #sendBtn { padding:12px 18px; border:none; border-radius:20px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer; }
            .thinking { color:rgba(255,255,255,0.6); font-size:13px; text-align:left; margin-bottom:10px; }
          </style>
        </head>
        <body>
          <div class="topBar"><a href="/welcome?name=${name}">&larr; Back to Welcome</a></div>
          <div id="chatLog">
            <div class="bubble aiBubble">Hi ${name}! I'm your AI assistant. Ask me anything.</div>
          </div>
          <div class="inputBar">
            <input id="chatInput" placeholder="Type a message..." />
            <button id="sendBtn" onclick="sendChat()">Send</button>
          </div>

          <script>
            const history = [];

            function addBubble(text, who) {
              const log = document.getElementById("chatLog");
              const div = document.createElement("div");
              div.className = "bubble " + (who === "user" ? "userBubble" : "aiBubble");
              div.textContent = text;
              log.appendChild(div);
              log.scrollTop = log.scrollHeight;
              return div;
            }

            async function sendChat() {
              const input = document.getElementById("chatInput");
              const text = input.value.trim();
              if (!text) return;
              input.value = "";

              addBubble(text, "user");
              history.push({ role: "user", content: text });

              const log = document.getElementById("chatLog");
              const thinkingEl = document.createElement("div");
              thinkingEl.className = "thinking";
              thinkingEl.textContent = "AI is thinking...";
              log.appendChild(thinkingEl);
              log.scrollTop = log.scrollHeight;

              try {
                const res = await fetch("/api/ai-chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ history })
                });
                const data = await res.json();
                thinkingEl.remove();

                if (data.error) {
                  addBubble("Error: " + data.error, "ai");
                } else {
                  addBubble(data.reply, "ai");
                  history.push({ role: "assistant", content: data.reply });
                }
              } catch (err) {
                thinkingEl.remove();
                addBubble("Something went wrong. Please try again.", "ai");
              }
            }

            document.getElementById("chatInput").addEventListener("keydown", (e) => {
              if (e.key === "Enter") sendChat();
            });
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/ai-astrology") {
    const name = parsedUrl.query.name || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              margin:0; min-height:100vh;
              background:linear-gradient(160deg,#3d0f6e,#9333ea);
              color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif;
              padding:20px; text-align:center;
            }
            .card { max-width:420px; margin:0 auto; }
            a.backLink { color:#ffd966; font-size:13px; text-decoration:none; display:block; margin-bottom:20px; }
            select, input {
              width:100%; padding:12px; border-radius:12px; margin-bottom:12px;
              border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08); color:white; font-size:14.5px;
            }
            button {
              width:100%; padding:13px; border:none; border-radius:12px;
              background:linear-gradient(135deg, #ffd966, #ff9d3d); color:#3d0f6e; font-weight:700; font-size:15px; cursor:pointer;
            }
            #reading {
              margin-top:20px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15);
              border-radius:14px; padding:16px; text-align:left; font-size:14.5px; line-height:1.5; display:none;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <a class="backLink" href="/welcome?name=${name}">&larr; Back to Welcome</a>
            <h1>🔮 AI Astrology</h1>
            <p style="color:rgba(255,255,255,0.7); font-size:13px;">Get a personalized reading powered by AI</p>

            <select id="zodiacSign">
              <option value="Aries">Aries (Mar 21 - Apr 19)</option>
              <option value="Taurus">Taurus (Apr 20 - May 20)</option>
              <option value="Gemini">Gemini (May 21 - Jun 20)</option>
              <option value="Cancer">Cancer (Jun 21 - Jul 22)</option>
              <option value="Leo">Leo (Jul 23 - Aug 22)</option>
              <option value="Virgo">Virgo (Aug 23 - Sep 22)</option>
              <option value="Libra">Libra (Sep 23 - Oct 22)</option>
              <option value="Scorpio">Scorpio (Oct 23 - Nov 21)</option>
              <option value="Sagittarius">Sagittarius (Nov 22 - Dec 21)</option>
              <option value="Capricorn">Capricorn (Dec 22 - Jan 19)</option>
              <option value="Aquarius">Aquarius (Jan 20 - Feb 18)</option>
              <option value="Pisces">Pisces (Feb 19 - Mar 20)</option>
            </select>

            <input id="question" placeholder="Anything specific? (optional) e.g. career, love" />

            <button onclick="getReading()" id="readingBtn">Get My Reading</button>

            <div id="reading"></div>
          </div>

          <script>
            async function getReading() {
              const zodiacSign = document.getElementById("zodiacSign").value;
              const question = document.getElementById("question").value.trim();
              const btn = document.getElementById("readingBtn");
              const readingEl = document.getElementById("reading");

              btn.disabled = true;
              btn.textContent = "Reading the stars...";
              readingEl.style.display = "none";

              try {
                const res = await fetch("/api/ai-astrology", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ zodiacSign, question: question || undefined })
                });
                const data = await res.json();

                readingEl.textContent = data.error ? ("Error: " + data.error) : data.reply;
                readingEl.style.display = "block";
              } catch (err) {
                readingEl.textContent = "Something went wrong. Please try again.";
                readingEl.style.display = "block";
              }

              btn.disabled = false;
              btn.textContent = "Get My Reading";
            }
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/camera-test") {
    const name = parsedUrl.query.name || "";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <body style="background:linear-gradient(160deg,#3d0f6e,#9333ea); color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif; text-align:center; padding-top:60px; margin:0; min-height:100vh;">
          <a style="color:#ffd966; text-decoration:none; font-size:13px; position:absolute; top:16px; left:16px;" href="/welcome?name=${name}">&larr; Back</a>
          <h2>🎥 Camera & Mic Test</h2>
          <video id="preview" autoplay playsinline muted style="width:320px; height:240px; background:black; border-radius:12px; border:1px solid rgba(255,255,255,0.15);"></video>
          <br /><br />
          <button onclick="startPreview()" style="padding:12px 24px; font-size:15px; border:none; border-radius:20px; background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e; font-weight:700; cursor:pointer;">Start Camera & Mic</button>
          <p id="status" style="margin-top:15px; color:#ffd966;"></p>
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

  } else if (parsedUrl.pathname === "/privacy-policy") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            body {
              margin:0; background:linear-gradient(160deg,#3d0f6e,#9333ea);
              color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif;
              padding:24px 20px 40px;
            }
            .card {
              max-width:600px; margin:0 auto;
              background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15);
              border-radius:16px; padding:26px;
            }
            h1 { font-size:22px; margin-top:0; }
            h2 { font-size:15px; color:#ffd966; margin-top:26px; }
            p, li { font-size:13.5px; line-height:1.6; color:rgba(255,255,255,0.85); }
            a.backLink { color:#ffd966; text-decoration:none; font-size:13px; display:inline-block; margin-bottom:16px; }
          </style>
        </head>
        <body>
          <div class="card">
            <a class="backLink" href="javascript:history.back()">&larr; Back</a>
            <h1>Privacy Policy</h1>
            <p>Last updated: ${new Date().toISOString().slice(0, 10)}</p>
            <p>ConnectBondhu ("the app") is a personal messaging project. This policy explains what information is collected and how it's used.</p>

            <h2>Information We Collect</h2>
            <ul>
              <li><strong>Display name:</strong> the name you type in to sign in. No password or email is required.</li>
              <li><strong>Messages:</strong> text messages, images, and files you send are stored so conversations persist between sessions.</li>
              <li><strong>Camera & microphone:</strong> used only during video/audio calls you initiate. We do not record or store call audio/video.</li>
              <li><strong>Usage data:</strong> basic technical logs (e.g. connection timestamps) may be recorded by our hosting provider for security and reliability.</li>
            </ul>

            <h2>How Information Is Used</h2>
            <p>Your information is used solely to provide core app features: chat, calls, group rooms, games, and AI features. We do not sell or share your data with advertisers or third parties.</p>

            <h2>AI Features</h2>
            <p>Messages you send to AI Chat or AI Astrology are sent to Anthropic's Claude API to generate a response. These messages are not used to train AI models by Anthropic under their API terms.</p>

            <h2>Blocking & Reporting</h2>
            <p>You can block another user at any time, which hides them from your buddy list and prevents further messages between you. You can also report a user; reports are stored so misuse can be reviewed.</p>

            <h2>Data Retention & Deletion</h2>
            <p>Messages and account data are stored until you request deletion. To request your data be deleted, contact the app developer directly.</p>

            <h2>Children's Privacy</h2>
            <p>This app is not directed at children under 13, and we do not knowingly collect data from children under 13.</p>

            <h2>Changes to This Policy</h2>
            <p>This policy may be updated as the app evolves. Continued use of the app after changes means you accept the updated policy.</p>

            <h2>Contact</h2>
            <p>For questions or data deletion requests, please contact the app developer directly.</p>
          </div>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/blocked-users") {
    const me = parsedUrl.query.me || "Guest";
    const blockedList = db
      .prepare("SELECT blocked_name, created_at FROM blocks WHERE blocker_name = ? ORDER BY created_at DESC")
      .all(me);

    const listHTML = blockedList.length
      ? blockedList
          .map(
            (b) => `
        <div class="roomRow">
          <span class="roomName">${b.blocked_name}</span>
          <a class="joinLabel" href="/unblock-user?blocker=${encodeURIComponent(me)}&blocked=${encodeURIComponent(b.blocked_name)}">Unblock</a>
        </div>`
          )
          .join("")
      : `<div style="padding:14px; font-size:12.5px; color:rgba(255,255,255,0.5); text-align:center;">You haven't blocked anyone.</div>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body { margin:0; min-height:100vh; background:linear-gradient(160deg,#3d0f6e,#9333ea); color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif; padding-bottom:30px; }
            .header { padding:20px; text-align:center; position:relative; }
            .header a.backLink { position:absolute; top:20px; left:16px; color:#ffd966; text-decoration:none; font-size:20px; }
            .header h1 { margin:6px 0 2px; font-size:20px; }
            .section { max-width:420px; margin:0 auto; padding:0 16px; }
            .roomCategory { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); border-radius:14px; overflow:hidden; margin-top:10px; }
            .roomRow { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.07); font-size:14px; }
            .roomRow:last-child { border-bottom:none; }
            .joinLabel { color:#ffd966; text-decoration:none; font-size:12.5px; }
          </style>
        </head>
        <body>
          <div class="header">
            <a class="backLink" href="/welcome?name=${me}">&larr;</a>
            <h1>🚫 Blocked Users</h1>
          </div>
          <div class="section">
            <div class="roomCategory">${listHTML}</div>
          </div>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/rooms") {
    const me = parsedUrl.query.me || "Guest";
    const genderParam = parsedUrl.query.gender || "";

    const categories = [
      { name: "Family & Friends", icon: "👨‍👩‍👧‍👦", rooms: ["Family Room", "Best Friends", "Cousins Corner"] },
      { name: "General Chat", icon: "💬", rooms: ["General Lobby", "Newcomers", "Random Talk"] },
      { name: "Sports", icon: "⚽", rooms: ["Cricket Talk", "Football Fans", "Live Match Room"] },
      { name: "Music & Bollywood", icon: "🎵", rooms: ["Bollywood Beats", "Assamese Music", "Karaoke Room"] },
      { name: "Regional", icon: "🌏", rooms: ["Assam Adda", "Dibrugarh Circle", "Guwahati Hangout"] }
    ];

    const categoriesHTML = categories
      .map(
        (cat) => `
        <div class="roomCategory">
          <div class="categoryHeader"><span class="catIcon">${cat.icon}</span>${cat.name}</div>
          <div class="roomList">
            ${cat.rooms
              .map((room) => {
                const roomId = room.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                return `<a class="roomRow" href="/group-call?room=${roomId}&me=${me}&gender=${genderParam}">
                  <span class="roomName">${room}</span>
                  <span class="joinLabel">Join &rarr;</span>
                </a>`;
              })
              .join("")}
          </div>
        </div>`
      )
      .join("");

    const customRooms = db.prepare("SELECT * FROM custom_rooms ORDER BY created_at DESC").all();
    const customRoomsHTML = customRooms.length
      ? customRooms
          .map(
            (r) => `
        <a class="roomRow" href="/group-call?room=${r.room_id}&me=${me}&gender=${genderParam}">
          <span class="roomName">${r.display_name}<br/><span style="font-size:10.5px; color:rgba(255,255,255,0.5);">by ${r.created_by}</span></span>
          <span class="joinLabel">Join &rarr;</span>
        </a>`
          )
          .join("")
      : `<div style="padding:14px; font-size:12.5px; color:rgba(255,255,255,0.5); text-align:center;">No custom rooms yet \u2014 be the first to create one!</div>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              margin:0; min-height:100vh;
              background:linear-gradient(160deg,#3d0f6e,#9333ea);
              color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif;
              padding-bottom:30px;
            }
            .header { padding:20px 20px 10px; text-align:center; position:relative; }
            .header a.backLink { position:absolute; top:20px; left:16px; color:#ffd966; text-decoration:none; font-size:20px; }
            .header h1 { margin:6px 0 2px; font-size:20px; }
            .header p { margin:0; color:rgba(255,255,255,0.65); font-size:12.5px; }

            .section { max-width:440px; margin:0 auto; padding:0 16px; }
            .roomCategory {
              background:rgba(255,255,255,0.06);
              border:1px solid rgba(255,255,255,0.14);
              border-radius:14px;
              margin-top:14px;
              overflow:hidden;
            }
            .categoryHeader {
              padding:12px 14px;
              font-weight:700;
              font-size:14px;
              background:rgba(255,255,255,0.05);
              border-bottom:1px solid rgba(255,255,255,0.1);
              display:flex; align-items:center; justify-content:space-between;
            }
            .catIcon { margin-right:8px; }
            .roomRow {
              display:flex; align-items:center; justify-content:space-between;
              padding:11px 14px;
              text-decoration:none; color:white;
              border-bottom:1px solid rgba(255,255,255,0.07);
              font-size:13.5px;
            }
            .roomRow:last-child { border-bottom:none; }
            .joinLabel { color:#ffd966; font-size:12px; flex-shrink:0; margin-left:8px; }

            .createRoomBox {
              background:rgba(255,255,255,0.08);
              border:1px solid rgba(255,255,255,0.18);
              border-radius:14px;
              padding:14px;
              margin-top:14px;
            }
            .createRoomBox input {
              width:100%; padding:11px 14px; border-radius:20px;
              border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08);
              color:white; font-size:14px; margin-bottom:10px;
            }
            .createRoomBox input::placeholder { color:rgba(255,255,255,0.5); }
            .createRoomBox button {
              width:100%; padding:12px; border:none; border-radius:20px;
              background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e;
              font-weight:700; font-size:14px; cursor:pointer;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <a class="backLink" href="/welcome?name=${me}">&larr;</a>
            <h1>👥 Group Call Rooms</h1>
            <p>Pick a room, or create your own</p>
          </div>

          <div class="section">
            <div class="createRoomBox">
              <p style="margin:0 0 10px; font-weight:700; font-size:13.5px;">✨ Create Your Own Room</p>
              <input id="newRoomName" placeholder="Room name, e.g. Movie Night" maxlength="40" />
              <button onclick="createRoom()">Create & Join</button>
            </div>

            <div class="roomCategory">
              <div class="categoryHeader"><span><span class="catIcon">🌟</span>Community Rooms</span></div>
              <div class="roomList">
                ${customRoomsHTML}
              </div>
            </div>

            ${categoriesHTML}
          </div>

          <script>
            function createRoom() {
              const input = document.getElementById("newRoomName");
              const name = input.value.trim();
              if (!name) return;
              window.location.href = "/create-room?name=" + encodeURIComponent(name) + "&me=" + encodeURIComponent("${me}") + "&gender=" + encodeURIComponent("${genderParam}");
            }
            document.getElementById("newRoomName").addEventListener("keydown", (e) => {
              if (e.key === "Enter") createRoom();
            });
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/create-room") {
    const displayName = (parsedUrl.query.name || "").trim().slice(0, 40);
    const me = parsedUrl.query.me || "Guest";
    const genderParam = parsedUrl.query.gender || "";

    if (displayName) {
      const roomId = slugify(displayName) + "-" + Math.floor(Math.random() * 10000);
      try {
        db.prepare("INSERT INTO custom_rooms (room_id, display_name, created_by) VALUES (?, ?, ?)").run(
          roomId,
          displayName,
          me
        );
      } catch (e) {}

      res.writeHead(302, { Location: `/group-call?room=${roomId}&me=${encodeURIComponent(me)}&gender=${encodeURIComponent(genderParam)}` });
      res.end();
    } else {
      res.writeHead(302, { Location: `/rooms?me=${encodeURIComponent(me)}&gender=${encodeURIComponent(genderParam)}` });
      res.end();
    }

  } else if (parsedUrl.pathname === "/group-call") {
    const me = parsedUrl.query.me || "Guest";
    const genderQ = parsedUrl.query.gender || "";
    const room = parsedUrl.query.room || "family-room";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <style>
            * { box-sizing:border-box; }
            body { background:linear-gradient(160deg,#0f0620,#1a0b33); color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif; margin:0; padding:0; }
            #topBar {
              background:linear-gradient(135deg,#3d0f6e,#9333ea);
              padding:14px; text-align:center; position:relative;
              box-shadow:0 2px 10px rgba(0,0,0,0.3);
            }
            #topBar h2 { margin:4px; font-size:16px; }
            #videoGrid {
              display:grid;
              grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
              gap:10px;
              padding:14px;
            }
            .tile {
              position:relative; background:#1c1230; border-radius:14px; overflow:hidden;
              aspect-ratio:4/3; border:1px solid rgba(255,255,255,0.1);
              box-shadow:0 4px 14px rgba(0,0,0,0.35);
              transition:transform 0.15s;
            }
            .tile video { width:100%; height:100%; object-fit:cover; }
            .tile .label {
              position:absolute; bottom:6px; left:8px;
              background:rgba(0,0,0,0.55); padding:3px 10px; border-radius:12px;
              font-size:12px; display:flex; align-items:center; gap:4px;
            }
            .tile .privateCallBtn {
              position:absolute; top:6px; right:6px;
              background:rgba(0,0,0,0.55); border:1px solid rgba(255,255,255,0.25);
              color:white; border-radius:14px; padding:4px 9px; font-size:11px; cursor:pointer;
            }
            #controls {
              text-align:center; padding:14px;
              display:flex; flex-wrap:wrap; justify-content:center; gap:8px;
            }
            #controls button {
              padding:11px 18px; border:none; border-radius:22px; font-size:13.5px;
              background:rgba(255,255,255,0.1); color:white; cursor:pointer;
              border:1px solid rgba(255,255,255,0.15);
            }
            #leaveBtn { background:linear-gradient(135deg,#e33,#c22); color:white; }
            .off { background:#e33 !important; }

            #gamePanel {
              display:none;
              position:fixed;
              bottom:0; left:0; right:0;
              background:#160c2b;
              padding:16px;
              text-align:center;
              border-top:2px solid #9333ea;
              border-radius:20px 20px 0 0;
              z-index:500;
              max-height:70vh;
              overflow-y:auto;
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

            /* Participant roster */
            #roster {
              display:flex;
              gap:8px;
              overflow-x:auto;
              padding:12px 14px;
              background:rgba(255,255,255,0.04);
              border-bottom:1px solid rgba(255,255,255,0.1);
            }
            .rosterChip {
              display:flex; flex-direction:column; align-items:center; gap:4px;
              text-decoration:none; color:white; flex-shrink:0; width:58px;
              text-align:center;
            }
            .rosterAvatar {
              width:42px; height:42px; border-radius:50%;
              background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e;
              display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px;
              border:2px solid rgba(255,255,255,0.2);
            }
            .rosterName { font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%; }
            .rosterMe { opacity:0.6; }

            /* Room text chat (main view) */
            #chatPanel {
              display:flex;
              flex-direction:column;
              height:calc(100vh - 300px);
              min-height:260px;
              background:#160c2b;
              margin:0 0 10px;
            }
            #chatPanelHeader {
              padding:12px 16px; background:rgba(255,255,255,0.04);
              display:flex; justify-content:space-between; align-items:center; font-size:13.5px; font-weight:600;
              border-bottom:1px solid rgba(255,255,255,0.08);
            }
            #groupMessages { flex:1; overflow-y:auto; padding:12px; }
            .groupMsg { margin-bottom:10px; font-size:13px; }
            .groupMsg b { color:#ffd966; }
            .groupMsg img { max-width:160px; border-radius:8px; margin-top:4px; display:block; }
            #chatInputBar { padding:10px; border-top:1px solid rgba(255,255,255,0.1); position:relative; }
            #chatInputRow { display:flex; gap:6px; }
            #groupChatInput {
              flex:1; padding:10px 12px; border-radius:18px; border:1px solid rgba(255,255,255,0.2);
              background:rgba(255,255,255,0.07); color:white; font-size:13px;
            }
            #chatInputBar button {
              border:none; border-radius:18px; padding:9px 12px; background:rgba(255,255,255,0.1); color:white; font-size:14px; cursor:pointer;
            }
            #chatInputBar .sendGroupBtn { background:#ffd966; color:#3d0f6e; font-weight:700; }

            #emojiPicker {
              display:none;
              position:absolute; bottom:52px; left:10px; right:10px;
              background:#221542; border:1px solid rgba(255,255,255,0.15); border-radius:12px;
              padding:8px; max-height:160px; overflow-y:auto;
              grid-template-columns: repeat(7, 1fr); gap:4px;
            }
            #emojiPicker span { font-size:20px; text-align:center; cursor:pointer; padding:4px; border-radius:6px; }
            #emojiPicker span:hover { background:rgba(255,255,255,0.1); }

            /* Private call overlay */
            #privateCallOverlay {
              display:none;
              position:fixed; top:0; left:0; right:0; bottom:0;
              background:#000; z-index:900;
            }
            #privateBigVideo { width:100%; height:100%; object-fit:cover; }
            #privateSmallVideo {
              position:absolute; width:100px; height:135px; top:20px; right:20px;
              object-fit:cover; border-radius:10px; border:2px solid white; background:#333;
            }
            #privateCallStatus {
              position:absolute; top:20px; left:20px; color:#ffd966; font-size:14px;
              background:rgba(0,0,0,0.4); padding:4px 10px; border-radius:6px;
            }
            #privateCallControls {
              position:absolute; bottom:26px; left:50%; transform:translateX(-50%);
              display:flex; gap:10px;
            }
            #privateCallControls button {
              border:none; padding:12px 18px; border-radius:24px; font-size:13px; color:white; cursor:pointer;
            }
            #privateInviteBox {
              position:absolute; bottom:90px; left:50%; transform:translateX(-50%);
              background:rgba(0,0,0,0.6); border-radius:12px; padding:8px; display:none; gap:4px;
              max-width:80%; flex-wrap:wrap; justify-content:center;
            }
            #privateInviteBox button { font-size:11px; padding:6px 10px; border-radius:12px; border:none; background:#333; color:white; }

            #privateIncoming {
              display:none;
              position:fixed; top:20px; left:50%; transform:translateX(-50%);
              background:white; color:black; padding:14px 18px; border-radius:12px;
              z-index:950; text-align:center; box-shadow:0 6px 20px rgba(0,0,0,0.4);
            }
          </style>
        </head>
        <body>
          <div id="topBar">
            <a href="/welcome?name=${me}" style="color:#ffd966; text-decoration:none; font-size:13px; position:absolute; top:16px; left:16px;">&larr; Back</a>
            <h2>👥 ${room}</h2>
            <p style="margin:4px; font-size:12.5px; color:#ffd966;">Tap a name for a private chat, or chat here with everyone</p>
          </div>

          <div id="roster"></div>

          <div id="videoGrid" style="display:none;"></div>

          <div id="controls">
            <button onclick="toggleVideoGrid()">🎥 Group Video</button>
            <button onclick="toggleGamePanel()">🎮 Games</button>
            <button id="leaveBtn" onclick="leaveCall()">🚪 Leave Room</button>
          </div>

          <div id="videoSubControls" style="display:none; text-align:center; padding-bottom:10px;">
            <button id="muteBtn" onclick="toggleMute()">🎤 Mute</button>
            <button id="camBtn" onclick="toggleCam()">📷 Camera Off</button>
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

          <div id="chatPanel" class="open">
            <div id="chatPanelHeader">
              <span>💬 Room Chat</span>
            </div>
            <div id="groupMessages"></div>
            <div id="chatInputBar">
              <div id="emojiPicker"></div>
              <div id="chatInputRow">
                <button onclick="toggleEmojiPicker()">😊</button>
                <input id="groupChatInput" placeholder="Message the room..." />
                <button onclick="document.getElementById('groupFileInput').click()">📎</button>
                <button class="sendGroupBtn" onclick="sendGroupMessage()">Send</button>
              </div>
              <input type="file" id="groupFileInput" onchange="sendGroupFile()" style="display:none;" />
            </div>
          </div>

          <div id="privateCallOverlay">
            <video id="privateBigVideo" autoplay playsinline></video>
            <video id="privateSmallVideo" autoplay playsinline muted></video>
            <p id="privateCallStatus"></p>
            <div id="privateInviteBox"></div>
            <div id="privateCallControls">
              <button onclick="togglePrivateInviteBox()" style="background:#444;">➕ Invite</button>
              <button onclick="endPrivateCall(true)" style="background:#e33;">End Private Call</button>
            </div>
          </div>

          <div id="privateIncoming">
            <p id="privateIncomingText" style="margin:0 0 10px;"></p>
            <button onclick="acceptPrivateCall()" style="padding:8px 16px; margin-right:8px; border:none; border-radius:16px; background:#4ade80; cursor:pointer;">Accept</button>
            <button onclick="declinePrivateCall()" style="padding:8px 16px; border:none; border-radius:16px; background:#e33; color:white; cursor:pointer;">Decline</button>
          </div>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const me = "${me}";
            const myGender = "${genderQ}";
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
            const peerGenders = {}; // socketId -> gender
            let muted = false;
            let camOff = false;

            function genderSymbol(g) {
              if (g === "Male") return " ♂";
              if (g === "Female") return " ♀";
              if (g === "Other") return " ⚧";
              return "";
            }

            function addTile(id, stream, name, isLocal, gender) {
              let tile = document.getElementById("tile-" + id);
              if (!tile) {
                tile = document.createElement("div");
                tile.className = "tile";
                tile.id = "tile-" + id;
                const label = name + genderSymbol(gender) + (isLocal ? " (You)" : "");
                const privateBtn = isLocal ? "" : '<button class="privateCallBtn" onclick="requestPrivateCall(\\'' + id + '\\', \\'' + name.replace(/'/g, "") + '\\')">🔒 Private</button>';
                tile.innerHTML = '<video autoplay playsinline' + (isLocal ? ' muted' : '') + '></video><div class="label">' + label + '</div>' + privateBtn;
                document.getElementById("videoGrid").appendChild(tile);
              }
              tile.querySelector("video").srcObject = stream;
            }

            function removeTile(id) {
              const tile = document.getElementById("tile-" + id);
              if (tile) tile.remove();
            }

            function createPeerConnection(peerId, peerName, peerGender) {
              const pc = new RTCPeerConnection(rtcConfig);
              peerGenders[peerId] = peerGender;

              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket.emit("group-ice-candidate", { to: peerId, from: socket.id, candidate: event.candidate });
                }
              };

              pc.ontrack = (event) => {
                addTile(peerId, event.streams[0], peerName, false, peerGender);
              };

              if (localStream) {
                localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
              }

              peers[peerId] = pc;
              return pc;
            }

            let videoStarted = false;

            async function startVideo() {
              if (videoStarted) return;
              videoStarted = true;
              try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              } catch (err) {
                alert("Could not access camera/mic: " + err.message);
                videoStarted = false;
                return;
              }
              addTile(socket.id || "local", localStream, me, true, myGender);
              socket.emit("join-group", { room, name: me, gender: myGender });
            }

            function toggleVideoGrid() {
              const grid = document.getElementById("videoGrid");
              const subControls = document.getElementById("videoSubControls");
              const isOpen = grid.style.display !== "none";

              if (isOpen) {
                grid.style.display = "none";
                subControls.style.display = "none";
              } else {
                grid.style.display = "grid";
                subControls.style.display = "block";
                startVideo();
              }
            }

            socket.on("connect", () => {
              // re-label local tile with real socket id once connected
              const oldTile = document.getElementById("tile-local");
              if (oldTile) oldTile.id = "tile-" + socket.id;
            });

            // Existing people already in the room -> call each of them
            socket.on("existing-peers", async (peerList) => {
              for (const peer of peerList) {
                const pc = createPeerConnection(peer.id, peer.name, peer.gender);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("group-offer", { to: peer.id, from: socket.id, offer, name: me, gender: myGender });
              }
            });

            // Someone new joined -> wait for their offer
            socket.on("new-peer", ({ id, name, gender }) => {
              peerGenders[id] = gender;
            });

            socket.on("group-offer", async ({ from, offer, name, gender }) => {
              const pc = createPeerConnection(from, name, gender);
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

            // ---- Group text chat ----
            let chatJoined = false;

            function toggleChatPanel() {
              const panel = document.getElementById("chatPanel");
              const isOpen = panel.classList.contains("open");
              panel.classList.toggle("open", !isOpen);

              if (!isOpen && !chatJoined) {
                chatJoined = true;
                socket.emit("get-group-chat-history", { room });
              }
            }

            function renderGroupMsg(msg) {
              const box = document.getElementById("groupMessages");
              const div = document.createElement("div");
              div.className = "groupMsg";
              div.setAttribute("data-id", msg.id);

              const mine = msg.from === me;
              const actions = mine
                ? '<span style="margin-left:6px;">' +
                  (msg.type === "text" ? '<button style="font-size:10px; padding:2px 6px; margin-left:3px; border:none; border-radius:4px; background:rgba(255,255,255,0.15); color:white; cursor:pointer;" onclick="editGroupMsg(' + msg.id + ')">Edit</button>' : "") +
                  '<button style="font-size:10px; padding:2px 6px; margin-left:3px; border:none; border-radius:4px; background:rgba(255,255,255,0.15); color:white; cursor:pointer;" onclick="deleteGroupMsg(' + msg.id + ')">Delete</button></span>'
                : "";

              if (msg.type === "image") {
                div.innerHTML = "<b>" + msg.from + ":</b>" + actions + "<br/><img src=\\"" + msg.fileData + "\\" />";
              } else if (msg.type === "file") {
                div.innerHTML = "<b>" + msg.from + ":</b>" + actions + "<br/><a style=\\"color:#ffd966;\\" href=\\"" + msg.fileData + "\\" download=\\"" + msg.fileName + "\\">📎 " + msg.fileName + "</a>";
              } else {
                div.innerHTML = "<b>" + msg.from + ":</b> <span class=\\"groupMsgText\\">" + msg.text + "</span>" + actions;
              }
              box.appendChild(div);
              box.scrollTop = box.scrollHeight;
            }

            socket.on("group-chat-history", (history) => {
              document.getElementById("groupMessages").innerHTML = "";
              history.forEach(renderGroupMsg);
            });

            socket.on("group-chat-message", (msg) => {
              renderGroupMsg(msg);
            });

            socket.on("group-message-edited", ({ id, newText }) => {
              const row = document.querySelector('.groupMsg[data-id="' + id + '"]');
              if (row) {
                const textSpan = row.querySelector(".groupMsgText");
                if (textSpan) textSpan.textContent = newText;
              }
            });

            socket.on("group-message-deleted", ({ id }) => {
              const row = document.querySelector('.groupMsg[data-id="' + id + '"]');
              if (row) row.remove();
            });

            function editGroupMsg(id) {
              const row = document.querySelector('.groupMsg[data-id="' + id + '"]');
              const textSpan = row ? row.querySelector(".groupMsgText") : null;
              if (!textSpan) return;
              const newText = prompt("Edit your message:", textSpan.textContent);
              if (newText === null || newText.trim() === "" || newText === textSpan.textContent) return;
              socket.emit("group-edit-message", { room, id, newText });
            }

            function deleteGroupMsg(id) {
              if (!confirm("Delete this message for everyone in the room?")) return;
              socket.emit("group-delete-message", { room, id });
            }

            function sendGroupMessage() {
              const input = document.getElementById("groupChatInput");
              const text = input.value.trim();
              if (!text) return;
              socket.emit("group-chat-message", { room, from: me, type: "text", text });
              input.value = "";
            }

            document.getElementById("groupChatInput").addEventListener("keydown", (e) => {
              if (e.key === "Enter") sendGroupMessage();
            });

            function sendGroupFile() {
              const input = document.getElementById("groupFileInput");
              const file = input.files[0];
              if (!file) return;
              if (file.size > 8 * 1024 * 1024) {
                alert("Please choose a file under 8MB.");
                input.value = "";
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const type = file.type.startsWith("image/") ? "image" : "file";
                socket.emit("group-chat-message", {
                  room, from: me, type, fileName: file.name, fileData: reader.result
                });
              };
              reader.readAsDataURL(file);
              input.value = "";
            }

            // ---- Professional emoji picker ----
            const EMOJI_LIST = ["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😴","😢","😭","😡","👍","👎","👏","🙏","💪","🤝","👋","❤️","💯","🔥","✨","🎉","🎂","☕","🍕","⚽","🎵","💬","📷","📎","😅","😉","🙂","😇","🥳","🤗","😋"];

            function toggleEmojiPicker() {
              const picker = document.getElementById("emojiPicker");
              const isOpen = picker.style.display === "grid";
              if (!isOpen) {
                picker.innerHTML = EMOJI_LIST.map((e) => '<span onclick="insertEmoji(\\'' + e + '\\')">' + e + '</span>').join("");
                picker.style.display = "grid";
              } else {
                picker.style.display = "none";
              }
            }

            function insertEmoji(emoji) {
              const input = document.getElementById("groupChatInput");
              input.value += emoji;
              input.focus();
            }

            // ---- Private calls ----
            let privatePeers = {};
            let privateLocalStream = null;
            let currentPrivateRoom = null;
            let pendingPrivateTarget = null;
            let privateBigIsRemote = true;

            function requestPrivateCall(peerId, peerName) {
              pendingPrivateTarget = { id: peerId, name: peerName };
              socket.emit("private-call-invite", { room, to: peerId, fromId: socket.id, fromName: me });
              alert("Private call request sent to " + peerName + ". Waiting for them to accept...");
            }

            socket.on("private-call-invite", ({ fromId, fromName }) => {
              window.incomingPrivateFrom = { id: fromId, name: fromName };
              document.getElementById("privateIncomingText").textContent = fromName + " wants a private call with you";
              document.getElementById("privateIncoming").style.display = "block";
            });

            function acceptPrivateCall() {
              document.getElementById("privateIncoming").style.display = "none";
              const from = window.incomingPrivateFrom;
              const privateRoomId = [me, from.name, Date.now()].join("-").replace(/[^a-zA-Z0-9-]/g, "");
              socket.emit("private-call-response", { toId: from.id, accepted: true, privateRoom: privateRoomId, fromName: me });
              startPrivateCall(privateRoomId);
            }

            function declinePrivateCall() {
              document.getElementById("privateIncoming").style.display = "none";
              const from = window.incomingPrivateFrom;
              socket.emit("private-call-response", { toId: from.id, accepted: false });
            }

            socket.on("private-call-response", ({ accepted, privateRoom, fromName }) => {
              if (!accepted) {
                alert((pendingPrivateTarget ? pendingPrivateTarget.name : "They") + " declined the private call.");
                pendingPrivateTarget = null;
                return;
              }
              startPrivateCall(privateRoom);
            });

            async function startPrivateCall(privateRoomId) {
              currentPrivateRoom = privateRoomId;
              document.getElementById("privateCallOverlay").style.display = "block";
              document.getElementById("privateCallStatus").textContent = "Private call";

              privateLocalStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              document.getElementById("privateSmallVideo").srcObject = privateLocalStream;

              socket.emit("join-private", { privateRoom: privateRoomId, name: me });
            }

            function createPrivatePeerConnection(peerId) {
              const pc = new RTCPeerConnection(rtcConfig);
              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket.emit("private-ice-candidate", { to: peerId, from: socket.id, candidate: event.candidate });
                }
              };
              pc.ontrack = (event) => {
                document.getElementById("privateBigVideo").srcObject = event.streams[0];
              };
              if (privateLocalStream) {
                privateLocalStream.getTracks().forEach((t) => pc.addTrack(t, privateLocalStream));
              }
              privatePeers[peerId] = pc;
              return pc;
            }

            socket.on("private-existing-peers", async (peerList) => {
              for (const peer of peerList) {
                const pc = createPrivatePeerConnection(peer.id);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("private-offer", { to: peer.id, from: socket.id, offer, name: me });
              }
            });

            socket.on("private-new-peer", ({ id, name }) => {
              // will receive an offer from them
            });

            socket.on("private-offer", async ({ from, offer }) => {
              const pc = createPrivatePeerConnection(from);
              await pc.setRemoteDescription(offer);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.emit("private-answer", { to: from, from: socket.id, answer });
            });

            socket.on("private-answer", async ({ from, answer }) => {
              const pc = privatePeers[from];
              if (pc) await pc.setRemoteDescription(answer);
            });

            socket.on("private-ice-candidate", async ({ from, candidate }) => {
              const pc = privatePeers[from];
              if (pc) {
                try { await pc.addIceCandidate(candidate); } catch (err) {}
              }
            });

            socket.on("private-peer-left", ({ id }) => {
              if (privatePeers[id]) {
                privatePeers[id].close();
                delete privatePeers[id];
              }
            });

            function togglePrivateInviteBox() {
              const box = document.getElementById("privateInviteBox");
              const isOpen = box.style.display === "flex";
              if (!isOpen) {
                box.innerHTML = "";
                Object.entries(peerGenders).forEach(([id]) => {
                  const tile = document.getElementById("tile-" + id);
                  if (!tile || id === socket.id) return;
                  const nameLabel = tile.querySelector(".label").textContent;
                  const btn = document.createElement("button");
                  btn.textContent = "Invite " + nameLabel;
                  btn.onclick = () => {
                    socket.emit("private-call-invite", { room, to: id, fromId: socket.id, fromName: me });
                    alert("Invited " + nameLabel + " to the private call.");
                    box.style.display = "none";
                  };
                  box.appendChild(btn);
                });
                box.style.display = "flex";
              } else {
                box.style.display = "none";
              }
            }

            function endPrivateCall(notify) {
              Object.values(privatePeers).forEach((pc) => pc.close());
              privatePeers = {};
              if (privateLocalStream) {
                privateLocalStream.getTracks().forEach((t) => t.stop());
                privateLocalStream = null;
              }
              if (currentPrivateRoom && notify) {
                socket.emit("leave-private", { privateRoom: currentPrivateRoom });
              }
              currentPrivateRoom = null;
              document.getElementById("privateCallOverlay").style.display = "none";
              document.getElementById("privateBigVideo").srcObject = null;
              document.getElementById("privateSmallVideo").srcObject = null;
            }

            // ---- Participant roster (chat-first landing) ----
            function renderRoster(list) {
              const rosterEl = document.getElementById("roster");
              rosterEl.innerHTML = "";

              const meChip = document.createElement("div");
              meChip.className = "rosterChip rosterMe";
              meChip.innerHTML = '<div class="rosterAvatar">' + me.charAt(0).toUpperCase() + '</div><div class="rosterName">' + me + " (You)" + '</div>';
              rosterEl.appendChild(meChip);

              list.forEach((p) => {
                const chip = document.createElement("a");
                chip.className = "rosterChip";
                chip.href = "/chat?me=" + encodeURIComponent(me) + "&with=" + encodeURIComponent(p.name);
                chip.innerHTML = '<div class="rosterAvatar">' + p.name.charAt(0).toUpperCase() + '</div><div class="rosterName">' + p.name + genderSymbol(p.gender) + '</div>';
                rosterEl.appendChild(chip);
              });
            }

            socket.on("roster-update", (list) => {
              renderRoster(list);
            });

            function startRoom() {
              socket.emit("join-room-chat", { room, name: me, gender: myGender });
              socket.emit("get-group-chat-history", { room });
            }

            startRoom();
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/chat") {
    const me = parsedUrl.query.me;
    const withBuddy = parsedUrl.query.with;

    if (isBlockedEitherWay(me, withBuddy)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <body style="background:linear-gradient(160deg,#3d0f6e,#9333ea); color:white; font-family:-apple-system, Segoe UI, Roboto, sans-serif; text-align:center; padding-top:100px; margin:0; min-height:100vh;">
            <h2>🚫 Conversation unavailable</h2>
            <p style="color:rgba(255,255,255,0.7); max-width:300px; margin:10px auto;">You can't message this user right now.</p>
            <a style="color:#ffd966; text-decoration:none;" href="/welcome?name=${me}">&larr; Back to Welcome</a>
          </body>
        </html>
      `);
      return;
    }

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
            body {
              margin:0;
              min-height:100vh;
              font-family:-apple-system, Segoe UI, Roboto, sans-serif;
              background:linear-gradient(160deg, #3d0f6e 0%, #6c2bd9 50%, #9333ea 100%);
              color:white;
              text-align:center;
              padding-bottom:20px;
            }

            .chatHeader {
              display:flex;
              align-items:center;
              gap:12px;
              padding:14px 16px;
              background:rgba(255,255,255,0.06);
              border-bottom:1px solid rgba(255,255,255,0.12);
              text-align:left;
              position:relative;
            }
            .backBtn {
              color:#ffd966;
              text-decoration:none;
              font-size:20px;
              padding:4px 6px;
              flex-shrink:0;
            }
            .chatHeaderAvatar {
              width:38px; height:38px;
              border-radius:50%;
              background:linear-gradient(135deg, #ffd966, #ff9d3d);
              color:#3d0f6e;
              font-weight:700;
              display:flex; align-items:center; justify-content:center;
              flex-shrink:0;
            }
            .chatHeaderName { font-size:16px; font-weight:600; }
            .callBtnTop {
              margin-left:auto;
              background:rgba(255,255,255,0.12);
              border:1px solid rgba(255,255,255,0.2);
              color:white;
              padding:8px 16px;
              border-radius:20px;
              font-size:13px;
              cursor:pointer;
            }
            .menuBtn {
              background:none; border:none; color:white; font-size:20px; cursor:pointer; padding:4px 8px;
            }
            .menuDropdown {
              display:none;
              position:absolute;
              top:52px; right:16px;
              background:#2a1052;
              border:1px solid rgba(255,255,255,0.2);
              border-radius:10px;
              overflow:hidden;
              z-index:50;
              min-width:150px;
            }
            .menuDropdown button {
              display:block; width:100%; text-align:left; padding:11px 14px;
              background:none; border:none; color:white; font-size:13.5px; cursor:pointer;
            }
            .menuDropdown button:hover { background:rgba(255,255,255,0.08); }
            .menuDropdown button.danger { color:#ff6b6b; }

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

            @keyframes buzzShake {
              0%, 100% { transform: translateX(0); }
              10%, 30%, 50%, 70%, 90% { transform: translateX(-8px); }
              20%, 40%, 60%, 80% { transform: translateX(8px); }
            }
            body.buzzing { animation: buzzShake 0.5s; }

            #audioCallAvatar {
              width:120px; height:120px; border-radius:50%;
              background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e;
              display:none; align-items:center; justify-content:center;
              font-size:48px; font-weight:700;
              position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
            }
            #fileInput { display:none; }
          </style>
        </head>
        <body>
          <div class="chatHeader">
            <a class="backBtn" href="/welcome?name=${me}">&larr;</a>
            <span class="chatHeaderAvatar">${withBuddy.charAt(0).toUpperCase()}</span>
            <span class="chatHeaderName">${withBuddy}</span>
            <button class="callBtnTop" onclick="buzz()" title="Buzz" style="background:rgba(255,217,102,0.2);">🔔</button>
            <button class="callBtnTop" onclick="startCall('audio')">📞</button>
            <button class="callBtnTop" onclick="startCall('video')">📹</button>
            <button class="menuBtn" onclick="toggleMenu()">⋮</button>
            <div class="menuDropdown" id="menuDropdown">
              <button onclick="reportUser()">⚠️ Report ${withBuddy}</button>
              <button class="danger" onclick="blockUser()">🚫 Block ${withBuddy}</button>
            </div>
          </div>

          <div id="callArea">
            <video id="bigVideo" autoplay playsinline></video>
            <video id="smallVideo" autoplay playsinline muted onclick="swapVideos()"></video>
            <div id="audioCallAvatar"></div>
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

          <div id="messages" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:white; max-width:420px; margin:15px auto; padding:14px; min-height:200px; text-align:left; border-radius:14px; overflow-y:auto; max-height:340px;">
            ${messagesHTML || "<i style=\"color:rgba(255,255,255,0.5);\">No messages yet</i>"}
          </div>

          <div id="attachBar" style="max-width:420px; margin:0 auto; position:relative; display:flex; flex-wrap:wrap; justify-content:center; gap:6px; padding:0 12px;">
            <div id="dmEmojiPicker" style="display:none; position:absolute; bottom:52px; left:12px; right:12px; background:#221542; border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:8px; max-height:160px; overflow-y:auto; grid-template-columns: repeat(7, 1fr); gap:4px;"></div>
            <input id="text" placeholder="Type a message" style="flex:1; min-width:120px; padding:11px 14px; border-radius:20px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08); color:white; font-size:14px;" />
            <button onclick="toggleDmEmojiPicker()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">😊</button>
            <button onclick="sendMessage()" style="padding:10px 16px; border:none; border-radius:20px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer;">Send</button>
            <button onclick="document.getElementById('backCameraInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">📷 Back</button>
            <button onclick="document.getElementById('frontCameraInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">🤳 Front</button>
            <button onclick="document.getElementById('fileInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">📎 File</button>
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
            socket.emit("register-user", { name: me });

            if ("Notification" in window && Notification.permission === "default") {
              Notification.requestPermission();
            }

            function playNotifySound() {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              const ctx = new AudioCtx();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.frequency.value = 700;
              osc.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.1, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.15);
              setTimeout(() => ctx.close(), 300);
            }

            // Notifications for messages/calls from OTHER conversations while this one is open
            socket.on("message-notification", ({ from, preview }) => {
              if (from === withBuddy) return; // already visible in this open chat
              playNotifySound();
              if (navigator.vibrate) navigator.vibrate(150);
              if ("Notification" in window && Notification.permission === "granted") {
                const n = new Notification(from + " sent a message", { body: preview });
                n.onclick = () => { window.location.href = "/chat?me=" + encodeURIComponent(me) + "&with=" + encodeURIComponent(from); };
              }
            });

            socket.on("incoming-call-request", ({ from, mode }) => {
              if (from === withBuddy) return; // handled by the normal incoming-call popup on this page
              playNotifySound();
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
              if ("Notification" in window && Notification.permission === "granted") {
                const n = new Notification((mode === "audio" ? "📞 " : "📹 ") + from + " is calling you", { body: "Tap to answer" });
                n.onclick = () => { window.location.href = "/chat?me=" + encodeURIComponent(me) + "&with=" + encodeURIComponent(from) + "&autoAnswer=1"; };
              }
            });

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

            // ---- Emoji picker for 1-on-1 chat ----
            const DM_EMOJI_LIST = ["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😴","😢","😭","😡","👍","👎","👏","🙏","💪","🤝","👋","❤️","💯","🔥","✨","🎉","🎂","☕","🍕","⚽","🎵","💬","📷","📎","😅","😉","🙂","😇","🥳","🤗","😋"];

            function toggleDmEmojiPicker() {
              const picker = document.getElementById("dmEmojiPicker");
              const isOpen = picker.style.display === "grid";
              if (!isOpen) {
                picker.innerHTML = DM_EMOJI_LIST.map((e) => '<span style="font-size:20px; text-align:center; cursor:pointer; padding:4px; border-radius:6px;" onclick="insertDmEmoji(\\'' + e + '\\')">' + e + '</span>').join("");
                picker.style.display = "grid";
                picker.style.gridTemplateColumns = "repeat(7, 1fr)";
              } else {
                picker.style.display = "none";
              }
            }

            function insertDmEmoji(emoji) {
              const textBox = document.getElementById("text");
              textBox.value += emoji;
              textBox.focus();
            }

            function sendFile(inputId) {
              const input = document.getElementById(inputId);
              const file = input.files[0];
              if (!file) return;

              if (file.size > 8 * 1024 * 1024) {
                alert("Please choose a file under 8MB for now.");
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

            // ---- Menu: Block / Report ----
            function toggleMenu() {
              const menu = document.getElementById("menuDropdown");
              menu.style.display = menu.style.display === "block" ? "none" : "block";
            }
            document.addEventListener("click", (e) => {
              const menu = document.getElementById("menuDropdown");
              if (menu.style.display === "block" && !e.target.closest(".chatHeader")) {
                menu.style.display = "none";
              }
            });

            function reportUser() {
              toggleMenu();
              const reason = prompt("Why are you reporting " + withBuddy + "? (optional)");
              if (reason === null) return; // cancelled

              fetch("/api/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reporter: me, reported: withBuddy, reason })
              })
                .then(() => alert("Thanks, your report has been submitted."))
                .catch(() => alert("Something went wrong submitting your report."));
            }

            function blockUser() {
              toggleMenu();
              const confirmed = confirm(
                "Block " + withBuddy + "? You won't see each other's messages or buddy list entries anymore."
              );
              if (!confirmed) return;
              window.location.href = "/block-user?blocker=" + encodeURIComponent(me) + "&blocked=" + encodeURIComponent(withBuddy);
            }

            // ---- Buzz (grab attention) ----
            let lastBuzzSent = 0;

            function playBuzzSound() {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              const ctx = new AudioCtx();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.frequency.value = 320;
              osc.type = "square";
              osc.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.12, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.35);
              setTimeout(() => ctx.close(), 500);
            }

            function buzz() {
              const now = Date.now();
              if (now - lastBuzzSent < 3000) return; // simple cooldown to avoid spamming
              lastBuzzSent = now;
              socket.emit("buzz", { room, from: me });
            }

            socket.on("buzz", ({ from }) => {
              document.body.classList.remove("buzzing");
              void document.body.offsetWidth; // restart animation
              document.body.classList.add("buzzing");
              playBuzzSound();
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            });

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

            let callMode = "video"; // "video" or "audio"

            async function getLocalStream(mode) {
              if (!localStream) {
                localStream = await navigator.mediaDevices.getUserMedia({
                  video: mode !== "audio",
                  audio: true
                });
              }
              return localStream;
            }

            function applyCallModeUI(mode) {
              const bigVideo = document.getElementById("bigVideo");
              const smallVideo = document.getElementById("smallVideo");
              const avatar = document.getElementById("audioCallAvatar");

              if (mode === "audio") {
                bigVideo.style.display = "none";
                smallVideo.style.display = "none";
                avatar.style.display = "flex";
                avatar.textContent = withBuddy.charAt(0).toUpperCase();
              } else {
                bigVideo.style.display = "block";
                smallVideo.style.display = "block";
                avatar.style.display = "none";
              }
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

            let isCallingOut = false;
            let lastOfferSent = null;

            async function startCall(mode) {
              callMode = mode || "video";
              showCallScreen();
              applyCallModeUI(callMode);
              document.getElementById("callStatus").textContent = "Calling " + withBuddy + "...";
              playRingtone();

              const stream = await getLocalStream(callMode);
              document.getElementById("smallVideo").srcObject = stream;

              peerConnection = createPeerConnection();
              stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

              const offer = await peerConnection.createOffer();
              await peerConnection.setLocalDescription(offer);

              isCallingOut = true;
              lastOfferSent = { offer, mode: callMode };
              socket.emit("call-user", { room, from: me, to: withBuddy, offer, mode: callMode });
            }

            // If the person we're calling opens the chat page late (e.g. via a
            // notification), they'll ask us to resend the offer so they don't miss it.
            socket.on("request-current-offer", () => {
              if (isCallingOut && lastOfferSent) {
                socket.emit("call-user", { room, from: me, to: withBuddy, offer: lastOfferSent.offer, mode: lastOfferSent.mode });
              }
            });

            // If we arrived on this page because of a call notification, ask the
            // caller to (re)send their offer, and auto-answer once it arrives.
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get("autoAnswer") === "1") {
              window.autoAnswerPending = true;
              setTimeout(() => socket.emit("request-current-offer", { room }), 500);
            }

            socket.on("incoming-call", ({ from, offer, mode }) => {
              window.incomingOffer = offer;
              window.incomingCallMode = mode || "video";

              if (window.autoAnswerPending) {
                window.autoAnswerPending = false;
                answerCall();
                return;
              }

              document.getElementById("callerName").textContent = from + (mode === "audio" ? " (Audio Call)" : " (Video Call)");
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
              callMode = window.incomingCallMode || "video";
              showCallScreen();
              applyCallModeUI(callMode);
              document.getElementById("callStatus").textContent = "In call with " + withBuddy;

              const stream = await getLocalStream(callMode);
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
              isCallingOut = false;
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
              isCallingOut = false;
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
  maxHttpBufferSize: 15 * 1024 * 1024 // allow larger messages for file sharing (8MB files, base64-encoded)
});

const ringingRoomCallers = new Map(); // room -> socket.id of whoever is currently ringing it
const activeCallRooms = new Set();
const groupRoomMembers = {}; // room -> { socketId: {name, gender} }
const roomRosterMembers = {}; // room -> { socketId: {name, gender} } (lightweight, no video)
const groupChatHistory = {}; // room -> [ recent messages ]
let groupMessageIdCounter = 0;
const privateRoomMembers = {}; // privateRoomId -> { socketId: name }
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

  // ---- Personal notification channel: lets us reach someone wherever they are in the app ----
  socket.on("register-user", ({ name }) => {
    if (!name) return;
    socket.join("user-" + name);
    socket.data.registeredName = name;
  });

  // ---- Room roster (chat-first landing, no camera needed) ----
  socket.on("join-room-chat", ({ room, name, gender }) => {
    socket.join("room-" + room);
    socket.data.chatRoom = room;
    socket.data.chatName = name;
    socket.data.chatGender = gender;

    if (!roomRosterMembers[room]) roomRosterMembers[room] = {};
    roomRosterMembers[room][socket.id] = { name, gender };

    // Send everyone currently in the room an updated roster (minus themselves)
    const fullRoster = Object.entries(roomRosterMembers[room]).map(([id, info]) => ({
      id, name: info.name, gender: info.gender
    }));
    fullRoster.forEach((p) => {
      io.to(p.id).emit("roster-update", fullRoster.filter((other) => other.id !== p.id));
    });
  });

  // ---- Group call signaling ----
  socket.on("join-group", ({ room, name, gender }) => {
    socket.join("group-" + room);
    socket.data.groupRoom = room;
    socket.data.name = name;
    socket.data.gender = gender;

    if (!groupRoomMembers[room]) groupRoomMembers[room] = {};

    // Tell the new person who is already here
    const existingPeers = Object.entries(groupRoomMembers[room]).map(([id, info]) => ({
      id,
      name: info.name,
      gender: info.gender
    }));
    socket.emit("existing-peers", existingPeers);

    // Add them to the room, then tell everyone else
    groupRoomMembers[room][socket.id] = { name, gender };
    socket.to("group-" + room).emit("new-peer", { id: socket.id, name, gender });
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

  // ---- Group text chat (with recent history buffer) ----
  socket.on("group-chat-message", (msg) => {
    if (!groupChatHistory[msg.room]) groupChatHistory[msg.room] = [];
    groupMessageIdCounter++;
    msg.id = groupMessageIdCounter;
    groupChatHistory[msg.room].push(msg);
    if (groupChatHistory[msg.room].length > 50) groupChatHistory[msg.room].shift();

    io.to("room-" + msg.room).emit("group-chat-message", msg);
  });

  socket.on("get-group-chat-history", ({ room }) => {
    socket.emit("group-chat-history", groupChatHistory[room] || []);
  });

  socket.on("group-edit-message", ({ room, id, newText }) => {
    const history = groupChatHistory[room];
    if (!history) return;
    const msg = history.find((m) => m.id === id);
    if (!msg) return;
    msg.text = newText;
    io.to("room-" + room).emit("group-message-edited", { id, newText });
  });

  socket.on("group-delete-message", ({ room, id }) => {
    if (!groupChatHistory[room]) return;
    groupChatHistory[room] = groupChatHistory[room].filter((m) => m.id !== id);
    io.to("room-" + room).emit("group-message-deleted", { id });
  });

  // ---- Private calls within a group room ----
  socket.on("private-call-invite", ({ room, to, fromId, fromName }) => {
    io.to(to).emit("private-call-invite", { room, fromId, fromName });
  });

  socket.on("private-call-response", ({ toId, accepted, privateRoom, fromName }) => {
    io.to(toId).emit("private-call-response", { accepted, privateRoom, fromName });
  });

  socket.on("join-private", ({ privateRoom, name }) => {
    socket.join("private-" + privateRoom);
    socket.data.privateRoom = privateRoom;

    if (!privateRoomMembers[privateRoom]) privateRoomMembers[privateRoom] = {};

    const existingPeers = Object.entries(privateRoomMembers[privateRoom]).map(([id, n]) => ({ id, name: n }));
    socket.emit("private-existing-peers", existingPeers);

    privateRoomMembers[privateRoom][socket.id] = name;
    socket.to("private-" + privateRoom).emit("private-new-peer", { id: socket.id, name });
  });

  socket.on("private-offer", ({ to, from, offer, name }) => {
    io.to(to).emit("private-offer", { from, offer, name });
  });

  socket.on("private-answer", ({ to, from, answer }) => {
    io.to(to).emit("private-answer", { from, answer });
  });

  socket.on("private-ice-candidate", ({ to, from, candidate }) => {
    io.to(to).emit("private-ice-candidate", { from, candidate });
  });

  socket.on("leave-private", ({ privateRoom }) => {
    if (privateRoomMembers[privateRoom]) {
      delete privateRoomMembers[privateRoom][socket.id];
      socket.to("private-" + privateRoom).emit("private-peer-left", { id: socket.id });
    }
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
    // If this socket was in the middle of a 1-on-1 call, free up the room
    // so it doesn't stay stuck as "busy" forever, and let the other side know.
    const callRoom = socket.data.activeCallRoom;
    if (callRoom) {
      ringingRoomCallers.delete(callRoom);
      activeCallRooms.delete(callRoom);
      socket.to(callRoom).emit("hang-up");
    }

    const room = socket.data.groupRoom;
    if (room && groupRoomMembers[room]) {
      delete groupRoomMembers[room][socket.id];
      socket.to("group-" + room).emit("peer-left", { id: socket.id });
    }

    const chatRoom = socket.data.chatRoom;
    if (chatRoom && roomRosterMembers[chatRoom]) {
      delete roomRosterMembers[chatRoom][socket.id];
      const fullRoster = Object.entries(roomRosterMembers[chatRoom]).map(([id, info]) => ({
        id, name: info.name, gender: info.gender
      }));
      fullRoster.forEach((p) => {
        io.to(p.id).emit("roster-update", fullRoster.filter((other) => other.id !== p.id));
      });
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
    if (msg.from && msg.to && isBlockedEitherWay(msg.from, msg.to)) {
      return; // silently drop messages between blocked users
    }

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

    // Notify the recipient wherever they currently are in the app
    if (msg.to) {
      let preview = "New message";
      if (msg.type === "image") preview = "📷 Photo";
      else if (msg.type === "file") preview = "📎 " + (msg.fileName || "File");
      else if (msg.text) preview = msg.text.slice(0, 60);

      io.to("user-" + msg.to).emit("message-notification", { from: msg.from, preview });
    }
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
  socket.on("buzz", ({ room, from }) => {
    socket.to(room).emit("buzz", { from });
  });

  socket.on("call-user", ({ room, from, to, offer, mode }) => {
    const currentCaller = ringingRoomCallers.get(room);
    const alreadyRingingByOther = currentCaller && currentCaller !== socket.id;

    if (activeCallRooms.has(room) || alreadyRingingByOther) {
      socket.emit("call-busy");
      return;
    }
    ringingRoomCallers.set(room, socket.id);
    socket.data.activeCallRoom = room;
    socket.to(room).emit("incoming-call", { from, offer, mode });

    // Also notify the callee's personal channel, in case they're not on this exact chat page
    if (to) {
      io.to("user-" + to).emit("incoming-call-request", { room, from, mode });
    }
  });

  // A callee who arrived late (e.g. via a notification) asks the caller to resend the offer
  socket.on("request-current-offer", ({ room }) => {
    socket.to(room).emit("request-current-offer");
  });

  socket.on("make-answer", ({ room, answer }) => {
    ringingRoomCallers.delete(room);
    activeCallRooms.add(room);
    socket.data.activeCallRoom = room;
    socket.to(room).emit("call-answered", { answer });
  });

  socket.on("call-rejected", ({ room }) => {
    ringingRoomCallers.delete(room);
    socket.to(room).emit("call-rejected");
  });

  socket.on("ice-candidate", ({ room, candidate }) => {
    socket.to(room).emit("ice-candidate-received", { candidate });
  });

  socket.on("hang-up", ({ room }) => {
    ringingRoomCallers.delete(room);
    activeCallRooms.delete(room);
    socket.data.activeCallRoom = null;
    socket.to(room).emit("hang-up");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});