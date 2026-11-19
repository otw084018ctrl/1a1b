// 1A1B 連線對戰 — 零依賴，只需 Node.js 18+
// 執行：node 1a1b-server.js   （可用 PORT=8080 node 1a1b-server.js 改埠號）
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Poker = require('./poker.js');

const PORT = Number(process.env.PORT) || 3000;
const envList = (k, d) => (process.env[k] ? process.env[k].split(',').map(Number) : d);
const SET_OPTIONS = envList('SET_OPTIONS', [10, 20, 30]);  // 1 對 1 設定數字時間（秒）
const TURN_OPTIONS = envList('TURN_OPTIONS', [0, 40, 60]); // 每回合時間（秒），0 = 不限
const MEM_OPTIONS = envList('MEM_OPTIONS', [10, 20, 30]);  // 記憶撲克：記憶時間（秒）
const POKER_SEL_SEC = Number(process.env.POKER_SEL_SEC) || 60;       // 記憶撲克：選牌時間（秒）
const POKER_READY_SEC = process.env.POKER_READY_SEC !== undefined ? Number(process.env.POKER_READY_SEC) : 3; // 開局前的 3、2、1 倒數
const POKER_REVEAL_MS = Number(process.env.POKER_REVEAL_MS) || 3500; // 蠟印全部亮出來之後，等多久才翻牌
const POKER_TIE_MS = Number(process.env.POKER_TIE_MS) || 6000;       // 平手後多久自動重打一局
const MAX = { duel: 2, race: 8, poker: 4 };  // 各玩法人數上限
const MAX_SPECS = 30;
const CHAT_MAX = 60;
const IDLE_MS = 10 * 60 * 1000;    // 房間沒人在線超過這個時間就關掉
const MAX_ROOMS = 200;
const GRACE_MS = Number(process.env.GRACE_MS) || 8000;            // 短暫斷線不算缺席
const DROP_WAIT_MS = Number(process.env.DROP_WAIT_MS) || 20000;   // 等待/結算時離線多久就移出房間
const DROP_GAME_MS = Number(process.env.DROP_GAME_MS) || 90000;   // 對局中離線多久就判離開
const DROP_SPEC_MS = Number(process.env.DROP_SPEC_MS) || 30000;   // 觀戰者離線多久就移出
const rooms = new Map();
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8'); // 前端頁面

// ---------- 小工具 ----------
// 4 個不重複數字，第一位不能是 0
const DIGIT_OPTIONS = [4, 5];
const valid = (s, n) => typeof s === 'string' && s.length === n && /^[1-9]\d*$/.test(s) && new Set(s).size === n;
const badDigits = n => n + ' 個不重複的數字，第一位不能是 0';
function score(secret, guess) {
  let a = 0, b = 0;
  for (let i = 0; i < secret.length; i++) {
    if (guess[i] === secret[i]) a++;
    else if (secret.includes(guess[i])) b++;
  }
  return { a, b };
}
function randomSecret(n) {
  let s;
  do {
    const d = '0123456789'.split('');
    for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
    s = d.slice(0, n).join('');
  } while (!valid(s, n));
  return s;
}
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
}
function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const shortId = () => crypto.randomBytes(4).toString('hex');
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const members = room => [...room.players, ...room.specs];
const anyOnline = room => members(room).some(m => m.res);
const playersOnline = room => room.players.some(p => p.res);
const inGame = room => room.phase === 'setting' || room.phase === 'playing';
const joinable = room => !inGame(room) && room.players.length < MAX[room.settings.game];
// 各玩法／位數可選的每回合秒數（0 = 不限；多人競速不能不限，一個人發呆全場都在等）
function turnChoices(game, digits) {
  if (game === 'poker') return [0]; // 記憶撲克的時間由記憶秒數與固定選牌時間決定
  if (process.env.TURN_OPTIONS) return game === 'race' ? TURN_OPTIONS.filter(t => t > 0) : TURN_OPTIONS;
  if (game === 'race') return digits === 5 ? [60, 90] : [40, 60];
  return digits === 5 ? [0, 60, 90] : [0, 40, 60];
}
const nearest = (list, v) => list.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), list[0]);
function cleanSettings(src, base) {
  const s = Object.assign({}, base);
  if (src.game === 'duel' || src.game === 'race' || src.game === 'poker') s.game = src.game;
  if (MEM_OPTIONS.includes(Number(src.memSec))) s.memSec = Number(src.memSec);
  if (!MEM_OPTIONS.includes(s.memSec)) s.memSec = 20;
  if (src.hint === 'normal' || src.hint === 'easy') s.hint = src.hint;
  if (SET_OPTIONS.includes(Number(src.setSec))) s.setSec = Number(src.setSec);
  if (DIGIT_OPTIONS.includes(Number(src.digits))) s.digits = Number(src.digits);
  if (!DIGIT_OPTIONS.includes(s.digits)) s.digits = 4;
  const allowed = turnChoices(s.game, s.digits); // 每回合時間依玩法與位數而定：5 位數給多一點思考時間
  if (allowed.includes(Number(src.turnSec))) s.turnSec = Number(src.turnSec);
  if (src.peek === 'on' || src.peek === 'off') s.peek = src.peek;
  if (!allowed.includes(s.turnSec)) s.turnSec = nearest(allowed, s.turnSec || 60); // 換玩法或位數後把時間貼到最近的可選值
  return s;
}

