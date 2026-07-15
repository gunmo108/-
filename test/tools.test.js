/* くらしの計算ツール集 — 計算ロジック単体テスト
 *   実行: node test/tools.test.js
 */
const T = require('../assets/tools.js');

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}
function near(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? 0.01 : eps);
}

// ---------- toNum ----------
assert(T.toNum('1,234') === 1234, 'toNumはカンマ入りを許容');
assert(Number.isNaN(T.toNum('abc')), 'toNumは非数値でNaN');
assert(Number.isNaN(T.toNum('')), 'toNumは空文字でNaN(Number("")=0にしない)');

// ---------- 電気代 ----------
{
  // 1000W を 1時間 → 1kWh → 31円(既定単価)
  const r = T.denkidai(1000, 1, undefined);
  assert(near(r.day, 31), '電気代: 1000W×1h=31円/日');
  assert(near(r.month, 31 * 30), '電気代: 月=日×30');
  assert(near(r.year, 31 * 365), '電気代: 年=日×365');
  // エアコン600Wを8時間、単価31円 → 0.6*8*31 = 148.8円/日
  const ac = T.denkidai(600, 8, 31);
  assert(near(ac.day, 148.8), '電気代: エアコン例');
  assert(near(ac.kwhDay, 4.8), '電気代: kWh/日');
  // 0W・0時間は0円として有効
  assert(near(T.denkidai(0, 5).day, 0), '電気代: 0Wは0円');
  assert(near(T.denkidai(500, 0).day, 0), '電気代: 0時間は0円');
  // 不正入力
  assert(T.denkidai(-1, 1) === null, '電気代: 負のWはnull');
  assert(T.denkidai('abc', 1) === null, '電気代: 非数値はnull');
  assert(T.denkidai(100, 1, -5) === null, '電気代: 負の単価はnull');
  // 単価''は既定値扱い
  assert(near(T.denkidai(1000, 1, '').day, 31), '電気代: 単価空文字は既定31円');
}

// ---------- 単価比較 ----------
{
  // 300gで398円(132.7円/100g) vs 500gで598円(119.6円/100g) → 後者が得
  const r = T.tankaCompare([{ price: 398, amount: 300 }, { price: 598, amount: 500 }], 100);
  assert(r.bestIndex === 1, '単価: 500g/598円が得');
  assert(near(r.rows[0].unit, 132.67), '単価: 1つ目 132.67円/100g');
  assert(near(r.rows[1].unit, 119.6), '単価: 2つ目 119.6円/100g');
  assert(r.rows[1].best === true && r.rows[0].best === false, '単価: bestフラグ');
  assert(near(r.rows[1].savePercent, (132.666 - 119.6) / 132.666 * 100, 0.1), '単価: 節約率');
  // 同額なら先頭が best
  const eq = T.tankaCompare([{ price: 100, amount: 100 }, { price: 200, amount: 200 }]);
  assert(eq.bestIndex === 0, '単価: 同単価は先頭優先');
  // 3件比較
  const three = T.tankaCompare([
    { price: 100, amount: 80 }, { price: 250, amount: 240 }, { price: 500, amount: 450 },
  ]);
  assert(three.bestIndex === 1, '単価: 3件比較');
  // 不正入力
  assert(T.tankaCompare([{ price: 100, amount: 0 }]) === null, '単価: 量0はnull');
  assert(T.tankaCompare([], 100) === null, '単価: 空配列はnull');
  assert(T.tankaCompare([{ price: 100, amount: 100 }], 0) === null, '単価: 基準量0はnull');
}

// ---------- 割引 ----------
{
  const r = T.waribiki(7980, 30);
  assert(near(r.discounted, 5586), '割引: 7980の30%オフ=5586');
  assert(near(r.saved, 2394), '割引: 値引き額');
  assert(near(T.waribiki(1000, 0).discounted, 1000), '割引: 0%は満額');
  assert(near(T.waribiki(1000, 100).discounted, 0), '割引: 100%は0円');
  assert(T.waribiki(1000, 101) === null, '割引: 100%超はnull');
  assert(T.waribiki(-1, 10) === null, '割引: 負の価格はnull');

  const p = T.pointKangen(10000, 10);
  assert(near(p.effective, 9000) && near(p.point, 1000), 'ポイント: 10%還元の実質9000円');

  // 10%オフ(9000円) vs 10%還元(実質9000円だが支払10000円) → 同率は even 扱い(実質額は同じ)
  const vs = T.waribikiVsPoint(10000, 10, 10);
  assert(vs.winner === 'even' && near(vs.diff, 0), '割引vs還元: 同率は実質同額');
  const vs2 = T.waribikiVsPoint(10000, 10, 12);
  assert(vs2.winner === 'point', '割引vs還元: 12%還元 > 10%オフ');
  const vs3 = T.waribikiVsPoint(10000, 15, 12);
  assert(vs3.winner === 'off' && near(vs3.diff, 300), '割引vs還元: 15%オフの勝ち・差300円');
}

