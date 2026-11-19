'use strict';
// 記憶撲克的核心邏輯：牌組、牌型判斷、勝負比較。
// 不依賴伺服器或畫面，可以單獨測試（node poker.test.js）。
const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C']; // ♠ ♥ ♦ ♣
const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankName = r => RANK_NAME[r] || String(r);

// ---------- Deck Manager ----------
const card = (suit, rank) => ({ id: suit + rank, suit, rank });
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(card(s, r));
  return d;
}
function shuffle(arr, rnd = n => crypto.randomInt(n)) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// 一局：先洗一副牌，前 16 張是 4×4 棋盤，接著 3 張是公牌，保證不會重複
function dealRound(rnd) {
  const d = shuffle(makeDeck(), rnd);
  return { board: d.slice(0, 16), community: d.slice(16, 19) };
}

// ---------- Poker Hand Evaluator ----------
const CATEGORY = {
  9: ['Straight Flush', '同花順'],
  8: ['Four of a Kind', '四條'],
  7: ['Full House', '葫蘆'],
  6: ['Flush', '同花'],
  5: ['Straight', '順子'],
  4: ['Three of a Kind', '三條'],
  3: ['Two Pair', '兩對'],
  2: ['One Pair', '一對'],
  1: ['High Card', '高牌'],
};
// 每種牌型 comparisonValues（第 0 項是牌型權重）後面每一項的說明，用來解釋為什麼贏
const SLOT_LABEL = {
  9: ['最高牌'],
  8: ['四條的點數', '第五張牌'],
  7: ['三條的點數', '對子的點數'],
  6: ['最大牌', '第二大牌', '第三大牌', '第四大牌', '第五大牌'],
  5: ['最高牌'],
  4: ['三條的點數', '第一張單牌', '第二張單牌'],
  3: ['大對子', '小對子', '單牌'],
  2: ['對子的點數', '第一張單牌', '第二張單牌', '第三張單牌'],
  1: ['最大牌', '第二大牌', '第三大牌', '第四大牌', '第五大牌'],
};

function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error('需要剛好 5 張牌');
  if (new Set(cards.map(c => c.id)).size !== 5) throw new Error('牌不可重複');
  const byRank = new Map();
  for (const c of cards) byRank.set(c.rank, (byRank.get(c.rank) || []).concat(c));
  // 依「張數多的在前，同張數點數大的在前」分組
  const groups = [...byRank.entries()]
    .map(([rank, cs]) => ({ rank, cs }))
    .sort((a, b) => b.cs.length - a.cs.length || b.rank - a.rank);
  const ranksDesc = cards.map(c => c.rank).sort((a, b) => b - a);
  const flush = cards.every(c => c.suit === cards[0].suit);
  let straightHigh = 0;
  if (byRank.size === 5) {
    if (ranksDesc[0] - ranksDesc[4] === 4) straightHigh = ranksDesc[0];
    else if (ranksDesc.join() === '14,5,4,3,2') straightHigh = 5; // A-2-3-4-5：A 當 1，五高順子
  }
  const shape = groups.map(g => g.cs.length).join('');
  const flat = () => groups.flatMap(g => g.cs);
  const byHigh = () => cards.slice().sort((a, b) => b.rank - a.rank);
  const straightOrder = () => {
    const s = byHigh();
    return straightHigh === 5 ? s.slice(1).concat(s[0]) : s; // 五高順子 A 排最後
  };

  let category, values, display;
  if (straightHigh && flush) { category = 9; values = [9, straightHigh]; display = straightOrder(); }
  else if (shape === '41') { category = 8; values = [8, groups[0].rank, groups[1].rank]; display = flat(); }
  else if (shape === '32') { category = 7; values = [7, groups[0].rank, groups[1].rank]; display = flat(); }
  else if (flush) { category = 6; values = [6, ...ranksDesc]; display = byHigh(); }
  else if (straightHigh) { category = 5; values = [5, straightHigh]; display = straightOrder(); }
  else if (shape === '311') { category = 4; values = [4, groups[0].rank, groups[1].rank, groups[2].rank]; display = flat(); }
  else if (shape === '221') { category = 3; values = [3, groups[0].rank, groups[1].rank, groups[2].rank]; display = flat(); }
  else if (shape === '2111') { category = 2; values = [2, groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank]; display = flat(); }
  else { category = 1; values = [1, ...ranksDesc]; display = byHigh(); }

  return {
    category,
    categoryName: CATEGORY[category][0],
    categoryZh: CATEGORY[category][1],
    comparisonValues: values,
    displayCards: display,
  };
}

// ---------- Hand Comparator ----------
// 回傳 'A'、'B' 或 'TIE'。只看牌型與點數，花色永遠不參與比較
function compareHands(a, b) {
  const x = a.comparisonValues, y = b.comparisonValues;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 'A' : 'B';
  }
  return 'TIE';
}
// 多人：找出最強的那群人（可能有多人平手）
function bestOf(hands) {
  let best = [0];
  for (let i = 1; i < hands.length; i++) {
    const r = compareHands(hands[i], hands[best[0]]);
    if (r === 'A') best = [i]; else if (r === 'TIE') best.push(i);
  }
  return best;
}
// a 為什麼贏過 b（a 要是較強的那一手）：牌型不同就只看牌型；牌型相同就找出第一個分出高下的項目
function reasonParts(a, b) {
  const x = a.comparisonValues, y = b.comparisonValues;
  const out = { same: x[0] === y[0], catA: a.categoryZh, catB: b.categoryZh, label: '', hi: '', lo: '' };
  if (!out.same) return out;
  for (let i = 1; i < x.length; i++) {
    if (x[i] !== y[i]) {
      out.label = SLOT_LABEL[x[0]][i - 1] || '點數';
      out.hi = rankName(x[i]); out.lo = rankName(y[i]);
      return out;
    }
  }
  return out;
}
// 用一句白話說明（平手回傳空字串）
function explain(a, b) {
  const r = reasonParts(a, b);
  if (!r.same) return r.catA + '勝過' + r.catB;
  return r.label ? '同為' + r.catA + '，' + r.label + ' ' + r.hi + ' 大於 ' + r.lo : '';
}

module.exports = { SUITS, rankName, makeDeck, shuffle, dealRound, evaluateHand, compareHands, bestOf, explain, reasonParts, card };