// ---------- 計時 ----------
function clearTimers(room) {
  clearTimeout(room.timer);
  room.deadline = 0;
  room.total = 0;
}
function arm(room, sec, fn) {
  clearTimers(room);
  room.paused = false;
  if (!sec) return;
  room.deadline = Date.now() + sec * 1000;
  room.total = sec * 1000;
  room.timer = setTimeout(() => {
    // 玩家都不在線就暫停，等有人回來再繼續
    if (!playersOnline(room)) { room.paused = true; room.deadline = 0; return; }
    fn();
    broadcast(room);
  }, sec * 1000);
}
function resume(room) {
  if (!room.paused || room.phase !== 'playing') return;
  if (room.settings.game === 'poker') armPoker(room);
  else if (room.settings.game === 'duel') setTurn(room, room.turn);
  else armRound(room);
}

// ---------- 開局 / 結束 ----------
function startGame(room) {
  room.result = null;
  room.lastChance = false;
  for (const p of room.players) { p.secret = null; p.auto = false; p.out = false; p.guesses = []; p.pick = []; p.locked = false; p.timedOut = false; }
  room.lastIds = new Set(room.players.map(p => p.id));
  clearTimeout(room.tieTimer);
  if (room.settings.game === 'poker') {
    startPoker(room);
  } else if (room.settings.game === 'duel') {
    room.starter = room.players[room.flip % 2].id; // 先後手每局交換
    room.flip++;
    room.phase = 'setting';
    clearTimers(room);
    room.deadline = Date.now() + room.settings.setSec * 1000;
    room.total = room.settings.setSec * 1000;
    room.timer = setTimeout(() => {
      if (room.phase !== 'setting') return;
      for (const p of room.players) if (!p.secret) { p.secret = randomSecret(room.settings.digits); p.auto = true; }
      startDuel(room);
      broadcast(room);
    }, room.settings.setSec * 1000);
  } else {
    room.secret = randomSecret(room.settings.digits);
    room.round = 0;
    room.raceCount = room.players.length;
    room.phase = 'playing';
    nextRound(room);
  }
}
function finish(room, winners, reason, by) {
  clearTimers(room);
  room.paused = false;
  room.phase = 'over';
  const nameOf = id => (room.players.find(p => p.id === id) || {}).name || '';
  room.result = { winners, names: winners.map(nameOf), reason, by: by || null, byName: by ? nameOf(by) : '' };
}

