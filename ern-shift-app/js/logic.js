// 純粋ロジック（DOM / DB 非依存・テスト対象）

export const DEFAULT_SETTINGS = {
  key: 'app',
  round_count_default: 4,
  device_warn_days: { cvc: 7, foley: 5, vent: 5 },
  dot_warn_days: 7,
};

// ---- 日数計算 ---------------------------------------------------------

// 開始日を1日目として数える留置日数 / 投与日数（DOT）
export function daysSince(startDateStr, now = new Date()) {
  if (!startDateStr) return 0;
  const start = new Date(startDateStr + 'T00:00:00');
  if (isNaN(start)) return 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((today - start) / 86400000);
  return diff < 0 ? 0 : diff + 1;
}

export function deviceDays(devices, now = new Date()) {
  const out = { cvc: 0, foley: 0, vent: 0 };
  for (const k of ['cvc', 'foley', 'vent']) {
    const d = devices && devices[k];
    if (d && d.active && d.start_date) out[k] = daysSince(d.start_date, now);
  }
  return out;
}

export function dotDays(am, now = new Date()) {
  if (!am || !am.start_date) return 0;
  if (am.end_date) {
    return daysSince(am.start_date, new Date(am.end_date + 'T00:00:00'));
  }
  return daysSince(am.start_date, now);
}

export function maxDot(infection, now = new Date()) {
  const ams = (infection && infection.antimicrobials) || [];
  return ams.reduce((m, am) => Math.max(m, am.end_date ? 0 : dotDays(am, now)), 0);
}

// ---- 感染トリガー（roster に上げる3種・自動判定） ----------------------

export function infectionTriggers(infection, settings = DEFAULT_SETTINGS, now = new Date()) {
  const t = { device_warn: false, dot_warn: false, deesc_due: false };
  if (!infection) return t;
  const dd = deviceDays(infection.device_days_src || infection.devices, now);
  const th = settings.device_warn_days || DEFAULT_SETTINGS.device_warn_days;
  t.device_warn = dd.cvc >= th.cvc && dd.cvc > 0
    || dd.foley >= th.foley && dd.foley > 0
    || dd.vent >= th.vent && dd.vent > 0;
  const ams = infection.antimicrobials || [];
  t.dot_warn = ams.some(am => !am.end_date && dotDays(am, now) >= (settings.dot_warn_days || DEFAULT_SETTINGS.dot_warn_days));
  t.deesc_due = infection.culture_status === 'positive'
    && ams.some(am => !am.end_date && am.spectrum === 'broad')
    && infection.deescalation !== 'done';
  return t;
}

export function triggerCount(triggers) {
  if (!triggers) return 0;
  return ['device_warn', 'dot_warn', 'deesc_due'].filter(k => triggers[k]).length;
}

// ---- リスクスコア（roster 自動ソート用の合成スコア） --------------------

// 最新 EWS + ラウンド間の悪化幅（改善は加点しない） + 感染フラグ
export function riskScore({ ews = 0, delta = 0, triggers = null, proactive = false }) {
  let s = ews + 1.5 * Math.max(0, delta) + 1.0 * triggerCount(triggers);
  if (proactive) s += 0.25; // 同点時に proactive を上に
  return s;
}

// patient_rounds（同一患者・round_number 昇順）から EWS 系列と直近差分を得る
export function ewsSeries(prs) {
  const sorted = [...prs].sort((a, b) => a.round_number - b.round_number);
  const values = sorted.map(pr => pr.ews);
  const n = values.length;
  const delta = n >= 2 ? values[n - 1] - values[n - 2] : 0;
  return { values, latest: n ? values[n - 1] : null, delta };
}

// ---- 時間帯 -----------------------------------------------------------

export function timeBlock(date = new Date()) {
  const h = date.getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

// ---- ラウンド間隔（可変） ----------------------------------------------
// ラウンドは固定スケジュールではなく任意のタイミングで開始される。
// 前ラウンドとの実測間隔を表示・記録するためのユーティリティ。

export function roundInterval(prevRound, currentRound) {
  if (!prevRound || !currentRound) return null;
  const prev = new Date(prevRound.started_at).getTime();
  const cur = new Date(currentRound.started_at).getTime();
  if (isNaN(prev) || isNaN(cur)) return null;
  return cur - prev;
}

export function fmtDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
}

// ---- シフトサマリ / 精度計測 -------------------------------------------

