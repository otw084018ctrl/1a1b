// 1A1B 連線對戰 — 零依賴，只需 Node.js 18+
// 執行：node 1a1b-server.js   （可用 PORT=8080 node 1a1b-server.js 改埠號）
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SET_OPTIONS = [10, 20, 30];  // 設定數字時間（秒）
const TURN_OPTIONS = [0, 40, 60];  // 每回合時間（秒），0 = 不限
const CHAT_MAX = 60;               // 每間房保留的聊天訊息數
const IDLE_MS = 10 * 60 * 1000;    // 房間沒人在線超過這個時間就關掉
const rooms = new Map();

// ---------- 遊戲邏輯 ----------
// 4 個不重複數字，第一位不能是 0
const valid = s => /^[1-9]\d{3}$/.test(s) && new Set(s).size === 4;
function score(secret, guess) {
  let a = 0, b = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) a++;
    else if (secret.includes(guess[i])) b++;
  }
  return { a, b };
}
function randomSecret() {
  let s;
  do {
    const d = '0123456789'.split('');
    for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
    s = d.slice(0, 4).join('');
  } while (!valid(s));
  return s;
}
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  // 家用 Wi-Fi 常見的 192.168.x.x 排前面
  return out.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
}
function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const anyOnline = room => room.players.some(p => p.res);
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.turnTimer);
  room.turnDeadline = 0;
}
function startSetting(room) {
  clearTimers(room);
  room.phase = 'setting';
  room.deadline = Date.now() + room.settings.setSec * 1000;
  room.timer = setTimeout(() => {
    if (room.phase !== 'setting') return;
    for (const p of room.players) if (!p.secret) { p.secret = randomSecret(); p.auto = true; }
    startPlaying(room);
    broadcast(room);
  }, room.settings.setSec * 1000);
}
function startPlaying(room) {
  clearTimers(room);
  room.phase = 'playing';
  setTurn(room, room.starter);
}
function setTurn(room, i) {
  clearTimeout(room.turnTimer);
  room.turn = i;
  room.turnDeadline = 0;
  room.paused = false;
  const sec = room.settings.turnSec;
  if (!sec) return;
  room.turnDeadline = Date.now() + sec * 1000;
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'playing' || room.turn !== i) return;
    if (!anyOnline(room)) { room.paused = true; room.turnDeadline = 0; return; } // 沒人在線就暫停
    room.players[i].guesses.push({ timeout: true });
    afterMove(room, i, 0);
    broadcast(room);
  }, sec * 1000);
}
function afterMove(room, i, a) {
  if (room.lastChance) {
    // 後手的最後一次機會：猜中就平手，否則先手贏
    finish(room, a === 4 ? null : room.starter, 'guess');
  } else if (a === 4) {
    if (i === room.starter) { room.lastChance = true; setTurn(room, 1 - i); } // 給後手一次追平機會
    else finish(room, i, 'guess');
  } else {
    setTurn(room, 1 - i);
  }
}
function finish(room, winner, reason, by) {
  clearTimers(room);
  room.phase = 'over';
  room.result = { winner, reason, by };
}
function resetRound(room) {
  clearTimers(room);
  room.lastChance = false;
  room.result = null;
  room.rematch = new Set();
  for (const p of room.players) { p.secret = null; p.auto = false; p.guesses = []; }
  if (room.players.length === 2) startSetting(room);
  else room.phase = 'waiting';
}
function closeRoom(room) {
  clearTimers(room);
  for (const p of room.players) if (p.res) p.res.end();
  rooms.delete(room.code);
}

function view(room, pid) {
  const i = room.players.findIndex(p => p.id === pid);
  const me = room.players[i];
  const opp = room.players[1 - i];
  const over = room.phase === 'over';
  let result = null;
  if (over) {
    const r = room.result;
    result = {
      outcome: r.winner === null ? 'draw' : r.winner === i ? 'win' : 'lose',
      reason: r.reason === 'surrender' ? (r.by === i ? 'iSurrendered' : 'oppSurrendered') : 'guess',
    };
  }
  return {
    room: room.code,
    name: room.name,
    phase: room.phase,
    settings: room.settings,
    setMsLeft: room.phase === 'setting' ? Math.max(0, room.deadline - Date.now()) : 0,
    turnMsLeft: room.phase === 'playing' && room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : 0,
    myTurn: room.phase === 'playing' && room.turn === i,
    lastChance: room.lastChance,
    iStart: room.starter === i,
    result,
    oppLeft: !!room.oppLeft && room.players.length === 1,
    rematchMe: room.rematch.has(pid),
    rematchOpp: opp ? room.rematch.has(opp.id) : false,
    me: { name: me.name, secret: me.secret, auto: me.auto, guesses: me.guesses },
    opp: opp ? {
      name: opp.name,
      online: !!opp.res,
      ready: !!opp.secret,
      guesses: opp.guesses,
      secret: over ? opp.secret : null,
    } : null,
    chat: room.chat.map(m => ({ id: m.id, name: m.name, text: m.text, mine: m.pid === pid })),
    ips: lanIPs(),
    port: PORT,
  };
}
function broadcast(room) {
  for (const p of room.players)
    if (p.res) p.res.write(`data: ${JSON.stringify(view(room, p.id))}\n\n`);
}
function summary(room) {
  return {
    code: room.code,
    name: room.name,
    host: room.players[0] ? room.players[0].name : '',
    players: room.players.length,
    phase: room.phase,
    settings: room.settings,
  };
}