// ---------- 記憶撲克 ----------
// 階段（room.pk.stage）：ready 倒數 → memorize 記憶 → select 選牌 → reveal 亮出蠟印 → result 翻牌比大小
function startPoker(room) {
  const d = Poker.dealRound();
  room.pk = { board: d.board, community: d.community, stage: POKER_READY_SEC ? 'ready' : 'memorize', hands: null, why: '', vs: null, tie: false };
  room.raceCount = room.players.length;
  room.phase = 'playing';
  armPoker(room);
}
function armPoker(room) {
  const pk = room.pk, st = pk.stage;
  if (st === 'ready') arm(room, POKER_READY_SEC, () => { if (room.phase === 'playing' && pk.stage === 'ready') { pk.stage = 'memorize'; armPoker(room); } });
  else if (st === 'memorize') arm(room, room.settings.memSec, () => { if (room.phase === 'playing' && pk.stage === 'memorize') { pk.stage = 'select'; armPoker(room); } });
  else if (st === 'select') arm(room, POKER_SEL_SEC, () => { if (room.phase === 'playing' && pk.stage === 'select') pokerSelectTimeout(room); });
  else if (st === 'reveal') arm(room, POKER_REVEAL_MS / 1000, () => { if (room.phase === 'playing' && pk.stage === 'reveal') showdown(room); });
}
// 選牌時間到：已選兩張的自動鎖定，沒選完的判逾時失敗（規則可在這裡調整）
function pokerSelectTimeout(room) {
  for (const p of active(room)) {
    if (p.pick.length === 2) p.locked = true;
    else { p.out = true; p.timedOut = true; }
  }
  const act = active(room);
  if (act.length) startReveal(room); else pokerEnd(room, [], 'allOut');
}
function startReveal(room) {
  room.pk.stage = 'reveal';
  armPoker(room);
}
// 有人鎖定、投降或離開之後，檢查要不要往下走
function pokerProceed(room) {
  if (room.phase !== 'playing' || !room.pk) return;
  const act = active(room);
  if (act.length === 0) return pokerEnd(room, [], 'allOut');
  if (act.length === 1 && room.raceCount >= 2 && !act[0].locked) return pokerEnd(room, [act[0].id], 'othersOut');
  if (room.pk.stage === 'select' && act.every(p => p.locked)) startReveal(room);
}
function pokerEnd(room, winners, reason) {
  room.pk.stage = 'result';
  for (const p of room.players) if (room.lastIds.has(p.id)) p.played = (p.played || 0) + 1;
  const solo = room.raceCount < 2; // 一個人練習：不算勝負
  if (!solo) for (const id of winners) { const w = room.players.find(p => p.id === id); if (w) w.wins = (w.wins || 0) + 1; }
  finish(room, solo ? [] : winners, solo && reason === 'poker' ? 'solo' : reason);
}
function showdown(room) {
  const pk = room.pk;
  const act = active(room).filter(p => p.locked);
  const hands = act.map(p => Poker.evaluateHand([pk.board[p.pick[0]], pk.board[p.pick[1]]].concat(pk.community)));
  const best = Poker.bestOf(hands);
  const order = hands.map((_, i) => i).sort((i, j) => { const r = Poker.compareHands(hands[i], hands[j]); return r === 'A' ? -1 : r === 'B' ? 1 : 0; });
  // 名次：牌力完全相同的並列同一名
  const place = new Array(hands.length);
  order.forEach((idx, k) => { place[idx] = k > 0 && Poker.compareHands(hands[order[k - 1]], hands[idx]) === 'TIE' ? place[order[k - 1]] : k + 1; });
  pk.hands = act.map((p, i) => ({ id: p.id, h: hands[i], place: place[i] }));
  pk.why = order.length > 1 ? Poker.explain(hands[order[0]], hands[order[1]]) : '';
  const top = hands[order[0]], second = order.length > 1 ? hands[order[1]] : null;
  pk.vs = second ? Object.assign(Poker.reasonParts(top, second), { win: act[order[0]].id, lose: act[order[1]].id }) : { solo: true, win: act[order[0]].id, catA: top.categoryZh };
  if (best.length > 1) {
    // 最強的牌平手：不指定贏家，過幾秒自動重打一局
    pk.tie = true;
    pokerEnd(room, [], 'tie');
    room.tieTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'over' || room.settings.game !== 'poker' || room.players.length < 2) return;
      startGame(room);
      broadcast(room);
    }, POKER_TIE_MS);
  } else pokerEnd(room, [act[best[0]].id], 'poker');
}