// flips: RaceFlip[]（resulted_in_intervention 未確定でよい）
// interventions: Intervention[]
// 返り値の hitFlipIds を使って呼び出し側が resulted_in_intervention を書き戻す
export function computeShiftSummary({ patients = [], rounds = [], patientRounds = [], interventions = [], flips = [] }) {
  const patientById = new Map(patients.map(p => [p.id, p]));
  const prByPatientRound = new Map(patientRounds.map(pr => [pr.patient_id + '|' + pr.round_id, pr]));

  // race フリップの的中判定: フリップ以降に同一患者へ outcome=needed の介入があったか
  const hitFlipIds = new Set();
  for (const f of flips) {
    const hit = interventions.some(iv =>
      iv.patient_id === f.patient_id &&
      iv.outcome === 'needed' &&
      new Date(iv.timestamp).getTime() >= new Date(f.at).getTime()
    );
    if (hit) hitFlipIds.add(f.id);
  }
  const flipTotal = flips.length;
  const flipHit = hitFlipIds.size;
  const precision = flipTotal ? flipHit / flipTotal : null;

  // 取り逃し: 現場発の介入のうち、その時点で patient が proactive でなかったもの
  let misses = 0;
  for (const iv of interventions) {
    if (iv.trigger_source !== 'floor') continue;
    const pr = iv.round_id ? prByPatientRound.get(iv.patient_id + '|' + iv.round_id) : null;
    const layer = pr ? pr.race_layer
      : (patientById.get(iv.patient_id) || {}).race_layer || 'reactive';
    if (layer !== 'proactive') misses++;
  }

  const count = (arr, keyFn) => {
    const m = {};
    for (const x of arr) {
      const k = keyFn(x) ?? 'unknown';
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  };

  const roundNoById = new Map(rounds.map(r => [r.id, r.round_number]));

  return {
    total_interventions: interventions.length,
    by_category: count(interventions, iv => iv.category),
    by_source: count(interventions, iv => iv.trigger_source),
    by_facility: count(interventions, iv => (patientById.get(iv.patient_id) || {}).facility),
    by_round: count(interventions, iv => iv.round_id ? 'R' + (roundNoById.get(iv.round_id) ?? '?') : 'ラウンド外'),
    by_domain: count(interventions, iv => iv.domain),
    flip_total: flipTotal,
    flip_hit: flipHit,
    precision,
    misses,
    hitFlipIds,
  };
}

// ---- 蓄積ダッシュボード用集計 -------------------------------------------

// closedShifts: {shift, summary}[] を日付順に precision 系列へ
export function precisionTrend(shiftSummaries) {
  return shiftSummaries
    .filter(s => s.summary && s.summary.precision != null)
    .sort((a, b) => (a.shift.date || '').localeCompare(b.shift.date || ''))
    .map(s => ({ date: s.shift.date, precision: s.summary.precision, flips: s.summary.flip_total }));
}

// 条件別 precision（フリップの features を軸に分解）
export function precisionBy(flips, keyFn) {
  const m = new Map();
  for (const f of flips) {
    const k = keyFn(f) ?? '不明';
    if (!m.has(k)) m.set(k, { total: 0, hit: 0 });
    const e = m.get(k);
    e.total++;
    if (f.resulted_in_intervention) e.hit++;
  }
  return [...m.entries()].map(([key, { total, hit }]) => ({
    key, total, hit, precision: total ? hit / total : null,
  })).sort((a, b) => b.total - a.total);
}

// eRN 先着率: eRN発 / (eRN発 + 現場発)
export function raceWinRate(interventions, keyFn) {
  const m = new Map();
  for (const iv of interventions) {
    if (iv.trigger_source !== 'eRN' && iv.trigger_source !== 'floor') continue;
    const k = keyFn(iv) ?? '不明';
    if (!m.has(k)) m.set(k, { ern: 0, floor: 0 });
    const e = m.get(k);
    if (iv.trigger_source === 'eRN') e.ern++; else e.floor++;
  }
  return [...m.entries()].map(([key, { ern, floor }]) => ({
    key, ern, floor, rate: (ern + floor) ? ern / (ern + floor) : null,
  })).sort((a, b) => (b.ern + b.floor) - (a.ern + a.floor));
}

// ---- CSV --------------------------------------------------------------

export function toCSV(rows, columns) {
  const esc = v => {
    if (v == null) v = '';
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const head = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(c.get(r))).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