// ---------- API ----------
const api = {
  // 大廳的房間列表：只列出有人在線的房間
  rooms() {
    const list = [...rooms.values()].filter(anyOnline)
      .sort((a, b) => (a.players.length - b.players.length) || (b.created - a.created))
      .map(summary);
    return { rooms: list };
  },
  // 邀請連結打開時，先看房間資訊
  info({ room: code }) {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) throw new Error('這個房間已經關閉了');
    return summary(room);
  },
  join({ room: code, name, pid, roomName, setSec, turnSec, mode }) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let room;
    if (!code) {
      // 建立新房間
      code = newRoomCode();
      room = {
        code, name: cleanText(roomName, 16), players: [], starter: 0, phase: 'waiting',
        rematch: new Set(), chat: [], chatSeq: 0, created: Date.now(), idleSince: Date.now(),
        settings: {
          setSec: SET_OPTIONS.includes(Number(setSec)) ? Number(setSec) : 10,
          turnSec: TURN_OPTIONS.includes(Number(turnSec)) ? Number(turnSec) : 0,
          mode: mode === 'easy' ? 'easy' : 'normal', // easy：A 會標出位置
        },
      };
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room) throw new Error('找不到房間 ' + code + '，可能已經關閉了');
    }
    const existing = room.players.find(p => p.id === pid);
    if (existing) { if (name) existing.name = cleanText(name, 12) || existing.name; return { pid, room: code }; }
    if (room.players.length >= 2) throw new Error('這個房間已經滿了');
    const id = crypto.randomUUID();
    room.players.push({ id, name: cleanText(name, 12) || `玩家${room.players.length + 1}`, secret: null, auto: false, guesses: [], res: null, lastChat: 0 });
    room.oppLeft = false;
    if (room.players.length === 2) resetRound(room);
    broadcast(room);
    return { pid: id, room: code };
  },
  secret({ secret }, room, i) {
    if (room.phase !== 'setting') throw new Error('現在不能設定數字');
    if (!valid(secret)) throw new Error('4 個不重複的數字，第一位不能是 0');
    room.players[i].secret = secret;
    if (room.players.every(p => p.secret)) startPlaying(room); // 兩人都設好就提早開始
    broadcast(room);
    return { ok: true };
  },
  guess({ guess }, room, i) {
    if (room.phase !== 'playing') throw new Error('遊戲尚未開始');
    if (room.turn !== i) throw new Error('還沒輪到你');
    if (!valid(guess)) throw new Error('4 個不重複的數字，第一位不能是 0');
    const opp = room.players[1 - i];
    const { a, b } = score(opp.secret, guess);
    const g = { guess, a, b };
    if (room.settings.mode === 'easy') g.pos = [0, 1, 2, 3].filter(k => guess[k] === opp.secret[k]);
    room.players[i].guesses.push(g);
    afterMove(room, i, a);
    broadcast(room);
    return { a, b };
  },
  chat({ text }, room, i) {
    const p = room.players[i];
    text = cleanText(text, 100);
    if (!text) throw new Error('訊息是空的');
    if (Date.now() - p.lastChat < 400) throw new Error('慢一點，訊息傳太快了');
    p.lastChat = Date.now();
    room.chat.push({ id: ++room.chatSeq, pid: p.id, name: p.name, text });
    if (room.chat.length > CHAT_MAX) room.chat.splice(0, room.chat.length - CHAT_MAX);
    broadcast(room);
    return { ok: true };
  },
  surrender(_, room, i) {
    if (room.phase !== 'setting' && room.phase !== 'playing') throw new Error('現在不能投降');
    finish(room, 1 - i, 'surrender', i);
    broadcast(room);
    return { ok: true };
  },
  leave(_, room, i) {
    const [p] = room.players.splice(i, 1);
    if (p.res) { p.res.end(); p.res = null; }
    if (room.players.length === 0) { closeRoom(room); return { ok: true }; }
    room.starter = 0;
    room.oppLeft = true;
    resetRound(room);
    broadcast(room);
    return { ok: true };
  },
  rematch({ pid }, room) {
    if (room.phase !== 'over') throw new Error('遊戲還沒結束');
    room.rematch.add(pid);
    if (room.rematch.size === 2) { room.starter = 1 - room.starter; resetRound(room); }
    broadcast(room);
    return { ok: true };
  },
};
const ROOMLESS = new Set([api.rooms, api.info, api.join]);

// 沒人在線太久的房間自動關掉
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values())
    if (!anyOnline(room) && now - room.idleSince > IDLE_MS) closeRoom(room);
}, 60 * 1000).unref();