// ---------- 1 對 1 ----------
const opponent = (room, id) => room.players.find(p => p.id !== id);
function startDuel(room) {
  room.phase = 'playing';
  setTurn(room, room.starter);
}
function setTurn(room, id) {
  room.turn = id;
  arm(room, room.settings.turnSec, () => {
    if (room.phase !== 'playing' || room.turn !== id) return;
    const p = room.players.find(x => x.id === id);
    p.guesses.push({ timeout: true });
    afterDuelMove(room, p, 0);
  });
}
function afterDuelMove(room, p, a) {
  const opp = opponent(room, p.id);
  if (room.lastChance) {
    // 後手的最後一次機會：猜中就平手，否則先手贏
    finish(room, a === room.settings.digits ? [opp.id, p.id] : [room.starter], 'guess');
  } else if (a === room.settings.digits) {
    if (p.id === room.starter) { room.lastChance = true; setTurn(room, opp.id); } // 給後手一次追平機會
    else finish(room, [p.id], 'guess');
  } else {
    setTurn(room, opp.id);
  }
}

// ---------- 多人競速 ----------
const active = room => room.players.filter(p => !p.out);
const present = p => !!p.res || Date.now() - p.offAt < GRACE_MS;
function nextRound(room) {
  room.round++;
  room.submitted = new Set();
  armRound(room);
}
function armRound(room) {
  const r = room.round;
  arm(room, room.settings.turnSec, () => { if (room.phase === 'playing' && room.round === r) endRound(room); });
}
function maybeEndRound(room) {
  if (room.phase !== 'playing' || room.settings.game !== 'race') return;
  const act = active(room);
  // 送出的人都到齊就結算；斷線超過寬限時間的人不等，剛斷線的人還是會等
  if (act.some(p => p.res) && act.every(p => room.submitted.has(p.id) || !present(p))) endRound(room);
}
function endRound(room) {
  const act = active(room);
  for (const p of act) if (!room.submitted.has(p.id)) p.guesses.push({ timeout: true, round: room.round });
  const winners = act.filter(p => { const g = p.guesses[p.guesses.length - 1]; return g && g.round === room.round && g.a === room.settings.digits; });
  if (winners.length) finish(room, winners.map(p => p.id), 'guess');
  else nextRound(room);
}
function checkRaceLeft(room) {
  const act = active(room);
  if (act.length === 0) finish(room, [], 'allOut');
  else if (act.length === 1 && room.raceCount >= 2) finish(room, [act[0].id], 'othersOut');
  else maybeEndRound(room);
}

