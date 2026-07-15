/* くらしの計算ツール集 — 共通計算ロジック
 * ブラウザ(window.KurashiTools)と Node(module.exports)の両方で動く純関数群。
 * DOM操作は各ページ側で行い、ここには計算だけを置く(test/tools.test.js で検証)。
 */
(function (global) {
  'use strict';

  // ---------- 共通ユーティリティ ----------

  function toNum(v) {
    if (typeof v === 'string') {
      v = v.replace(/,/g, '').trim();
      if (v === '') return NaN;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function yen(n) {
    return Math.round(n).toLocaleString('ja-JP') + '円';
  }

  // ---------- 電気代計算 ----------
  // watts: 消費電力(W) / hoursPerDay: 1日の使用時間(h)
  // unitPrice: 電力量料金の単価(円/kWh)。目安単価は全国家庭電気製品公正取引協議会の31円/kWh。
  const DENKI_UNIT_DEFAULT = 31;

  function denkidai(watts, hoursPerDay, unitPrice) {
    watts = toNum(watts); hoursPerDay = toNum(hoursPerDay);
    unitPrice = unitPrice === undefined || unitPrice === '' ? DENKI_UNIT_DEFAULT : toNum(unitPrice);
    if (!(watts >= 0) || !(hoursPerDay >= 0) || !(unitPrice >= 0)) return null;
    const kwhDay = (watts / 1000) * hoursPerDay;
    const day = kwhDay * unitPrice;
    return {
      kwhDay: kwhDay,
      day: day,
      week: day * 7,
      month: day * 30,
      year: day * 365,
    };
  }

  // ---------- 単価比較(どっちがお得) ----------
  // items: [{ price: 総額(円), amount: 内容量 }] を単価(基準量あたり)で比較。
  // per: 基準量(例: 100gあたりなら100)
  function tankaCompare(items, per) {
    per = per === undefined ? 100 : toNum(per);
    if (!(per > 0) || !Array.isArray(items)) return null;
    const rows = [];
    for (const it of items) {
      const price = toNum(it.price);
      const amount = toNum(it.amount);
      if (!(price >= 0) || !(amount > 0)) return null;
      rows.push({ price: price, amount: amount, unit: (price / amount) * per });
    }
    if (rows.length === 0) return null;
    let best = 0;
    rows.forEach((r, i) => { if (r.unit < rows[best].unit) best = i; });
    const worst = rows.reduce((m, r) => Math.max(m, r.unit), -Infinity);
    rows.forEach((r, i) => {
      r.best = i === best;
      r.savePercent = worst > 0 ? ((worst - r.unit) / worst) * 100 : 0;
    });
    return { rows: rows, bestIndex: best };
  }

  // ---------- 割引計算 ----------
  // 「○%オフ」と「○%ポイント還元」の実質価格比較にも対応。
  function waribiki(price, offPercent) {
    price = toNum(price); offPercent = toNum(offPercent);
    if (!(price >= 0) || !(offPercent >= 0) || offPercent > 100) return null;
    const discounted = price * (1 - offPercent / 100);
    return { discounted: discounted, saved: price - discounted };
  }

  // ポイント還元の実質価格: 支払いは満額、後でpoint分が戻る前提の実質負担額
  function pointKangen(price, pointPercent) {
    price = toNum(price); pointPercent = toNum(pointPercent);
    if (!(price >= 0) || !(pointPercent >= 0) || pointPercent > 100) return null;
    const point = price * (pointPercent / 100);
    return { pay: price, point: point, effective: price - point };
  }

  // 割引 vs ポイント還元: どちらが得か(同率なら割引が得 — 実質負担が必ず低い)
  function waribikiVsPoint(price, offPercent, pointPercent) {
    const w = waribiki(price, offPercent);
    const p = pointKangen(price, pointPercent);
    if (!w || !p) return null;
    const diff = p.effective - w.discounted;
    return {
      off: w, point: p,
      winner: diff > 0 ? 'off' : diff < 0 ? 'point' : 'even',
      diff: Math.abs(diff),
    };
  }

  // ---------- 割り勘計算 ----------
  // total: 合計金額 / people: 人数 / roundUnit: 1人分を切り上げる単位(1,10,100,500,1000)
  // 切り上げた場合の余りは「幹事の取り分(プール)」として返す。
  // 端数を幹事が負担する方式(roundMode='organizer')では切り捨てにして不足分を幹事が払う。
  function warikan(total, people, roundUnit, roundMode) {
    total = toNum(total); people = toNum(people);
    roundUnit = roundUnit === undefined ? 100 : toNum(roundUnit);
    roundMode = roundMode || 'collect'; // collect: 集めすぎ(多め徴収) / organizer: 幹事負担
    if (!(total >= 0) || !Number.isInteger(people) || people < 1 || !(roundUnit >= 1)) return null;
    const exact = total / people;
    let perPerson, organizer;
    if (roundMode === 'organizer') {
      perPerson = Math.floor(exact / roundUnit) * roundUnit;
      organizer = total - perPerson * (people - 1); // 幹事は自分の分+端数
    } else {
      perPerson = Math.ceil(exact / roundUnit) * roundUnit;
      organizer = null;
    }
    const collected = roundMode === 'organizer'
      ? perPerson * (people - 1) + organizer
      : perPerson * people;
    return {
      exact: exact,
      perPerson: perPerson,
      organizerPays: organizer,
      collected: collected,
      surplus: collected - total, // collectモードでの余り(次回繰越や幹事チップ)
    };
  }

  // 傾斜配分: weights の比で total を配分し、100円単位に丸めて誤差は最重み者が吸収
  function warikanKeisha(total, weights, roundUnit) {
    total = toNum(total);
    roundUnit = roundUnit === undefined ? 100 : toNum(roundUnit);
    if (!(total >= 0) || !Array.isArray(weights) || weights.length === 0 || !(roundUnit >= 1)) return null;
    const ws = weights.map(toNum);
    if (ws.some((w) => !(w > 0))) return null;
    const sum = ws.reduce((a, b) => a + b, 0);
    const shares = ws.map((w) => Math.round((total * w) / sum / roundUnit) * roundUnit);
    let heaviest = 0;
    ws.forEach((w, i) => { if (w > ws[heaviest]) heaviest = i; });
    const drift = total - shares.reduce((a, b) => a + b, 0);
    shares[heaviest] += drift;
    return { shares: shares, adjustedIndex: heaviest, adjustment: drift };
  }

  // ---------- 日数計算 ----------
  // ISO文字列(YYYY-MM-DD)同士の日数差。時刻・タイムゾーンの影響を受けないようUTCで計算。
  function parseISO(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return d;
  }

  function dateDiff(fromISO, toISO) {
    const a = parseISO(fromISO), b = parseISO(toISO);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  function dateAdd(fromISO, days) {
    const a = parseISO(fromISO); days = toNum(days);
    if (!a || !Number.isFinite(days) || !Number.isInteger(days)) return null;
    const d = new Date(a.getTime() + days * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  const YOUBI = ['日', '月', '火', '水', '木', '金', '土'];
  function youbiOf(iso) {
    const d = parseISO(iso);
    return d ? YOUBI[d.getUTCDay()] : null;
  }

  // ---------- 積立シミュレーター ----------
  // monthly: 毎月の積立額 / years: 年数 / annualRatePercent: 想定年利(%)
  // 月次複利・毎月末積立(期末払い)で計算。rate=0 でも動く。
  function tsumitate(monthly, years, annualRatePercent) {
    monthly = toNum(monthly); years = toNum(years); annualRatePercent = toNum(annualRatePercent);
    if (!(monthly >= 0) || !(years > 0) || !Number.isFinite(annualRatePercent) || annualRatePercent < -100) return null;
    const months = Math.round(years * 12);
    const r = annualRatePercent / 100 / 12;
    const principal = monthly * months;
    const total = r === 0 ? principal : monthly * ((Math.pow(1 + r, months) - 1) / r);
    // 年ごとの推移(グラフ・表示用)
    const yearly = [];
    for (let y = 1; y <= Math.ceil(years); y++) {
      const m = Math.min(y * 12, months);
      const t = r === 0 ? monthly * m : monthly * ((Math.pow(1 + r, m) - 1) / r);
      yearly.push({ year: y, principal: monthly * m, total: t });
    }
    return { months: months, principal: principal, total: total, gain: total - principal, yearly: yearly };
  }

  const api = {
    toNum: toNum,
    yen: yen,
    DENKI_UNIT_DEFAULT: DENKI_UNIT_DEFAULT,
    denkidai: denkidai,
    tankaCompare: tankaCompare,
    waribiki: waribiki,
    pointKangen: pointKangen,
    waribikiVsPoint: waribikiVsPoint,
    warikan: warikan,
    warikanKeisha: warikanKeisha,
    parseISO: parseISO,
    dateDiff: dateDiff,
    dateAdd: dateAdd,
    youbiOf: youbiOf,
    tsumitate: tsumitate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.KurashiTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