// ---------- HTTP ----------
function readJSON(req) {
  return new Promise((ok, fail) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { fail(e); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const room = rooms.get(url.searchParams.get('room'));
    const p = room && room.players.find(p => p.id === url.searchParams.get('pid'));
    if (!p) return send(res, 404, { error: '找不到房間或玩家' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (p.res) p.res.end();
    p.res = res;
    if (room.paused && room.phase === 'playing') setTurn(room, room.turn); // 有人回來就繼續計時
    broadcast(room);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      if (p.res === res) {
        p.res = null;
        if (!anyOnline(room)) room.idleSince = Date.now();
        broadcast(room);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const fn = Object.hasOwn(api, url.pathname.slice(5)) && api[url.pathname.slice(5)];
    if (!fn) return send(res, 404, { error: 'not found' });
    try {
      const body = await readJSON(req);
      if (ROOMLESS.has(fn)) return send(res, 200, fn(body));
      const room = rooms.get(body.room);
      const i = room ? room.players.findIndex(p => p.id === body.pid) : -1;
      if (i < 0) throw new Error('找不到房間或玩家');
      return send(res, 200, fn(body, room, i));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  res.writeHead(404); res.end();
}).on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('\n  [!] ' + PORT + ' 埠已經被佔用，通常是舊的遊戲伺服器還開著。');
    console.log('      請把舊的黑色視窗關掉（或在裡面按 Ctrl+C），再重新執行一次。');
    console.log('      找不到舊視窗的話，開 cmd 輸入：taskkill /im node.exe /f\n');
  } else console.log('\n  [!] 伺服器啟動失敗：' + e.message + '\n');
  process.exitCode = 1;
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n  1A1B 對戰伺服器已啟動\n');
  console.log(`  本機：      http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  同 Wi-Fi：  http://${ip}:${PORT}`);
  console.log('\n  按 Ctrl+C 結束\n');
});

// ---------- 前端頁面 ----------
const PAGE = /* html */ `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#eef0f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101215" media="(prefers-color-scheme: dark)">
<title>1A1B</title>
<style>
/* 版面：手機單欄。上方狀態列 → 中間記分表（可捲動）→ 底部固定數字盤；聊天室從底部滑出 */
:root{
  --bg:#eef0f2; --surface:#ffffff; --sunk:#e5e8ec; --ink:#15181c; --mute:#69707a; --faint:#a3a9b1; --line:#d7dbe0;
  --me:#2c5a8c; --me-soft:#e6edf5; --a:#1d7a4e; --b:#a46812; --warn:#b42318; --scrim:rgba(16,18,21,.38);
  --sans:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
  --mono:"SF Mono",ui-monospace,Menlo,Consolas,"Roboto Mono",monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#101215; --surface:#181b1f; --sunk:#0c0e10; --ink:#e6e8eb; --mute:#8b929b; --faint:#5a616a; --line:#2a2f36;
  --me:#86acd9; --me-soft:#1b2633; --a:#55c28d; --b:#e2b150; --warn:#f07462; --scrim:rgba(0,0,0,.55); color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#101215; --surface:#181b1f; --sunk:#0c0e10; --ink:#e6e8eb; --mute:#8b929b; --faint:#5a616a; --line:#2a2f36;
  --me:#86acd9; --me-soft:#1b2633; --a:#55c28d; --b:#e2b150; --warn:#f07462; --scrim:rgba(0,0,0,.55); color-scheme:dark}

*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);-webkit-text-size-adjust:100%}
button{font:inherit;color:inherit;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
button:disabled{cursor:default}
:focus-visible{outline:2px solid var(--me);outline-offset:2px}
.hide{display:none!important}

.app{height:100%;max-width:460px;margin:0 auto;display:flex;flex-direction:column;background:var(--bg);position:relative}
@media (min-width:520px){.app{border-left:1px solid var(--line);border-right:1px solid var(--line)}}
.screen{flex:1;min-height:0;display:flex;flex-direction:column}

/* ---------- 大廳 ---------- */
.lobby{overflow:auto;padding:max(28px,env(safe-area-inset-top)) 20px max(28px,env(safe-area-inset-bottom));gap:22px}
.mark{font:700 40px/1 var(--mono);letter-spacing:-.02em}
.mark i{font-style:normal;color:var(--a)}.mark u{text-decoration:none;color:var(--b)}
.rules{margin:0;color:var(--mute);font-size:14px;line-height:1.7}
.rules b{font-family:var(--mono)}
.ta{color:var(--a)}.tb{color:var(--b)}
.group{display:flex;flex-direction:column;gap:12px;padding-top:18px;border-top:1px solid var(--line)}
.glabel{font-size:12px;letter-spacing:.08em;color:var(--mute)}
.glabel small{letter-spacing:0;color:var(--faint);font-size:12px;margin-left:4px}
.field{display:flex;align-items:center;justify-content:space-between;gap:12px}
.field>span{font-size:14px;flex:none}
input{font:inherit;font-size:16px;width:100%;min-width:0;height:46px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink)}
input::placeholder{color:var(--faint)}
#roomIn{font-family:var(--mono);text-transform:uppercase;letter-spacing:.3em}
.seg{display:flex;background:var(--sunk);border-radius:9px;padding:3px;gap:2px}
.seg button{border:0;background:none;padding:6px 12px;border-radius:7px;font-size:14px;color:var(--mute);font-variant-numeric:tabular-nums}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.btn{height:46px;padding:0 18px;border-radius:10px;border:1px solid var(--line);background:var(--surface);font-weight:600;white-space:nowrap}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn:disabled{opacity:.4}
.row{display:flex;gap:10px}
.msg{font-size:13px;color:var(--warn);min-height:20px}

/* 房間列表 */
.rlist{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
.ritem{display:flex;align-items:center;gap:12px;padding:12px 14px;border:0;border-top:1px solid var(--line);background:none;text-align:left;width:100%}
.ritem:first-child{border-top:0}
.ritem:not(:disabled):active{background:var(--sunk)}
.ritem .info{flex:1;min-width:0}
.ritem .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ritem .nm .cd{font:500 12px var(--mono);letter-spacing:.12em;color:var(--faint);margin-left:6px}
.ritem .meta{font-size:12px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ritem .go{flex:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:8px;background:var(--ink);color:var(--bg)}
.ritem:disabled .go{background:none;color:var(--faint);font-weight:500;padding:6px 0}
.rempty{padding:18px 14px;color:var(--faint);font-size:14px;text-align:center}

/* 邀請畫面 */
.invite{justify-content:center}
.invite .host{color:var(--mute);font-size:14px}
.invite .rname{font-size:28px;font-weight:700;line-height:1.25;text-wrap:balance}
.invite .rcode{font:600 14px var(--mono);letter-spacing:.24em;color:var(--mute)}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:12px;padding:4px 10px;border:1px solid var(--line);border-radius:99px;color:var(--mute)}
.linkbtn{border:0;background:none;color:var(--mute);font-size:14px;padding:8px 0;text-decoration:underline;text-underline-offset:3px;align-self:flex-start}

/* ---------- 遊戲畫面 ---------- */
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:max(10px,env(safe-area-inset-top)) 16px 10px;border-bottom:1px solid var(--line)}
.bar .left{display:flex;align-items:center;gap:8px;min-width:0}
.bar .title{font-weight:700;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.code{font:600 12px var(--mono);letter-spacing:.18em;color:var(--mute);flex:none}
.modetag{font-size:11px;color:var(--a);border:1px solid var(--a);border-radius:5px;padding:0 6px;letter-spacing:.04em;flex:none}
.bar .right{display:flex;align-items:center;gap:14px;flex:none}
.textbtn{border:0;background:none;padding:6px 2px;font-size:14px;color:var(--mute);position:relative}
.textbtn.arm{color:var(--warn);font-weight:600}
.badge{position:absolute;top:0;right:-10px;min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:var(--warn);color:#fff;font:700 11px/17px var(--sans);text-align:center}

.status{padding:12px 16px 0}
.status .line{display:flex;align-items:center;justify-content:space-between;gap:12px}
.who{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--mute);min-width:0}
.who b{color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.dot.on{background:var(--a)}
.clock{font:600 14px var(--mono);color:var(--mute);font-variant-numeric:tabular-nums}
.clock.low{color:var(--warn)}
.turn{font-size:20px;font-weight:700;margin-top:6px}
.turn.mine{color:var(--me)}
.turn.idle{color:var(--mute);font-weight:500}
.sub{font-size:13px;color:var(--mute);min-height:20px}
.timebar{height:2px;background:var(--line);margin-top:10px;border-radius:2px;overflow:hidden}
.timebar i{display:block;height:100%;width:100%;background:var(--ink);transform-origin:left;transition:transform .2s linear}
.timebar.low i{background:var(--warn)}

.sheet{flex:1;min-height:0;overflow:auto;padding:0 16px;-webkit-overflow-scrolling:touch}

/* 等待 */
.wait{padding:30px 0;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center}
.wait .big{font:700 52px/1 var(--mono);letter-spacing:.18em;margin:6px 0 4px}
.wait .k{font-size:12px;letter-spacing:.08em;color:var(--mute)}
.wait .chips{justify-content:center}
.share{display:flex;flex-direction:column;gap:8px;width:100%;max-width:320px;margin-top:6px}
.share .url{font:13px var(--mono);color:var(--mute);word-break:break-all;user-select:all;padding:10px 12px;border:1px dashed var(--line);border-radius:10px}

/* 設定數字倒數 */
.setv{padding:28px 0 12px;text-align:center}
.count{font:700 84px/1 var(--mono);font-variant-numeric:tabular-nums}
.count.low{color:var(--warn)}
.setv p{margin:12px 0 0;color:var(--mute);font-size:14px}
.setv .mine{font:700 28px var(--mono);letter-spacing:.2em;color:var(--ink);margin-top:14px}

/* 記分表 */
.board{padding:10px 0 16px}
.bhead,.brow{display:grid;grid-template-columns:22px 1fr 1fr;gap:8px;align-items:center}
.bhead{position:sticky;top:0;background:var(--bg);padding:8px 0;font-size:12px;color:var(--mute);border-bottom:1px solid var(--line);z-index:1}
.bhead .me{color:var(--me);font-weight:600}
.bhead em{font-style:normal;font-family:var(--mono);letter-spacing:.12em;color:var(--ink)}
.brow{padding:4px 0;border-bottom:1px solid var(--line)}
.brow .n{font:12px var(--mono);color:var(--faint);text-align:center}
.cell{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 10px;border-radius:8px;min-height:42px}
.cell.me{background:var(--me-soft)}
.cell .dg{font:600 18px var(--mono);letter-spacing:.12em}
.cell .rs{font:600 14px var(--mono);white-space:nowrap}
.dg .hit{color:var(--a);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:4px}
.rs .ra{color:var(--a)}.rs .rb{color:var(--b)}.rs .zero{color:var(--faint)}
.cell.to .dg{font:500 13px var(--sans);letter-spacing:0;color:var(--faint)}
.cell.win{box-shadow:inset 0 0 0 1.5px var(--a)}
.cell.new{animation:pop .5s ease-out}
@keyframes pop{from{background:var(--sunk)}}
.empty{padding:28px 0;text-align:center;color:var(--faint);font-size:14px}

/* 筆記列 */
.notes{display:flex;align-items:center;gap:6px;padding:8px 16px;border-top:1px solid var(--line)}
.notes .lbl{font-size:12px;color:var(--mute);margin-right:4px;flex:none}
.notes button{flex:1;min-width:0;height:30px;border:1px solid var(--line);border-radius:7px;background:none;font:500 14px var(--mono);padding:0}
.notes button.x{color:var(--faint);text-decoration:line-through;border-color:transparent}
.notes button.y{color:var(--a);border-color:var(--a);font-weight:700}

/* 底部數字盤 */
.dock{background:var(--surface);border-top:1px solid var(--line);padding:12px 12px max(12px,env(safe-area-inset-bottom))}
.slots{display:flex;justify-content:center;gap:8px;margin-bottom:10px}
.slot{width:44px;height:50px;border-radius:9px;background:var(--sunk);display:grid;place-items:center;font:600 24px var(--mono);border:1.5px solid transparent}
.slot.cur{border-color:var(--ink)}
.keys{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
.keys button{height:48px;border-radius:10px;border:1px solid var(--line);background:var(--bg);font:500 20px var(--mono);padding:0}
.keys button:active:not(:disabled){background:var(--sunk)}
.keys button:disabled{color:var(--faint);opacity:.55}
.keys .del{font-family:var(--sans);font-size:18px}
.keys .go{background:var(--ink);color:var(--bg);border-color:var(--ink);font:600 15px var(--sans)}
.keys .go:disabled{background:var(--sunk);color:var(--faint);border-color:var(--line);opacity:1}
.dmsg{font-size:13px;text-align:center;min-height:18px;margin:-4px 0 6px;color:var(--mute)}
.dmsg.err{color:var(--warn)}

/* 結算 */
.over{display:flex;flex-direction:column;gap:6px;padding:4px 4px 0}
.over .otitle{font-size:26px;font-weight:700}
.over .otitle.win{color:var(--a)}.over .otitle.lose{color:var(--warn)}
.over .why{font-size:14px;color:var(--mute)}
.over .reveal{display:flex;gap:18px;margin:8px 0 12px;font-size:13px;color:var(--mute)}
.over .reveal b{display:block;font:600 22px var(--mono);letter-spacing:.14em;color:var(--ink)}
.over .row .btn{flex:1}

/* 對手訊息：從對手名字下方冒出的對話泡泡 */
.status{position:relative}
.toast{position:absolute;left:12px;right:16px;top:38px;z-index:5;display:flex;pointer-events:none}
.toast div{position:relative;max-width:100%;background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:4px 14px 14px 14px;font-size:15px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;word-break:break-word;transform-origin:top left;animation:bubble .28s cubic-bezier(.2,.9,.3,1.3)}
.toast div::before{content:"";position:absolute;left:0;top:-7px;border:7px solid transparent;border-left-color:var(--ink);border-bottom:0}
.toast div.emo{font-size:34px;line-height:1.1;padding:6px 10px}
@keyframes bubble{from{transform:scale(.6);opacity:0}}

/* 聊天室 */
.chatwrap{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;justify-content:flex-end;background:var(--scrim)}
.chat{background:var(--surface);border-radius:16px 16px 0 0;height:72%;max-height:560px;display:flex;flex-direction:column;animation:up .22s ease-out}
@keyframes up{from{transform:translateY(24px);opacity:.6}}
.chead{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line)}
.chead b{font-size:16px}
.msgs{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.msgs .none{margin:auto;color:var(--faint);font-size:14px}
.m{display:flex;flex-direction:column;align-items:flex-start;max-width:80%}
.m.mine{align-self:flex-end;align-items:flex-end}
.m .nm{font-size:11px;color:var(--faint);margin:0 4px 2px}
.m .tx{padding:7px 12px;border-radius:14px;background:var(--sunk);font-size:15px;line-height:1.45;word-break:break-word}
.m.mine .tx{background:var(--me-soft);color:var(--ink)}
.m .tx.emo{background:none;padding:0 2px;font-size:38px;line-height:1.1}
.quick{display:flex;gap:6px;overflow-x:auto;padding:10px 16px 0;scrollbar-width:none}
.quick::-webkit-scrollbar{display:none}
.quick button{flex:none;border:1px solid var(--line);background:var(--bg);border-radius:99px;padding:6px 12px;font-size:14px;white-space:nowrap}
.quick button:active{background:var(--sunk)}
.emos{display:flex;gap:2px;overflow-x:auto;padding:8px 12px 0;scrollbar-width:none}
.emos::-webkit-scrollbar{display:none}
.emos button{flex:none;border:0;background:none;font-size:26px;width:44px;height:44px;border-radius:10px;padding:0}
.emos button:active{background:var(--sunk)}
.cform{display:flex;gap:8px;padding:10px 12px max(12px,env(safe-area-inset-bottom))}
.cform input{height:42px;border-radius:21px}
.cform .btn{height:42px;border-radius:21px}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="app">

<!-- 大廳 -->
<section id="lobby" class="screen lobby">
  <div class="mark">1<i>A</i>1<u>B</u></div>
  <p class="rules">兩人各設一組 4 位數，數字不重複、首位不為 0，輪流猜對方的數字。<b class="ta">A</b>＝數字與位置都對，<b class="tb">B</b>＝數字對但位置不對。先猜到 4A 的人獲勝；先手猜中時，後手還有一次追平機會。<br>簡單模式會直接報 A 的位置。</p>
  <div class="group" style="border-top:0;padding-top:0">
    <label class="glabel" for="name">你的名字</label>
    <input id="name" maxlength="12" placeholder="輸入暱稱" autocomplete="off" enterkeyhint="done">
  </div>
  <div class="group">
    <div class="glabel">開新房間</div>
    <input id="roomName" maxlength="16" placeholder="房間名稱（可不填）" autocomplete="off" enterkeyhint="done" aria-label="房間名稱">
    <div class="field"><span>模式</span><div class="seg" id="segMode"></div></div>
    <div class="field"><span>設定數字</span><div class="seg" id="segSet"></div></div>
    <div class="field"><span>每回合思考</span><div class="seg" id="segTurn"></div></div>
    <button type="button" class="btn primary" id="createBtn">建立房間</button>
  </div>
  <div class="group">
    <div class="glabel">目前的房間</div>
    <div class="rlist" id="rlist"><div class="rempty">讀取中…</div></div>
  </div>
  <form class="group" id="joinForm" autocomplete="off">
    <label class="glabel" for="roomIn">用代碼加入</label>
    <div class="row">
      <input id="roomIn" maxlength="6" placeholder="代碼" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <button type="submit" class="btn">加入</button>
    </div>
  </form>
  <div class="msg" id="lobbyMsg"></div>
</section>

<!-- 邀請連結打開時 -->
<section id="invite" class="screen lobby invite hide">
  <div class="mark" style="font-size:28px">1<i>A</i>1<u>B</u></div>
  <div style="display:flex;flex-direction:column;gap:6px">
    <div class="host" id="invHost"></div>
    <div class="rname" id="invName"></div>
    <div class="rcode" id="invCode"></div>
  </div>
  <div class="chips" id="invChips"></div>
  <div class="group" style="border-top:0;padding-top:0">
    <label class="glabel" for="invNameIn">你的名字<small>可不填</small></label>
    <input id="invNameIn" maxlength="12" placeholder="輸入暱稱" autocomplete="off" enterkeyhint="go">
  </div>
  <button type="button" class="btn primary" id="invGo">進入房間</button>
  <div class="msg" id="invMsg"></div>
  <button type="button" class="linkbtn" id="invBack">回到大廳</button>
</section>

<!-- 遊戲 -->
<section id="game" class="screen hide">
  <header class="bar">
    <div class="left"><span class="title" id="roomTitle"></span><span class="code" id="roomCode"></span><span class="modetag hide" id="modeTag">簡單</span></div>
    <div class="right">
      <button type="button" class="textbtn" id="chatBtn">聊天<span class="badge hide" id="badge"></span></button>
      <button type="button" class="textbtn" id="quitBtn">投降</button>
    </div>
  </header>

  <div class="status">
    <div class="line">
      <div class="who"><span class="dot" id="oppDot"></span><span>對手</span><b id="oppName">—</b></div>
      <span class="clock" id="clock"></span>
    </div>
    <div class="turn" id="turn"></div>
    <div class="sub" id="sub"></div>
    <div class="timebar hide" id="timebar"><i id="timefill"></i></div>
    <div class="toast hide" id="toast"><div id="toastIn"></div></div>
  </div>

  <main class="sheet" id="sheet">
    <div class="wait hide" id="waitView">
      <span class="k">房間代碼</span>
      <div class="big" id="bigCode"></div>
      <div class="chips" id="chips"></div>
      <div class="share">
        <button type="button" class="btn primary" id="shareBtn">複製邀請連結</button>
        <div class="url" id="shareUrl"></div>
        <span class="sub">朋友打開連結就會直接進到這個房間。也可以請對方在大廳的房間列表點這間。</span>
      </div>
    </div>

    <div class="setv hide" id="setView">
      <div class="count" id="count"></div>
      <p id="setText"></p>
      <div class="mine hide" id="setMine"></div>
    </div>

    <div class="board hide" id="board">
      <div class="bhead"><span></span><span class="me">我猜對手</span><span>對手猜我 <em id="mySecretH"></em></span></div>
      <div id="rows"></div>
    </div>
  </main>

  <div class="notes hide" id="notes"><span class="lbl">筆記</span></div>

  <footer class="dock hide" id="dock">
    <div id="entry">
      <div class="dmsg" id="dmsg"></div>
      <div class="slots" id="slots"></div>
      <div class="keys" id="keys"></div>
    </div>
    <div class="over hide" id="overPanel">
      <div class="otitle" id="overTitle"></div>
      <div class="why" id="overWhy"></div>
      <div class="reveal"><span>對手的數字<b id="revOpp"></b></span><span>你的數字<b id="revMe"></b></span></div>
      <div class="row"><button type="button" class="btn" id="leaveBtn">離開</button><button type="button" class="btn primary" id="rematchBtn">再來一局</button></div>
    </div>
  </footer>


  <div class="chatwrap hide" id="chatWrap">
    <div class="chat" role="dialog" aria-label="聊天室">
      <div class="chead"><b>聊天</b><button type="button" class="textbtn" id="chatClose">關閉</button></div>
      <div class="msgs" id="msgs"></div>
      <div class="quick" id="quick"></div>
      <div class="emos" id="emos"></div>
      <form class="cform" id="chatForm" autocomplete="off">
        <input id="chatIn" maxlength="100" placeholder="輸入訊息" enterkeyhint="send" aria-label="輸入訊息">
        <button type="submit" class="btn primary">送出</button>
      </form>
    </div>
  </div>
</section>

</div>
<script>
const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hide', !on);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = t => ({
  get: k => { try { return window[t + 'Storage'].getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { window[t + 'Storage'].setItem(k, v); } catch (e) {} },
  del: k => { try { window[t + 'Storage'].removeItem(k); } catch (e) {} },
});
const LS = store('local'), SS = store('session');

const QUICK = ['快一點', '快睡著了', '你只剩一次機會', '我要猜到了', '好菜'];
const EMOJI = [['🥲', '哭笑不得'], ['🥱', '打哈欠'], ['😭', '哭哭'], ['🤣', '大笑'], ['😏', '得意'], ['🤔', '思考'], ['😱', '嚇到'], ['😤', '不服'], ['👍', '讚'], ['🙏', '拜託']];
const EMOJI_SET = new Set(EMOJI.map(e => e[0]));

let S = null, room = null, pid = null, es = null;
let entry = '', mode = null, sending = false;
let setDeadline = 0, turnDeadline = 0, turnTotal = 0;
const qs = new URLSearchParams(location.search);

async function post(path, body) {
  const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '發生錯誤');
  return j;
}
function screen(id) { ['lobby', 'invite', 'game'].forEach(s => show(s, s === id)); if (id === 'lobby') loadRooms(); }
const modeLabel = m => m === 'easy' ? '簡單模式' : '標準模式';
const turnLabel = t => t ? '每回合 ' + t + ' 秒' : '不限時';
const roomTitle = r => r.name || '房間 ' + r.code;

// ---------- 大廳 ----------
function seg(id, opts, key, fmt) {
  const el = $(id);
  let val = LS.get(key);
  if (!opts.map(String).includes(val)) val = String(opts[0]);
  el.dataset.val = val;
  el.innerHTML = opts.map(o => '<button type="button" data-v="' + o + '">' + fmt(o) + '</button>').join('');
  const paint = () => el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === el.dataset.val));
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    el.dataset.val = b.dataset.v; LS.set(key, b.dataset.v); paint();
  });
  paint();
}
seg('segMode', ['normal', 'easy'], '1a1b-mode', o => o === 'easy' ? '簡單' : '標準');
seg('segSet', [10, 20, 30], '1a1b-set', o => o + ' 秒');
seg('segTurn', [0, 40, 60], '1a1b-turn2', o => o ? o + ' 秒' : '不限');
$('name').value = LS.get('1a1b-name') || '';
$('invNameIn').value = LS.get('1a1b-name') || '';

async function enter(code, nameOverride, msgId) {
  const msgEl = $(msgId || 'lobbyMsg');
  msgEl.textContent = '';
  const name = (nameOverride != null ? nameOverride : $('name').value).trim();
  if (name) { LS.set('1a1b-name', name); $('name').value = name; }
  code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  try {
    const j = await post('join', {
      room: code, name, pid: code ? SS.get('1a1b-pid-' + code) : null,
      roomName: $('roomName').value,
      setSec: Number($('segSet').dataset.val), turnSec: Number($('segTurn').dataset.val), mode: $('segMode').dataset.val,
    });
    room = j.room; pid = j.pid;
    SS.set('1a1b-pid-' + room, pid);
    try { history.replaceState(null, '', '?room=' + room); } catch (e) {}
    if (document.activeElement) document.activeElement.blur();
    $('roomName').value = '';
    connect();
  } catch (e) {
    if ($('game').classList.contains('hide') && $('invite').classList.contains('hide')) screen('lobby');
    if (!$('lobby').classList.contains('hide')) $('lobbyMsg').textContent = e.message; else msgEl.textContent = e.message;
  }
}
$('createBtn').onclick = () => enter('');
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!$('roomIn').value.trim()) { $('lobbyMsg').textContent = '請輸入房間代碼'; return; }
  enter($('roomIn').value);
});

// 房間列表（大廳開著時每 3 秒更新）
async function loadRooms() {
  if ($('lobby').classList.contains('hide')) return;
  let list;
  try { list = (await post('rooms')).rooms; } catch (e) { return; }
  $('rlist').innerHTML = list.length ? list.map(r => {
    const open = r.players < 2;
    const meta = (r.host ? r.host + ' 開的 · ' : '') + modeLabel(r.settings.mode) + ' · ' + turnLabel(r.settings.turnSec);
    return '<button type="button" class="ritem" data-code="' + r.code + '"' + (open ? '' : ' disabled') + '>'
      + '<div class="info"><div class="nm">' + esc(r.name || (r.host ? r.host + ' 的房間' : '未命名房間')) + '<span class="cd">' + r.code + '</span></div>'
      + '<div class="meta">' + esc(meta) + '</div></div>'
      + '<span class="go">' + (open ? '加入' : '對戰中') + '</span></button>';
  }).join('') : '<div class="rempty">目前沒有開著的房間，自己開一間吧</div>';
}
$('rlist').addEventListener('click', e => {
  const b = e.target.closest('.ritem'); if (!b || b.disabled) return;
  enter(b.dataset.code);
});
setInterval(loadRooms, 3000);

// ---------- 邀請連結 ----------
let inviteCode = null;
async function openInvite(code) {
  let info;
  try { info = await post('info', { room: code }); }
  catch (e) { screen('lobby'); $('lobbyMsg').textContent = '邀請的房間 ' + code + ' 已經關閉了'; return; }
  if (info.players >= 2) { screen('lobby'); $('lobbyMsg').textContent = '房間 ' + code + ' 已經滿了'; return; }
  // 記得名字的人直接進房
  if (LS.get('1a1b-name')) return enter(code, LS.get('1a1b-name'));
  inviteCode = code;
  $('invHost').textContent = (info.host || '朋友') + ' 邀請你加入';
  $('invName').textContent = info.name || (info.host ? info.host + ' 的房間' : '1A1B 對戰');
  $('invCode').textContent = '房間 ' + info.code;
  $('invChips').innerHTML = '<span class="chip">' + modeLabel(info.settings.mode) + '</span><span class="chip">設定數字 ' + info.settings.setSec + ' 秒</span><span class="chip">' + turnLabel(info.settings.turnSec) + '</span>';
  screen('invite');
}
$('invGo').onclick = () => enter(inviteCode, $('invNameIn').value, 'invMsg');
$('invNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('invGo').click(); } });
$('invBack').onclick = () => { try { history.replaceState(null, '', location.pathname); } catch (e) {} screen('lobby'); };

function connect() {
  if (es) es.close();
  es = new EventSource('/events?room=' + room + '&pid=' + pid);
  es.onmessage = e => { S = JSON.parse(e.data); render(); };
  es.onerror = () => { $('sub').textContent = '連線中斷，重新連線中…'; };
  chatSeen = -1; chatRendered = -1;
  screen('game');
}
function backToLobby() {
  if (es) { es.close(); es = null; }
  SS.del('1a1b-pid-' + room);
  S = null; room = null; pid = null; mode = null; entry = '';
  closeChat(); show('toast', false);
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  $('roomIn').value = '';
  screen('lobby');
}

// ---------- 分享 ----------
function inviteUrl(s) {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  const base = local && s.ips.length ? 'http://' + s.ips[0] + ':' + s.port : location.origin;
  return base + '/?room=' + s.room;
}
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  return new Promise((ok, fail) => {
    const ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
    let done = false;
    try { done = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    done ? ok() : fail();
  });
}
$('shareBtn').onclick = async () => {
  if (!S) return;
  const url = inviteUrl(S), b = $('shareBtn');
  if (navigator.share) {
    try { await navigator.share({ title: '來玩 1A1B：' + roomTitle(S), url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(url).then(() => { b.textContent = '已複製，貼給朋友就好'; })
    .catch(() => { b.textContent = '請長按下面的網址複製'; });
  setTimeout(() => { b.textContent = '複製邀請連結'; }, 2500);
};

// ---------- 數字盤 ----------
const KEYS = ['1','2','3','4','5','del','6','7','8','9','0','go'];
$('keys').innerHTML = KEYS.map(k =>
  k === 'del' ? '<button type="button" class="del" data-k="del" aria-label="刪除">⌫</button>'
  : k === 'go' ? '<button type="button" class="go" data-k="go"></button>'
  : '<button type="button" data-k="' + k + '">' + k + '</button>').join('');
function canPress(d) {
  if (entry.length >= 4 || entry.includes(d)) return false;
  return !(d === '0' && entry.length === 0); // 首位不能是 0
}
function canSubmit() {
  if (entry.length !== 4 || sending) return false;
  return mode === 'secret' || (mode === 'guess' && S && S.myTurn);
}
function press(d) { if (mode && canPress(d)) { entry += d; dmsg(''); renderEntry(); } }
function backspace() { if (mode && entry) { entry = entry.slice(0, -1); renderEntry(); } }
async function submit() {
  if (!canSubmit()) return;
  sending = true; renderEntry();
  try {
    if (mode === 'secret') await post('secret', { room, pid, secret: entry });
    else await post('guess', { room, pid, guess: entry });
    entry = ''; dmsg('');
  } catch (e) { dmsg(e.message, true); }
  sending = false; renderEntry();
}
$('keys').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const k = b.dataset.k;
  if (k === 'del') backspace(); else if (k === 'go') submit(); else press(k);
});
document.addEventListener('keydown', e => {
  if (!mode || chatOpen || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
  else if (e.key === 'Backspace') { backspace(); e.preventDefault(); }
  else if (e.key === 'Enter') { submit(); e.preventDefault(); }
});
function renderEntry() {
  $('slots').innerHTML = [0, 1, 2, 3].map(i =>
    '<div class="slot' + (i === entry.length && mode ? ' cur' : '') + '">' + (entry[i] || '') + '</div>').join('');
  $('keys').querySelectorAll('button').forEach(b => {
    const k = b.dataset.k;
    if (k === 'del') b.disabled = !entry;
    else if (k === 'go') {
      b.disabled = !canSubmit();
      b.textContent = mode === 'secret' ? '設定' : (S && S.myTurn ? '送出' : '等待');
    } else b.disabled = !canPress(k);
  });
}
function dmsg(t, err) { $('dmsg').textContent = t; $('dmsg').classList.toggle('err', !!err); }

// ---------- 聊天 ----------
let chatOpen = false, chatSeen = -1, chatRendered = -1, toastTimer = 0;
$('quick').innerHTML = QUICK.map(q => '<button type="button">' + q + '</button>').join('');
$('emos').innerHTML = EMOJI.map(e => '<button type="button" aria-label="' + e[1] + '" title="' + e[1] + '">' + e[0] + '</button>').join('');
async function say(text) {
  text = String(text || '').trim();
  if (!text || !room) return false;
  try { await post('chat', { room, pid, text }); return true; }
  catch (e) { $('chatIn').placeholder = e.message; setTimeout(() => { $('chatIn').placeholder = '輸入訊息'; }, 1500); return false; }
}
$('quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) say(b.textContent); });
$('emos').addEventListener('click', e => { const b = e.target.closest('button'); if (b) say(b.textContent); });
$('chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('chatIn').value;
  if (await say(v)) $('chatIn').value = '';
});
function openChat() {
  chatOpen = true; show('chatWrap', true); show('toast', false);
  renderChat(true);
}
function closeChat() {
  chatOpen = false; show('chatWrap', false);
  if (document.activeElement === $('chatIn')) $('chatIn').blur();
}
$('chatBtn').onclick = openChat;
$('chatClose').onclick = closeChat;
$('chatWrap').addEventListener('click', e => { if (e.target === $('chatWrap')) closeChat(); });
$('toast').onclick = openChat;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatOpen) closeChat(); });

function renderChat(force) {
  const list = S ? S.chat : [];
  const lastId = list.length ? list[list.length - 1].id : 0;
  if (chatSeen < 0) chatSeen = lastId; // 剛進房，舊訊息不算未讀
  if (chatOpen) chatSeen = lastId;
  const unread = list.filter(m => !m.mine && m.id > chatSeen).length;
  $('badge').textContent = unread > 9 ? '9+' : unread;
  show('badge', unread > 0);

  // 對手新訊息：聊天室沒開時跳提示
  const fresh = list.filter(m => !m.mine && m.id > chatRendered);
  if (!chatOpen && chatRendered >= 0 && fresh.length) {
    const m = fresh[fresh.length - 1];
    const tin = $('toastIn');
    tin.textContent = m.text;
    tin.className = EMOJI_SET.has(m.text) ? 'emo' : '';
    show('toast', false); void tin.offsetWidth; show('toast', true); // 重新播放冒出動畫
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show('toast', false), 4000);
  }
  if (lastId === chatRendered && !force) return;
  chatRendered = lastId;
  if (!chatOpen) return;
  const box = $('msgs');
  box.innerHTML = list.length ? list.map(m =>
    '<div class="m' + (m.mine ? ' mine' : '') + '">' + (m.mine ? '' : '<span class="nm">' + esc(m.name) + '</span>')
    + '<span class="tx' + (EMOJI_SET.has(m.text) ? ' emo' : '') + '">' + esc(m.text) + '</span></div>').join('')
    : '<div class="none">還沒有訊息，丟個快捷語嗆一下對手吧</div>';
  box.scrollTop = box.scrollHeight;
}

// ---------- 投降 / 離開 ----------
let armTimer = 0;
$('quitBtn').onclick = async () => {
  if (!S) return;
  if (S.phase === 'waiting' || S.phase === 'over') return leave();
  const b = $('quitBtn');
  if (!b.classList.contains('arm')) {
    b.classList.add('arm'); b.textContent = '確定投降？';
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { b.classList.remove('arm'); if (S) render(); }, 3000);
    return;
  }
  clearTimeout(armTimer); b.classList.remove('arm');
  try { await post('surrender', { room, pid }); } catch (e) { dmsg(e.message, true); }
};
async function leave() {
  try { await post('leave', { room, pid }); } catch (e) {}
  backToLobby();
}
$('leaveBtn').onclick = leave;
$('rematchBtn').onclick = () => post('rematch', { room, pid }).catch(e => dmsg(e.message, true));

// ---------- 筆記 ----------
const marks = {};
for (let d = 0; d < 10; d++) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = d;
  b.onclick = () => { marks[d] = ((marks[d] || 0) + 1) % 3; b.className = ['', 'x', 'y'][marks[d]]; };
  $('notes').appendChild(b);
}
function clearNotes() { $('notes').querySelectorAll('button').forEach((b, d) => { marks[d] = 0; b.className = ''; }); }

// ---------- 計時 ----------
setInterval(tick, 200);
function tick() {
  if (!S) return;
  const now = Date.now();
  if (S.phase === 'setting') {
    const sec = Math.max(0, Math.ceil((setDeadline - now) / 1000));
    $('count').textContent = sec;
    $('count').classList.toggle('low', sec <= 3);
    $('clock').textContent = '';
    bar((setDeadline - now) / (S.settings.setSec * 1000), sec <= 3);
  } else if (S.phase === 'playing' && turnDeadline) {
    const sec = Math.max(0, Math.ceil((turnDeadline - now) / 1000));
    $('clock').textContent = sec + 's';
    $('clock').classList.toggle('low', sec <= 5);
    bar((turnDeadline - now) / turnTotal, sec <= 5);
  } else {
    $('clock').textContent = '';
    show('timebar', false);
  }
}
function bar(frac, low) {
  show('timebar', true);
  $('timebar').classList.toggle('low', low);
  $('timefill').style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
}

// ---------- 畫面 ----------
function cell(g, mine, isNew) {
  if (!g) return '<div class="cell' + (mine ? ' me' : '') + '"></div>';
  let cls = 'cell' + (mine ? ' me' : '') + (isNew ? ' new' : '');
  if (g.timeout) return '<div class="' + cls + ' to"><span class="dg">超時跳過</span></div>';
  if (g.a === 4) cls += ' win';
  const rs = g.a === 0 && g.b === 0 ? '<span class="zero">0A0B</span>'
    : '<span class="ra">' + g.a + 'A</span><span class="rb">' + g.b + 'B</span>';
  const dg = g.pos ? g.guess.split('').map((d, k) => g.pos.includes(k) ? '<span class="hit">' + d + '</span>' : d).join('') : g.guess;
  return '<div class="' + cls + '"><span class="dg">' + dg + '</span><span class="rs">' + rs + '</span></div>';
}
let lastMoves = 0;
function renderBoard(s) {
  const mine = s.me.guesses, theirs = s.opp ? s.opp.guesses : [];
  const n = Math.max(mine.length, theirs.length);
  const total = mine.length + theirs.length;
  const fresh = total > lastMoves;
  const newest = !fresh ? null : (s.iStart ? (mine.length > theirs.length ? 'me' : 'opp') : (theirs.length > mine.length ? 'opp' : 'me'));
  let html = '';
  for (let r = 0; r < n; r++) {
    html += '<div class="brow"><span class="n">' + (r + 1) + '</span>'
      + cell(mine[r], true, newest === 'me' && r === mine.length - 1)
      + cell(theirs[r], false, newest === 'opp' && r === theirs.length - 1) + '</div>';
  }
  $('rows').innerHTML = html || '<div class="empty">' + (s.iStart ? '你先猜，從下面輸入 4 個數字' : '對手先猜') + '</div>';
  if (fresh) $('sheet').scrollTop = $('sheet').scrollHeight;
  lastMoves = total;
}

function render() {
  const s = S;
  const now = Date.now();
  $('roomTitle').textContent = s.name || '1A1B';
  $('roomCode').textContent = s.room;
  $('bigCode').textContent = s.room;
  show('modeTag', s.settings.mode === 'easy');

  // 數字盤用途；用途一變就清空
  const newMode = s.phase === 'setting' && !s.me.secret ? 'secret' : s.phase === 'playing' ? 'guess' : null;
  if (newMode !== mode) { entry = ''; dmsg(''); if (newMode === 'secret') { clearNotes(); lastMoves = 0; } }
  mode = newMode;
  setDeadline = s.phase === 'setting' ? now + s.setMsLeft : 0;
  turnDeadline = s.turnMsLeft ? now + s.turnMsLeft : 0;
  turnTotal = (s.settings.turnSec || 1) * 1000;

  $('oppName').textContent = s.opp ? s.opp.name : '尚未加入';
  $('oppDot').classList.toggle('on', !!(s.opp && s.opp.online));

  const q = $('quitBtn');
  if (!q.classList.contains('arm')) q.textContent = s.phase === 'setting' || s.phase === 'playing' ? '投降' : '離開';
  show('quitBtn', s.phase !== 'over');

  const T = $('turn'); let turn = '', sub = '', tcls = '';
  if (s.phase === 'waiting') {
    turn = '等待對手'; tcls = 'idle';
    sub = s.oppLeft ? '對手已離開，等新的對手加入' : '';
  } else if (s.phase === 'setting') {
    turn = s.me.secret ? (s.opp.ready ? '準備開始' : '等對手設定') : '設定你的數字';
    tcls = s.me.secret ? 'idle' : 'mine';
    sub = s.iStart ? '這局你先猜' : '這局對手先猜';
  } else if (s.phase === 'playing') {
    turn = s.myTurn ? '輪到你' : '對手思考中';
    tcls = s.myTurn ? 'mine' : 'idle';
    if (s.lastChance) sub = s.myTurn ? '對手已猜中，這是你追平的最後機會' : '你猜中了，對手還有一次追平機會';
    else sub = '第 ' + ((s.myTurn ? s.me.guesses.length : s.opp.guesses.length) + 1) + ' 回合';
  } else {
    turn = '本局結束'; tcls = 'idle';
  }
  T.textContent = turn; T.className = 'turn ' + tcls;
  $('sub').textContent = sub;

  show('waitView', s.phase === 'waiting');
  show('setView', s.phase === 'setting');
  show('board', s.phase === 'playing' || s.phase === 'over');
  if (s.phase === 'waiting') {
    $('shareUrl').textContent = inviteUrl(s);
    $('chips').innerHTML = '<span class="chip">' + modeLabel(s.settings.mode) + '</span><span class="chip">設定數字 ' + s.settings.setSec + ' 秒</span><span class="chip">' + turnLabel(s.settings.turnSec) + '</span>';
  }
  if (s.phase === 'setting') {
    $('setText').textContent = s.me.secret ? '你的數字已鎖定' : '時間到還沒設定，會自動幫你選一組';
    show('setMine', !!s.me.secret);
    $('setMine').textContent = s.me.secret || '';
  }
  if (s.phase === 'playing' || s.phase === 'over') {
    $('mySecretH').textContent = s.me.secret || '';
    renderBoard(s);
  }
  show('notes', s.phase === 'playing');

  show('dock', !!mode || s.phase === 'over');
  show('entry', !!mode);
  show('overPanel', s.phase === 'over');
  if (mode === 'guess' && s.me.auto && !s.me.guesses.length && !s.opp.guesses.length && !entry)
    dmsg('時間到，已幫你選了 ' + s.me.secret);
  if (s.phase === 'over') {
    const r = s.result;
    const t = $('overTitle');
    t.textContent = { win: '你贏了', lose: '你輸了', draw: '平手' }[r.outcome];
    t.className = 'otitle ' + r.outcome;
    const turns = s.me.guesses.filter(g => !g.timeout).length;
    $('overWhy').textContent = r.reason === 'oppSurrendered' ? s.opp.name + ' 投降了'
      : r.reason === 'iSurrendered' ? '你投降了'
      : r.outcome === 'draw' ? '雙方都猜中了'
      : r.outcome === 'win' ? '你用了 ' + turns + ' 次猜中'
      : s.opp.name + ' 先猜中了';
    $('revOpp').textContent = s.opp.secret || '—';
    $('revMe').textContent = s.me.secret || '—';
    const rb = $('rematchBtn');
    rb.disabled = s.rematchMe || !s.opp.online;
    rb.textContent = s.rematchMe ? (s.rematchOpp ? '開始中…' : '等對手同意') : (s.rematchOpp ? '對手想再來，接受' : '再來一局');
  }
  renderEntry();
  renderChat();
  tick();
}

// ---------- 啟動 ----------
(function boot() {
  const code = (qs.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return screen('lobby');
  if (SS.get('1a1b-pid-' + code)) return enter(code, LS.get('1a1b-name') || ''); // 重新整理：回到原本的房間
  openInvite(code);
})();
</script>
</body></html>`;