// ---------- 給每個人看的畫面資料 ----------
function view(room, viewer) {
  const spec = viewer.role === 'spec';
  const g = room.settings.game;
  const peek = room.settings.peek === 'on';
  // 這局結束後才加入的玩家沒參與過，看到的是等待畫面，不是上一局的結果
  const late = room.phase === 'over' && !spec && !room.lastIds.has(viewer.id);
  const phase = late ? 'waiting' : room.phase;
  const over = phase === 'over';
  const pubOf = id => { const p = room.players.find(x => x.id === id); return p ? p.pub : null; };
  // 多人競速：別人的數字看不到，只看已結算回合的 A/B（房主沒開放時，觀戰者也一樣）
  const hideRace = g === 'race' && !over && !(spec && peek);
  const players = room.players.map(p => {
    const mine = p.id === viewer.id;
    let guesses = p.guesses;
    if (hideRace && !mine) guesses = p.guesses.filter(x => x.round < room.round).map(x => x.timeout ? { timeout: true } : { a: x.a, b: x.b });
    const showSecret = mine || over || (spec && peek);
    const pkx = g === 'poker' && room.pk ? {
      pick: mine || room.pk.stage === 'reveal' || room.pk.stage === 'result' || (spec && peek) ? p.pick : null,
      pickN: (p.pick || []).length, locked: !!p.locked, timedOut: !!p.timedOut, wins: p.wins || 0, played: p.played || 0,
    } : {};
    return Object.assign(pkx, {
      pub: p.pub, name: p.name, online: !!p.res, host: room.host === p.id, me: mine,
      secret: showSecret ? p.secret : null, ready: !!p.secret, auto: mine && p.auto,
      out: p.out, submitted: g === 'race' && room.phase === 'playing' && !!room.submitted && room.submitted.has(p.id),
      guesses,
    });
  });
  return {
    code: room.code,
    name: room.name,
    phase,
    settings: room.settings,
    max: MAX[g],
    me: { pub: viewer.pub, role: viewer.role, host: room.host === viewer.id, name: viewer.name },
    players,
    specs: room.specs.map(s => ({ name: s.name, online: !!s.res, me: s.id === viewer.id })),
    turn: g === 'duel' && room.phase === 'playing' ? pubOf(room.turn) : null,
    starter: g === 'duel' && inGame(room) ? pubOf(room.starter) : null,
    lastChance: !!room.lastChance,
    round: g === 'race' ? room.round || 0 : 0,
    answer: g === 'race' && (over || (spec && peek)) ? room.secret : null,
    pk: g === 'poker' && room.pk && phase !== 'waiting' ? pkView(room, spec, peek) : null,
    msLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0,
    msTotal: room.total || 0,
    paused: !!room.paused,
    result: over ? {
      winners: room.result.winners.map(pubOf), names: room.result.names,
      reason: room.result.reason, by: pubOf(room.result.by), byName: room.result.byName,
    } : null,
    canSit: spec && joinable(room),
    chat: room.chat.map(m => ({ id: m.id, name: m.name, text: m.text, spec: m.spec, from: m.pub, mine: m.from === viewer.id })),
    ips: lanIPs(),
    port: PORT,
  };
}
const pubOfId = (room, id) => { const p = room.players.find(x => x.id === id); return p ? p.pub : null; };
function pkView(room, spec, peek) {
  const pk = room.pk, st = pk.stage, over = st === 'result';
  const face = c => ({ id: c.id, s: c.suit, r: c.rank });
  const see = st === 'memorize' || over || (spec && peek); // 蓋牌階段只有記憶時間看得到牌面
  return {
    stage: st,
    board: see ? pk.board.map(face) : null,
    community: st === 'ready' || st === 'memorize' ? null : pk.community.map(face),
    hands: over && pk.hands ? pk.hands.map(x => {
      const pl = room.players.find(p => p.id === x.id);
      return { pub: pl ? pl.pub : null, cards: x.h.displayCards.map(face), en: x.h.categoryName, zh: x.h.categoryZh, cat: x.h.category, place: x.place };
    }) : null,
    why: over ? pk.why : '',
    vs: over && pk.vs ? Object.assign({}, pk.vs, { win: pubOfId(room, pk.vs.win), lose: pubOfId(room, pk.vs.lose) }) : null,
    tie: over && !!pk.tie,
    solo: room.raceCount < 2,
    tieMs: POKER_TIE_MS,
    selSec: POKER_SEL_SEC,
  };
}
function broadcast(room) {
  for (const m of members(room))
    if (m.res) m.res.write(`data: ${JSON.stringify(view(room, m))}\n\n`);
}
function summary(room) {
  const host = room.players.find(p => p.id === room.host);
  return {
    code: room.code, name: room.name, host: host ? host.name : '',
    players: room.players.length, max: MAX[room.settings.game], specs: room.specs.length,
    phase: room.phase, settings: room.settings, joinable: joinable(room),
  };
}
function closeRoom(room) {
  clearTimers(room);
  clearTimeout(room.tieTimer);
  for (const m of members(room)) if (m.res) m.res.end();
  rooms.delete(room.code);
}
function findMember(room, id) {
  return room.players.find(p => p.id === id) || room.specs.find(s => s.id === id);
}
function newMember(name, role) {
  return { id: crypto.randomUUID(), pub: shortId(), name, role, res: null, offAt: 0, dropTimer: null, lastChat: 0, secret: null, auto: false, out: false, guesses: [], pick: [], locked: false, timedOut: false, wins: 0, played: 0 };
}

