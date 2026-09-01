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
try { db.exec("ALTER TABLE users ADD COLUMN profile_pic TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_from TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_preview TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN zodiac_sign TEXT"); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS streaks (
    user_a TEXT,
    user_b TEXT,
    streak_count INTEGER DEFAULT 0,
    last_chat_date TEXT,
    PRIMARY KEY (user_a, user_b)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS time_capsules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT,
    to_user TEXT,
    text TEXT,
    deliver_at TEXT,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    type TEXT,
    content TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

function streakKey(a, b) {
  return [a, b].sort();
}

function bumpStreak(a, b) {
  const [userA, userB] = streakKey(a, b);
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT * FROM streaks WHERE user_a = ? AND user_b = ?").get(userA, userB);

  if (!row) {
    db.prepare("INSERT INTO streaks (user_a, user_b, streak_count, last_chat_date) VALUES (?, ?, 1, ?)").run(userA, userB, today);
    return 1;
  }
  if (row.last_chat_date === today) return row.streak_count; // already counted today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newCount = row.last_chat_date === yesterday ? row.streak_count + 1 : 1;
  db.prepare("UPDATE streaks SET streak_count = ?, last_chat_date = ? WHERE user_a = ? AND user_b = ?").run(newCount, today, userA, userB);
  return newCount;
}

function getStreak(a, b) {
  const [userA, userB] = streakKey(a, b);
  const row = db.prepare("SELECT * FROM streaks WHERE user_a = ? AND user_b = ?").get(userA, userB);
  if (!row) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (row.last_chat_date !== today && row.last_chat_date !== yesterday) return 0; // streak broken
  return row.streak_count;
}

// Check for due time capsules every minute and deliver them
setInterval(() => {
  const now = new Date().toISOString();
  const due = db.prepare("SELECT * FROM time_capsules WHERE delivered = 0 AND deliver_at <= ?").all(now);
  due.forEach((capsule) => {
    const result = db.prepare(
      "INSERT INTO messages (from_user, to_user, text, type) VALUES (?, ?, ?, 'text')"
    ).run(capsule.from_user, capsule.to_user, "⏳ Time Capsule: " + capsule.text);

    const room = [capsule.from_user, capsule.to_user].sort().join("-");
    const msg = { id: result.lastInsertRowid, room, from: capsule.from_user, to: capsule.to_user, type: "text", text: "⏳ Time Capsule: " + capsule.text };
    io.to(room).emit("chat message", msg);
    io.to("user-" + capsule.to_user).emit("message-notification", { from: capsule.from_user, preview: "⏳ A time capsule message arrived!" });

    db.prepare("UPDATE time_capsules SET delivered = 1 WHERE id = ?").run(capsule.id);
  });
}, 60000);

db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER,
    user_name TEXT,
    emoji TEXT,
    PRIMARY KEY (message_id, user_name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS read_receipts (
    reader_name TEXT,
    other_name TEXT,
    last_read_id INTEGER,
    PRIMARY KEY (reader_name, other_name)
  )
`);

function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM reactions WHERE message_id IN (${placeholders})`).all(...messageIds);
  const grouped = {};
  rows.forEach((r) => {
    if (!grouped[r.message_id]) grouped[r.message_id] = {};
    if (!grouped[r.message_id][r.emoji]) grouped[r.message_id][r.emoji] = [];
    grouped[r.message_id][r.emoji].push(r.user_name);
  });
  return grouped;
}

function genderBadge(gender) {
  if (gender === "Male") return '<span style="color:#5aa9ff;">♂</span>';
  if (gender === "Female") return '<span style="color:#ff8fc7;">♀</span>';
  if (gender === "Other") return '<span style="color:#c58fff;">⚧</span>';
  return "";
}

function avatarHTML(name, profilePic, sizeStyle) {
  if (profilePic) {
    return `<img src="${profilePic}" style="${sizeStyle} border-radius:50%; object-fit:cover;" />`;
  }
  return `<span style="${sizeStyle} border-radius:50%; background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e; display:flex; align-items:center; justify-content:center; font-weight:700;">${name.charAt(0).toUpperCase()}</span>`;
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

function reactionsBarHTML(msgId, reactionsForMsg) {
  if (!reactionsForMsg) return "";
  const entries = Object.entries(reactionsForMsg);
  if (!entries.length) return "";
  return (
    '<div class="reactionsBar">' +
    entries.map(([emoji, users]) => `<span class="reactionPill" onclick="toggleReaction(${msgId}, '${emoji}')">${emoji} ${users.length}</span>`).join("") +
    "</div>"
  );
}

function replyPreviewHTML(m) {
  if (!m.reply_to_id) return "";
  return `<div class="replyPreview">↩ ${m.reply_to_from}: ${(m.reply_to_preview || "").slice(0, 60)}</div>`;
}

function ticksHTML(m, mine, otherLastReadId) {
  if (!mine) return "";
  const read = otherLastReadId && m.id <= otherLastReadId;
  return `<span class="msgTicks" style="color:${read ? "#4fc3f7" : "rgba(255,255,255,0.4)"};">${read ? "✓✓" : "✓"}</span>`;
}

function renderMessageHTML(m, viewerName, reactionsMap, otherLastReadId) {
  const mine = m.from_user === viewerName;
  const actions = mine
    ? `<span class="msgActions">${m.type === "text" ? `<button onclick="editMsg(${m.id}, this)">Edit</button>` : ""}<button onclick="deleteMsg(${m.id})">Delete</button></span>`
    : `<span class="msgActions"><button onclick="startReply(${m.id}, '${m.from_user}')">Reply</button></span>`;
  const reactBtn = `<button class="reactBtn" onclick="openEmojiReactPicker(${m.id})">+</button>`;
  const reactions = reactionsMap ? reactionsBarHTML(m.id, reactionsMap[m.id]) : "";
  const reply = replyPreviewHTML(m);
  const ticks = ticksHTML(m, mine, otherLastReadId);

  if (m.type === "image") {
    return `<div class="msgRow" data-id="${m.id}">${reply}<b>${m.from_user}:</b><br/><img src="${m.file_data}" onclick="openImageViewer('${m.file_data}')" style="max-width:220px; border-radius:6px; margin-top:4px; cursor:pointer;" />${ticks}${actions}${reactBtn}${reactions}</div>`;
  } else if (m.type === "file") {
    return `<div class="msgRow" data-id="${m.id}">${reply}<b>${m.from_user}:</b><br/><a href="${m.file_data}" download="${m.file_name}">📎 ${m.file_name}</a>${ticks}${actions}${reactBtn}${reactions}</div>`;
  } else if (m.type === "voice") {
    return `<div class="msgRow" data-id="${m.id}">${reply}<b>${m.from_user}:</b><br/><audio controls src="${m.file_data}" style="height:32px; max-width:200px;"></audio>${ticks}${actions}${reactBtn}${reactions}</div>`;
  } else if (m.type === "location") {
    let loc = {};
    try { loc = JSON.parse(m.file_data); } catch (e) {}
    const mapId = loc.live ? loc.liveId : "loc-" + m.id;
    const liveBadge = loc.live ? `<div id="${mapId}-badge" style="font-size:11px; color:#e33; margin-top:2px;">🔴 Live location</div>` : "";
    return `<div class="msgRow" data-id="${m.id}">${reply}<b>${m.from_user}:</b><br/>
      <div id="${mapId}" style="width:200px; height:120px; border-radius:8px; margin-top:4px;" onclick="window.open('https://www.google.com/maps?q=${loc.lat},${loc.lng}','_blank')"></div>
      ${liveBadge}
      <script>renderLocationMap('${mapId}', ${loc.lat}, ${loc.lng});</script>
      ${ticks}${actions}${reactBtn}${reactions}</div>`;
  } else {
    const translateBtn = `<button class="reactBtn" onclick="translateMsg(${m.id})" title="Translate">🌐</button>`;
    return `<div class="msgRow" data-id="${m.id}">${reply}<b>${m.from_user}:</b> <span class="msgText">${m.text}</span>${ticks}${actions}${reactBtn}${translateBtn}${reactions}<div class="translationBox" id="translation-${m.id}" style="display:none;"></div></div>`;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) req.destroy(); // 10MB safety limit
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

  if (req.method === "POST" && parsedUrl.pathname === "/api/schedule-capsule") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { from, to, text, deliverAt } = body;
      if (!from || !to || !text || !deliverAt) throw new Error("Missing required fields");

      db.prepare(
        "INSERT INTO time_capsules (from_user, to_user, text, deliver_at) VALUES (?, ?, ?, ?)"
      ).run(from, to, text.slice(0, 1000), deliverAt);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/translate") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { text, targetLanguage } = body;
      if (!text || !targetLanguage) throw new Error("Missing text or target language");

      const reply = await callClaude(
        [{ role: "user", content: text }],
        `Translate the user's message into ${targetLanguage}. Reply with ONLY the translation, nothing else - no notes, no explanation, no quotation marks.`
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ translation: reply.trim() }));
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

  if (req.method === "POST" && parsedUrl.pathname === "/api/post-status") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { name, type, content } = body;
      if (!name || !type || !content) throw new Error("Missing required fields");
      if (content.length > 3 * 1024 * 1024) throw new Error("Status content too large");

      db.prepare("INSERT INTO statuses (user_name, type, content) VALUES (?, ?, ?)").run(name, type, content);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsedUrl.pathname === "/api/ice-config") {
    // Uses real TURN credentials from environment variables if you've set them up
    // (recommended — the free demo TURN below gets overloaded on mobile networks).
    // Falls back to the free public demo TURN service otherwise.
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

    if (process.env.METERED_DOMAIN && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
      const domainValue = process.env.METERED_DOMAIN.trim();
      const uname = process.env.TURN_USERNAME;
      const pass = process.env.TURN_PASSWORD;

      if (domainValue.includes("turn:") || domainValue.includes(",")) {
        // A full list of TURN URLs was pasted in here (possibly comma-separated) rather than a bare domain
        const urls = domainValue.split(",").map((u) => u.trim()).filter(Boolean);
        urls.forEach((url) => {
          iceServers.push({ urls: url, username: uname, credential: pass });
        });
      } else {
        // A bare domain like "global.relay.metered.ca" — build the standard 4 TURN URLs from it
        iceServers.push(
          { urls: `turn:${domainValue}:80`, username: uname, credential: pass },
          { urls: `turn:${domainValue}:80?transport=tcp`, username: uname, credential: pass },
          { urls: `turn:${domainValue}:443`, username: uname, credential: pass },
          { urls: `turns:${domainValue}:443?transport=tcp`, username: uname, credential: pass }
        );
      }
    } else if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      // TURN_URLS can be a comma-separated list, e.g. from Metered's "Show ICE Servers Array"
      const urls = process.env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
      urls.forEach((url) => {
        iceServers.push({
          urls: url,
          username: process.env.TURN_USERNAME,
          credential: process.env.TURN_CREDENTIAL
        });
      });
    } else if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
      });
    } else {
      iceServers.push(
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
      );
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/set-zodiac") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { name, zodiacSign } = body;
      if (!name || !zodiacSign) throw new Error("Missing required fields");

      db.prepare("UPDATE users SET zodiac_sign = ? WHERE name = ?").run(zodiacSign, name);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/set-profile-pic") {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const { name, imageData } = body;
      if (!name || !imageData) throw new Error("Missing required fields");
      if (imageData.length > 6 * 1024 * 1024) throw new Error("Image too large");

      db.prepare("UPDATE users SET profile_pic = ? WHERE name = ?").run(imageData, name);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
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
          <script>
            // If already signed in (and haven't logged out), skip straight to Welcome
            const savedUser = localStorage.getItem("connectbondhu_user");
            if (savedUser) {
              try {
                const u = JSON.parse(savedUser);
                window.location.href = "/welcome?name=" + encodeURIComponent(u.name) + "&gender=" + encodeURIComponent(u.gender || "");
              } catch (e) {}
            }
          </script>
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
              localStorage.setItem("connectbondhu_user", JSON.stringify({ name, gender }));
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

    const myUserRow = db.prepare("SELECT profile_pic, zodiac_sign FROM users WHERE name = ?").get(name) || {};
    const myProfilePic = myUserRow.profile_pic || "";
    const myZodiacSign = myUserRow.zodiac_sign || "";

    const allUsers = db.prepare("SELECT name, gender, profile_pic FROM users").all();
    const buddyListHTML = allUsers
      .filter((u) => u.name !== name && !isBlockedEitherWay(name, u.name))
      .map(
        (u) => `
        <a class="buddyRow" data-name="${u.name}" href="/chat?me=${name}&with=${u.name}">
          ${avatarHTML(u.name, u.profile_pic, "width:36px; height:36px; flex-shrink:0;")}
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
            <div style="position:relative; width:64px; height:64px; margin:0 auto 8px;">
              <div id="myAvatarDisplay">${avatarHTML(name, myProfilePic, "width:64px; height:64px; font-size:24px;")}</div>
              <button onclick="document.getElementById('profilePicInput').click()" style="position:absolute; bottom:-2px; right:-2px; width:24px; height:24px; border-radius:50%; background:#ffd966; border:2px solid #3d0f6e; font-size:11px; cursor:pointer;">✏️</button>
              <input type="file" id="profilePicInput" accept="image/*" style="display:none;" onchange="uploadProfilePic()" />
            </div>
            <h1>Welcome, ${name}!</h1>
            <p>What would you like to do?</p>
          </div>

          <div class="section" id="horoscopeSection">
            ${myZodiacSign ? `
            <div id="dailyHoroscopeCard" style="display:none; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.18); border-radius:14px; padding:14px; margin-bottom:6px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span style="font-weight:700; font-size:13px;">🔮 Today's Horoscope (${myZodiacSign})</span>
                <span onclick="dismissHoroscope()" style="cursor:pointer; color:rgba(255,255,255,0.6); font-size:16px;">&times;</span>
              </div>
              <p id="dailyHoroscopeText" style="font-size:12.5px; color:rgba(255,255,255,0.85); margin:0;">Loading...</p>
            </div>` : `
            <div style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:14px; padding:12px; text-align:center; font-size:12.5px;">
              🔮 Set your zodiac sign to get a daily horoscope card:
              <select id="zodiacQuickSet" style="margin-top:8px; padding:6px; border-radius:8px; width:100%;">
                <option value="">Choose sign...</option>
                <option>Aries</option><option>Taurus</option><option>Gemini</option><option>Cancer</option>
                <option>Leo</option><option>Virgo</option><option>Libra</option><option>Scorpio</option>
                <option>Sagittarius</option><option>Capricorn</option><option>Aquarius</option><option>Pisces</option>
              </select>
              <button onclick="saveZodiacQuick()" style="margin-top:8px; padding:8px 16px; border:none; border-radius:8px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer;">Save</button>
            </div>`}
          </div>

          <div class="section">
            <p class="sectionTitle">Quick Access</p>
            <div class="featureGrid">
              <a class="featureCard" href="/status?me=${name}">
                <span class="icon">📸</span><span class="label">Status</span>
              </a>
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
              <a class="buddyRow" href="javascript:void(0)" onclick="logoutUser()">
                <span class="buddyAvatar" style="background:#e33; color:white;">🚪</span>
                <span class="buddyName">Logout</span>
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
            const myZodiac = "${myZodiacSign}";

            function logoutUser() {
              if (!confirm("Log out of ConnectBondhu?")) return;
              localStorage.removeItem("connectbondhu_user");
              window.location.href = "/";
            }

            async function saveZodiacQuick() {
              const sign = document.getElementById("zodiacQuickSet").value;
              if (!sign) return;
              try {
                await fetch("/api/set-zodiac", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: myName, zodiacSign: sign })
                });
                window.location.reload();
              } catch (err) {
                alert("Could not save your zodiac sign.");
              }
            }

            function dismissHoroscope() {
              document.getElementById("dailyHoroscopeCard").style.display = "none";
              localStorage.setItem("horoscopeDismissed_" + myName, new Date().toISOString().slice(0, 10));
            }

            async function loadDailyHoroscopeIfNeeded() {
              if (!myZodiac) return;
              const today = new Date().toISOString().slice(0, 10);
              const lastShown = localStorage.getItem("horoscopeShownDate_" + myName);
              const dismissed = localStorage.getItem("horoscopeDismissed_" + myName);
              if (dismissed === today) return; // already dismissed today

              const card = document.getElementById("dailyHoroscopeCard");
              if (!card) return;
              card.style.display = "block";

              if (lastShown === today) {
                const cached = localStorage.getItem("horoscopeText_" + myName);
                if (cached) {
                  document.getElementById("dailyHoroscopeText").textContent = cached;
                  return;
                }
              }

              try {
                const res = await fetch("/api/ai-astrology", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ zodiacSign: myZodiac })
                });
                const data = await res.json();
                const text = data.error ? "Could not load your horoscope right now." : data.reply;
                document.getElementById("dailyHoroscopeText").textContent = text;
                localStorage.setItem("horoscopeShownDate_" + myName, today);
                localStorage.setItem("horoscopeText_" + myName, text);
              } catch (err) {
                document.getElementById("dailyHoroscopeText").textContent = "Could not load your horoscope right now.";
              }
            }

            loadDailyHoroscopeIfNeeded();

            function uploadProfilePic() {
              const input = document.getElementById("profilePicInput");
              const file = input.files[0];
              if (!file) return;
              if (file.size > 5 * 1024 * 1024) {
                alert("Please choose an image under 5MB.");
                input.value = "";
                return;
              }
              const reader = new FileReader();
              reader.onload = async () => {
                try {
                  const res = await fetch("/api/set-profile-pic", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: myName, imageData: reader.result })
                  });
                  const data = await res.json();
                  if (data.error) {
                    alert("Error: " + data.error);
                  } else {
                    document.getElementById("myAvatarDisplay").innerHTML =
                      '<img src="' + reader.result + '" style="width:64px; height:64px; border-radius:50%; object-fit:cover;" />';
                  }
                } catch (err) {
                  alert("Could not upload photo.");
                }
              };
              reader.readAsDataURL(file);
            }
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

  } else if (parsedUrl.pathname === "/status") {
    const me = parsedUrl.query.me || "Guest";

    const myStatuses = db.prepare(
      "SELECT * FROM statuses WHERE user_name = ? AND created_at > datetime('now','-1 day') ORDER BY created_at DESC"
    ).all(me);

    const allRecent = db.prepare(
      "SELECT * FROM statuses WHERE created_at > datetime('now','-1 day') ORDER BY created_at DESC"
    ).all();

    const buddyStatusMap = {};
    allRecent.forEach((s) => {
      if (s.user_name === me) return;
      if (isBlockedEitherWay(me, s.user_name)) return;
      if (!buddyStatusMap[s.user_name]) buddyStatusMap[s.user_name] = [];
      buddyStatusMap[s.user_name].push(s);
    });

    const buddyRowsHTML = Object.keys(buddyStatusMap).length
      ? Object.entries(buddyStatusMap)
          .map(
            ([user, statuses]) => `
        <div class="statusRow" onclick='openStatusViewer(${JSON.stringify(user)})'>
          <span class="statusRingAvatar">${user.charAt(0).toUpperCase()}</span>
          <span>
            <div style="font-weight:600; font-size:13.5px;">${user}</div>
            <div style="font-size:11px; color:rgba(255,255,255,0.55);">${statuses.length} update${statuses.length > 1 ? "s" : ""}</div>
          </span>
        </div>`
          )
          .join("")
      : `<div style="padding:16px; text-align:center; font-size:12.5px; color:rgba(255,255,255,0.5);">No updates from buddies in the last 24 hours.</div>`;

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
            .section { max-width:440px; margin:0 auto 16px; padding:0 16px; }
            .sectionTitle { font-size:12px; text-transform:uppercase; letter-spacing:0.8px; color:rgba(255,255,255,0.6); margin:0 0 8px 4px; }

            .myStatusCard { background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.15); border-radius:14px; padding:14px; display:flex; align-items:center; gap:12px; cursor:pointer; }
            .statusRingAvatar {
              width:44px; height:44px; border-radius:50%; flex-shrink:0;
              background:linear-gradient(135deg,#ffd966,#ff9d3d); color:#3d0f6e; font-weight:700;
              display:flex; align-items:center; justify-content:center; font-size:16px;
              border:2px solid #ffd966;
            }
            .statusRow { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); border-radius:12px; padding:10px 12px; display:flex; align-items:center; gap:12px; margin-bottom:8px; cursor:pointer; }

            #addStatusModal, #statusViewer { display:none; position:fixed; top:0; left:0; right:0; bottom:0; z-index:2000; align-items:center; justify-content:center; }
            #addStatusModal { background:rgba(0,0,0,0.6); }
            #addStatusModal .box { background:white; color:#333; border-radius:14px; padding:20px; max-width:320px; width:90%; }
            #addStatusModal textarea { width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px; margin-bottom:10px; }
            #statusViewer { background:#000; flex-direction:column; }
            #statusViewerContent { flex:1; display:flex; align-items:center; justify-content:center; width:100%; padding:20px; text-align:center; }
            #statusViewerContent img { max-width:100%; max-height:80vh; border-radius:8px; }
            #statusViewerText { font-size:20px; font-weight:600; padding:30px; background:linear-gradient(135deg,#3d0f6e,#9333ea); border-radius:14px; }
            .statusViewerBar { display:flex; justify-content:space-between; align-items:center; padding:14px; color:white; }
            .statusNav { position:absolute; top:0; bottom:0; width:33%; }
          </style>
        </head>
        <body>
          <div class="header">
            <a class="backLink" href="/welcome?name=${me}">&larr;</a>
            <h1>📸 Status</h1>
          </div>

          <div class="section">
            <div class="myStatusCard" onclick="${myStatuses.length ? `openStatusViewer(${JSON.stringify(me)})` : "openAddStatus()"}">
              <span class="statusRingAvatar">${me.charAt(0).toUpperCase()}</span>
              <span style="flex:1;">
                <div style="font-weight:600; font-size:14px;">My Status</div>
                <div style="font-size:11.5px; color:rgba(255,255,255,0.6);">${myStatuses.length ? myStatuses.length + " update(s) in the last 24h \u2014 tap to view" : "Tap to post your first status"}</div>
              </span>
              <button onclick="event.stopPropagation(); openAddStatus();" style="padding:8px 12px; border:none; border-radius:16px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer;">+ Add</button>
            </div>
          </div>

          <div class="section">
            <p class="sectionTitle">Buddy Updates</p>
            ${buddyRowsHTML}
          </div>

          <div id="addStatusModal">
            <div class="box">
              <h3 style="margin:0 0 10px;">Post a Status</h3>
              <textarea id="statusTextInput" rows="3" placeholder="What's on your mind?"></textarea>
              <input type="file" id="statusImageInput" accept="image/*" style="margin-bottom:10px;" />
              <div style="display:flex; gap:8px;">
                <button onclick="postStatus()" style="flex:1; padding:10px; border:none; border-radius:8px; background:#9333ea; color:white; font-weight:700; cursor:pointer;">Post</button>
                <button onclick="closeAddStatus()" style="flex:1; padding:10px; border:none; border-radius:8px; background:#eee; cursor:pointer;">Cancel</button>
              </div>
            </div>
          </div>

          <div id="statusViewer">
            <div class="statusViewerBar">
              <span id="statusViewerName" style="font-weight:600;"></span>
              <span onclick="closeStatusViewer()" style="cursor:pointer; font-size:22px;">&times;</span>
            </div>
            <div id="statusViewerContent" style="position:relative;">
              <div class="statusNav" style="left:0;" onclick="prevStatus()"></div>
              <div class="statusNav" style="right:0;" onclick="nextStatus()"></div>
              <div id="statusViewerInner"></div>
            </div>
          </div>

          <script>
            const myName = "${me}";
            const allBuddyStatuses = ${JSON.stringify(buddyStatusMap)};
            const myStatusesData = ${JSON.stringify(myStatuses)};

            function openAddStatus() {
              document.getElementById("addStatusModal").style.display = "flex";
            }
            function closeAddStatus() {
              document.getElementById("addStatusModal").style.display = "none";
              document.getElementById("statusTextInput").value = "";
              document.getElementById("statusImageInput").value = "";
            }

            async function postStatus() {
              const text = document.getElementById("statusTextInput").value.trim();
              const fileInput = document.getElementById("statusImageInput");
              const file = fileInput.files[0];

              if (file) {
                if (file.size > 3 * 1024 * 1024) { alert("Please choose an image under 3MB."); return; }
                const reader = new FileReader();
                reader.onload = async () => {
                  await submitStatus("image", reader.result);
                };
                reader.readAsDataURL(file);
              } else if (text) {
                await submitStatus("text", text);
              } else {
                alert("Write something or choose a photo first.");
              }
            }

            async function submitStatus(type, content) {
              try {
                const res = await fetch("/api/post-status", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: myName, type, content })
                });
                const data = await res.json();
                if (data.error) { alert("Error: " + data.error); return; }
                closeAddStatus();
                window.location.reload();
              } catch (err) {
                alert("Could not post status.");
              }
            }

            let viewerStatuses = [];
            let viewerIndex = 0;

            function openStatusViewer(user) {
              viewerStatuses = user === myName ? myStatusesData : (allBuddyStatuses[user] || []);
              if (!viewerStatuses.length) return;
              viewerIndex = 0;
              document.getElementById("statusViewerName").textContent = user;
              document.getElementById("statusViewer").style.display = "flex";
              renderViewerFrame();
            }

            function renderViewerFrame() {
              const s = viewerStatuses[viewerIndex];
              const inner = document.getElementById("statusViewerInner");
              if (s.type === "image") {
                inner.innerHTML = '<img src="' + s.content + '" />';
              } else {
                inner.innerHTML = '<div id="statusViewerText">' + s.content + '</div>';
              }
            }

            function nextStatus() {
              if (viewerIndex < viewerStatuses.length - 1) { viewerIndex++; renderViewerFrame(); }
              else closeStatusViewer();
            }
            function prevStatus() {
              if (viewerIndex > 0) { viewerIndex--; renderViewerFrame(); }
            }
            function closeStatusViewer() {
              document.getElementById("statusViewer").style.display = "none";
            }
          </script>
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

    const customRoomRow = db.prepare("SELECT created_by FROM custom_rooms WHERE room_id = ?").get(room);
    const roomOwner = customRoomRow ? customRoomRow.created_by : "";

    const myBuddiesForInvite = db.prepare("SELECT name FROM users WHERE name != ?").all(me)
      .filter((u) => !isBlockedEitherWay(me, u.name))
      .map((u) => u.name);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
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

            #snlBoardWrap {
              position:relative;
              width:314px;
              margin:14px auto;
              padding:8px;
              background:linear-gradient(145deg,#6b4423,#4a2f18);
              border-radius:12px;
              box-shadow:
                0 8px 20px rgba(0,0,0,0.5),
                inset 0 2px 4px rgba(255,255,255,0.15),
                inset 0 -3px 6px rgba(0,0,0,0.4);
            }
            #snlBoard {
              display:grid;
              grid-template-columns: repeat(10, 28px);
              grid-template-rows: repeat(10, 28px);
              gap:2px;
              width:fit-content;
              position:relative;
              z-index:1;
              border-radius:4px;
              overflow:hidden;
              box-shadow: inset 0 2px 8px rgba(0,0,0,0.5);
            }
            .snl-cell {
              background:linear-gradient(145deg,#f0dcae,#e0c589);
              font-size:9px;
              font-weight:700;
              color:#6b4423;
              display:flex;
              align-items:flex-start;
              justify-content:flex-start;
              padding:2px;
              position:relative;
              box-shadow: inset 0 1px 2px rgba(255,255,255,0.5), inset 0 -1px 2px rgba(0,0,0,0.15);
            }
            .snl-cell.dark { background:linear-gradient(145deg,#cfa565,#bd9151); }
            .snl-cell.win {
              background:linear-gradient(145deg,#ffe27a,#ffb03d);
              color:#5a2d00;
              box-shadow: inset 0 0 8px rgba(255,255,255,0.7), 0 0 10px rgba(255,200,60,0.6);
            }
            .snl-token {
              width:14px; height:14px;
              border-radius:50%;
              position:absolute;
              bottom:2px; right:2px;
              box-shadow:0 2px 4px rgba(0,0,0,0.5), inset -2px -2px 3px rgba(0,0,0,0.35), inset 2px 2px 3px rgba(255,255,255,0.6);
              z-index:3;
              transition: all 0.25s ease;
            }
            #snlOverlay {
              position:absolute;
              top:8px; left:8px;
              width:298px; height:298px;
              pointer-events:none;
              z-index:2;
              filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4));
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
          <div id="joinWaitingOverlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(10,3,20,0.97); z-index:2000; align-items:center; justify-content:center; color:white; text-align:center; padding:20px;">
            <div>
              <div style="font-size:36px; margin-bottom:10px;">⏳</div>
              <p style="font-size:16px; font-weight:600;">Waiting for the room creator to let you in...</p>
              <p style="font-size:12.5px; color:rgba(255,255,255,0.6);">This room is private. You'll be let in once approved.</p>
            </div>
          </div>

          <div id="topBar">
            <a href="/welcome?name=${me}" style="color:#ffd966; text-decoration:none; font-size:13px; position:absolute; top:16px; left:16px;">&larr; Back</a>
            <h2>👥 ${room}</h2>
            <p style="margin:4px; font-size:12.5px; color:#ffd966;">Tap a name for a private chat, or chat here with everyone</p>
            <button id="inviteBtn" onclick="openInvitePicker()" style="display:none; position:absolute; top:16px; right:16px; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.3); color:white; padding:6px 12px; border-radius:16px; font-size:12px; cursor:pointer;">➕ Invite</button>
          </div>

          <div id="invitePickerModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); z-index:2100; align-items:center; justify-content:center;">
            <div style="background:white; color:#333; border-radius:14px; padding:18px; max-width:320px; width:90%; max-height:70vh; overflow-y:auto;">
              <h3 style="margin:0 0 10px;">Invite buddies to this room</h3>
              <div id="inviteBuddyList"></div>
              <button onclick="closeInvitePicker()" style="width:100%; margin-top:12px; padding:10px; border:none; border-radius:8px; background:#eee; cursor:pointer;">Close</button>
            </div>
          </div>

          <div id="roster"></div>

          <div id="videoGrid" style="display:none;"></div>

          <div id="controls">
            <button onclick="toggleVideoGrid()">🎥 Group Video</button>
            <button onclick="toggleGamePanel()">🎮 Games</button>
            <button onclick="toggleLiveMap()">🗺️ Live Map</button>
            <button id="leaveBtn" onclick="leaveCall()">🚪 Leave Room</button>
          </div>

          <div id="liveMapOverlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:#000; z-index:1800;">
            <div style="position:absolute; top:0; left:0; right:0; z-index:1801; background:linear-gradient(135deg,#3d0f6e,#9333ea); padding:12px; display:flex; justify-content:space-between; align-items:center;">
              <span style="font-weight:600; font-size:14px;">🗺️ Live Room Map</span>
              <span onclick="toggleLiveMap()" style="cursor:pointer; font-size:20px;">&times;</span>
            </div>
            <div id="liveMapDiv" style="width:100%; height:100%;"></div>
            <button id="shareMyLocationBtn" onclick="toggleShareMyLocation()" style="position:absolute; bottom:20px; left:50%; transform:translateX(-50%); z-index:1801; padding:12px 22px; border:none; border-radius:24px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer;">📍 Share My Location</button>
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
              <div id="snlBoardWrap">
                <svg id="snlOverlay"></svg>
                <div id="snlBoard"></div>
              </div>
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

            let rtcConfigPromise = fetch("/api/ice-config")
              .then((r) => r.json())
              .catch(() => ({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));

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

            async function createPeerConnection(peerId, peerName, peerGender) {
              const config = await rtcConfigPromise;
              const pc = new RTCPeerConnection(config);
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
                const pc = await createPeerConnection(peer.id, peer.name, peer.gender);
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
              const pc = await createPeerConnection(from, name, gender);
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
            let snlBoardDrawn = false;

            // Matches the same zig-zag numbering used to lay out the grid
            function snlCellCenter(num) {
              const row = Math.floor((num - 1) / 10);
              const withinRow = (num - 1) % 10;
              const leftToRight = row % 2 === 0;
              const colIndex = leftToRight ? withinRow : 9 - withinRow;
              const x = colIndex * 30 + 14;
              const y = (9 - row) * 30 + 14;
              return { x, y };
            }

            function drawSnlOverlay() {
              const svg = document.getElementById("snlOverlay");
              svg.setAttribute("viewBox", "0 0 298 298");
              let html = "";

              // Ladders: two rails + rungs, bottom to top
              Object.entries(SNL_LADDERS).forEach(([bottom, top]) => {
                const a = snlCellCenter(Number(bottom));
                const b = snlCellCenter(Number(top));
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                const nx = -dy / len, ny = dx / len; // perpendicular unit vector
                const offset = 3.5;
                const r1 = { x1: a.x + nx * offset, y1: a.y + ny * offset, x2: b.x + nx * offset, y2: b.y + ny * offset };
                const r2 = { x1: a.x - nx * offset, y1: a.y - ny * offset, x2: b.x - nx * offset, y2: b.y - ny * offset };

                html += '<line x1="' + r1.x1 + '" y1="' + r1.y1 + '" x2="' + r1.x2 + '" y2="' + r1.y2 + '" stroke="#c98a3a" stroke-width="2.5"/>';
                html += '<line x1="' + r2.x1 + '" y1="' + r2.y1 + '" x2="' + r2.x2 + '" y2="' + r2.y2 + '" stroke="#c98a3a" stroke-width="2.5"/>';

                const rungCount = Math.max(3, Math.round(len / 18));
                for (let i = 1; i < rungCount; i++) {
                  const t = i / rungCount;
                  const rx1 = r1.x1 + (r1.x2 - r1.x1) * t;
                  const ry1 = r1.y1 + (r1.y2 - r1.y1) * t;
                  const rx2 = r2.x1 + (r2.x2 - r2.x1) * t;
                  const ry2 = r2.y1 + (r2.y2 - r2.y1) * t;
                  html += '<line x1="' + rx1 + '" y1="' + ry1 + '" x2="' + rx2 + '" y2="' + ry2 + '" stroke="#8a5a20" stroke-width="1.5"/>';
                }
              });

              // Snakes: realistic tapered body with scales, eyes, and a tongue
              const snakePalettes = [
                { light: "#5ecb6e", dark: "#1f7a33" },
                { light: "#5fb8e8", dark: "#1a5f8a" },
                { light: "#e87fc4", dark: "#a12f7a" },
                { light: "#e8c85f", dark: "#a1791f" }
              ];

              function quadPoint(a, ctrl, b, t) {
                const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ctrl.x + t * t * b.x;
                const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * ctrl.y + t * t * b.y;
                return { x, y };
              }

              Object.entries(SNL_SNAKES).forEach(([head, tail], i) => {
                const a = snlCellCenter(Number(head));
                const b = snlCellCenter(Number(tail));
                const ctrl = { x: (a.x + b.x) / 2 + (a.y - b.y) * 0.3, y: (a.y + b.y) / 2 + (b.x - a.x) * 0.3 };
                const palette = snakePalettes[i % snakePalettes.length];

                // Body: overlapping circles, tapering from thick head to thin tail
                const steps = 26;
                let bodyHtml = "";
                for (let s = steps; s >= 0; s--) {
                  const t = s / steps;
                  const p = quadPoint(a, ctrl, b, t);
                  const radius = 5.2 - t * 3.2; // thick near head (t=0), thin near tail (t=1)
                  const shade = t < 0.5 ? palette.light : palette.dark;
                  bodyHtml += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + radius + '" fill="' + shade + '"/>';

                  // small scale marks every few steps
                  if (s % 3 === 0 && t > 0.05) {
                    bodyHtml += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (radius * 0.4) + '" fill="rgba(0,0,0,0.15)"/>';
                  }
                }
                html += bodyHtml;

                // Head details: eyes + forked tongue pointing away from the body
                const dirX = a.x - ctrl.x, dirY = a.y - ctrl.y;
                const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
                const ux = dirX / dirLen, uy = dirY / dirLen;
                const perpX = -uy, perpY = ux;

                const tongueBaseX = a.x + ux * 5;
                const tongueBaseY = a.y + uy * 5;
                const tongueTipX = a.x + ux * 11;
                const tongueTipY = a.y + uy * 11;
                const forkSpread = 2.2;

                html += '<line x1="' + tongueBaseX + '" y1="' + tongueBaseY + '" x2="' + (tongueTipX + perpX * forkSpread) + '" y2="' + (tongueTipY + perpY * forkSpread) + '" stroke="#c0203a" stroke-width="1"/>';
                html += '<line x1="' + tongueBaseX + '" y1="' + tongueBaseY + '" x2="' + (tongueTipX - perpX * forkSpread) + '" y2="' + (tongueTipY - perpY * forkSpread) + '" stroke="#c0203a" stroke-width="1"/>';

                const eyeOffset = 2.4;
                html += '<circle cx="' + (a.x + perpX * eyeOffset) + '" cy="' + (a.y + perpY * eyeOffset) + '" r="1.3" fill="white"/>';
                html += '<circle cx="' + (a.x - perpX * eyeOffset) + '" cy="' + (a.y - perpY * eyeOffset) + '" r="1.3" fill="white"/>';
                html += '<circle cx="' + (a.x + perpX * eyeOffset) + '" cy="' + (a.y + perpY * eyeOffset) + '" r="0.6" fill="black"/>';
                html += '<circle cx="' + (a.x - perpX * eyeOffset) + '" cy="' + (a.y - perpY * eyeOffset) + '" r="0.6" fill="black"/>';
              });

              svg.innerHTML = html;
            }

            // ---- Snakes & Ladders sound effects (Web Audio, no files needed) ----
            let lastSnlMoveSeq = 0;

            function snlAudioCtx() {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              return new AudioCtx();
            }

            function playDiceSound() {
              const ctx = snlAudioCtx();
              for (let i = 0; i < 5; i++) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "square";
                osc.frequency.value = 180 + Math.random() * 120;
                osc.connect(gain);
                gain.connect(ctx.destination);
                const start = ctx.currentTime + i * 0.06;
                gain.gain.setValueAtTime(0.08, start);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
                osc.start(start);
                osc.stop(start + 0.06);
              }
              setTimeout(() => ctx.close(), 500);
            }

            function playLadderSound() {
              const ctx = snlAudioCtx();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = "triangle";
              osc.frequency.setValueAtTime(300, ctx.currentTime);
              osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.5);
              osc.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.12, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
              osc.start();
              osc.stop(ctx.currentTime + 0.55);
              setTimeout(() => ctx.close(), 700);
            }

            function playSnakeSound() {
              const ctx = snlAudioCtx();
              // Hiss (filtered noise)
              const bufferSize = ctx.sampleRate * 0.4;
              const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
              const data = buffer.getChannelData(0);
              for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
              const noise = ctx.createBufferSource();
              noise.buffer = buffer;
              const filter = ctx.createBiquadFilter();
              filter.type = "bandpass";
              filter.frequency.value = 2500;
              const gain = ctx.createGain();
              gain.gain.setValueAtTime(0.15, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
              noise.connect(filter);
              filter.connect(gain);
              gain.connect(ctx.destination);
              noise.start();

              // Descending slide tone
              const osc = ctx.createOscillator();
              const oscGain = ctx.createGain();
              osc.type = "sawtooth";
              osc.frequency.setValueAtTime(500, ctx.currentTime);
              osc.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.5);
              osc.connect(oscGain);
              oscGain.connect(ctx.destination);
              oscGain.gain.setValueAtTime(0.08, ctx.currentTime);
              oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
              osc.start();
              osc.stop(ctx.currentTime + 0.5);

              setTimeout(() => ctx.close(), 700);
            }

            function playWinSound() {
              const ctx = snlAudioCtx();
              const notes = [523, 659, 784, 1047]; // C E G C (major arpeggio)
              notes.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "triangle";
                osc.frequency.value = freq;
                osc.connect(gain);
                gain.connect(ctx.destination);
                const start = ctx.currentTime + i * 0.14;
                gain.gain.setValueAtTime(0.13, start);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
                osc.start(start);
                osc.stop(start + 0.3);
              });
              setTimeout(() => ctx.close(), 1000);
            }

            function renderSnlBoard(state) {
              const boardEl = document.getElementById("snlBoard");

              if (!snlBoardDrawn) {
                boardEl.innerHTML = "";

                // Build board visually in the classic boustrophedon (zig-zag) layout,
                // numbered 1 (bottom-left) to 100 (top-left), 10 columns wide
                for (let row = 9; row >= 0; row--) {
                  const leftToRight = row % 2 === 0;
                  for (let col = 0; col < 10; col++) {
                    const colIndex = leftToRight ? col : 9 - col;
                    const cellNumber = row * 10 + colIndex + 1; // 1-100

                    const cellEl = document.createElement("div");
                    cellEl.id = "snl-cell-" + cellNumber;
                    cellEl.className = "snl-cell" + ((row + col) % 2 === 0 ? " dark" : "") + (cellNumber === 100 ? " win" : "");
                    cellEl.textContent = cellNumber;
                    cellEl.style.gridColumn = col + 1;
                    cellEl.style.gridRow = (10 - row);

                    boardEl.appendChild(cellEl);
                  }
                }

                drawSnlOverlay();
                snlBoardDrawn = true;
              }

              // Play the right sound for what just happened (only once per move)
              if (state.moveSeq && state.moveSeq > lastSnlMoveSeq) {
                lastSnlMoveSeq = state.moveSeq;
                playDiceSound();
                if (state.landedType === "ladder") {
                  setTimeout(playLadderSound, 250);
                } else if (state.landedType === "snake") {
                  setTimeout(playSnakeSound, 250);
                }
                if (state.winner) {
                  setTimeout(playWinSound, 700);
                }
              }

              // Clear old tokens, then place current ones
              document.querySelectorAll(".snl-token").forEach((t) => t.remove());
              Object.entries(state.players).forEach(([color, p]) => {
                const cellEl = document.getElementById("snl-cell-" + p.position);
                if (!cellEl) return;
                const token = document.createElement("div");
                token.className = "snl-token";
                token.style.background = SNL_COLORS[color];
                cellEl.appendChild(token);
              });

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
              lastSnlMoveSeq = 0;
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
              document.getElementById("emojiPicker").style.display = "none";
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
              document.getElementById("emojiPicker").style.display = "none";
            }

            document.addEventListener("click", (e) => {
              const picker = document.getElementById("emojiPicker");
              if (picker && picker.style.display === "grid" && !e.target.closest("#emojiPicker") && !e.target.closest("#chatInputRow button")) {
                picker.style.display = "none";
              }
            });

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

            async function createPrivatePeerConnection(peerId) {
              const config = await rtcConfigPromise;
              const pc = new RTCPeerConnection(config);
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
                const pc = await createPrivatePeerConnection(peer.id);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("private-offer", { to: peer.id, from: socket.id, offer, name: me });
              }
            });

            socket.on("private-new-peer", ({ id, name }) => {
              // will receive an offer from them
            });

            socket.on("private-offer", async ({ from, offer }) => {
              const pc = await createPrivatePeerConnection(from);
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

            // ---- Live Room Map ----
            let liveMap = null;
            let liveMapMarkers = {}; // name -> marker
            let myLocationWatchId = null;
            let sharingMyLocation = false;

            function toggleLiveMap() {
              const overlay = document.getElementById("liveMapOverlay");
              const isOpen = overlay.style.display === "block";
              if (isOpen) {
                overlay.style.display = "none";
                return;
              }
              overlay.style.display = "block";

              if (!liveMap) {
                liveMap = L.map("liveMapDiv").setView([20.5937, 78.9629], 5); // default India view
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(liveMap);
              }
              setTimeout(() => liveMap.invalidateSize(), 100);
            }

            function toggleShareMyLocation() {
              const btn = document.getElementById("shareMyLocationBtn");
              if (!sharingMyLocation) {
                if (!navigator.geolocation) {
                  alert("Location isn't supported on this device/browser.");
                  return;
                }
                sharingMyLocation = true;
                btn.textContent = "🛑 Stop Sharing";
                btn.style.background = "#e33";
                btn.style.color = "white";

                myLocationWatchId = navigator.geolocation.watchPosition((pos) => {
                  const lat = pos.coords.latitude, lng = pos.coords.longitude;
                  socket.emit("group-location-update", { room, name: me, lat, lng });
                  updateMapMarker(me, lat, lng, true);
                }, () => {
                  alert("Could not get your location. Please allow location access.");
                  toggleShareMyLocation();
                }, { enableHighAccuracy: true });
              } else {
                sharingMyLocation = false;
                btn.textContent = "📍 Share My Location";
                btn.style.background = "#ffd966";
                btn.style.color = "#3d0f6e";
                if (myLocationWatchId !== null) {
                  navigator.geolocation.clearWatch(myLocationWatchId);
                  myLocationWatchId = null;
                }
                socket.emit("group-location-stop", { room, name: me });
                if (liveMapMarkers[me]) {
                  liveMap.removeLayer(liveMapMarkers[me]);
                  delete liveMapMarkers[me];
                }
              }
            }

            function updateMapMarker(name, lat, lng, isMe) {
              if (!liveMap) return;
              if (liveMapMarkers[name]) {
                liveMapMarkers[name].setLatLng([lat, lng]);
              } else {
                liveMapMarkers[name] = L.marker([lat, lng]).addTo(liveMap)
                  .bindPopup(isMe ? "You" : name);
              }
              if (isMe) liveMap.setView([lat, lng], 15);
            }

            socket.on("group-location-update", ({ name, lat, lng }) => {
              updateMapMarker(name, lat, lng, false);
            });

            socket.on("group-location-stop", ({ name }) => {
              if (liveMapMarkers[name] && liveMap) {
                liveMap.removeLayer(liveMapMarkers[name]);
                delete liveMapMarkers[name];
              }
            });

            // ---- Room join approval (only applies to custom, creator-owned rooms) ----
            const roomOwner = "${roomOwner}";
            socket.emit("register-user", { name: me });

            if (roomOwner && roomOwner !== me) {
              document.getElementById("joinWaitingOverlay").style.display = "flex";
              socket.emit("request-join-room", { room, requesterName: me });
            } else {
              startRoom();
              if (roomOwner === me) {
                document.getElementById("inviteBtn").style.display = "block";
              }
            }

            // ---- Invite buddies to this room ----
            const myBuddiesList = ${JSON.stringify(myBuddiesForInvite)};

            function openInvitePicker() {
              const listEl = document.getElementById("inviteBuddyList");
              if (!myBuddiesList.length) {
                listEl.innerHTML = '<p style="font-size:13px; color:#666;">No buddies to invite yet.</p>';
              } else {
                listEl.innerHTML = myBuddiesList.map((name) =>
                  '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #eee;">' +
                  '<span style="font-size:13.5px;">' + name + '</span>' +
                  '<button onclick="sendRoomInvite(\\'' + name.replace(/'/g, "") + '\\')" style="padding:6px 12px; border:none; border-radius:14px; background:#9333ea; color:white; font-size:12px; cursor:pointer;">Invite</button>' +
                  '</div>'
                ).join("");
              }
              document.getElementById("invitePickerModal").style.display = "flex";
            }

            function closeInvitePicker() {
              document.getElementById("invitePickerModal").style.display = "none";
            }

            function sendRoomInvite(buddyName) {
              socket.emit("invite-to-room", { room, from: me, to: buddyName });
              alert("Invite sent to " + buddyName + "!");
            }

            socket.on("room-invite-received", ({ room: invitedRoom, from }) => {
              const accept = confirm(from + " invited you to join their room \\"" + invitedRoom + "\\". Join now?");
              if (accept) {
                window.location.href = "/group-call?room=" + encodeURIComponent(invitedRoom) + "&me=" + encodeURIComponent(me) + "&gender=" + encodeURIComponent(myGender);
              }
            });

            socket.on("join-approved", () => {
              document.getElementById("joinWaitingOverlay").style.display = "none";
              startRoom();
            });

            socket.on("join-denied", () => {
              document.getElementById("joinWaitingOverlay").innerHTML =
                '<div style="text-align:center; padding:20px;"><p style="font-size:15px;">🚫 The room creator did not approve your request.</p><a href="/rooms?me=' + encodeURIComponent(me) + '" style="color:#ffd966;">&larr; Back to Rooms</a></div>';
            });

            // If I'm the owner, listen for join requests from others (even if I opened this room
            // from a notification rather than being on this exact page)
            socket.on("join-request", ({ room: reqRoom, requesterName, requesterSocketId }) => {
              if (reqRoom !== room) return;
              const approve = confirm(requesterName + " wants to join your room \\"" + room + "\\". Allow them in?");
              socket.emit("respond-join-request", { room: reqRoom, requesterSocketId, approved: approve, requesterName });
            });
          </script>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/chat") {
    const me = parsedUrl.query.me;
    const withBuddy = parsedUrl.query.with;
    const currentStreak = getStreak(me, withBuddy);

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

    const reactionsMap = getReactionsForMessages(conversation.map((m) => m.id));

    const otherReadRow = db.prepare("SELECT last_read_id FROM read_receipts WHERE reader_name = ? AND other_name = ?").get(withBuddy, me);
    const otherLastReadId = otherReadRow ? otherReadRow.last_read_id : 0;

    // Mark this whole conversation as read by me, up to the latest message
    if (conversation.length) {
      const latestId = conversation[conversation.length - 1].id;
      db.prepare(
        "INSERT INTO read_receipts (reader_name, other_name, last_read_id) VALUES (?, ?, ?) ON CONFLICT(reader_name, other_name) DO UPDATE SET last_read_id = excluded.last_read_id"
      ).run(me, withBuddy, latestId);
    }

    const messagesHTML = conversation.map((m) => renderMessageHTML(m, me, reactionsMap, otherLastReadId)).join("");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html>
        <head>
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
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
            #callControls {
              position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
              display:flex; flex-wrap:wrap; justify-content:center; gap:8px;
              width:94%; max-width:340px;
            }
            .callBtn { border:none; padding:11px 14px; border-radius:22px; font-size:13px; color:white; white-space:nowrap; }
            #hangUpBtn { background:#e33; order:99; } /* Hang Up always shows last, in its own row if needed */
            #muteBtn, #camBtn { background:#444; }
            .callBtn.off { background:#e33; }

            #incomingCall { display:none; background:white; color:black; padding:14px; width:250px; margin:10px auto; border-radius:8px; }

            .msgRow { position:relative; margin-bottom:10px; padding-right:70px; }
            .msgActions { display:inline-block; margin-left:6px; }
            .msgActions button { font-size:11px; padding:2px 6px; margin-left:3px; border:none; border-radius:4px; background:#eee; cursor:pointer; }

            .reactBtn { font-size:11px; padding:1px 6px; margin-left:4px; border:none; border-radius:10px; background:rgba(0,0,0,0.08); cursor:pointer; color:#555; }
            .reactionsBar { margin-top:3px; display:flex; gap:4px; flex-wrap:wrap; }
            .reactionPill { font-size:11px; background:rgba(0,0,0,0.07); border-radius:10px; padding:1px 7px; cursor:pointer; }
            .replyPreview { font-size:11px; background:rgba(0,0,0,0.06); border-left:3px solid #9333ea; padding:3px 8px; margin-bottom:3px; border-radius:4px; color:#555; }
            .translationBox { font-size:11.5px; background:rgba(147,51,234,0.08); border-left:3px solid #9333ea; padding:4px 8px; margin-top:4px; border-radius:4px; color:#5a2d8a; font-style:italic; }
            .msgTicks { font-size:11px; margin-left:5px; }

            #reactPicker { display:none; position:fixed; background:white; border-radius:10px; padding:6px; box-shadow:0 4px 14px rgba(0,0,0,0.3); z-index:1200; gap:4px; }
            #reactPicker span { font-size:20px; cursor:pointer; padding:2px; }

            #replyBar { display:none; background:rgba(255,255,255,0.9); color:#333; padding:8px 12px; border-radius:10px; max-width:420px; margin:0 auto 6px; font-size:12.5px; position:relative; }
            #replyBar .cancelReply { position:absolute; top:4px; right:8px; cursor:pointer; color:#999; }

            #typingIndicator { max-width:420px; margin:0 auto; padding:0 16px; font-size:12px; color:rgba(255,255,255,0.6); min-height:16px; }

            #voiceRecordBtn.recording { background:#e33 !important; animation: pulseRec 1s infinite; }
            @keyframes pulseRec { 0%, 100% { opacity:1; } 50% { opacity:0.5; } }

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
            <span id="streakBadge" style="font-size:12px; color:#ffd966;">${currentStreak > 0 ? "🔥" + currentStreak : ""}</span>
            <button class="callBtnTop" onclick="buzz()" title="Buzz" style="background:rgba(255,217,102,0.2);">🔔</button>
            <button class="callBtnTop" onclick="startCall('audio')">📞</button>
            <button class="callBtnTop" onclick="startCall('video')">📹</button>
            <button class="menuBtn" onclick="toggleMenu()">⋮</button>
            <div class="menuDropdown" id="menuDropdown">
              <button onclick="openTimeCapsule()">⏳ Send Time Capsule</button>
              <button onclick="reportUser()">⚠️ Report ${withBuddy}</button>
              <button class="danger" onclick="blockUser()">🚫 Block ${withBuddy}</button>
            </div>
          </div>

          <div id="timeCapsuleModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); z-index:1300; align-items:center; justify-content:center;">
            <div style="background:white; color:#333; border-radius:14px; padding:20px; max-width:320px; width:90%;">
              <h3 style="margin:0 0 10px;">⏳ Time Capsule</h3>
              <p style="font-size:12.5px; color:#666; margin:0 0 12px;">Write a message that will be delivered to ${withBuddy} at a future date/time.</p>
              <textarea id="capsuleText" rows="3" style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px; margin-bottom:10px;" placeholder="Your message..."></textarea>
              <input type="datetime-local" id="capsuleDate" style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px; margin-bottom:12px;" />
              <div style="display:flex; gap:8px;">
                <button onclick="sendTimeCapsule()" style="flex:1; padding:10px; border:none; border-radius:8px; background:#9333ea; color:white; font-weight:700; cursor:pointer;">Schedule</button>
                <button onclick="closeTimeCapsule()" style="flex:1; padding:10px; border:none; border-radius:8px; background:#eee; cursor:pointer;">Cancel</button>
              </div>
            </div>
          </div>

          <div id="callArea">
            <video id="bigVideo" autoplay playsinline></video>
            <video id="smallVideo" autoplay playsinline muted onclick="swapVideos()"></video>
            <div id="audioCallAvatar"></div>
            <div id="camOffOverlay">Camera off</div>
            <p id="callStatus"></p>
            <div id="callDebugPanel" style="display:none; position:absolute; top:60px; left:16px; right:16px; background:rgba(0,0,0,0.8); color:#0f0; font-family:monospace; font-size:11px; padding:10px; border-radius:8px; white-space:pre-wrap; max-height:200px; overflow-y:auto;"></div>
            <div id="callControls">
              <button id="muteBtn" class="callBtn" onclick="toggleMute()">Mute</button>
              <button id="camBtn" class="callBtn" onclick="toggleCamera()">Camera Off</button>
              <button id="switchCamBtn" class="callBtn" onclick="switchCamera()">Switch Cam</button>
              <button class="callBtn" onclick="toggleVoiceFilterPicker()" style="background:#444;">🎭 Voice</button>
              <button class="callBtn" onclick="toggleDebugPanel()" style="background:#444;">🔧 Debug</button>
              <button id="hangUpBtn" class="callBtn" onclick="hangUp(true)">Hang Up</button>
            </div>
            <div id="voiceFilterPicker" style="display:none; position:absolute; bottom:110px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.7); border-radius:12px; padding:8px; display:none; gap:6px; flex-wrap:wrap; justify-content:center; max-width:90%;">
              <button onclick="applyVoiceFilter('normal')" style="padding:8px 12px; border:none; border-radius:10px; background:#333; color:white; font-size:12px;">Normal</button>
              <button onclick="applyVoiceFilter('robot')" style="padding:8px 12px; border:none; border-radius:10px; background:#333; color:white; font-size:12px;">🤖 Robot</button>
              <button onclick="applyVoiceFilter('deep')" style="padding:8px 12px; border:none; border-radius:10px; background:#333; color:white; font-size:12px;">🎙️ Deep</button>
              <button onclick="applyVoiceFilter('echo')" style="padding:8px 12px; border:none; border-radius:10px; background:#333; color:white; font-size:12px;">🏔️ Echo</button>
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

          <div id="typingIndicator"></div>

          <div id="replyBar">
            <span class="cancelReply" onclick="cancelReply()">&times;</span>
            <span id="replyBarText"></span>
          </div>

          <div id="reactPicker">
            ${["👍", "❤️", "😂", "😮", "😢", "🙏"].map((e) => `<span onclick="sendReaction('${e}')">${e}</span>`).join("")}
          </div>

          <div id="attachBar" style="max-width:420px; margin:0 auto; position:relative; display:flex; flex-wrap:wrap; justify-content:center; gap:6px; padding:0 12px;">
            <div id="dmEmojiPicker" style="display:none; position:absolute; bottom:52px; left:12px; right:12px; background:#221542; border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:8px; max-height:160px; overflow-y:auto; grid-template-columns: repeat(7, 1fr); gap:4px;"></div>
            <input id="text" placeholder="Type a message" style="flex:1; min-width:120px; padding:11px 14px; border-radius:20px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08); color:white; font-size:14px;" />
            <button onclick="toggleDmEmojiPicker()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">😊</button>
            <button id="voiceRecordBtn" onclick="toggleVoiceRecording()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">🎤</button>
            <button onclick="sendMessage()" style="padding:10px 16px; border:none; border-radius:20px; background:#ffd966; color:#3d0f6e; font-weight:700; cursor:pointer;">Send</button>
            <button onclick="document.getElementById('backCameraInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">📷 Back</button>
            <button onclick="document.getElementById('frontCameraInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">🤳 Front</button>
            <button onclick="document.getElementById('fileInput').click()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">📎 File</button>
            <button onclick="openLocationPicker()" style="padding:10px 12px; border:none; border-radius:20px; background:rgba(255,255,255,0.12); color:white; cursor:pointer;">📍</button>
            <input type="file" id="backCameraInput" accept="image/*" capture="environment" onchange="sendFile('backCameraInput')" style="display:none;" />
            <input type="file" id="frontCameraInput" accept="image/*" capture="user" onchange="sendFile('frontCameraInput')" style="display:none;" />
            <input type="file" id="fileInput" onchange="sendFile('fileInput')" style="display:none;" />
          </div>

          <div id="locationPickerModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); z-index:1400; align-items:center; justify-content:center;">
            <div style="background:white; color:#333; border-radius:14px; padding:20px; max-width:300px; width:90%; text-align:center;">
              <h3 style="margin:0 0 14px;">📍 Share Location</h3>
              <button onclick="shareLocation(false)" style="width:100%; padding:11px; margin-bottom:8px; border:none; border-radius:8px; background:#9333ea; color:white; font-weight:700; cursor:pointer;">Share Current Location</button>
              <button onclick="shareLocation(true)" style="width:100%; padding:11px; margin-bottom:8px; border:none; border-radius:8px; background:#e33; color:white; font-weight:700; cursor:pointer;">🔴 Share Live Location (15 min)</button>
              <button onclick="closeLocationPicker()" style="width:100%; padding:11px; border:none; border-radius:8px; background:#eee; cursor:pointer;">Cancel</button>
            </div>
          </div>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const me = "${me}";
            const withBuddy = "${withBuddy}";
            const room = [me, withBuddy].sort().join("-");
            const socket = io();

            socket.emit("join", { room });
            socket.emit("register-user", { name: me });

            socket.on("streak-updated", ({ streak }) => {
              const badge = document.getElementById("streakBadge");
              badge.textContent = streak > 0 ? "🔥" + streak : "";
            });

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
              socket.emit("mark-read", { room, reader: me, other: withBuddy });
            });

            function actionsHTML(id, isText, mine) {
              if (mine) {
                let editBtn = isText ? '<button onclick="editMsg(' + id + ', this)">Edit</button>' : "";
                return '<span class="msgActions">' + editBtn + '<button onclick="deleteMsg(' + id + ')">Delete</button></span>';
              }
              return '<span class="msgActions"><button onclick="startReply(' + id + ', \\'' + me.replace(/'/g, "") + '\\')">Reply</button></span>';
            }

            function replyPreviewClientHTML(msg) {
              if (!msg.replyToId) return "";
              return '<div class="replyPreview">↩ ' + msg.replyToFrom + ': ' + (msg.replyToPreview || "").slice(0, 60) + '</div>';
            }

            function addMessageToBox(msg) {
              const box = document.getElementById("messages");
              const mine = msg.from === me;
              const actions = actionsHTML(msg.id, msg.type === "text", mine);
              const reactBtn = '<button class="reactBtn" onclick="openEmojiReactPicker(' + msg.id + ')">+</button>';
              const reply = replyPreviewClientHTML(msg);
              const ticks = mine ? '<span class="msgTicks" data-tick-for="' + msg.id + '" style="color:rgba(255,255,255,0.4);">✓</span>' : "";
              let html = "";

              if (msg.type === "image") {
                html = '<div class="msgRow" data-id="' + msg.id + '">' + reply + '<b>' + msg.from + ':</b><br/><img src="' + msg.fileData + '" onclick="openImageViewer(this.src)" style="max-width:220px; border-radius:6px; margin-top:4px; cursor:pointer;" />' + ticks + actions + reactBtn + '</div>';
              } else if (msg.type === "file") {
                html = '<div class="msgRow" data-id="' + msg.id + '">' + reply + '<b>' + msg.from + ':</b><br/><a href="' + msg.fileData + '" download="' + msg.fileName + '">📎 ' + msg.fileName + '</a>' + ticks + actions + reactBtn + '</div>';
              } else if (msg.type === "voice") {
                html = '<div class="msgRow" data-id="' + msg.id + '">' + reply + '<b>' + msg.from + ':</b><br/><audio controls src="' + msg.fileData + '" style="height:32px; max-width:200px;"></audio>' + ticks + actions + reactBtn + '</div>';
              } else if (msg.type === "location") {
                let loc = {};
                try { loc = JSON.parse(msg.fileData); } catch (e) {}
                const mapId = loc.live ? loc.liveId : "loc-" + msg.id;
                const liveBadge = loc.live ? '<div id="' + mapId + '-badge" style="font-size:11px; color:#e33; margin-top:2px;">🔴 Live location</div>' : "";
                html = '<div class="msgRow" data-id="' + msg.id + '">' + reply + '<b>' + msg.from + ':</b><br/>' +
                  '<div id="' + mapId + '" style="width:200px; height:120px; border-radius:8px; margin-top:4px;" onclick="window.open(\\'https://www.google.com/maps?q=' + loc.lat + ',' + loc.lng + '\\',\\'_blank\\')"></div>' +
                  liveBadge + ticks + actions + reactBtn + '</div>';
                box.insertAdjacentHTML("beforeend", html);
                renderLocationMap(mapId, loc.lat, loc.lng);
                box.scrollTop = box.scrollHeight;
                return;
              } else {
                html = '<div class="msgRow" data-id="' + msg.id + '">' + reply + '<b>' + msg.from + ':</b> <span class="msgText">' + msg.text + '</span>' + ticks + actions + reactBtn + '<button class="reactBtn" onclick="translateMsg(' + msg.id + ')" title="Translate">🌐</button>' + '<div class="translationBox" id="translation-' + msg.id + '" style="display:none;"></div></div>';
              }
              box.insertAdjacentHTML("beforeend", html);
              box.scrollTop = box.scrollHeight;
            }

            // ---- Reply-to ----
            let replyingTo = null;

            function startReply(id, fromName) {
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              let preview = "message";
              if (row) {
                const textSpan = row.querySelector(".msgText");
                preview = textSpan ? textSpan.textContent : "attachment";
              }
              replyingTo = { id, from: fromName, preview: preview.slice(0, 60) };
              document.getElementById("replyBarText").textContent = "Replying to " + fromName + ": " + preview.slice(0, 40);
              document.getElementById("replyBar").style.display = "block";
              document.getElementById("text").focus();
            }

            function cancelReply() {
              replyingTo = null;
              document.getElementById("replyBar").style.display = "none";
            }

            // ---- Reactions ----
            let reactingToId = null;

            function openEmojiReactPicker(id) {
              reactingToId = id;
              const picker = document.getElementById("reactPicker");
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              const rect = row.getBoundingClientRect();
              picker.style.top = (window.scrollY + rect.top - 44) + "px";
              picker.style.left = Math.max(10, rect.left) + "px";
              picker.style.display = "flex";
            }

            function sendReaction(emoji) {
              if (reactingToId) {
                socket.emit("toggle-reaction", { room, messageId: reactingToId, user: me, emoji });
              }
              document.getElementById("reactPicker").style.display = "none";
            }

            function toggleReaction(id, emoji) {
              socket.emit("toggle-reaction", { room, messageId: id, user: me, emoji });
            }

            // ---- AI Translation ----
            async function translateMsg(id) {
              const row = document.querySelector('.msgRow[data-id="' + id + '"]');
              const textSpan = row ? row.querySelector(".msgText") : null;
              const box = document.getElementById("translation-" + id);
              if (!textSpan || !box) return;

              if (box.style.display === "block") {
                box.style.display = "none";
                return;
              }

              const targetLanguage = prompt("Translate to which language? (e.g. English, Assamese, Hindi)", "English");
              if (!targetLanguage) return;

              box.style.display = "block";
              box.textContent = "Translating...";

              try {
                const res = await fetch("/api/translate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: textSpan.textContent, targetLanguage })
                });
                const data = await res.json();
                box.textContent = data.error ? ("Error: " + data.error) : ("🌐 " + data.translation);
              } catch (err) {
                box.textContent = "Translation failed.";
              }
            }

            document.addEventListener("click", (e) => {
              if (!e.target.closest("#reactPicker") && !e.target.closest(".reactBtn")) {
                document.getElementById("reactPicker").style.display = "none";
              }
            });

            socket.on("reaction-updated", ({ messageId, emoji, users }) => {
              const row = document.querySelector('.msgRow[data-id="' + messageId + '"]');
              if (!row) return;
              let bar = row.querySelector(".reactionsBar");
              if (!bar) {
                bar = document.createElement("div");
                bar.className = "reactionsBar";
                row.appendChild(bar);
              }
              let pill = bar.querySelector('[data-emoji="' + emoji + '"]');
              if (users.length === 0) {
                if (pill) pill.remove();
              } else {
                if (!pill) {
                  pill = document.createElement("span");
                  pill.className = "reactionPill";
                  pill.setAttribute("data-emoji", emoji);
                  pill.onclick = () => toggleReaction(messageId, emoji);
                  bar.appendChild(pill);
                }
                pill.textContent = emoji + " " + users.length;
              }
            });

            // ---- Typing indicator ----
            let typingTimeout = null;
            document.getElementById("text").addEventListener("input", () => {
              socket.emit("typing", { room, from: me });
              clearTimeout(typingTimeout);
              typingTimeout = setTimeout(() => {
                socket.emit("stop-typing", { room, from: me });
              }, 1500);
            });

            let typingIndicatorTimeout = null;
            socket.on("typing", ({ from }) => {
              if (from !== withBuddy) return;
              document.getElementById("typingIndicator").textContent = from + " is typing...";
              clearTimeout(typingIndicatorTimeout);
              typingIndicatorTimeout = setTimeout(() => {
                document.getElementById("typingIndicator").textContent = "";
              }, 3000);
            });

            socket.on("stop-typing", ({ from }) => {
              if (from !== withBuddy) return;
              document.getElementById("typingIndicator").textContent = "";
            });

            // ---- Read receipts ----
            socket.emit("mark-read", { room, reader: me, other: withBuddy });

            socket.on("read-updated", ({ upToId }) => {
              document.querySelectorAll(".msgTicks").forEach((el) => {
                const id = parseInt(el.getAttribute("data-tick-for"), 10);
                if (id <= upToId) {
                  el.textContent = "✓✓";
                  el.style.color = "#4fc3f7";
                }
              });
            });

            // ---- Voice messages ----
            let mediaRecorder = null;
            let audioChunks = [];
            let isRecording = false;

            async function toggleVoiceRecording() {
              const btn = document.getElementById("voiceRecordBtn");
              if (!isRecording) {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  mediaRecorder = new MediaRecorder(stream);
                  audioChunks = [];
                  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
                  mediaRecorder.onstop = () => {
                    const blob = new Blob(audioChunks, { type: "audio/webm" });
                    const reader = new FileReader();
                    reader.onload = () => {
                      socket.emit("chat message", {
                        room, from: me, to: withBuddy, type: "voice",
                        fileName: "voice-message.webm", fileData: reader.result,
                        replyToId: replyingTo ? replyingTo.id : null,
                        replyToFrom: replyingTo ? replyingTo.from : null,
                        replyToPreview: replyingTo ? replyingTo.preview : null
                      });
                      cancelReply();
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach((t) => t.stop());
                  };
                  mediaRecorder.start();
                  isRecording = true;
                  btn.classList.add("recording");
                  btn.textContent = "⏹";
                } catch (err) {
                  alert("Could not access microphone: " + err.message);
                }
              } else {
                mediaRecorder.stop();
                isRecording = false;
                btn.classList.remove("recording");
                btn.textContent = "🎤";
              }
            }

            function sendMessage() {
              const textBox = document.getElementById("text");
              const text = textBox.value;
              if (!text) return;
              socket.emit("chat message", {
                room, from: me, to: withBuddy, type: "text", text,
                replyToId: replyingTo ? replyingTo.id : null,
                replyToFrom: replyingTo ? replyingTo.from : null,
                replyToPreview: replyingTo ? replyingTo.preview : null
              });
              textBox.value = "";
              cancelReply();
              socket.emit("stop-typing", { room, from: me });
              document.getElementById("dmEmojiPicker").style.display = "none";
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
              document.getElementById("dmEmojiPicker").style.display = "none";
            }

            document.addEventListener("click", (e) => {
              const picker = document.getElementById("dmEmojiPicker");
              if (picker && picker.style.display === "grid" && !e.target.closest("#dmEmojiPicker") && !e.target.closest("#attachBar button")) {
                picker.style.display = "none";
              }
            });

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

            // ---- Location sharing ----
            let liveLocationWatchId = null;
            let liveLocationId = null;
            let liveLocationTimeout = null;

            function openLocationPicker() {
              document.getElementById("locationPickerModal").style.display = "flex";
            }
            function closeLocationPicker() {
              document.getElementById("locationPickerModal").style.display = "none";
            }

            function shareLocation(isLive) {
              closeLocationPicker();
              if (!navigator.geolocation) {
                alert("Location isn't supported on this device/browser.");
                return;
              }

              navigator.geolocation.getCurrentPosition((pos) => {
                const lat = pos.coords.latitude, lng = pos.coords.longitude;

                if (!isLive) {
                  socket.emit("chat message", {
                    room, from: me, to: withBuddy, type: "location",
                    fileData: JSON.stringify({ lat, lng, live: false })
                  });
                  return;
                }

                liveLocationId = "live-" + Date.now();
                socket.emit("chat message", {
                  room, from: me, to: withBuddy, type: "location",
                  fileData: JSON.stringify({ lat, lng, live: true, liveId: liveLocationId })
                });

                liveLocationWatchId = navigator.geolocation.watchPosition((p) => {
                  socket.emit("live-location-update", {
                    room, liveId: liveLocationId, lat: p.coords.latitude, lng: p.coords.longitude
                  });
                }, () => {}, { enableHighAccuracy: true });

                liveLocationTimeout = setTimeout(stopLiveLocation, 15 * 60 * 1000);
              }, () => {
                alert("Could not get your location. Please allow location access.");
              });
            }

            function stopLiveLocation() {
              if (liveLocationWatchId !== null) {
                navigator.geolocation.clearWatch(liveLocationWatchId);
                liveLocationWatchId = null;
              }
              if (liveLocationTimeout) {
                clearTimeout(liveLocationTimeout);
                liveLocationTimeout = null;
              }
              if (liveLocationId) {
                socket.emit("live-location-stop", { room, liveId: liveLocationId });
                liveLocationId = null;
              }
            }

            window.addEventListener("beforeunload", stopLiveLocation);

            function renderLocationMap(elementId, lat, lng) {
              setTimeout(() => {
                const el = document.getElementById(elementId);
                if (!el || el.dataset.mapReady) return;
                el.dataset.mapReady = "1";
                const map = L.map(elementId, { zoomControl: false, dragging: false, scrollWheelZoom: false, attributionControl: false }).setView([lat, lng], 15);
                L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
                const marker = L.marker([lat, lng]).addTo(map);
                el._leafletMap = map;
                el._leafletMarker = marker;
              }, 50);
            }

            socket.on("live-location-update", ({ liveId, lat, lng }) => {
              const el = document.getElementById(liveId);
              if (el && el._leafletMap) {
                el._leafletMap.setView([lat, lng], 15);
                el._leafletMarker.setLatLng([lat, lng]);
              }
            });

            socket.on("live-location-stop", ({ liveId }) => {
              const badge = document.getElementById(liveId + "-badge");
              if (badge) badge.textContent = "Live location ended";
            });

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

            // ---- Time Capsule ----
            function openTimeCapsule() {
              toggleMenu();
              document.getElementById("timeCapsuleModal").style.display = "flex";
            }

            function closeTimeCapsule() {
              document.getElementById("timeCapsuleModal").style.display = "none";
              document.getElementById("capsuleText").value = "";
              document.getElementById("capsuleDate").value = "";
            }

            async function sendTimeCapsule() {
              const text = document.getElementById("capsuleText").value.trim();
              const dateVal = document.getElementById("capsuleDate").value;
              if (!text || !dateVal) {
                alert("Please write a message and pick a delivery date/time.");
                return;
              }
              const deliverAt = new Date(dateVal).toISOString();
              if (new Date(deliverAt) <= new Date()) {
                alert("Please pick a time in the future.");
                return;
              }

              try {
                const res = await fetch("/api/schedule-capsule", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ from: me, to: withBuddy, text, deliverAt })
                });
                const data = await res.json();
                if (data.error) {
                  alert("Error: " + data.error);
                } else {
                  alert("⏳ Time capsule scheduled! It'll be delivered to " + withBuddy + " at the chosen time.");
                  closeTimeCapsule();
                }
              } catch (err) {
                alert("Could not schedule the time capsule.");
              }
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

            let rtcConfigPromise = fetch("/api/ice-config")
              .then((r) => r.json())
              .catch(() => ({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));

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
              // Always get a fresh stream matching what THIS call needs (audio-only vs video),
              // instead of reusing a stream left over from a previous call of a different mode.
              if (localStream) {
                localStream.getTracks().forEach((t) => t.stop());
                localStream = null;
              }
              localStream = await navigator.mediaDevices.getUserMedia({
                video: mode !== "audio",
                audio: true
              });
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

            async function createPeerConnection() {
              const config = await rtcConfigPromise;
              const pc = new RTCPeerConnection(config);
              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  socket.emit("ice-candidate", { room, candidate: event.candidate });
                }
              };
              pc.ontrack = (event) => {
                const bigVideo = document.getElementById("bigVideo");
                bigVideo.srcObject = event.streams[0];
                bigVideo.play().catch(() => {}); // some mobile browsers need an explicit play() call
                stopRingtone();
                document.getElementById("callStatus").textContent = "In call with " + withBuddy;

                // Detect if the other person's camera/mic actually drops mid-call,
                // instead of the screen silently going blank with no explanation
                event.track.onended = () => {
                  document.getElementById("callStatus").textContent = withBuddy + "'s camera/mic disconnected";
                };
                event.track.onmute = () => {
                  document.getElementById("callStatus").textContent = withBuddy + "'s connection is weak...";
                };
                event.track.onunmute = () => {
                  document.getElementById("callStatus").textContent = "In call with " + withBuddy;
                };
              };

              let disconnectTimer = null;
              pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === "disconnected") {
                  // Brief blips often self-heal within a couple seconds — only alarm the
                  // user if it's still disconnected after a short delay.
                  disconnectTimer = setTimeout(() => {
                    if (pc.iceConnectionState === "disconnected") {
                      document.getElementById("callStatus").textContent = "Connection unstable, reconnecting...";
                    }
                  }, 2500);
                } else if (state === "failed") {
                  clearTimeout(disconnectTimer);
                  attemptIceRestart(pc);
                } else if (state === "connected" || state === "completed") {
                  clearTimeout(disconnectTimer);
                  document.getElementById("callStatus").textContent = "In call with " + withBuddy;
                }
              };

              return pc;
            }

            // If the connection drops mid-call (e.g. WiFi to mobile data switch), the side
            // that originally sent the offer tries to re-negotiate instead of the call just dying.
            async function attemptIceRestart(pc) {
              if (!pc.localDescription || pc.localDescription.type !== "offer") return; // only the original caller restarts
              try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                socket.emit("ice-restart-offer", { room, offer });
              } catch (err) {}
            }

            socket.on("ice-restart-offer", async ({ offer }) => {
              if (!peerConnection) return;
              try {
                await peerConnection.setRemoteDescription(offer);
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit("ice-restart-answer", { room, answer });
              } catch (err) {}
            });

            socket.on("ice-restart-answer", async ({ answer }) => {
              if (!peerConnection) return;
              try {
                await peerConnection.setRemoteDescription(answer);
              } catch (err) {}
            });

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

              peerConnection = await createPeerConnection();
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

              peerConnection = await createPeerConnection();
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

            // ---- Voice Filters (real-time audio effects on outgoing call audio) ----
            let voiceFilterCtx = null;

            // ---- Call diagnostics (helps debug connection issues from a screenshot) ----
            let debugPanelInterval = null;

            function toggleDebugPanel() {
              const panel = document.getElementById("callDebugPanel");
              const isOpen = panel.style.display === "block";
              if (isOpen) {
                panel.style.display = "none";
                clearInterval(debugPanelInterval);
              } else {
                panel.style.display = "block";
                updateDebugPanel();
                debugPanelInterval = setInterval(updateDebugPanel, 2000);
              }
            }

            async function updateDebugPanel() {
              const panel = document.getElementById("callDebugPanel");
              if (!peerConnection) {
                panel.textContent = "No active call connection.";
                return;
              }

              let lines = [];
              lines.push("ICE state: " + peerConnection.iceConnectionState);
              lines.push("Connection state: " + peerConnection.connectionState);
              lines.push("Signaling state: " + peerConnection.signalingState);

              const localAudioTracks = localStream ? localStream.getAudioTracks() : [];
              const localVideoTracks = localStream ? localStream.getVideoTracks() : [];
              lines.push("My mic track: " + (localAudioTracks.length ? (localAudioTracks[0].enabled ? "on" : "muted") : "MISSING"));
              lines.push("My camera track: " + (localVideoTracks.length ? (localVideoTracks[0].enabled ? "on" : "off") : "MISSING (audio-only call?)"));

              const remoteStream = document.getElementById("bigVideo").srcObject;
              const remoteAudio = remoteStream ? remoteStream.getAudioTracks() : [];
              const remoteVideo = remoteStream ? remoteStream.getVideoTracks() : [];
              lines.push("Their mic track received: " + (remoteAudio.length ? "yes" : "NO"));
              lines.push("Their camera track received: " + (remoteVideo.length ? "yes" : "NO"));

              try {
                const stats = await peerConnection.getStats();
                let candidateType = "unknown";
                let bytesReceived = 0;
                stats.forEach((report) => {
                  if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
                    const localCand = stats.get(report.localCandidateId);
                    if (localCand) candidateType = localCand.candidateType;
                  }
                  if (report.type === "inbound-rtp" && report.kind === "video") {
                    bytesReceived = report.bytesReceived || 0;
                  }
                });
                lines.push("Connection type: " + candidateType + " (relay = using TURN, srflx/host = direct)");
                lines.push("Video bytes received: " + bytesReceived);
              } catch (err) {
                lines.push("Stats unavailable: " + err.message);
              }

              panel.textContent = lines.join("\\n");
            }

            function toggleVoiceFilterPicker() {
              const picker = document.getElementById("voiceFilterPicker");
              picker.style.display = picker.style.display === "flex" ? "none" : "flex";
            }

            function applyVoiceFilter(type) {
              if (!localStream || !peerConnection) return;
              const audioTrack = localStream.getAudioTracks()[0];
              if (!audioTrack) return;

              if (voiceFilterCtx) {
                voiceFilterCtx.close();
                voiceFilterCtx = null;
              }

              const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === "audio");

              if (type === "normal") {
                if (sender) sender.replaceTrack(audioTrack);
                document.getElementById("voiceFilterPicker").style.display = "none";
                return;
              }

              voiceFilterCtx = new (window.AudioContext || window.webkitAudioContext)();
              const source = voiceFilterCtx.createMediaStreamSource(new MediaStream([audioTrack]));
              const dest = voiceFilterCtx.createMediaStreamDestination();

              if (type === "robot") {
                const carrier = voiceFilterCtx.createOscillator();
                carrier.frequency.value = 50;
                const ringGain = voiceFilterCtx.createGain();
                ringGain.gain.value = 0;
                carrier.connect(ringGain.gain);
                carrier.start();
                source.connect(ringGain);
                ringGain.connect(dest);
              } else if (type === "deep") {
                const filter = voiceFilterCtx.createBiquadFilter();
                filter.type = "lowpass";
                filter.frequency.value = 700;
                source.connect(filter);
                filter.connect(dest);
              } else if (type === "echo") {
                const delay = voiceFilterCtx.createDelay();
                delay.delayTime.value = 0.28;
                const feedback = voiceFilterCtx.createGain();
                feedback.gain.value = 0.35;
                source.connect(dest);
                source.connect(delay);
                delay.connect(feedback);
                feedback.connect(delay);
                delay.connect(dest);
              }

              const newTrack = dest.stream.getAudioTracks()[0];
              if (sender) sender.replaceTrack(newTrack);
              document.getElementById("voiceFilterPicker").style.display = "none";
            }

            function hangUp(notifyOther) {
              stopRingtone();
              isCallingOut = false;
              clearInterval(debugPanelInterval);
              document.getElementById("callDebugPanel").style.display = "none";
              if (voiceFilterCtx) {
                voiceFilterCtx.close();
                voiceFilterCtx = null;
              }
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
              document.getElementById("voiceFilterPicker").style.display = "none";
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
const roomApprovedUsers = {}; // room -> Set of names approved to join a private/custom room
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

  // ---- Private room join approval ----
  socket.on("request-join-room", ({ room, requesterName }) => {
    const customRoom = db.prepare("SELECT created_by FROM custom_rooms WHERE room_id = ?").get(room);

    // Not a custom/private room, or requester is the owner, or already approved this session
    if (!customRoom || customRoom.created_by === requesterName || (roomApprovedUsers[room] && roomApprovedUsers[room].has(requesterName))) {
      socket.emit("join-approved");
      return;
    }

    // Ask the owner, wherever they currently are
    io.to("user-" + customRoom.created_by).emit("join-request", {
      room, requesterName, requesterSocketId: socket.id
    });
  });

  socket.on("respond-join-request", ({ room, requesterSocketId, approved, requesterName }) => {
    if (approved) {
      if (!roomApprovedUsers[room]) roomApprovedUsers[room] = new Set();
      roomApprovedUsers[room].add(requesterName);
      io.to(requesterSocketId).emit("join-approved");
    } else {
      io.to(requesterSocketId).emit("join-denied");
    }
  });

  socket.on("invite-to-room", ({ room, from, to }) => {
    // Pre-approve the invited person so they skip the approval popup entirely
    if (!roomApprovedUsers[room]) roomApprovedUsers[room] = new Set();
    roomApprovedUsers[room].add(to);
    io.to("user-" + to).emit("room-invite-received", { room, from });
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
    let landedType = "normal";
    if (newPos > 100) newPos = player.position; // must land exactly on 100
    if (SNL_LADDERS[newPos]) { newPos = SNL_LADDERS[newPos]; landedType = "ladder"; }
    else if (SNL_SNAKES[newPos]) { newPos = SNL_SNAKES[newPos]; landedType = "snake"; }

    player.position = newPos;
    game.lastMover = currentColor;
    game.landedType = landedType;
    game.moveSeq = (game.moveSeq || 0) + 1;

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
    game.moveSeq = 0;
    game.landedType = null;
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
      "INSERT INTO messages (from_user, to_user, text, type, file_name, file_data, reply_to_id, reply_to_from, reply_to_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      msg.from,
      msg.to,
      msg.text || null,
      msg.type || "text",
      msg.fileName || null,
      msg.fileData || null,
      msg.replyToId || null,
      msg.replyToFrom || null,
      msg.replyToPreview || null
    );
    msg.id = result.lastInsertRowid;
    io.to(msg.room).emit("chat message", msg);

    // Update friendship streak and let both people know the new count
    if (msg.to) {
      const newStreak = bumpStreak(msg.from, msg.to);
      io.to(msg.room).emit("streak-updated", { streak: newStreak });
    }

    // Notify the recipient wherever they currently are in the app
    if (msg.to) {
      let preview = "New message";
      if (msg.type === "image") preview = "📷 Photo";
      else if (msg.type === "file") preview = "📎 " + (msg.fileName || "File");
      else if (msg.type === "voice") preview = "🎤 Voice message";
      else if (msg.text) preview = msg.text.slice(0, 60);

      io.to("user-" + msg.to).emit("message-notification", { from: msg.from, preview });
    }
  });

  socket.on("toggle-reaction", ({ room, messageId, user, emoji }) => {
    const existing = db.prepare("SELECT emoji FROM reactions WHERE message_id = ? AND user_name = ?").get(messageId, user);

    if (existing && existing.emoji === emoji) {
      db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_name = ?").run(messageId, user);
    } else {
      db.prepare(
        "INSERT INTO reactions (message_id, user_name, emoji) VALUES (?, ?, ?) ON CONFLICT(message_id, user_name) DO UPDATE SET emoji = excluded.emoji"
      ).run(messageId, user, emoji);
    }

    const rows = db.prepare("SELECT user_name FROM reactions WHERE message_id = ? AND emoji = ?").all(messageId, emoji);
    io.to(room).emit("reaction-updated", { messageId, emoji, users: rows.map((r) => r.user_name) });

    // If the user had a different emoji before, tell clients to clear that old pill too
    if (existing && existing.emoji !== emoji) {
      const oldRows = db.prepare("SELECT user_name FROM reactions WHERE message_id = ? AND emoji = ?").all(messageId, existing.emoji);
      io.to(room).emit("reaction-updated", { messageId, emoji: existing.emoji, users: oldRows.map((r) => r.user_name) });
    }
  });

  socket.on("typing", ({ room, from }) => {
    socket.to(room).emit("typing", { from });
  });

  socket.on("stop-typing", ({ room, from }) => {
    socket.to(room).emit("stop-typing", { from });
  });

  socket.on("mark-read", ({ room, reader, other }) => {
    const latest = db.prepare(
      "SELECT MAX(id) as maxId FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)"
    ).get(reader, other, other, reader);
    const upToId = latest && latest.maxId ? latest.maxId : 0;
    if (!upToId) return;

    db.prepare(
      "INSERT INTO read_receipts (reader_name, other_name, last_read_id) VALUES (?, ?, ?) ON CONFLICT(reader_name, other_name) DO UPDATE SET last_read_id = excluded.last_read_id"
    ).run(reader, other, upToId);

    socket.to(room).emit("read-updated", { upToId });
  });

  socket.on("live-location-update", ({ room, liveId, lat, lng }) => {
    socket.to(room).emit("live-location-update", { liveId, lat, lng });
  });

  socket.on("live-location-stop", ({ room, liveId }) => {
    socket.to(room).emit("live-location-stop", { liveId });
  });

  socket.on("group-location-update", ({ room, name, lat, lng }) => {
    socket.to("room-" + room).emit("group-location-update", { name, lat, lng });
  });

  socket.on("group-location-stop", ({ room, name }) => {
    socket.to("room-" + room).emit("group-location-stop", { name });
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

  socket.on("ice-restart-offer", ({ room, offer }) => {
    socket.to(room).emit("ice-restart-offer", { offer });
  });

  socket.on("ice-restart-answer", ({ room, answer }) => {
    socket.to(room).emit("ice-restart-answer", { answer });
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