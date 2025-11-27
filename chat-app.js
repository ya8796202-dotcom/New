#!/usr/bin/env node
/**
 * Single-file Phone Chat App
 * - Login by phone number
 * - Add contacts by phone number
 * - Real-time messaging via raw WebSocket
 * - Messages stored locally on both clients (LocalStorage)
 * - No external dependencies
 */

const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(INDEX_HTML);
  } else {
    res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end('Not found');
  }
});

const clientsByPhone = new Map(); // phone -> socket
const phoneBySocket = new WeakMap();
const PORT = process.env.PORT || 3000;

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  socket.on('data', buffer => {
    try {
      const frames = parseFrames(buffer);
      for (const f of frames) {
        if (f.opcode === 0x8) { // close
          cleanup(socket);
          try { socket.end(); } catch {}
          return;
        }
        if (f.opcode === 0x9) { // ping
          sendFrame(socket, Buffer.alloc(0), 0xA); // pong
          continue;
        }
        if (f.opcode === 0x1) { // text
          handleJson(socket, f.payload.toString('utf8'));
        }
      }
    } catch {
      cleanup(socket);
      try { socket.end(); } catch {}
    }
  });

  socket.on('end', () => cleanup(socket));
  socket.on('error', () => cleanup(socket));
});

function cleanup(socket) {
  const phone = phoneBySocket.get(socket);
  if (phone && clientsByPhone.get(phone) === socket) {
    clientsByPhone.delete(phone);
  }
}

function sendFrame(socket, data, opcode = 0x1) {
  const len = data.length;
  let header;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  socket.write(Buffer.concat([header, data]));
}

function parseFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const b0 = buf[i++], b1 = buf[i++];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;

    if (len === 126) { len = buf.readUInt16BE(i); i += 2; }
    else if (len === 127) {
      const hi = buf.readUInt32BE(i), lo = buf.readUInt32BE(i + 4);
      i += 8; if (hi !== 0) throw new Error('payload too big');
      len = lo;
    }

    let mask;
    if (masked) { mask = buf.slice(i, i + 4); i += 4; }
    if (i + len > buf.length) break;

    let payload = buf.slice(i, i + len); i += len;
    if (masked) {
      for (let k = 0; k < payload.length; k++) {
        payload[k] ^= mask[k % 4];
      }
    }
    out.push({ opcode, payload });
  }
  return out;
}

function sendJson(socket, obj) {
  sendFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
}

function normalizePhone(p) {
  if (!p) return null;
  const s = String(p).replace(/[^\d]/g, '');
  return s.length >= 7 ? s : null;
}

function handleJson(socket, text) {
  let data; try { data = JSON.parse(text); } catch { return; }
  switch (data.type) {
    case 'login': {
      const phone = normalizePhone(data.phone);
      if (!phone) return sendJson(socket, { type: 'error', error: 'invalid_phone' });
      phoneBySocket.set(socket, phone);
      clientsByPhone.set(phone, socket);
      sendJson(socket, { type: 'login_ok', phone });
      break;
    }
    case 'send': {
      const from = phoneBySocket.get(socket);
      if (!from) return sendJson(socket, { type: 'error', error: 'not_logged_in' });
      const to = normalizePhone(data.to);
      const message = String(data.message ?? '');
      const id = String(data.id ?? '');
      const ts = Number(data.ts ?? Date.now());
      if (!to || !message) return sendJson(socket, { type: 'error', error: 'bad_request' });

      const payload = { type: 'receive', from, to, message, id, ts };
      const toSock = clientsByPhone.get(to);
      if (toSock) sendJson(toSock, payload); // يسلم للطرف الآخر لو أونلاين
      sendJson(socket, { type: 'sent_ok', to, id, ts }); // تأكيد للمرسل
      break;
    }
    default:
      sendJson(socket, { type: 'error', error: 'unknown_type' });
  }
}

server.listen(PORT, () => {
  console.log(`Chat app on http://localhost:${PORT}`);
});