// ---------- API ----------
const api = {
  rooms({ kind } = {}) {
    const list = [...rooms.values()].filter(anyOnline)
      .filter(r => !kind || (kind === 'poker') === (r.settings.game === 'poker'))
      .sort((a, b) => (Number(joinable(b)) - Number(joinable(a))) || (b.created - a.created))
      .map(summary);
    return { rooms: list };
  },
  info({ room: code }) {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) throw new Error('這個房間已經關閉了');
    return summary(room);
  },
  // role: 'player' 或 'spec'；沒有 room 代表開新房間
  join({ room: code, name, pid, role, roomName, settings }) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    name = cleanText(name, 12);
    let room;
    if (!code) {
      if (rooms.size >= MAX_ROOMS) throw new Error('目前房間太多了，請晚點再試');
      code = newRoomCode();
      room = {
        code, name: cleanText(roomName, 16), players: [], specs: [], host: null,
        flip: crypto.randomInt(2), lastIds: new Set(), // 1 對 1 第一局誰先手是隨機的
        phase: 'waiting', chat: [], chatSeq: 0, created: Date.now(), idleSince: Date.now(),
        settings: cleanSettings(settings || {}, { game: 'duel', hint: 'normal', digits: 4, memSec: 20, setSec: 10, turnSec: 0, peek: 'off' }),
      };
      rooms.set(code, room);
      role = 'player';
    } else {
      room = rooms.get(code);
      if (!room) throw new Error('找不到房間 ' + code + '，可能已經關閉了');
    }
    const existing = pid && findMember(room, pid);
    if (existing) { if (name) existing.name = name; return { pid, room: code }; }

    if (role === 'spec') {
      if (!name) throw new Error('觀戰要先輸入名字');
      if (room.specs.length >= MAX_SPECS) throw new Error('觀戰人數已滿');
      const s = newMember(name, 'spec');
      room.specs.push(s);
      broadcast(room);
      return { pid: s.id, room: code };
    }
    if (inGame(room)) throw new Error('這局正在進行中，可以先觀戰，下一局再加入');
    if (room.players.length >= MAX[room.settings.game]) throw new Error('玩家已滿，可以先觀戰');
    const p = newMember(name || `玩家${room.players.length + 1}`, 'player');
    room.players.push(p);
    if (!room.host) room.host = p.id;
    broadcast(room);
    return { pid: p.id, room: code };
  },
};
// 以下 API 需要是房內成員（m = 成員）
const memberApi = {
  settings({ patch }, room, m) {
    if (room.host !== m.id) throw new Error('只有房主可以改設定');
    if (inGame(room)) throw new Error('遊戲進行中不能改設定');
    patch = patch || {};
    const next = cleanSettings(patch, room.settings);
    if ((next.game === 'poker') !== (room.settings.game === 'poker')) throw new Error('記憶撲克和 1A1B 是不同的遊戲，不能在房間裡切換');
    if (room.players.length > MAX[next.game]) throw new Error('現在有 ' + room.players.length + ' 位玩家，' + { duel: '1 對 1 只能 2 人', race: '多人競速最多 8 人', poker: '記憶撲克最多 4 人' }[next.game]);
    room.settings = next;
    if (typeof patch.roomName === 'string') room.name = cleanText(patch.roomName, 16);
    broadcast(room);
    return { ok: true };
  },
  start(_, room, m) {
    if (room.host !== m.id) throw new Error('只有房主可以開始');
    if (inGame(room)) throw new Error('遊戲已經開始了');
    const n = room.players.length;
    if (room.settings.game === 'duel' && n !== 2) throw new Error('1 對 1 需要剛好 2 位玩家');
    if (room.settings.game === 'race' && n < 2) throw new Error('至少要 2 位玩家');
    if (room.settings.game === 'poker' && n < 1) throw new Error('至少要 1 位玩家');
    startGame(room);
    broadcast(room);
    return { ok: true };
  },
  sit(_, room, m) {
    if (m.role !== 'spec') throw new Error('你已經是玩家了');
    if (!joinable(room)) throw new Error(inGame(room) ? '等這局結束才能加入' : '玩家已滿');
    room.specs.splice(room.specs.indexOf(m), 1);
    m.role = 'player';
    Object.assign(m, { secret: null, auto: false, out: false, guesses: [], pick: [], locked: false, timedOut: false, wins: 0, played: 0 });
    room.players.push(m);
    if (!room.host) room.host = m.id;
    broadcast(room);
    return { ok: true };
  },
  secret({ secret }, room, m) {
    if (m.role !== 'player') throw new Error('觀戰中不能設定數字');
    if (room.settings.game === 'poker' || room.phase !== 'setting') throw new Error('現在不能設定數字');
    if (!valid(secret, room.settings.digits)) throw new Error(badDigits(room.settings.digits));
    m.secret = secret;
    if (room.players.every(p => p.secret)) startDuel(room); // 兩人都設好就提早開始
    broadcast(room);
    return { ok: true };
  },
  guess({ guess }, room, m) {
    if (m.role !== 'player') throw new Error('觀戰中不能猜');
    if (room.phase !== 'playing' || room.settings.game === 'poker') throw new Error('遊戲尚未開始');
    if (!valid(guess, room.settings.digits)) throw new Error(badDigits(room.settings.digits));
    const easy = room.settings.hint === 'easy';
    if (room.settings.game === 'duel') {
      if (room.turn !== m.id) throw new Error('還沒輪到你');
      const opp = opponent(room, m.id);
      const g = Object.assign({ guess }, score(opp.secret, guess));
      if (easy) g.pos = [...guess].map((_, k) => k).filter(k => guess[k] === opp.secret[k]);
      m.guesses.push(g);
      afterDuelMove(room, m, g.a);
    } else {
      if (m.out) throw new Error('你已經投降了');
      if (room.submitted.has(m.id)) throw new Error('這回合已經送出了，等其他人');
      const g = Object.assign({ guess, round: room.round }, score(room.secret, guess));
      if (easy) g.pos = [...guess].map((_, k) => k).filter(k => guess[k] === room.secret[k]);
      m.guesses.push(g);
      room.submitted.add(m.id);
      maybeEndRound(room);
    }
    broadcast(room);
    return { ok: true };
  },
  // 記憶撲克：點一張蓋牌放上蠟印，再點一次取消；每人最多 2 張
  pick({ idx }, room, m) {
    if (room.settings.game !== 'poker' || room.phase !== 'playing' || room.pk.stage !== 'select') throw new Error('現在不能選牌');
    if (m.role !== 'player' || m.out) throw new Error('你不能選牌');
    if (m.locked) throw new Error('你已經鎖定了');
    idx = Number(idx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) throw new Error('位置不對');
    const at = m.pick.indexOf(idx);
    if (at >= 0) m.pick.splice(at, 1);
    else {
      if (m.pick.length >= 2) throw new Error('最多選 2 張，先點已選的牌取消');
      m.pick.push(idx);
    }
    broadcast(room);
    return { ok: true };
  },
  lock(_, room, m) {
    if (room.settings.game !== 'poker' || room.phase !== 'playing' || room.pk.stage !== 'select') throw new Error('現在不能鎖定');
    if (m.role !== 'player' || m.out) throw new Error('你不能選牌');
    if (m.locked) return { ok: true };
    if (m.pick.length !== 2) throw new Error('要先選滿 2 張');
    m.locked = true;
    pokerProceed(room);
    broadcast(room);
    return { ok: true };
  },
  chat({ text }, room, m) {
    text = cleanText(text, 100);
    if (!text) throw new Error('訊息是空的');
    if (Date.now() - m.lastChat < 400) throw new Error('慢一點，訊息傳太快了');
    m.lastChat = Date.now();
    room.chat.push({ id: ++room.chatSeq, from: m.id, pub: m.pub, name: m.name, text, spec: m.role === 'spec' });
    if (room.chat.length > CHAT_MAX) room.chat.splice(0, room.chat.length - CHAT_MAX);
    broadcast(room);
    return { ok: true };
  },
  surrender(_, room, m) {
    if (m.role !== 'player' || !inGame(room)) throw new Error('現在不能投降');
    if (room.settings.game === 'poker') {
      if (m.out) throw new Error('你已經投降了');
      if (room.pk.stage === 'reveal') throw new Error('正在揭曉，等結果吧');
      m.out = true;
      pokerProceed(room);
    } else if (room.settings.game === 'duel') finish(room, [opponent(room, m.id).id], 'surrender', m.id);
    else {
      if (m.out) throw new Error('你已經投降了');
      m.out = true;
      checkRaceLeft(room);
    }
    broadcast(room);
    return { ok: true };
  },
  leave(_, room, m) {
    if (!members(room).includes(m)) return { ok: true };
    clearTimeout(m.dropTimer);
    if (m.res) { m.res.end(); m.res = null; }
    if (m.role === 'spec') room.specs.splice(room.specs.indexOf(m), 1);
    else {
      const wasIn = inGame(room);
      room.players.splice(room.players.indexOf(m), 1);
      if (wasIn && room.settings.game === 'duel') {
        finish(room, room.players.map(p => p.id), 'left', null);
        room.result.byName = m.name;
      } else if (wasIn && room.settings.game === 'poker') pokerProceed(room);
      else if (wasIn) checkRaceLeft(room);
      if (room.host === m.id) room.host = room.players[0] ? room.players[0].id : null;
    }
    if (!members(room).length) { closeRoom(room); return { ok: true }; }
    broadcast(room);
    return { ok: true };
  },
};

