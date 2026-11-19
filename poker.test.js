'use strict';
// 執行：node poker.test.js
const assert = require('assert');
const P = require('./poker.js');

const R = { A: 14, K: 13, Q: 12, J: 11 };
// 'AS KH 10D' → 牌物件（最後一個字是花色 S/H/D/C）
const hand = str => str.trim().split(/\s+/).map(t => {
  const s = t.slice(-1), r = t.slice(0, -1);
  return P.card(s, R[r] || Number(r));
});
const ev = str => P.evaluateHand(hand(str));
const cmp = (a, b) => P.compareHands(ev(a), ev(b));

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log('PASS ' + String(n).padStart(2) + '. ' + name); }
  catch (e) { failed++; console.log('FAIL ' + String(n).padStart(2) + '. ' + name + '\n     ' + e.message); }
}

const SF = '9S 10S JS QS KS', FOUR = 'AS AH AD AC 7S', FULL = 'KS KH KD 8S 8H', FLUSH = 'AH JH 8H 5H 2H',
  STR = '5S 6H 7D 8C 9S', TRIPS = 'QS QH QD 8C 4S', TWOP = 'AS AH KS KD 7C', PAIR = 'JS JH 9C 6D 3S', HIGH = 'AS KH QD 9C 7S';

test('同花順 > 四條', () => assert.strictEqual(cmp(SF, FOUR), 'A'));
test('四條 > 葫蘆', () => assert.strictEqual(cmp(FOUR, FULL), 'A'));
test('葫蘆 > 同花', () => assert.strictEqual(cmp(FULL, FLUSH), 'A'));
test('同花 > 順子', () => assert.strictEqual(cmp(FLUSH, STR), 'A'));
test('順子 > 三條', () => assert.strictEqual(cmp(STR, TRIPS), 'A'));
test('三條 > 兩對', () => assert.strictEqual(cmp(TRIPS, TWOP), 'A'));
test('兩對 > 一對', () => assert.strictEqual(cmp(TWOP, PAIR), 'A'));
test('一對 > 高牌', () => assert.strictEqual(cmp(PAIR, HIGH), 'A'));
test('A-K-Q-J-10 是最大順子', () => {
  const h = ev('AS KH QD JC 10S');
  assert.strictEqual(h.categoryName, 'Straight');
  assert.strictEqual(h.comparisonValues[1], 14);
  assert.strictEqual(cmp('AS KH QD JC 10S', 'KS QH JD 10C 9S'), 'A');
});
test('A-2-3-4-5 是五高順子', () => {
  const h = ev('AS 2H 3D 4C 5S');
  assert.strictEqual(h.categoryName, 'Straight');
  assert.strictEqual(h.comparisonValues[1], 5);
  assert.strictEqual(cmp('2S 3H 4D 5C 6S', 'AS 2H 3D 4C 5S'), 'A'); // 六高順子贏五高順子
  assert.strictEqual(h.displayCards[4].rank, 14); // 顯示時 A 排最後
});
test('Q-K-A-2-3 不是順子', () => assert.strictEqual(ev('QS KH AD 2C 3S').categoryName, 'High Card'));
test('K-A-2-3-4 不是順子', () => assert.strictEqual(ev('KS AH 2D 3C 4S').categoryName, 'High Card'));
test('同花順必須五張同花色（同點數不同花色只是順子）', () => {
  assert.strictEqual(ev('9S 10S JS QS KH').categoryName, 'Straight');
  assert.strictEqual(ev('9S 10S JS QS KS').categoryName, 'Straight Flush');
  assert.strictEqual(ev('AH 2H 3H 4H 5H').categoryName, 'Straight Flush'); // 五高同花順
  assert.strictEqual(cmp('9S 10S JS QS KS', '10H JH QH KH AH'), 'B');
});
test('葫蘆先比三條，再比對子', () => {
  assert.strictEqual(cmp('KS KH KD 8S 8H', 'QS QH QD AS AH'), 'A');
  assert.strictEqual(cmp('KS KH KD 8S 8H', 'KC KD KH 9S 9H'), 'B'); // 三條同點（不同花色）才比對子
});
test('四條相同時比第五張', () => {
  assert.strictEqual(cmp('AS AH AD AC 3S', 'KS KH KD KC AS'), 'A');
  assert.strictEqual(cmp('KS KH KD KC 3S', 'KS KH KD KC 4D'), 'B');
});
test('同花最高牌相同，比第二張', () => assert.strictEqual(cmp('AH JH 8H 5H 2H', 'AS 10S 9S 5S 2S'), 'A'));
test('兩對：大對子 → 小對子 → 單牌', () => {
  assert.strictEqual(cmp('AS AH KS KD 3C', 'AC AD QS QH KC'), 'A');
  assert.strictEqual(cmp('AS AH KS KD 3C', 'AC AD KH KC 2S'), 'A'); // 對子都相同，比單牌 3 > 2
  assert.strictEqual(cmp('QS QH JS JD 3C', 'QC QD 10S 10H AC'), 'A'); // 小對子 J > 10，不會被單牌 A 影響
});
test('一對：對子點數與三張踢腳牌', () => {
  assert.strictEqual(cmp('JS JH AC 8D 3S', 'JC JD KS QH 9S'), 'A');
  assert.strictEqual(cmp('JS JH AC 8D 3S', 'JC JD AH 7S 6H'), 'A');
  assert.strictEqual(cmp('JS JH AC 8D 3S', 'JC JD AH 8S 2H'), 'A');
});
test('高牌依序比較五張', () => {
  assert.strictEqual(cmp('AS KH QD 9C 7S', 'AC KD JH 10S 8H'), 'A');
  assert.strictEqual(cmp('AS KH QD 9C 7S', 'AC KD QH 9S 6H'), 'A'); // 最後一張才分出勝負
});
test('相同牌型與點數判定平手', () => {
  assert.strictEqual(cmp('AS KH QD 9C 7S', 'AC KD QH 9S 7H'), 'TIE');
  assert.strictEqual(cmp('5S 6H 7D 8C 9S', '5H 6D 7C 8S 9H'), 'TIE');
});
test('花色絕對不能作為勝負條件', () => {
  assert.strictEqual(cmp('AS KS QS 9S 7D', 'AH KH QH 9H 7C'), 'TIE');
  assert.strictEqual(cmp('AH JH 8H 5H 2H', 'AS JS 8S 5S 2S'), 'TIE'); // 同花同點數、不同花色
});
test('同一副牌不會抽出重複的牌', () => {
  for (let i = 0; i < 200; i++) {
    const d = P.shuffle(P.makeDeck());
    assert.strictEqual(d.length, 52);
    assert.strictEqual(new Set(d.map(c => c.id)).size, 52);
  }
});
test('16 張記憶牌與 3 張公牌不重複', () => {
  for (let i = 0; i < 500; i++) {
    const { board, community } = P.dealRound();
    assert.strictEqual(board.length, 16);
    assert.strictEqual(community.length, 3);
    assert.strictEqual(new Set(board.concat(community).map(c => c.id)).size, 19);
  }
});
test('每局重新洗牌（連續兩局棋盤不同）', () => {
  const a = P.dealRound().board.map(c => c.id).join(), b = P.dealRound().board.map(c => c.id).join();
  assert.notStrictEqual(a, b);
});
test('每位玩家只能選兩個不同位置（用相同牌組驗證選牌組合）', () => {
  const { board, community } = P.dealRound();
  const h1 = P.evaluateHand([board[0], board[5]].concat(community));
  const h2 = P.evaluateHand([board[0], board[5]].concat(community)); // 雙方可選相同位置，結果必為平手
  assert.strictEqual(P.compareHands(h1, h2), 'TIE');
  assert.throws(() => P.evaluateHand([board[0], board[0]].concat(community)), /不可重複/);
});
test('多人比較：bestOf 與平手', () => {
  const hs = [ev(PAIR), ev(TWOP), ev(TWOP)];
  assert.deepStrictEqual(P.bestOf(hs), [1, 2]);
  assert.deepStrictEqual(P.bestOf([ev(HIGH), ev(PAIR)]), [1]);
});
test('勝負說明文字', () => {
  assert.strictEqual(P.explain(ev(FOUR), ev(FULL)), '四條勝過葫蘆');
  assert.strictEqual(P.explain(ev('JS JH AC 8D 3S'), ev('JC JD KS QH 9S')), '同為一對，第一張單牌 A 大於 K');
});
test('隨機抽 20 萬手五張牌：都能分類且不報錯，高牌與一對的比例符合機率', () => {
  const deck = P.makeDeck(); const cnt = {};
  for (let i = 0; i < 200000; i++) {
    const h = P.evaluateHand(P.shuffle(deck).slice(0, 5));
    cnt[h.category] = (cnt[h.category] || 0) + 1;
    assert.strictEqual(h.displayCards.length, 5);
  }
  // 高牌約 50%、一對約 42%：粗略檢查分布合理
  assert.ok(cnt[1] / 200000 > 0.48 && cnt[1] / 200000 < 0.52, '高牌比例 ' + cnt[1] / 200000);
  assert.ok(cnt[2] / 200000 > 0.40 && cnt[2] / 200000 < 0.44, '一對比例 ' + cnt[2] / 200000);
});

console.log('\n' + (failed ? failed + ' 項失敗' : '全部 ' + n + ' 項通過'));
process.exit(failed ? 1 : 0);