const INDEX_HTML = `
<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>دردشة برقم الهاتف</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #0b0c0e; color: #e9eaee; }
  header { padding: 12px 16px; background: #121318; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #1f2026; }
  input, button { font: inherit; }
  input[type="text"] { padding: 8px; border-radius: 8px; border: 1px solid #2b2d36; background: #15161c; color: #e9eaee; }
  button { padding: 8px 12px; border-radius: 8px; border: 1px solid #2b2d36; background: #1a1b22; color: #e9eaee; cursor: pointer; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 50px); }
  .sidebar { border-left: 1px solid #1f2026; padding: 8px; background: #0f1014; }
  .section-title { font-size: 14px; opacity: .8; margin: 12px 8px; }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .item { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-radius: 8px; background: #14151b; border: 1px solid #2b2d36; }
  .chat { display: flex; flex-direction: column; height: calc(100vh - 50px); }
  .messages { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 65%; padding: 8px 10px; border-radius: 12px; border: 1px solid #2b2d36; background: #181a22; }
  .msg.me { align-self: flex-start; background: #17263a; border-color: #234; }
  .msg.them { align-self: flex-end; background: #1e1f28; }
  .msg .meta { font-size: 12px; opacity: .7; margin-top: 4px; }
  .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #1f2026; background: #121318; }
  .row { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
<header>
  <div class="row">
    <span>تسجيل الدخول برقم الهاتف:</span>
    <input id="loginPhone" type="text" placeholder="مثال: 2010xxxxxxx" />
    <button id="loginBtn">دخول</button>
    <span id="status" style="font-size:12px;opacity:.8;"></span>
  </div>
</header>

<main>
  <aside class="sidebar">
    <div class="section-title">جهات الاتصال</div>
    <div class="row" style="margin:8px;">
      <input id="contactPhone" type="text" placeholder="رقم الهاتف" />
      <button id="addContactBtn">إضافة</button>
    </div>
    <div class="list" id="contacts"></div>

    <div class="section-title">المحادثات</div>
    <div class="list" id="chats"></div>
  </aside>

  <section class="chat">
    <div class="messages" id="messages"></div>
    <div class="composer">
      <input id="messageInput" type="text" placeholder="اكتب رسالة..." />
      <button id="sendBtn" disabled>إرسال</button>
    </div>
  </section>
</main>

<script>
  const state = {
    phone: null,
    ws: null,
    contacts: loadJson('contacts', []),
    chats: loadJson('chats', []),
    currentChat: null
  };

  const statusEl = document.getElementById('status');
  const loginPhoneEl = document.getElementById('loginPhone');
  const loginBtnEl = document.getElementById('loginBtn');
  const contactPhoneEl = document.getElementById('contactPhone');
  const addContactBtnEl = document.getElementById('addContactBtn');
  const contactsEl = document.getElementById('contacts');
  const chatsEl = document.getElementById('chats');
  const messagesEl = document.getElementById('messages');
  const messageInputEl = document.getElementById('messageInput');
  const sendBtnEl = document.getElementById('sendBtn');

  // استرجاع آخر رقم مُستخدم
  const lastPhone = localStorage.getItem('last_phone');
  if (lastPhone) loginPhoneEl.value = lastPhone;

  renderContacts();
  renderChats();

  loginBtnEl.addEventListener('click', () => {
    const phone = normalizePhone(loginPhoneEl.value);
    if (!phone) return setStatus('رقم غير صالح');
    connectWS(() => sendWS({ type: 'login', phone }));
  });

  addContactBtnEl.addEventListener('click', () => {
    const phone = normalizePhone(contactPhoneEl.value);
    if (!phone) return setStatus('رقم غير صالح');
    if (!state.contacts.includes(phone)) {
      state.contacts.push(phone);
      saveJson('contacts', state.contacts);
      renderContacts();
      addChat(phone);
    }
    contactPhoneEl.value = '';
  });

  sendBtnEl.addEventListener('click', sendMessage);
  messageInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  function sendMessage() {
    const text = messageInputEl.value.trim();
    if (!text || !state.currentChat || !state.phone) return;
    const id = genId();
    const ts = Date.now();
    const to = state.currentChat;

    // حفظ محلي للطرف المرسل
    saveMessage(to, { id, from: state.phone, to, message: text, ts, direction: 'me' });
    renderMessages(to);
    messageInputEl.value = '';

    // إرسال للطرف الآخر عبر WS
    sendWS({ type: 'send', to, message: text, id, ts });
  }

  function connectWS(onOpen) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    state.ws = ws;
    setStatus('يتصل بالسيرفر...');
    ws.onopen = () => { setStatus('متصل'); onOpen && onOpen(); };
    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'login_ok') {
        state.phone = data.phone;
        localStorage.setItem('last_phone', data.phone);
        setStatus('تم الدخول: ' + data.phone);
        sendBtnEl.disabled = !state.currentChat;
      } else if (data.type === 'sent_ok') {
        // تأكيد إرسال (يمكن استخدامه لعلامة تم التسليم)
      } else if (data.type === 'receive') {
        const other = (data.from === state.phone) ? data.to : data.from;
        addChat(other);
        const dir = (data.to === state.phone) ? 'them' : 'me';
        saveMessage(other, { id: data.id, from: data.from, to: data.to, message: data.message, ts: data.ts, direction: dir });
        if (state.currentChat === other) renderMessages(other);
      } else if (data.type === 'error') {
        setStatus('خطأ: ' + data.error);
      }
    };
    ws.onclose = () => setStatus('غير متصل');
    ws.onerror = () => setStatus('مشكلة اتصال');
  }

  function sendWS(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return setStatus('الاتصال غير جاهز');
    state.ws.send(JSON.stringify(obj));
  }

  function setStatus(t) { statusEl.textContent = t; }

  function renderContacts() {
    contactsEl.innerHTML = '';
    state.contacts.forEach(phone => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = '<span>' + phone + '</span>';
      const btn = document.createElement('button');
      btn.textContent = 'محادثة';
      btn.onclick = () => { addChat(phone); openChat(phone); };
      div.appendChild(btn);
      contactsEl.appendChild(div);
    });
  }

  function addChat(phone) {
    if (!state.chats.includes(phone)) {
      state.chats.unshift(phone);
      saveJson('chats', state.chats);
      renderChats();
    }
  }

  function renderChats() {
    chatsEl.innerHTML = '';
    state.chats.forEach(phone => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = '<span>' + phone + '</span>';
      const btn = document.createElement('button');
      btn.textContent = (state.currentChat === phone) ? 'مفتوحة' : 'فتح';
      btn.onclick = () => openChat(phone);
      div.appendChild(btn);
      chatsEl.appendChild(div);
    });
  }

  function openChat(phone) {
    state.currentChat = phone;
    sendBtnEl.disabled = !state.phone;
    renderChats();
    renderMessages(phone);
  }

  function renderMessages(phone) {
    messagesEl.innerHTML = '';
    const msgs = loadMessages(phone).sort((a,b) => a.ts - b.ts);
    msgs.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.direction === 'me' ? 'me' : 'them');
      const text = document.createElement('div'); text.textContent = m.message;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (m.direction === 'me' ? 'أرسلت' : 'وصلت') + ' • ' + new Date(m.ts).toLocaleString();
      div.appendChild(text); div.appendChild(meta);
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // تخزين محلي
  function keyForChat(phone) { return 'chat_' + phone; }
  function saveMessage(phone, msg) {
    const list = loadMessages(phone); list.push(msg);
    localStorage.setItem(keyForChat(phone), JSON.stringify(list));
  }
  function loadMessages(phone) {
    const raw = localStorage.getItem(keyForChat(phone)); if (!raw) return [];
    try { return JSON.parse(raw) || []; } catch { return []; }
  }
  function saveJson(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function loadJson(k, fb) {
    const raw = localStorage.getItem(k); if (!raw) return fb;
    try { return JSON.parse(raw) ?? fb; } catch { return fb; }
  }

  function normalizePhone(p) {
    if (!p) return null;
    const s = String(p).replace(/[^\\d]/g, '');
    return s.length >= 7 ? s : null;
  }
  function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
</script>
</body>
</html>
`;