// 離線太久的人自動請出房間（房主離線時，房主會交給下一位），不然對局會一直卡住
function scheduleDrop(room, m, ms) {
  clearTimeout(m.dropTimer);
  const need = () => (m.role === 'spec' ? DROP_SPEC_MS : inGame(room) ? DROP_GAME_MS : DROP_WAIT_MS);
  if (ms === undefined) ms = need();
  m.dropTimer = setTimeout(() => {
    if (m.res || rooms.get(room.code) !== room || !members(room).includes(m)) return;
    const left = need() - (Date.now() - m.offAt); // 離線期間剛好開局的話，按局內的時間再多等一下
    if (left > 500) return scheduleDrop(room, m, left);
    memberApi.leave(null, room, m);
  }, ms);
}

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
    const m = room && findMember(room, url.searchParams.get('pid'));
    if (!m) return send(res, 404, { error: '找不到房間或玩家' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (m.res) m.res.end();
    m.res = res;
    m.offAt = 0;
    clearTimeout(m.dropTimer);
    if (m.role === 'player') resume(room);
    broadcast(room);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      if (m.res !== res) return;
      m.res = null;
      m.offAt = Date.now();
      if (!anyOnline(room)) room.idleSince = Date.now();
      scheduleDrop(room, m);
      // 寬限時間過了還沒回來，競速就不再等他
      setTimeout(() => { if (rooms.get(room.code) === room) { maybeEndRound(room); broadcast(room); } }, GRACE_MS + 200);
      broadcast(room);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const key = url.pathname.slice(5);
    try {
      const body = await readJSON(req);
      if (Object.hasOwn(api, key)) return send(res, 200, api[key](body));
      if (!Object.hasOwn(memberApi, key)) return send(res, 404, { error: 'not found' });
      const room = rooms.get(body.room);
      const m = room && findMember(room, body.pid);
      if (!m) throw new Error('找不到房間或玩家');
      return send(res, 200, memberApi[key](body, room, m));
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
