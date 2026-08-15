const http = require("http");
const url = require("url");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

// This opens (or creates, if it doesn't exist yet) a file called
// messenger.db - this file IS your database, sitting on disk
const db = new Database("messenger.db");

// Set up the tables if they don't already exist.
// A table is like a spreadsheet: rows and columns.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT,
    to_user TEXT,
    text TEXT
  );
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

    // "INSERT OR IGNORE" adds this user, but does nothing if they're
    // already in the table (since "name" is the PRIMARY KEY, duplicates
    // aren't allowed - the database itself prevents them)
    if (name) {
      db.prepare("INSERT OR IGNORE INTO users (name) VALUES (?)").run(name);
    }

    // Pull every signed-in user out of the database
    const allUsers = db.prepare("SELECT name FROM users").all().map((row) => row.name);

    const buddyListHTML = allUsers
      .filter((buddy) => buddy !== name)
      .map((buddy) => `<li><a style="color:#ffd966;" href="/chat?me=${name}&with=${buddy}">${buddy}</a></li>`)
      .join("");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:100px;">
          <h1>Welcome, ${name}!</h1>
          <h3>Signed-in Buddies</h3>
          <ul style="list-style:none; padding:0;">
            ${buddyListHTML || "<li>No one else is signed in yet</li>"}
          </ul>
        </body>
      </html>
    `);

  } else if (parsedUrl.pathname === "/chat") {
    const me = parsedUrl.query.me;
    const withBuddy = parsedUrl.query.with;

    // Get every message between exactly these two people, oldest first
    const conversation = db.prepare(`
      SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY id ASC
    `).all(me, withBuddy, withBuddy, me);

    const messagesHTML = conversation
      .map((m) => `<p><b>${m.from_user}:</b> ${m.text}</p>`)
      .join("");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="background:#5b1f9e; color:white; font-family:sans-serif; text-align:center; padding-top:60px;">
          <h2>Chat with ${withBuddy}</h2>
          <div id="chatBox" style="background:white; color:black; width:300px; margin:0 auto; padding:10px; min-height:150px; text-align:left; border-radius:6px; overflow-y:auto; max-height:300px;">
            ${messagesHTML || "<i>No messages yet</i>"}
          </div>
          <div style="margin-top:15px;">
            <input id="textBox" placeholder="Type a message" style="padding:8px; width:200px;" />
            <button onclick="sendMessage()" style="padding:8px 12px;">Send</button>
          </div>

          <script src="/socket.io/socket.io.js"></script>
          <script>
            const socket = io();
            const me = "${me}";
            const withBuddy = "${withBuddy}";

            socket.emit("join", { me, withBuddy });

            function sendMessage() {
              const textBox = document.getElementById("textBox");
              const text = textBox.value;
              if (!text) return;
              socket.emit("chat message", { from: me, to: withBuddy, text });
              textBox.value = "";
            }

            socket.on("chat message", (msg) => {
              const chatBox = document.getElementById("chatBox");
              const p = document.createElement("p");
              p.innerHTML = "<b>" + msg.from + ":</b> " + msg.text;
              chatBox.appendChild(p);
              chatBox.scrollTop = chatBox.scrollHeight;
            });

            document.getElementById("textBox").addEventListener("keydown", (e) => {
              if (e.key === "Enter") sendMessage();
            });
          </script>
        </body>
      </html>
    `);
  }
});

const io = new Server(server);

io.on("connection", (socket) => {
  socket.on("join", ({ me, withBuddy }) => {
    const room = [me, withBuddy].sort().join("-");
    socket.join(room);
  });

  socket.on("chat message", ({ from, to, text }) => {
    // Save the message permanently to the database
    db.prepare("INSERT INTO messages (from_user, to_user, text) VALUES (?, ?, ?)").run(from, to, text);

    const room = [from, to].sort().join("-");
    io.to(room).emit("chat message", { from, text });
  });
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});