// ---------- 割り勘 ----------
{
  // 13,470円を4人、100円単位切り上げ → 3,367.5 → 3,400円/人、余り130円
  const r = T.warikan(13470, 4, 100);
  assert(r.perPerson === 3400, '割り勘: 100円単位切り上げ');
  assert(near(r.exact, 3367.5), '割り勘: 正確な頭割り');
  assert(r.surplus === 130, '割り勘: 余り130円');
  // 幹事負担: 3,300円×3人 + 幹事3,570円
  const o = T.warikan(13470, 4, 100, 'organizer');
  assert(o.perPerson === 3300, '割り勘幹事: メンバー3300円');
  assert(o.organizerPays === 13470 - 3300 * 3, '割り勘幹事: 幹事が端数吸収');
  assert(o.collected === 13470, '割り勘幹事: 合計一致');
  // 1円単位・割り切れる
  const e = T.warikan(9000, 3, 1);
  assert(e.perPerson === 3000 && e.surplus === 0, '割り勘: 割り切れ');
  // 1人でも動く
  assert(T.warikan(5000, 1, 100).perPerson === 5000, '割り勘: 1人');
  // 不正入力
  assert(T.warikan(1000, 0, 100) === null, '割り勘: 0人はnull');
  assert(T.warikan(1000, 2.5, 100) === null, '割り勘: 小数人数はnull');

  // 傾斜: 10000円を 2:1:1 で → 5000/2500/2500
  const k = T.warikanKeisha(10000, [2, 1, 1], 100);
  assert(k.shares[0] === 5000 && k.shares[1] === 2500 && k.shares[2] === 2500, '傾斜: 2:1:1');
  assert(k.shares.reduce((a, b) => a + b, 0) === 10000, '傾斜: 合計一致');
  // 丸め誤差は最重み者が吸収して必ず合計一致
  const k2 = T.warikanKeisha(10000, [3, 2, 2], 100);
  assert(k2.shares.reduce((a, b) => a + b, 0) === 10000, '傾斜: 誤差吸収後も合計一致');
  assert(T.warikanKeisha(1000, [1, -1], 100) === null, '傾斜: 負の重みはnull');
}

// ---------- 日数計算 ----------
{
  assert(T.dateDiff('2026-01-01', '2026-01-31') === 30, '日数: 1/1→1/31は30日');
  assert(T.dateDiff('2026-01-31', '2026-01-01') === -30, '日数: 逆方向は負');
  assert(T.dateDiff('2024-02-28', '2024-03-01') === 2, '日数: うるう年2024をまたぐ');
  assert(T.dateDiff('2025-02-28', '2025-03-01') === 1, '日数: 平年2025');
  assert(T.dateDiff('2026-01-01', '2026-01-01') === 0, '日数: 同日0');
  assert(T.dateAdd('2026-07-15', 100) === '2026-10-23', '日数: 100日後');
  assert(T.dateAdd('2026-01-01', -1) === '2025-12-31', '日数: 年またぎマイナス');
  assert(T.dateAdd('2026-07-15', 1.5) === null, '日数: 小数日数はnull');
  assert(T.dateDiff('2026-02-30', '2026-03-01') === null, '日数: 実在しない日付はnull');
  assert(T.dateDiff('abc', '2026-01-01') === null, '日数: 不正文字列はnull');
  assert(T.youbiOf('2026-07-15') === '水', '曜日: 2026-07-15は水曜');
}

// ---------- 積立 ----------
{
  // 利回り0%: 月3万×20年 = 720万
  const z = T.tsumitate(30000, 20, 0);
  assert(z.principal === 7200000 && near(z.total, 7200000), '積立: 0%は元本のみ');
  assert(near(z.gain, 0), '積立: 0%の運用益0');
  // 年利5%・月3万・20年 → 期末年金終価: 30000*((1+0.05/12)^240-1)/(0.05/12) ≈ 12,331,010円
  const r = T.tsumitate(30000, 20, 5);
  assert(near(r.total, 12331010, 2000), '積立: 5%20年の複利計算');
  assert(r.total > r.principal, '積立: 正の利回りで元本超え');
  assert(r.yearly.length === 20, '積立: 年次推移20行');
  assert(near(r.yearly[19].total, r.total), '積立: 最終年=総額');
  assert(r.yearly[0].principal === 360000, '積立: 1年目元本36万');
  // 半年(0.5年)
  assert(T.tsumitate(10000, 0.5, 0).months === 6, '積立: 0.5年=6ヶ月');
  // 不正入力
  assert(T.tsumitate(-1, 10, 3) === null, '積立: 負の月額はnull');
  assert(T.tsumitate(10000, 0, 3) === null, '積立: 0年はnull');
}

console.log('TOOLS TEST: ALL PASS (' + count + ' assertions)');
