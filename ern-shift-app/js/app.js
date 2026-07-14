// eRN 勤務管理アプリ 本体
// ラウンドは固定スケジュールを持たない（間隔は可変）: eRN が任意のタイミングで
// 開始・終了し、実測の開始時刻・前ラウンドからの間隔を記録・表示する。

import { db, uid } from './db.js';
import * as L from './logic.js';
import * as C from './clinical.js';
import {
  $, $$, esc, fmtTime, fmtDateTime, todayStr,
  openModal, toast, confirmDialog,
  segmented, segValue, segValues, wireSegments,
  sparkline, deltaBadge, lineChart, download,
} from './ui.js';

const FACILITIES = ['KRC', 'SMM'];
const REASON_TAGS = ['呼吸悪化', '循環不安定', '感染兆候', 'デバイス長期', '鎮静が深い', '現場体制が薄い', 'トレンド不穏', 'その他'];
const DOMAIN_LABEL = { resp: '呼吸', circ: '循環', infection: '感染', sedation: '鎮静', other: 'その他' };
const SOURCE_LABEL = { eRN: 'eRN が先に検知', floor: '現場が先に検知', alert: 'アラート', device: 'デバイス起因' };

// 監視役割（旧 race layer）の日本語ラベル。proactive=先回り, reactive=待機
const ROLE = {
  proactive: { short: '先回り', long: 'eRN 先回り', desc: 'eRN が先回りして見にいく（現場が拾いにくい悪化を持つ）' },
  reactive: { short: '待機', long: '現場待機', desc: '現場が確実に拾うので、eRN は閾値アラートだけ持って待つ' },
};

// 問題点の系統（roster 一覧表示用）
const SYSTEMS = [
  { key: 'consciousness', label: '意識' },
  { key: 'resp', label: '呼吸' },
  { key: 'circ', label: '循環' },
  { key: 'infection', label: '感染' },
  { key: 'renal', label: '腎/代謝' },
];
const SEVERITY = {
  stable: { label: '安定', cls: 'sev-stable' },
  caution: { label: '注意', cls: 'sev-caution' },
  alert: { label: '要対応', cls: 'sev-alert' },
};

let settings = { ...L.DEFAULT_SETTINGS };

// ---------------------------------------------------------------- 起動

async function boot() {
  const saved = await db.get('settings', 'app');
  if (saved) settings = { ...L.DEFAULT_SETTINGS, ...saved };
  wireSegments(document.body);
  window.addEventListener('hashchange', render);
  render();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller; // 初回インストールか更新かを判別
    navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
    // 既存SWがある状態で新SWが有効化されたら一度だけ自動リロード（初回installでは reload しない）
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing) return;
      refreshing = true;
      location.reload();
    });
  }
}

function currentShiftId() {
  return localStorage.getItem('ern.currentShift') || null;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, arg] = h.split('/');
  return { view: view || 'home', arg };
}

function nav(hash) { location.hash = hash; }

// ---------------------------------------------------------------- データ取得

async function loadBundle(shiftId) {
  const [shift, rounds, patients, patientRounds, interventions, flips, allInfections] = await Promise.all([
    db.get('shifts', shiftId),
    db.byIndex('rounds', 'shift_id', shiftId),
    db.byIndex('patients', 'shift_id', shiftId),
    db.byIndex('patient_rounds', 'shift_id', shiftId),
    db.byIndex('interventions', 'shift_id', shiftId),
    db.byIndex('raceflips', 'shift_id', shiftId),
    db.all('infections'),
  ]);
  rounds.sort((a, b) => a.round_number - b.round_number);
  const pidSet = new Set(patients.map(p => p.id));
  const infections = new Map(allInfections.filter(i => pidSet.has(i.patient_id)).map(i => [i.patient_id, i]));
  return { shift, rounds, patients, patientRounds, interventions, flips, infections };
}

function activeRound(rounds) {
  return rounds.find(r => !r.ended_at) || null;
}

// 患者の「最新値」: 指定ラウンドより前（または全体）の最後の観測。無ければ登録時初期値
function latestValues(patient, prs, beforeRoundNumber = Infinity) {
  const past = prs
    .filter(pr => pr.patient_id === patient.id && pr.round_number < beforeRoundNumber)
    .sort((a, b) => a.round_number - b.round_number);
  const last = past[past.length - 1];
  if (last) return {
    ews: last.ews, race_layer: last.race_layer, note: last.note,
    vitals: last.vitals || {}, acuity: last.acuity ?? null, drs: last.drs ?? null,
    problems: last.problems || {},
  };
  return {
    ews: patient.initial_ews ?? 0, race_layer: patient.race_layer, note: '',
    vitals: {}, acuity: null, drs: null, problems: {},
  };
}

// NEWS2 サブスコアと感染トリガーから系統別の問題点(安定/注意/要対応)を自動判定
function deriveProblems(vitals, triggers, manual = {}) {
  const sub = C.news2Sub(vitals || {});
  const sysFrom = (...scores) => {
    const vals = scores.filter(v => v != null);
    if (!vals.length) return null;
    const m = Math.max(...vals);
    return m >= 3 ? 'alert' : m >= 2 ? 'caution' : m >= 1 ? 'caution' : 'stable';
  };
  const auto = {
    consciousness: sub.consciousness == null ? null : (sub.consciousness >= 3 ? 'alert' : 'stable'),
    resp: sysFrom(sub.resp_rate, sub.spo2, sub.o2),
    circ: sysFrom(sub.sbp, sub.pulse),
    infection: triggers && (triggers.device_warn || triggers.dot_warn || triggers.deesc_due) ? 'caution' : null,
    renal: null,
  };
  // 手動指定があれば優先
  const out = {};
  for (const s of SYSTEMS) out[s.key] = manual[s.key] || auto[s.key] || null;
  return out;
}

function patientRowData(patient, prs, infection, round) {
  const own = prs.filter(pr => pr.patient_id === patient.id);
  const { values, latest, delta } = L.ewsSeries(own);
  const ews = latest != null ? latest : (patient.initial_ews ?? 0);
  const triggers = L.infectionTriggers(infection, settings);
  const score = L.riskScore({ ews, delta, triggers, proactive: patient.race_layer === 'proactive' });
  const currentPR = round ? own.find(pr => pr.round_id === round.id) : null;
  const lastPR = own.slice().sort((a, b) => a.round_number - b.round_number).pop();
  const problems = deriveProblems(lastPR && lastPR.vitals, triggers, lastPR && lastPR.problems);
  return { patient, values, ews, delta, triggers, score, currentPR, own, lastPR, problems, infection };
}

// 病床順ソートキー: 拠点順（FACILITIES の並び=KRC→SMM）→ 病床番号 → ラベル
function bedSortKey(patient) {
  const facIdx = FACILITIES.indexOf(patient.facility);
  const mnum = String(patient.bed_label || '').match(/\d+/);
  return {
    fac: facIdx < 0 ? 99 : facIdx,
    num: mnum ? Number(mnum[0]) : Infinity,
    label: patient.bed_label || '',
  };
}
function compareBed(a, b) {
  const ka = bedSortKey(a.patient), kb = bedSortKey(b.patient);
  return ka.fac - kb.fac || ka.num - kb.num || ka.label.localeCompare(kb.label);
}

// ---------------------------------------------------------------- 共通レイアウト

function shell(content, active) {
  const shiftId = currentShiftId();
  const tabs = [
    ['roster', '患者リスト', shiftId ? `#/roster/${shiftId}` : '#/home'],
    ['summary', 'シフト集計', shiftId ? `#/summary/${shiftId}` : '#/home'],
    ['dashboard', '蓄積分析', '#/dashboard'],
    ['home', 'シフト', '#/home'],
    ['settings', '設定', '#/settings'],
  ];
  $('#app').innerHTML = `
    <header class="topbar">
      <h1 class="app-title">eRN Rounds</h1>
      <nav class="tabs">
        ${tabs.map(([id, label, href]) => `
          <a class="tab ${active === id ? 'on' : ''}" href="${href}">${label}</a>`).join('')}
      </nav>
    </header>
    <main id="view">${content}</main>`;
}

async function render() {
  const { view, arg } = parseHash();
  try {
    if (view === 'roster' && arg) return await renderRoster(arg);
    if (view === 'patient' && arg) return await renderPatient(arg);
    if (view === 'handoff' && arg) return await renderHandoff(arg);
    if (view === 'summary' && arg) return await renderSummary(arg);
    if (view === 'dashboard') return await renderDashboard();
    if (view === 'settings') return await renderSettings();
    return await renderHome();
  } catch (err) {
    console.error(err);
    shell(`<p class="empty">エラーが発生しました: ${esc(err.message)}</p>`, view);
  }
}

// ---------------------------------------------------------------- シフト一覧

async function renderHome() {
  const shifts = (await db.all('shifts')).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const patients = await db.all('patients');
  const countByShift = {};
  for (const p of patients) countByShift[p.shift_id] = (countByShift[p.shift_id] || 0) + 1;

  shell(`
    <section class="card">
      <h2>シフト</h2>
      <button class="btn btn-primary" id="new-shift">＋ 新規シフト作成</button>
    </section>
    <section class="card">
      <h2>過去 / 進行中のシフト</h2>
      ${shifts.length ? `<div class="list">${shifts.map(s => `
        <button class="list-row" data-open-shift="${s.id}">
          <span class="list-main">${esc(s.date)} <span class="muted">${(s.facilities || []).join('・')}</span></span>
          <span class="muted">${countByShift[s.id] || 0}名 / 既定${s.round_count}R</span>
          <span class="chip ${s.status === 'closed' ? 'chip-muted' : 'chip-open'}">${s.status === 'closed' ? '終了' : '進行中'}</span>
        </button>`).join('')}</div>` : '<p class="empty">シフトがありません。新規作成してください。</p>'}
    </section>`, 'home');

  $('#new-shift').addEventListener('click', openNewShiftModal);
  $$('[data-open-shift]').forEach(el => el.addEventListener('click', () => {
    localStorage.setItem('ern.currentShift', el.dataset.openShift);
    nav(`#/roster/${el.dataset.openShift}`);
  }));
}

function openNewShiftModal() {
  const m = openModal(`
    <div class="modal-head">新規シフト</div>
    <div class="modal-body form">
      <label>日付 <input type="date" id="sh-date" value="${todayStr()}"></label>
      <div class="form-row">
        <label>開始 <input type="time" id="sh-start" value="08:00"></label>
        <label>終了 <input type="time" id="sh-end" value="20:00"></label>
      </div>
      <label>担当拠点（複数可）
        <div class="seg" data-seg="facilities" data-multi>
          ${FACILITIES.map(f => `<button type="button" class="seg-btn on" data-value="${f}">${f}</button>`).join('')}
        </div>
      </label>
      <label>ラウンド回数（既定・目安）
        <input type="number" id="sh-rounds" min="1" max="12" value="${settings.round_count_default}">
        <span class="hint">ラウンドの間隔・実施タイミングは固定せず可変。状況に応じて任意の時刻に開始でき、回数の追加も可能。</span>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="sh-save">作成</button>
    </div>`);
  m.querySelector('#sh-save').addEventListener('click', async () => {
    const facilities = segValues(m, 'facilities');
    if (!facilities.length) return toast('拠点を選択してください');
    const shift = {
      id: uid(),
      date: m.querySelector('#sh-date').value || todayStr(),
      start_at: m.querySelector('#sh-start').value,
      end_at: m.querySelector('#sh-end').value,
      facilities,
      round_count: Math.max(1, Number(m.querySelector('#sh-rounds').value) || settings.round_count_default),
      status: 'open',
      created_at: new Date().toISOString(),
    };
    await db.put('shifts', shift);
    localStorage.setItem('ern.currentShift', shift.id);
    m.close();
    nav(`#/roster/${shift.id}`);
  });
}

// ---------------------------------------------------------------- Roster

async function renderRoster(shiftId) {
  const bundle = await loadBundle(shiftId);
  const { shift, rounds, patients, patientRounds, infections } = bundle;
  if (!shift) return renderHome();
  localStorage.setItem('ern.currentShift', shiftId);
  const readonly = shift.status === 'closed';
  const round = readonly ? null : activeRound(rounds);
  const filter = sessionStorage.getItem('ern.rosterFilter') || 'all';
  const sortMode = sessionStorage.getItem('ern.rosterSort') || 'bed';
  const rosterView = sessionStorage.getItem('ern.rosterView') || 'standard'; // standard|dx|infection|memo
  const layout = sessionStorage.getItem('ern.rosterLayout') || 'list'; // list|card

  const rows = patients.map(p => patientRowData(p, patientRounds, infections.get(p.id), round));
  // 既定は病床順（KRC303→…→SMM104）。トグルで NEWS 順（高い順）。ピン留めは常に先頭。
  rows.sort((a, b) =>
    (b.patient.pinned === true) - (a.patient.pinned === true) ||
    (sortMode === 'news'
      ? (b.ews - a.ews) || (b.score - a.score) || compareBed(a, b)
      : compareBed(a, b)));

  const confirmed = round ? rows.filter(r => r.currentPR).length : 0;
  const shown = round && filter === 'todo' ? rows.filter(r => !r.currentPR) : rows;

  // ラウンドチップ: 実測開始時刻と前ラウンドからの可変間隔を表示
  const roundChips = rounds.map((r, i) => {
    const interval = i > 0 ? L.fmtDuration(L.roundInterval(rounds[i - 1], r)) : null;
    return `<span class="chip ${!r.ended_at ? 'chip-open' : 'chip-muted'}">
      R${r.round_number} ${fmtTime(r.started_at)}${!r.ended_at ? '〜進行中' : ''}${interval ? `<span class="chip-sub">（+${interval}）</span>` : ''}
    </span>`;
  }).join('');

  shell(`
    <section class="card roster-head">
      <div class="roster-title">
        <h2>${esc(shift.date)} <span class="muted">${(shift.facilities || []).join('・')} / ${patients.length}名</span></h2>
        ${readonly ? '<span class="chip chip-muted">終了済（読み取り専用）</span>' : ''}
      </div>
      <div class="round-strip">${roundChips || '<span class="muted">ラウンド未開始</span>'}</div>
      <div class="roster-tools">
        <div class="seg" data-seg="layout">
          <button type="button" class="seg-btn ${layout === 'list' ? 'on' : ''}" data-value="list">リスト</button>
          <button type="button" class="seg-btn ${layout === 'card' ? 'on' : ''}" data-value="card">カード</button>
        </div>
        <div class="seg" data-seg="sort">
          <button type="button" class="seg-btn ${sortMode === 'bed' ? 'on' : ''}" data-value="bed">病床順</button>
          <button type="button" class="seg-btn ${sortMode === 'news' ? 'on' : ''}" data-value="news">NEWS順</button>
        </div>
        ${layout === 'list' ? `<div class="seg seg-wrap" data-seg="rview">
          ${[['standard', '標準'], ['dx', '診断サマリ'], ['infection', '感染症治療'], ['memo', 'メモ']]
            .map(([v, l]) => `<button type="button" class="seg-btn ${rosterView === v ? 'on' : ''}" data-value="${v}">${l}</button>`).join('')}
        </div>` : ''}
        <button class="btn btn-sm" id="open-calc">🧮 計算ツール</button>
        <button class="btn btn-sm" id="to-handoff">📋 申し送り一覧</button>
      </div>
      ${readonly ? '' : `
      <div class="round-ctrl">
        ${round ? `
          <div class="progress-wrap">
            <div class="progress-label">R${round.round_number} 確認 ${confirmed}/${patients.length}</div>
            <div class="progress"><div class="progress-bar" style="width:${patients.length ? Math.round(100 * confirmed / patients.length) : 0}%"></div></div>
          </div>
          <div class="seg" data-seg="filter">
            <button type="button" class="seg-btn ${filter === 'all' ? 'on' : ''}" data-value="all">全て</button>
            <button type="button" class="seg-btn ${filter === 'todo' ? 'on' : ''}" data-value="todo">未確認のみ</button>
          </div>
          <button class="btn" id="end-round">ラウンド終了</button>
        ` : `
          <button class="btn btn-primary" id="start-round">▶ ラウンド${rounds.length + 1}を開始</button>
          <span class="hint">開始タイミングは任意（間隔可変）。開始時刻を記録します。</span>
        `}
      </div>`}
    </section>

    <section class="${layout === 'card' ? 'roster-cards' : 'roster'}">
      ${shown.length
        ? (layout === 'card'
          ? shown.map(r => rosterCard(r, rounds, readonly)).join('')
          : shown.map(r => rosterRow(r, round, readonly, rosterView)).join(''))
        : `<p class="empty">${patients.length ? '未確認の患者はありません' : '患者を追加してください'}</p>`}
    </section>

    ${readonly ? '' : `
    <div class="fab-bar">
      <button class="btn" id="add-patient">＋患者</button>
      <button class="btn btn-primary" id="log-intervention">＋介入記録</button>
      <button class="btn" id="to-summary">シフト集計 →</button>
    </div>`}
  `, 'roster');

  // events（並び替え・レイアウト・計算ツールは読み取り専用でも有効）
  $('#to-handoff')?.addEventListener('click', () => nav(`#/handoff/${shiftId}`));
  $('#open-calc')?.addEventListener('click', () => openCalcModal());
  $('#view').addEventListener('segchange', e => {
    const map = { sort: 'ern.rosterSort', rview: 'ern.rosterView', filter: 'ern.rosterFilter', layout: 'ern.rosterLayout' };
    if (map[e.detail.name]) {
      sessionStorage.setItem(map[e.detail.name], e.detail.value);
      render();
    }
  });
  if (!readonly) {
    $('#add-patient')?.addEventListener('click', () => openPatientModal(shift, null));
    $('#log-intervention')?.addEventListener('click', () => openInterventionModal(bundle, round, null));
    $('#to-summary')?.addEventListener('click', () => nav(`#/summary/${shiftId}`));
    $('#start-round')?.addEventListener('click', () => startRound(shift, rounds));
    $('#end-round')?.addEventListener('click', () => endRound(bundle, round, rows));
  }

  // リスト行のタップ操作
  $$('.p-row').forEach(el => {
    const pid = el.dataset.pid;
    const rd = rows.find(r => r.patient.id === pid);
    el.addEventListener('click', async e => {
      if (e.target.closest('[data-noop]')) return;
      if (e.target.closest('[data-detail]')) return nav(`#/patient/${pid}`);
      if (readonly) return nav(`#/patient/${pid}`);
      if (e.target.closest('[data-carry]')) return carryForward(bundle, round, rd);
      if (e.target.closest('[data-race]')) return toggleRace(bundle, round, rd.patient);
      if (round) return openQuickSheet(bundle, round, rd);
      nav(`#/patient/${pid}`);
    });
  });

  // カードの自由記載（スクリブル）を blur で保存
  if (layout === 'card' && !readonly) {
    $$('.pc-card [data-field]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const pid = inp.closest('.pc-card').dataset.pid;
        const p = patients.find(x => x.id === pid);
        if (!p) return;
        const f = inp.dataset.field;
        if (f === 'line') {
          p.round_lines = p.round_lines || [];
          p.round_lines[Number(inp.dataset.idx)] = inp.value;
        } else {
          p[f] = inp.value;
        }
        await db.put('patients', p);
      });
    });
    $$('.pc-card [data-race]').forEach(btn => btn.addEventListener('click', () => {
      const pid = btn.closest('.pc-card').dataset.pid;
      const rd = rows.find(r => r.patient.id === pid);
      toggleRace(bundle, round, rd.patient);
    }));
    $$('.pc-card [data-detail]').forEach(btn => btn.addEventListener('click', () => {
      nav(`#/patient/${btn.closest('.pc-card').dataset.pid}`);
    }));
    // ✎ 大きく手書き（Scribble を広いキャンバスで）
    $$('.pc-card [data-scribble]').forEach(btn => btn.addEventListener('click', () => {
      const card = btn.closest('.pc-card');
      const pid = card.dataset.pid;
      const p = patients.find(x => x.id === pid);
      if (!p) return;
      const field = btn.dataset.sfield;
      const idx = btn.dataset.sidx != null ? Number(btn.dataset.sidx) : null;
      const cur = field === 'line' ? ((p.round_lines || [])[idx] || '') : (p[field] || '');
      const titles = { memo: '申し送り・備考', shift_summary: '勤務サマリ', line: `R${idx + 1} 1行サマリー` };
      openScribbleSheet(`${p.bed_label}　${titles[field] || ''}`, cur, async (val) => {
        if (field === 'line') { p.round_lines = p.round_lines || []; p.round_lines[idx] = val; }
        else p[field] = val;
        await db.put('patients', p);
        render();
      });
    }));
  }
}

// 大きな手書きキャンバス（Apple Pencil の Scribble を広い面で使う）
function openScribbleSheet(title, value, onSave) {
  const m = openModal(`
    <div class="modal-head">✎ ${esc(title)}</div>
    <div class="modal-body">
      <textarea class="scribble-canvas" placeholder="Apple Pencil でここに直接手書き（Scribble）／キーボード入力も可">${esc(value || '')}</textarea>
      <p class="hint">Scribble は iPad の「設定 → Apple Pencil → 書いて入力」をオンにすると使えます。この欄に直接書くと文字に変換されます。</p>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="sc-save">保存</button>
    </div>`);
  const ta = m.querySelector('.scribble-canvas');
  setTimeout(() => ta.focus(), 50);
  m.querySelector('#sc-save').addEventListener('click', () => {
    const v = ta.value.trim();
    m.close();
    onSave(v);
  });
}

// カードビュー: 紙運用に近い自由記載カード（ラウンド1行サマリ×6＋備考＋Summary）
function rosterCard(r, rounds, readonly) {
  const p = r.patient;
  const lines = p.round_lines || [];
  const scoreLabel = (r.lastPR && r.lastPR.vitals && Object.keys(r.lastPR.vitals).length) ? 'NEWS2' : 'スコア';
  const ro = readonly ? 'readonly' : '';
  const penBtn = (field, idx) => ro ? '' :
    `<button class="btn btn-icon pen-btn" data-scribble data-sfield="${field}"${idx != null ? ` data-sidx="${idx}"` : ''} title="大きく手書き（Scribble）">✎</button>`;
  const lineRows = Array.from({ length: 6 }, (_, i) => {
    const rd = rounds[i];
    const label = rd ? `R${rd.round_number} ${fmtTime(rd.started_at)}` : `R${i + 1}`;
    return `<div class="pc-line">
      <span class="pc-rlabel">${label}</span>
      <input type="text" class="pc-lineinput" data-field="line" data-idx="${i}" value="${esc(lines[i] || '')}" placeholder="1行サマリー（Scribble可）" ${ro}>
      ${penBtn('line', i)}
    </div>`;
  }).join('');
  return `
  <div class="pc-card ${p.race_layer === 'proactive' ? 'proactive' : ''}" data-pid="${p.id}">
    <div class="pc-head">
      <span class="fac fac-${esc(p.facility)}">${esc(p.facility)}</span>
      <span class="pc-bed">${p.pinned ? '📌 ' : ''}${esc(p.bed_label)}</span>
      <button class="race-toggle ${p.race_layer}" data-race title="監視役割を切替">${ROLE[p.race_layer].short}</button>
      <span class="pc-score muted">${scoreLabel} ${r.ews}</span>
      <button class="btn btn-icon" data-detail title="詳細（NEWS2・呼吸器・感染）">ⓘ</button>
    </div>
    <div class="pc-notewrap">
      <textarea class="pc-notes scribble" data-field="memo" placeholder="申し送り・備考（Apple Pencil で直接手書き＝Scribble 可）" ${ro}>${esc(p.memo || '')}</textarea>
      ${penBtn('memo')}
    </div>
    <div class="pc-lines">${lineRows}</div>
    <div class="pc-line">
      <span class="pc-rlabel">Summary</span>
      <input type="text" class="pc-summary" data-field="shift_summary" value="${esc(p.shift_summary || '')}" placeholder="勤務サマリ（Scribble可）" ${ro}>
      ${penBtn('shift_summary')}
    </div>
  </div>`;
}

function problemChips(problems) {
  // 注意/要対応の系統のみ表示（安定・未評価は省いて視認性を上げる）
  const active = SYSTEMS
    .map(s => ({ label: s.label, sev: problems[s.key] }))
    .filter(x => x.sev === 'caution' || x.sev === 'alert');
  if (!active.length) return '<span class="prob-none muted">—</span>';
  return active.map(x =>
    `<span class="prob-chip ${SEVERITY[x.sev].cls}">${x.label}</span>`).join('');
}

// 感染症治療の1行サマリ（原因菌 / 培養提出日・状況 / 抗菌薬 何を いつから どれくらい）
function infectionSummaryHTML(infection) {
  if (!infection) return '<span class="muted">感染情報なし</span>';
  const orgs = organismNames(infection.organisms) || '—';
  const cul = `${cultureLabel(infection.culture_status)}${infection.culture_date ? `（提出 ${infection.culture_date}）` : ''}`;
  const ams = (infection.antimicrobials || []).filter(a => !a.end_date);
  const amText = ams.length
    ? ams.map(a => `${esc(a.name)}（${esc(a.start_date)}〜 ${L.dotDays(a)}日目・${a.spectrum === 'broad' ? '広域' : '狭域'}）`).join(' ／ ')
    : '投与なし';
  return `<span class="io-k">原因菌</span> ${esc(orgs)}　<span class="io-k">培養</span> ${esc(cul)}<br>
    <span class="io-k">抗菌薬</span> ${amText}`;
}

function rosterExtraRow(r, view) {
  const p = r.patient;
  if (view === 'dx') {
    return `<div class="p-extra p-dx" data-detail>${esc(p.dx_summary || '診断サマリ未入力')}</div>`;
  }
  if (view === 'infection') {
    return `<div class="p-extra p-inf" data-detail>${infectionSummaryHTML(r.infection)}</div>`;
  }
  if (view === 'memo') {
    const memo = p.memo || (r.lastPR && r.lastPR.note) || '';
    return `<div class="p-extra p-memo" data-detail>${memo ? esc(memo) : '<span class="muted">メモなし</span>'}</div>`;
  }
  return '';
}

function rosterRow(r, round, readonly, view) {
  const p = r.patient;
  const t = r.triggers;
  const scoreLabel = (r.lastPR && r.lastPR.vitals && Object.keys(r.lastPR.vitals).length) ? 'NEWS2' : 'スコア';
  const status = !round ? '' :
    !r.currentPR ? `<span class="chip chip-todo">未確認</span>` :
    r.currentPR.entry_status === 'carried' ? `<span class="chip chip-muted">変化なし</span>` :
      `<span class="chip chip-updated">更新済</span>`;
  const flags = [
    t.device_warn ? '<span class="flag flag-warn" title="デバイス留置日数の警告">デバイス</span>' : '',
    t.dot_warn ? '<span class="flag flag-warn" title="抗菌薬投与日数(DOT)の警告">DOT</span>' : '',
    t.deesc_due ? '<span class="flag flag-due" title="狭域化(de-escalation)の検討時期">狭域化</span>' : '',
  ].join('');
  const carryBtn = round && !readonly && !r.currentPR
    ? (p.race_layer === 'proactive'
      ? '<span class="chip chip-must">要確認</span>'
      : `<button class="btn btn-sm" data-carry data-noop-x>変化なし</button>`)
    : '';
  return `
  <div class="p-row ${p.race_layer === 'proactive' ? 'proactive' : ''}" data-pid="${p.id}">
    <span class="fac fac-${esc(p.facility)}">${esc(p.facility)}</span>
    <div class="bed">
      <div class="bed-label">${p.pinned ? '📌 ' : ''}${esc(p.bed_label)}</div>
      <div class="anon muted">${esc(p.anon_id)}</div>
    </div>
    <button class="race-toggle ${p.race_layer}" data-race title="監視役割を切替（先回り／待機）">
      ${ROLE[p.race_layer].short}
    </button>
    <div class="trend">
      ${sparkline(r.values.length ? r.values : [r.ews])}
      <span class="ews-now">${scoreLabel} ${r.ews}</span>${deltaBadge(r.values.length >= 2 ? r.delta : null)}
    </div>
    <div class="problems">${problemChips(r.problems)}</div>
    <div class="flags">${flags}</div>
    <div class="row-status">${status}${carryBtn}</div>
    <button class="btn btn-icon" data-detail title="患者詳細">ⓘ</button>
    ${rosterExtraRow(r, view)}
  </div>`;
}

// ---------------------------------------------------------------- ラウンド運用

async function startRound(shift, rounds) {
  if (rounds.length >= shift.round_count) {
    const ok = await confirmDialog(
      `既定ラウンド数（${shift.round_count}回）に達しています。追加ラウンドを開始しますか？（回数・間隔は可変）`,
      { okLabel: '開始する' });
    if (!ok) return;
  }
  await db.put('rounds', {
    id: uid(),
    shift_id: shift.id,
    round_number: rounds.length + 1,
    started_at: new Date().toISOString(),
    ended_at: null,
  });
  toast(`ラウンド${rounds.length + 1}を開始しました`);
  render();
}

async function endRound(bundle, round, rows) {
  const todo = rows.filter(r => !r.currentPR);
  const proTodo = todo.filter(r => r.patient.race_layer === 'proactive');
  if (proTodo.length) {
    return openModal(`
      <div class="modal-head">未確認の「先回り」患者があります</div>
      <div class="modal-body">
        <p>「先回り」患者は「変化なし」一括確定できません。開いて更新してください。</p>
        <ul>${proTodo.map(r => `<li>${esc(r.patient.bed_label)}（${esc(r.patient.anon_id)}）</li>`).join('')}</ul>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close>戻る</button></div>`);
  }
  if (todo.length) {
    const ok = await confirmDialog(
      `未確認の「待機」患者が ${todo.length} 名います。前回値を引き継いで（変化なし扱い）ラウンドを終了しますか？`,
      { okLabel: '引き継いで終了' });
    if (!ok) return;
    for (const r of todo) await carryForward(bundle, round, r, { silent: true });
  }
  round.ended_at = new Date().toISOString();
  await db.put('rounds', round);
  toast(`ラウンド${round.round_number}を終了しました`);
  render();
}

async function carryForward(bundle, round, rowData, { silent = false } = {}) {
  const p = rowData.patient;
  if (p.race_layer === 'proactive') return toast('「先回り」患者は開いて更新してください');
  if (rowData.currentPR) return;
  const prev = latestValues(p, bundle.patientRounds, round.round_number);
  const triggers = L.infectionTriggers(bundle.infections.get(p.id), settings);
  await db.put('patient_rounds', {
    id: uid(),
    patient_id: p.id,
    round_id: round.id,
    shift_id: bundle.shift.id,
    round_number: round.round_number,
    ews: prev.ews,
    race_layer: p.race_layer,
    infection_trigger_snapshot: triggers,
    entry_status: 'carried',
    note: '',
    vitals: prev.vitals || {},
    acuity: prev.acuity ?? null,
    drs: prev.drs ?? null,
    problems: prev.problems || {},
    at: new Date().toISOString(),
  });
  if (!silent) render();
}

// --- NEWS2 バイタル入力ブロック（教育ガイド付き） ---

const VITAL_FIELDS = [
  { id: 'resp_rate', g: 'resp_rate', ph: '例: 18', step: 1 },
  { id: 'spo2', g: 'spo2', ph: '例: 97', step: 1 },
  { id: 'sbp', g: 'sbp', ph: '例: 120', step: 1 },
  { id: 'pulse', g: 'pulse', ph: '例: 78', step: 1 },
  { id: 'temp', g: 'temp', ph: '例: 36.8', step: 0.1 },
];

function vitalsBlock(v = {}) {
  const num = x => (x == null || x === '' ? '' : x);
  const field = f => {
    const g = C.NEWS2_GUIDE[f.g];
    return `
      <div class="vital">
        <label class="vital-label" title="${esc(g.note)}">${g.label}<span class="vunit">${g.unit}</span></label>
        <input type="number" step="${f.step}" inputmode="decimal" class="vital-in" data-vital="${f.id}"
          value="${num(v[f.id])}" placeholder="${f.ph}">
        <span class="vital-sub muted">正常 ${esc(g.normal)}</span>
      </div>`;
  };
  return `
    <div class="vitals-grid">
      ${VITAL_FIELDS.map(field).join('')}
      <div class="vital">
        <label class="vital-label" title="${esc(C.NEWS2_GUIDE.o2.note)}">酸素投与</label>
        ${segmented('on_oxygen', [{ value: '0', label: '室内気' }, { value: '1', label: '酸素' }], v.on_oxygen ? '1' : '0')}
        <span class="vital-sub muted">SpO₂目標
          <button type="button" class="mini-toggle" data-spo2scale>${v.spo2_scale === 2 ? 'Scale2(88-92%)' : 'Scale1(≥96%)'}</button>
        </span>
      </div>
      <div class="vital vital-wide">
        <label class="vital-label" title="${esc(C.NEWS2_GUIDE.consciousness.note)}">意識 ACVPU</label>
        ${segmented('acvpu', [
          { value: 'A', label: 'A清明' }, { value: 'C', label: 'C錯乱' },
          { value: 'V', label: 'V呼名' }, { value: 'P', label: 'P痛み' }, { value: 'U', label: 'U無反応' },
        ], v.consciousness || 'A')}
      </div>
    </div>
    <div class="news2-panel" id="news2-panel"></div>`;
}

function readVitals(m) {
  const v = {};
  m.querySelectorAll('[data-vital]').forEach(inp => {
    if (inp.value !== '') v[inp.dataset.vital] = Number(inp.value);
  });
  v.on_oxygen = segValue(m, 'on_oxygen') === '1';
  v.consciousness = segValue(m, 'acvpu') || 'A';
  v.spo2_scale = m._spo2scale || 1;
  return v;
}

function news2PanelHTML(vitals) {
  const r = C.news2(vitals);
  if (r.measured === 0) {
    return `<div class="news2-empty muted">バイタルを入力すると NEWS2 が自動採点されます</div>`;
  }
  const chips = [
    ['resp_rate', '呼吸数'], ['spo2', 'SpO₂'], ['o2', '酸素'],
    ['sbp', 'SBP'], ['pulse', 'HR'], ['consciousness', '意識'], ['temp', '体温'],
  ].map(([k, lbl]) => {
    const s = r.sub[k];
    if (s == null) return '';
    const cls = s >= 3 ? 'sc3' : s >= 2 ? 'sc2' : s >= 1 ? 'sc1' : 'sc0';
    return `<span class="sc-chip ${cls}">${lbl} ${s}</span>`;
  }).join('');
  const bandCls = { high: 'band-high', medium: 'band-medium', low: 'band-low', zero: 'band-zero' }[r.band] || '';
  return `
    <div class="news2-head ${bandCls}">
      <span class="news2-total">NEWS2 <b>${r.total}</b></span>
      <span class="news2-band">${{ high: '高リスク', medium: '中リスク', low: '低リスク', zero: '安定' }[r.band] || ''}${r.redFlag ? '・単一項目3点(red)' : ''}</span>
    </div>
    <div class="sc-chips">${chips}</div>
    <div class="news2-action">${esc(r.action)}</div>`;
}

// クイックシート: 前回値プリフィル・差分のみ編集
function openQuickSheet(bundle, round, rowData) {
  const p = rowData.patient;
  const existing = rowData.currentPR;
  const prev = existing
    ? { ews: existing.ews, race_layer: existing.race_layer, note: existing.note,
        vitals: existing.vitals || {}, acuity: existing.acuity ?? null, drs: existing.drs ?? null }
    : latestValues(p, bundle.patientRounds, round.round_number);

  const m = openModal(`
    <div class="modal-head">R${round.round_number} ${esc(p.bed_label)} <span class="muted">${esc(p.anon_id)} / ${esc(p.facility)}</span></div>
    <div class="modal-body form">
      <fieldset class="vfs"><legend>バイタル → NEWS2 自動採点</legend>
        ${vitalsBlock(prev.vitals || {})}
      </fieldset>

      <fieldset class="vfs"><legend>PHILIPS eCareManager 指標（任意）</legend>
        <div class="form-row">
          <label>Acuity（重症度）<input type="number" step="0.1" id="qs-acuity" inputmode="decimal" value="${prev.acuity ?? ''}" placeholder="eCM 値">
            <span class="hint">eCM の重症度スコア。高いほど重症・要注視。</span></label>
          <label>DRS（退室準備度）<input type="number" step="0.1" id="qs-drs" inputmode="decimal" value="${prev.drs ?? ''}" placeholder="eCM 値">
            <span class="hint">Discharge Readiness Score。高いほど退室に近い。</span></label>
        </div>
      </fieldset>

      <label>監視役割
        ${segmented('race', [
          { value: 'proactive', label: '先回り（eRNが先に見る）' },
          { value: 'reactive', label: '待機（現場に任せ閾値監視）' },
        ], prev.race_layer)}
      </label>
      <div id="flip-extra" class="flip-extra hidden">
        <label>先回りに切替えた理由（複数可）
          <div class="seg seg-wrap" data-seg="reasons" data-multi>
            ${REASON_TAGS.map(t => `<button type="button" class="seg-btn" data-value="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
        </label>
        <label>現場体制メモ（任意）<input type="text" id="qs-floorctx" placeholder="例: 夜勤2名・新人あり"></label>
      </div>
      <label>メモ（任意・Scribble可）<textarea id="qs-note" class="scribble" rows="3">${esc(prev.note || '')}</textarea></label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="qs-save">保存（更新済）</button>
    </div>`);

  m._spo2scale = prev.vitals && prev.vitals.spo2_scale === 2 ? 2 : 1;
  const refreshPanel = () => {
    m.querySelector('#news2-panel').innerHTML = news2PanelHTML(readVitals(m));
  };
  refreshPanel();

  m.querySelectorAll('[data-vital]').forEach(inp => inp.addEventListener('input', refreshPanel));
  m.querySelector('[data-spo2scale]')?.addEventListener('click', e => {
    m._spo2scale = m._spo2scale === 2 ? 1 : 2;
    e.target.textContent = m._spo2scale === 2 ? 'Scale2(88-92%)' : 'Scale1(≥96%)';
    refreshPanel();
  });

  m.addEventListener('segchange', e => {
    if (e.detail.name === 'race') {
      const flipping = prev.race_layer === 'reactive' && e.detail.value === 'proactive';
      m.querySelector('#flip-extra').classList.toggle('hidden', !flipping);
    }
    if (e.detail.name === 'on_oxygen' || e.detail.name === 'acvpu') refreshPanel();
  });

  m.querySelector('#qs-save').addEventListener('click', async () => {
    const vitals = readVitals(m);
    const n2 = C.news2(vitals);
    // スコア: バイタルが入っていれば NEWS2 総点、無ければ前回値を維持
    const ews = n2.measured > 0 ? n2.total : (prev.ews ?? 0);
    const race = segValue(m, 'race') || prev.race_layer;
    const note = m.querySelector('#qs-note').value.trim();
    const acuity = m.querySelector('#qs-acuity').value === '' ? null : Number(m.querySelector('#qs-acuity').value);
    const drs = m.querySelector('#qs-drs').value === '' ? null : Number(m.querySelector('#qs-drs').value);
    const flipped = prev.race_layer === 'reactive' && race === 'proactive';

    const triggers = L.infectionTriggers(bundle.infections.get(p.id), settings);
    await db.put('patient_rounds', {
      id: existing ? existing.id : uid(),
      patient_id: p.id,
      round_id: round.id,
      shift_id: bundle.shift.id,
      round_number: round.round_number,
      ews,
      race_layer: race,
      infection_trigger_snapshot: triggers,
      entry_status: 'updated',
      note,
      vitals,
      acuity,
      drs,
      problems: deriveProblems(vitals, triggers, (existing && existing.problems) || {}),
      at: new Date().toISOString(),
    });
    if (race !== p.race_layer) {
      p.race_layer = race;
      await db.put('patients', p);
    }
    if (flipped) {
      await recordRaceFlip(bundle, p, round, {
        reason_tags: segValues(m, 'reasons'),
        floor_context: m.querySelector('#qs-floorctx').value.trim(),
        ews,
      });
    }
    m.close();
    render();
  });
}

// roster 上の監視役割トグル（先回り／待機）
async function toggleRace(bundle, round, patient) {
  if (patient.race_layer === 'proactive') {
    const ok = await confirmDialog(`${patient.bed_label} を「待機」に戻しますか？`, { okLabel: '戻す' });
    if (!ok) return;
    patient.race_layer = 'reactive';
    await db.put('patients', patient);
    return render();
  }
  // 待機 → 先回り: 切替イベントとして理由タグ付きで記録
  const m = openModal(`
    <div class="modal-head">${esc(patient.bed_label)} を「先回り」に切替</div>
    <div class="modal-body form">
      <label>選定理由（複数可）
        <div class="seg seg-wrap" data-seg="reasons" data-multi>
          ${REASON_TAGS.map(t => `<button type="button" class="seg-btn" data-value="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>
      </label>
      <label>現場体制メモ（任意）<input type="text" id="rf-floorctx" placeholder="例: 夜勤2名・新人あり"></label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="rf-save">切替を記録</button>
    </div>`);
  m.querySelector('#rf-save').addEventListener('click', async () => {
    patient.race_layer = 'proactive';
    await db.put('patients', patient);
    const prs = bundle.patientRounds.filter(pr => pr.patient_id === patient.id);
    const { latest } = L.ewsSeries(prs);
    await recordRaceFlip(bundle, patient, round, {
      reason_tags: segValues(m, 'reasons'),
      floor_context: m.querySelector('#rf-floorctx').value.trim(),
      ews: latest != null ? latest : (patient.initial_ews ?? 0),
    });
    m.close();
    render();
  });
}

// reactive→proactive フリップ: 選定時点の患者特徴を自動スナップショット
async function recordRaceFlip(bundle, patient, round, { reason_tags, floor_context, ews }) {
  const infection = bundle.infections.get(patient.id);
  const dd = L.deviceDays(infection && infection.devices);
  const now = new Date();
  await db.put('raceflips', {
    id: uid(),
    patient_id: patient.id,
    shift_id: bundle.shift.id,
    round_id: round ? round.id : null,
    round_number: round ? round.round_number : null,
    from: 'reactive',
    to: 'proactive',
    at: now.toISOString(),
    features: {
      ews,
      cvc_days: dd.cvc,
      foley_days: dd.foley,
      vent_days: dd.vent,
      dot_max: L.maxDot(infection),
      sedation: !!patient.sedation,
      facility: patient.facility,
      time_block: L.timeBlock(now),
      floor_context: floor_context || '',
    },
    reason_tags: reason_tags || [],
    resulted_in_intervention: null, // シフト終了時に突合
  });
  toast('役割切替（先回り化）を記録しました');
}

// ---------------------------------------------------------------- 患者追加 / 編集

function openPatientModal(shift, patient) {
  const p = patient || {};
  const m = openModal(`
    <div class="modal-head">${patient ? '患者情報を編集' : '患者を追加'}</div>
    <div class="modal-body form">
      <label>拠点 ${segmented('facility', shift.facilities.map(f => ({ value: f, label: f })), p.facility || shift.facilities[0])}</label>
      <div class="form-row">
        <label>病床 <input type="text" id="pt-bed" value="${esc(p.bed_label || '')}" placeholder="例: ICU-3"></label>
        <label>匿名ID <input type="text" id="pt-anon" value="${esc(p.anon_id || '')}" placeholder="例: P-01"></label>
      </div>
      <div class="form-row">
        <label>年齢 <input type="number" id="pt-age" inputmode="numeric" value="${p.age ?? ''}"></label>
        <label>性別 ${segmented('sex', [{ value: 'male', label: '男性' }, { value: 'female', label: '女性' }], p.sex || 'male')}</label>
      </div>
      <div class="form-row">
        <label>身長 (cm) <input type="number" id="pt-height" step="0.1" inputmode="decimal" value="${p.height_cm ?? ''}" placeholder="例: 165">
          <span class="hint">理想体重(IBW)・一回換気量計算に使用</span></label>
        <label>体重 (kg) <input type="number" id="pt-weight" step="0.1" inputmode="decimal" value="${p.weight_kg ?? ''}" placeholder="例: 60"></label>
      </div>
      ${patient ? '' : `<label>初期スコア（NEWS2未入力時の目安）<input type="number" id="pt-ews" inputmode="numeric" min="0" max="20" value="${p.initial_ews ?? 0}"></label>`}
      <label>診断サマリ（Scribble可）<textarea id="pt-dx" class="scribble" rows="2">${esc(p.dx_summary || '')}</textarea></label>
      <label>鎮静 ${segmented('sedation', [{ value: '1', label: 'あり' }, { value: '0', label: 'なし' }], p.sedation ? '1' : '0')}</label>
      <fieldset><legend>治療サポート（申し送りに表示）</legend>
        <div class="dev-row">
          <span class="dev-label">持続血液浄化</span>
          ${segmented('crrt', [{ value: '1', label: 'CRRT中' }, { value: '0', label: 'なし' }], (p.support && p.support.crrt) ? '1' : '0')}
        </div>
        <label>補助循環
          ${segmented('mcs', [
            { value: 'none', label: 'なし' }, { value: 'IABP', label: 'IABP' },
            { value: 'VA-ECMO', label: 'VA-ECMO' }, { value: 'VV-ECMO', label: 'VV-ECMO' },
            { value: 'Impella', label: 'Impella' },
          ], (p.support && p.support.mcs) || 'none')}
        </label>
        <span class="hint">人工呼吸器の詳細は患者詳細の「人工呼吸器」で設定します。</span>
      </fieldset>
      <label>前勤務帯からの懸念点（Scribble可）<textarea id="pt-concerns" class="scribble" rows="2">${esc(p.concerns || '')}</textarea></label>
      <label>申し送りTOPIC（Scribble可）<textarea id="pt-topics" class="scribble" rows="2">${esc(p.handoff_topics || '')}</textarea></label>
      <label>メモ（Scribble可）<textarea id="pt-memo" class="scribble" rows="2">${esc(p.memo || '')}</textarea></label>
      ${patient ? '' : `<label>初期の監視役割 ${segmented('race0', [
        { value: 'reactive', label: '待機（現場に任せる）' },
        { value: 'proactive', label: '先回り（eRNが先に見る）' },
      ], 'reactive')}</label>`}
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="pt-save">保存</button>
    </div>`);
  m.querySelector('#pt-save').addEventListener('click', async () => {
    const bed = m.querySelector('#pt-bed').value.trim();
    const anon = m.querySelector('#pt-anon').value.trim();
    if (!bed && !anon) return toast('病床か匿名IDを入力してください');
    const numOf = id => m.querySelector(id).value === '' ? null : Number(m.querySelector(id).value);
    const rec = {
      id: p.id || uid(),
      shift_id: shift.id,
      facility: segValue(m, 'facility'),
      bed_label: bed || '-',
      anon_id: anon || '-',
      age: m.querySelector('#pt-age').value ? Number(m.querySelector('#pt-age').value) : null,
      sex: segValue(m, 'sex') || 'male',
      height_cm: numOf('#pt-height'),
      weight_kg: numOf('#pt-weight'),
      dx_summary: m.querySelector('#pt-dx').value.trim(),
      sedation: segValue(m, 'sedation') === '1',
      support: { crrt: segValue(m, 'crrt') === '1', mcs: segValue(m, 'mcs') || 'none' },
      concerns: m.querySelector('#pt-concerns').value.trim(),
      handoff_topics: m.querySelector('#pt-topics').value.trim(),
      memo: m.querySelector('#pt-memo').value.trim(),
      initial_ews: patient ? p.initial_ews : (Number(m.querySelector('#pt-ews').value) || 0),
      race_layer: patient ? p.race_layer : (segValue(m, 'race0') || 'reactive'),
      ventilator: p.ventilator || null,
      pinned: p.pinned || false,
      created_at: p.created_at || new Date().toISOString(),
    };
    await db.put('patients', rec);
    m.close();
    render();
  });
}

// ---------------------------------------------------------------- 介入クイックログ

function openInterventionModal(bundle, round, defaultPatientId) {
  const { patients, shift } = bundle;
  if (!patients.length) return toast('先に患者を追加してください');
  const m = openModal(`
    <div class="modal-head">介入クイックログ ${round ? `<span class="muted">R${round.round_number} に紐付け</span>` : '<span class="muted">ラウンド外</span>'}</div>
    <div class="modal-body form">
      <label>患者
        <select id="iv-patient">
          ${patients.map(p => `<option value="${p.id}" ${p.id === defaultPatientId ? 'selected' : ''}>${esc(p.bed_label)}（${esc(p.anon_id)} / ${esc(p.facility)}）</option>`).join('')}
        </select>
      </label>
      <label>誰が先に気づいたか ${segmented('source', [
        { value: 'eRN', label: 'eRNが先' }, { value: 'floor', label: '現場が先' },
        { value: 'alert', label: 'アラート' }, { value: 'device', label: 'デバイス起因' },
      ], 'eRN')}</label>
      <label>区分 ${segmented('category', [
        { value: 'proactive', label: '先回り' }, { value: 'reactive', label: '待機からの反応' },
      ], 'proactive')}</label>
      <label>領域 ${segmented('domain', Object.entries(DOMAIN_LABEL).map(([v, l]) => ({ value: v, label: l })), 'resp')}</label>
      <label>結果 ${segmented('outcome', [
        { value: 'needed', label: '介入要だった' }, { value: 'miss', label: '空振り' },
      ], 'needed')}</label>
      <label>内容（任意・Scribble可）<textarea id="iv-note" class="scribble" rows="2"></textarea></label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="iv-save">記録</button>
    </div>`);
  m.querySelector('#iv-save').addEventListener('click', async () => {
    await db.put('interventions', {
      id: uid(),
      patient_id: m.querySelector('#iv-patient').value,
      round_id: round ? round.id : null,
      shift_id: shift.id,
      timestamp: new Date().toISOString(),
      trigger_source: segValue(m, 'source'),
      category: segValue(m, 'category'),
      domain: segValue(m, 'domain'),
      note: m.querySelector('#iv-note').value.trim(),
      outcome: segValue(m, 'outcome'),
    });
    m.close();
    toast('介入を記録しました');
    render();
  });
}

// ---------------------------------------------------------------- 患者詳細（精査層）

async function renderPatient(patientId) {
  const patient = await db.get('patients', patientId);
  if (!patient) return renderHome();
  const bundle = await loadBundle(patient.shift_id);
  const { shift, rounds, patientRounds, interventions } = bundle;
  const readonly = shift.status === 'closed';
  const infection = bundle.infections.get(patientId) || emptyInfection(patientId);
  const own = patientRounds.filter(pr => pr.patient_id === patientId).sort((a, b) => a.round_number - b.round_number);
  const ivs = interventions.filter(iv => iv.patient_id === patientId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const dd = L.deviceDays(infection.devices);
  const triggers = L.infectionTriggers(infection, settings);
  const roundNoById = new Map(rounds.map(r => [r.id, r.round_number]));
  const lastVitals = (own.slice().reverse().find(pr => pr.vitals && Object.keys(pr.vitals).length) || {}).vitals;

  shell(`
    <section class="card">
      <div class="detail-head">
        <button class="btn" id="back">← 患者リスト</button>
        <h2>${esc(patient.bed_label)} <span class="muted">${esc(patient.anon_id)} / ${esc(patient.facility)} / ${patient.age != null ? patient.age + '歳' : '年齢-'} / ${patient.sex === 'female' ? '女性' : '男性'}</span></h2>
        <div class="detail-actions">
          <button class="btn" id="calc-pt">🧮 計算</button>
          ${readonly ? '' : `
          <button class="btn" id="pin">${patient.pinned ? '📌 ピン解除' : '📌 ピン留め'}</button>
          <button class="btn" id="edit-pt">編集</button>`}
        </div>
      </div>
      <p class="dx">${esc(patient.dx_summary || '診断サマリ未入力')} / 鎮静${patient.sedation ? 'あり' : 'なし'}
        ${patient.height_cm ? ` / ${patient.height_cm}cm` : ''}${patient.weight_kg ? ` ${patient.weight_kg}kg` : ''}
        ${patient.height_cm ? ` / IBW ${Math.round(C.idealBodyWeight(patient.height_cm, patient.sex))}kg` : ''}</p>
      <div class="race-line">
        <span>監視役割:</span>
        <button class="race-toggle ${patient.race_layer}" id="race-toggle" ${readonly ? 'disabled' : ''}>
          ${ROLE[patient.race_layer].long}
        </button>
        <span class="muted">${ROLE[patient.race_layer].desc}</span>
      </div>
      ${treatmentOptions(patient).length ? `<p class="dx"><span class="io-k">治療</span> ${treatmentOptions(patient).map(esc).join(' ／ ')}</p>` : ''}
      ${patient.concerns ? `<p class="dx"><span class="io-k">前帯懸念</span> ${esc(patient.concerns)}</p>` : ''}
      ${patient.handoff_topics ? `<p class="dx"><span class="io-k">TOPIC</span> ${esc(patient.handoff_topics)}</p>` : ''}
      ${patient.memo ? `<p class="dx"><span class="io-k">メモ</span> ${esc(patient.memo)}</p>` : ''}
    </section>

    <section class="card">
      <h3>NEWS2 / スコア ラウンド推移</h3>
      ${own.length ? `
        <div class="ews-big">${sparkline(own.map(pr => pr.ews), { w: 320, h: 60 })}</div>
        <div class="table-scroll"><table class="table">
          <thead><tr><th>R</th><th>時刻</th><th>NEWS2</th><th>Acuity</th><th>DRS</th><th>役割</th><th>入力</th><th>メモ</th></tr></thead>
          <tbody>${own.map(pr => `
            <tr><td>R${pr.round_number}</td><td>${fmtTime(pr.at)}</td><td>${pr.ews}</td>
            <td>${pr.acuity ?? '—'}</td><td>${pr.drs ?? '—'}</td>
            <td>${ROLE[pr.race_layer].short}</td>
            <td>${pr.entry_status === 'carried' ? '変化なし' : '更新'}</td>
            <td class="note-cell">${esc(pr.note || '')}</td></tr>`).join('')}
          </tbody>
        </table></div>` : `<p class="empty">まだ観測がありません</p>`}
    </section>

    ${ventilatorCard(patient, lastVitals, readonly)}

    <section class="card">
      <h3>感染治療状況
        ${triggers.device_warn ? '<span class="flag flag-warn">デバイス</span>' : ''}
        ${triggers.dot_warn ? '<span class="flag flag-warn">DOT</span>' : ''}
        ${triggers.deesc_due ? '<span class="flag flag-due">狭域化</span>' : ''}
      </h3>
      <div class="inf-grid">
        <div><span class="muted">感染源/疑い部位:</span> ${esc(infection.source || '—')}</div>
        <div><span class="muted">グラム染色:</span> ${esc(gramLabel(infection.gram_stain) || '—')}</div>
        <div><span class="muted">起因菌:</span> ${esc(organismNames(infection.organisms) || '—')}</div>
        <div><span class="muted">培養:</span> ${cultureLabel(infection.culture_status)}</div>
        <div><span class="muted">狭域化(de-escalation):</span> ${deescLabel(infection.deescalation)}</div>
        <div><span class="muted">腎機能:</span> ${infection.crcl != null ? `CrCl ${infection.crcl}` : '—'}${infection.crrt ? ' / CRRT中' : ''}</div>
        <div><span class="muted">デバイス留置日数:</span>
          CVC ${dd.cvc || '—'} / 尿カテ ${dd.foley || '—'} / 人工呼吸 ${dd.vent || '—'}</div>
      </div>
      ${(infection.antimicrobials || []).length ? `
      <div class="table-scroll"><table class="table">
        <thead><tr><th>抗菌薬</th><th>開始</th><th>DOT</th><th>スペクトラム</th><th></th></tr></thead>
        <tbody>${infection.antimicrobials.map((am, i) => {
          const k = C.findAntimicrobial(am.name);
          return `<tr><td>${esc(am.name)}${k ? `<span class="am-jp muted">${esc(k.jp)}・${esc(k.cls)}</span>` : ''}</td>
          <td>${esc(am.start_date)}</td>
          <td>${am.end_date ? `${L.dotDays(am)}（終了）` : L.dotDays(am)}</td>
          <td>${am.spectrum === 'broad' ? '広域' : '狭域'}${k ? `<span class="am-note muted" title="${esc(k.note)}">ⓘ</span>` : ''}</td>
          <td>${readonly || am.end_date ? '' : `<button class="btn btn-sm" data-am-stop="${i}">終了</button>`}</td></tr>`;
        }).join('')}
        </tbody>
      </table></div>` : '<p class="empty">抗菌薬なし</p>'}
      ${antibioticFindingsHTML(infection)}
      ${(infection.infection_labs || []).length ? `
      <div class="table-scroll"><table class="table">
        <thead><tr><th>日時</th><th>体温</th><th>WBC</th><th>CRP</th><th>PCT</th></tr></thead>
        <tbody>${infection.infection_labs.map(l => `
          <tr><td>${fmtDateTime(l.t)}</td><td>${l.temp ?? '—'}</td><td>${l.wbc ?? '—'}</td><td>${l.crp ?? '—'}</td><td>${l.pct ?? '—'}</td></tr>`).join('')}
        </tbody>
      </table></div>` : ''}
      <p class="disclaimer">${esc(C.DISCLAIMER)}</p>
      ${readonly ? '' : `<div class="btn-row">
        <button class="btn" id="edit-inf">感染情報を編集</button>
        <button class="btn" id="add-lab">＋検査値</button>
      </div>`}
    </section>

    <section class="card">
      <h3>介入ログ</h3>
      ${ivs.length ? `<div class="list">${ivs.map(iv => `
        <div class="list-row iv-row">
          <span class="chip ${iv.trigger_source === 'eRN' ? 'chip-open' : 'chip-muted'}">${SOURCE_LABEL[iv.trigger_source] || iv.trigger_source}</span>
          <span>${iv.category} / ${DOMAIN_LABEL[iv.domain] || iv.domain}</span>
          <span class="chip ${iv.outcome === 'needed' ? 'chip-updated' : 'chip-todo'}">${iv.outcome === 'needed' ? '介入要' : '空振り'}</span>
          <span class="muted">${iv.round_id ? 'R' + (roundNoById.get(iv.round_id) ?? '?') : '外'} ${fmtDateTime(iv.timestamp)}</span>
          <span class="note-cell">${esc(iv.note || '')}</span>
        </div>`).join('')}</div>` : '<p class="empty">介入なし</p>'}
      ${readonly ? '' : '<button class="btn btn-primary" id="log-iv">＋介入記録</button>'}
    </section>`, 'roster');

  $('#back').addEventListener('click', () => nav(`#/roster/${shift.id}`));
  $('#calc-pt')?.addEventListener('click', () => openCalcModal({
    height_cm: patient.height_cm, weight_kg: patient.weight_kg, age: patient.age, sex: patient.sex,
  }));
  if (!readonly) {
    $('#pin')?.addEventListener('click', async () => {
      patient.pinned = !patient.pinned;
      await db.put('patients', patient);
      render();
    });
    $('#edit-pt')?.addEventListener('click', () => openPatientModal(shift, patient));
    $('#race-toggle')?.addEventListener('click', () => toggleRace(bundle, activeRound(rounds), patient));
    $('#edit-inf')?.addEventListener('click', () => openInfectionModal(patient, infection));
    $('#add-lab')?.addEventListener('click', () => openLabModal(patient, infection));
    $('#edit-vent')?.addEventListener('click', () => openVentilatorModal(patient, lastVitals));
    $('#log-iv')?.addEventListener('click', () => openInterventionModal(bundle, activeRound(rounds), patient.id));
    $$('[data-am-stop]').forEach(b => b.addEventListener('click', async () => {
      infection.antimicrobials[Number(b.dataset.amStop)].end_date = todayStr();
      await db.put('infections', infection);
      render();
    }));
  }
}

// ---- 人工呼吸器カード（計算・逸脱判定） --------------------------------

function statusRow(label, res) {
  if (!res) return '';
  const cls = { high: 'sev-alert', low: 'sev-alert', caution: 'sev-caution', ok: 'sev-stable' }[res.status] || '';
  const icon = res.status === 'ok' ? '✓' : '⚠';
  return `<div class="vent-row ${cls}"><span class="vent-ic">${icon}</span>
    <span class="vent-lbl">${esc(label)}</span><span class="vent-msg">${esc(res.message)}</span></div>`;
}

function ventilatorCard(patient, lastVitals, readonly) {
  const v = patient.ventilator;
  const hasHW = patient.height_cm && patient.sex;
  if (!v) {
    return `<section class="card">
      <h3>人工呼吸器</h3>
      <p class="empty">未設定。${readonly ? '' : '設定すると一回換気量・ドライビングプレッシャー・FiO₂/PEEP・目標分時換気量を自動チェックします。'}</p>
      ${readonly ? '' : '<button class="btn" id="edit-vent">＋呼吸器情報を入力</button>'}
    </section>`;
  }
  const vt = tidalIf(v.vt, patient);
  const dp = C.drivingPressure(v.pplat, v.peep);
  const fp = C.fio2PeepCheck(v.fio2, v.peep);
  const mv = C.minuteVentilation(v.rr, v.vt);
  const paco2 = v.paco2 ?? (lastVitals && lastVitals.paco2);
  const tmv = mv && paco2 ? C.targetMvForPaco2(mv, paco2, v.target_paco2 || 40) : null;
  return `<section class="card">
    <h3>人工呼吸器 <span class="muted">${esc(v.mode || '')}</span></h3>
    <div class="inf-grid">
      <div><span class="muted">モード:</span> ${esc(v.mode || '—')}</div>
      <div><span class="muted">VT:</span> ${v.vt ?? '—'} mL</div>
      <div><span class="muted">呼吸数:</span> ${v.rr ?? '—'} /分</div>
      <div><span class="muted">PEEP:</span> ${v.peep ?? '—'} cmH₂O</div>
      <div><span class="muted">FiO₂:</span> ${v.fio2 ?? '—'} %</div>
      <div><span class="muted">プラトー圧:</span> ${v.pplat ?? '—'} cmH₂O</div>
      <div><span class="muted">分時換気量:</span> ${mv ?? '—'} L/分</div>
      <div><span class="muted">PaCO₂:</span> ${paco2 ?? '—'} mmHg</div>
    </div>
    <div class="vent-checks">
      ${hasHW ? statusRow('一回換気量(6mL/kg IBW)', vt) : '<div class="vent-row muted">身長・性別を入力するとVT評価が表示されます</div>'}
      ${statusRow('ドライビングプレッシャー', dp)}
      ${statusRow('FiO₂/PEEP テーブル', fp)}
      ${tmv ? `<div class="vent-row sev-stable"><span class="vent-ic">🎯</span><span class="vent-lbl">目標PaCO₂の分時換気量</span><span class="vent-msg">${esc(tmv.message)}</span></div>` : ''}
    </div>
    <p class="disclaimer">${esc(C.DISCLAIMER)}</p>
    ${readonly ? '' : '<button class="btn" id="edit-vent">呼吸器情報を編集</button>'}
  </section>`;
}

function tidalIf(vt, patient) {
  if (vt == null || !patient.height_cm) return null;
  return C.tidalVolumeAssessment(vt, patient.height_cm, patient.sex);
}

function openVentilatorModal(patient, lastVitals) {
  const v = patient.ventilator || {};
  const num = x => (x == null ? '' : x);
  const m = openModal(`
    <div class="modal-head">人工呼吸器設定 ${esc(patient.bed_label)}</div>
    <div class="modal-body form">
      <label>モード <input type="text" id="vt-mode" value="${esc(v.mode || '')}" placeholder="例: A/C(VC), PSV, SIMV"></label>
      <div class="form-row">
        <label>VT 一回換気量 (mL) <input type="number" id="vt-vt" inputmode="numeric" value="${num(v.vt)}" placeholder="例: 400"></label>
        <label>呼吸数 (/分) <input type="number" id="vt-rr" inputmode="numeric" value="${num(v.rr)}" placeholder="例: 16"></label>
      </div>
      <div class="form-row">
        <label>PEEP (cmH₂O) <input type="number" id="vt-peep" inputmode="numeric" value="${num(v.peep)}" placeholder="例: 8"></label>
        <label>FiO₂ (%) <input type="number" id="vt-fio2" inputmode="numeric" value="${num(v.fio2)}" placeholder="例: 40"></label>
      </div>
      <div class="form-row">
        <label>プラトー圧 (cmH₂O) <input type="number" id="vt-pplat" inputmode="numeric" value="${num(v.pplat)}" placeholder="例: 22"></label>
        <label>PaCO₂ (mmHg) <input type="number" id="vt-paco2" step="0.1" inputmode="decimal" value="${num(v.paco2 ?? (lastVitals && lastVitals.paco2))}" placeholder="血ガス"></label>
      </div>
      <label>目標 PaCO₂ (mmHg) <input type="number" id="vt-target" inputmode="numeric" value="${num(v.target_paco2 ?? 40)}">
        <span class="hint">許容的高炭酸ガス血症など目標を変える場合に調整。既定40。</span></label>
      ${patient.height_cm ? `<p class="hint">IBW ${Math.round(C.idealBodyWeight(patient.height_cm, patient.sex))}kg・6mL/kg目標 ${Math.round(6 * C.idealBodyWeight(patient.height_cm, patient.sex))}mL</p>`
        : '<p class="hint">身長・性別を患者情報に入力すると一回換気量の評価が有効になります。</p>'}
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="vt-save">保存</button>
    </div>`);
  m.querySelector('#vt-save').addEventListener('click', async () => {
    const n = id => { const x = m.querySelector(id).value; return x === '' ? null : Number(x); };
    patient.ventilator = {
      mode: m.querySelector('#vt-mode').value.trim(),
      vt: n('#vt-vt'), rr: n('#vt-rr'), peep: n('#vt-peep'), fio2: n('#vt-fio2'),
      pplat: n('#vt-pplat'), paco2: n('#vt-paco2'), target_paco2: n('#vt-target') || 40,
      updated_at: new Date().toISOString(),
    };
    await db.put('patients', patient);
    m.close();
    render();
  });
}

// ---- 付録: 計算ツール（ガンマ計算 / IBW / VTe / CrCl） ------------------

function openCalcModal(prefill = {}) {
  const val = v => (v == null || v === '' ? '' : v);
  const m = openModal(`
    <div class="modal-head">計算ツール（付録）</div>
    <div class="modal-body form">
      <fieldset class="vfs"><legend>共通パラメータ</legend>
        <div class="form-row">
          <label>身長 (cm) <input type="number" id="cc-height" step="0.1" inputmode="decimal" value="${val(prefill.height_cm)}"></label>
          <label>体重 (kg) <input type="number" id="cc-weight" step="0.1" inputmode="decimal" value="${val(prefill.weight_kg)}"></label>
        </div>
        <div class="form-row">
          <label>年齢 <input type="number" id="cc-age" inputmode="numeric" value="${val(prefill.age)}"></label>
          <label>性別 ${segmented('ccsex', [{ value: 'male', label: '男性' }, { value: 'female', label: '女性' }], prefill.sex || 'male')}</label>
        </div>
      </fieldset>

      <fieldset class="vfs"><legend>ガンマ計算（γ ↔ mL/h）</legend>
        <div class="form-row">
          <label>薬剤量 (mg) <input type="number" id="cc-drug" step="0.01" inputmode="decimal" placeholder="例: 3"></label>
          <label>溶液量 (mL) <input type="number" id="cc-sol" step="0.1" inputmode="decimal" placeholder="例: 50"></label>
        </div>
        <div class="form-row">
          <label>γ (µg/kg/min) <input type="number" id="cc-gamma" step="0.01" inputmode="decimal" placeholder="入力→mL/h算出"></label>
          <label>流量 (mL/h) <input type="number" id="cc-rate" step="0.1" inputmode="decimal" placeholder="入力→γ算出"></label>
        </div>
        <div class="calc-out" id="cc-gamma-out"></div>
      </fieldset>

      <fieldset class="vfs"><legend>IBW（理想体重）／ VTe（一回換気量）</legend>
        <div class="calc-out" id="cc-ibw-out"></div>
      </fieldset>

      <fieldset class="vfs"><legend>CrCl（Cockcroft-Gault）</legend>
        <label>血清クレアチニン (mg/dL) <input type="number" id="cc-scr" step="0.01" inputmode="decimal" placeholder="例: 1.0"></label>
        <div class="calc-out" id="cc-crcl-out"></div>
      </fieldset>
      <p class="disclaimer">${esc(C.DISCLAIMER)}</p>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" data-close>閉じる</button></div>`);

  const numOf = id => { const v = m.querySelector(id).value; return v === '' ? null : Number(v); };

  const recalc = (source) => {
    const height = numOf('#cc-height'), weight = numOf('#cc-weight'), age = numOf('#cc-age');
    const sex = segValue(m, 'ccsex') || 'male';
    const conc = C.concentration(numOf('#cc-drug'), numOf('#cc-sol'));

    // ガンマ ↔ 流量（編集された側から他方を算出）
    const gEl = m.querySelector('#cc-gamma'), rEl = m.querySelector('#cc-rate');
    if (conc && weight) {
      if (source === 'gamma' && gEl.value !== '') rEl.value = C.gammaToRate(Number(gEl.value), conc, weight) ?? '';
      else if (source === 'rate' && rEl.value !== '') gEl.value = C.rateToGamma(Number(rEl.value), conc, weight) ?? '';
    }
    m.querySelector('#cc-gamma-out').innerHTML = conc
      ? `濃度 ${round3(conc)} mg/mL${weight ? '' : '（体重を入力すると γ↔mL/h を計算）'}`
      : '薬剤量・溶液量を入力すると濃度を計算';

    // IBW / VTe
    const ibw = height ? C.idealBodyWeight(height, sex) : null;
    m.querySelector('#cc-ibw-out').innerHTML = ibw
      ? `IBW <b>${Math.round(ibw * 10) / 10} kg</b>　目標VT(6mL/kg) <b>${Math.round(6 * ibw)} mL</b>　肺保護域(4–8) ${Math.round(4 * ibw)}–${Math.round(8 * ibw)} mL`
      : '身長・性別を入力するとIBW/目標VTを計算';

    // CrCl
    const crcl = C.crClCockcroft(age, weight, numOf('#cc-scr'), sex);
    m.querySelector('#cc-crcl-out').innerHTML = crcl != null
      ? `CrCl <b>${crcl} mL/分</b>${crcl < 50 ? '　<span class="calc-warn">腎機能低下：用量調整を検討</span>' : ''}`
      : '年齢・体重・Cr を入力するとCrClを計算';
  };

  m.querySelectorAll('input').forEach(inp => {
    const src = inp.id === 'cc-gamma' ? 'gamma' : inp.id === 'cc-rate' ? 'rate' : 'other';
    inp.addEventListener('input', () => recalc(src));
  });
  m.addEventListener('segchange', () => recalc('other'));
  recalc('other');
}

function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }

// ---- 感染: 抗菌薬適正判定の表示 ----------------------------------------

function antibioticFindingsHTML(infection) {
  const findings = C.assessAntibiotics({
    antimicrobials: infection.antimicrobials || [],
    organisms: infection.organisms || [],
    renal: { crcl: infection.crcl ?? null, crrt: !!infection.crrt },
  });
  if (!findings.length) return '';
  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return `<div class="abx-findings">
    <h4>抗菌薬アルゴリズム（参考）</h4>
    ${findings.map(f => `<div class="abx-item abx-${f.level}">
      <span class="abx-ic">${f.level === 'critical' ? '⛔' : f.level === 'warning' ? '⚠' : 'ℹ'}</span>
      <span>${esc(f.message)}</span></div>`).join('')}
  </div>`;
}

function organismNames(orgs) {
  return (orgs || []).map(o => {
    const k = C.findOrganism(o);
    return k ? `${k.jp}(${k.name})` : o;
  }).join(', ');
}

function gramLabel(key) {
  const g = C.GRAM_GUIDE.find(x => x.key === key);
  return g ? g.label : '';
}

function emptyInfection(patientId) {
  return {
    patient_id: patientId,
    source: '',
    gram_stain: '',
    organisms: [],
    culture_status: 'none',
    culture_date: '',
    antimicrobials: [],
    deescalation: 'none',
    crcl: null,
    crrt: false,
    devices: {
      cvc: { active: false, start_date: '' },
      foley: { active: false, start_date: '' },
      vent: { active: false, start_date: '' },
    },
    infection_labs: [],
  };
}

function cultureLabel(s) {
  return { none: '未提出', pending: '結果待ち', positive: '陽性', negative: '陰性' }[s] || '未提出';
}
function deescLabel(s) {
  return { none: '未', due: '検討可', done: '済' }[s] || '未';
}

function openInfectionModal(patient, infection) {
  const inf = JSON.parse(JSON.stringify(infection));
  const devRow = (key, label) => {
    const d = inf.devices[key] || { active: false, start_date: '' };
    return `
      <div class="dev-row">
        <span class="dev-label">${label}</span>
        ${segmented('dev-' + key, [{ value: '1', label: '留置中' }, { value: '0', label: 'なし' }], d.active ? '1' : '0')}
        <input type="date" id="dev-date-${key}" value="${esc(d.start_date || '')}" title="留置開始日">
      </div>`;
  };
  const m = openModal(`
    <div class="modal-head">感染治療状況 ${esc(patient.bed_label)}</div>
    <div class="modal-body form">
      <label>感染源 / 疑い部位 <input type="text" id="inf-source" value="${esc(inf.source || '')}" placeholder="例: 肺炎疑い"></label>
      <label>グラム染色所見
        <div class="seg seg-wrap" data-seg="gram">
          <button type="button" class="seg-btn ${!inf.gram_stain ? 'on' : ''}" data-value="">未</button>
          ${C.GRAM_GUIDE.map(g => `<button type="button" class="seg-btn ${inf.gram_stain === g.key ? 'on' : ''}" data-value="${g.key}">${esc(g.label)}</button>`).join('')}
        </div>
        <span class="hint" id="gram-hint">${esc((C.GRAM_GUIDE.find(g => g.key === inf.gram_stain) || {}).hint || 'グラム染色の形態から起因菌を推定します。')}</span>
      </label>
      <label>起因菌（該当を選択・複数可）
        <div class="seg seg-wrap" data-seg="orgs" data-multi>
          ${C.ORGANISMS.map(o => `<button type="button" class="seg-btn ${(inf.organisms || []).includes(o.key) ? 'on' : ''}" data-value="${o.key}" title="${esc(o.jp)}">${esc(o.name)}</button>`).join('')}
        </div>
      </label>
      <label>その他の菌（カンマ区切り・任意）<input type="text" id="inf-org-free" value="${esc((inf.organisms || []).filter(o => !C.findOrganism(o)).join(', '))}"></label>
      <div class="form-row">
        <label>培養状況 ${segmented('culture', [
          { value: 'none', label: '未提出' }, { value: 'pending', label: '結果待ち' },
          { value: 'positive', label: '陽性' }, { value: 'negative', label: '陰性' },
        ], inf.culture_status || 'none')}</label>
        <label>培養提出日 <input type="date" id="inf-culdate" value="${esc(inf.culture_date || '')}"></label>
      </div>
      <label>狭域化(de-escalation) ${segmented('deesc', [
        { value: 'none', label: '未' }, { value: 'due', label: '検討可' }, { value: 'done', label: '済' },
      ], inf.deescalation || 'none')}</label>
      <fieldset><legend>腎機能（用量チェック用）</legend>
        <div class="form-row">
          <label>CrCl / eGFR <input type="number" id="inf-crcl" inputmode="numeric" value="${inf.crcl ?? ''}" placeholder="mL/分"></label>
          <label>血液浄化 ${segmented('crrt', [{ value: '0', label: 'なし' }, { value: '1', label: 'CRRT中' }], inf.crrt ? '1' : '0')}</label>
        </div>
      </fieldset>
      <fieldset><legend>デバイス留置日数（開始日から自動加算）</legend>
        ${devRow('cvc', 'CVC')}${devRow('foley', '尿カテ')}${devRow('vent', '人工呼吸')}
      </fieldset>
      <fieldset><legend>抗菌薬（DOT 自動計算）</legend>
        <div id="am-list"></div>
        <datalist id="abx-list">${C.ANTIMICROBIALS.map(a => `<option value="${a.name}">${esc(a.jp)}</option>`).join('')}</datalist>
        <div class="form-row am-new">
          <input type="text" id="am-name" placeholder="薬剤名(例:MEPM)" list="abx-list">
          <input type="date" id="am-start" value="${todayStr()}">
          ${segmented('am-spec', [{ value: 'broad', label: '広域' }, { value: 'narrow', label: '狭域' }], 'broad')}
          <button type="button" class="btn" id="am-add">追加</button>
        </div>
        <span class="hint" id="abx-hint"></span>
      </fieldset>
      <div id="abx-preview"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="inf-save">保存</button>
    </div>`);

  const collectOrgs = () => {
    const keys = segValues(m, 'orgs');
    const free = m.querySelector('#inf-org-free').value.split(',').map(s => s.trim()).filter(Boolean);
    return [...keys, ...free];
  };
  const renderAms = () => {
    m.querySelector('#am-list').innerHTML = inf.antimicrobials.map((am, i) => {
      const k = C.findAntimicrobial(am.name);
      return `<div class="am-row" data-am="${i}">
        <span>${esc(am.name)}${k ? `<span class="am-jp muted">${esc(k.jp)}</span>` : ''}（${esc(am.start_date)}〜 ${am.spectrum === 'broad' ? '広域' : '狭域'}${am.end_date ? '・終了' : ''}）</span>
        <button type="button" class="btn btn-sm" data-am-del="${i}">削除</button>
      </div>`;
    }).join('') || '<span class="muted">未登録</span>';
  };
  const refreshPreview = () => {
    inf.organisms = collectOrgs();
    inf.crcl = m.querySelector('#inf-crcl').value === '' ? null : Number(m.querySelector('#inf-crcl').value);
    inf.crrt = segValue(m, 'crrt') === '1';
    m.querySelector('#abx-preview').innerHTML = antibioticFindingsHTML(inf);
  };
  renderAms();
  refreshPreview();

  m.addEventListener('click', e => {
    const del = e.target.closest('[data-am-del]');
    if (del) { inf.antimicrobials.splice(Number(del.dataset.amDel), 1); renderAms(); refreshPreview(); }
  });
  m.addEventListener('segchange', e => {
    if (e.detail.name === 'gram') {
      const g = C.GRAM_GUIDE.find(x => x.key === e.detail.value);
      m.querySelector('#gram-hint').textContent = g ? g.hint : 'グラム染色の形態から起因菌を推定します。';
    }
    if (['orgs', 'crrt'].includes(e.detail.name)) refreshPreview();
  });
  m.querySelector('#inf-crcl').addEventListener('input', refreshPreview);
  m.querySelector('#inf-org-free').addEventListener('input', refreshPreview);
  m.querySelector('#am-name').addEventListener('input', e => {
    const k = C.findAntimicrobial(e.target.value);
    m.querySelector('#abx-hint').textContent = k ? `${k.jp}・${k.cls}：${k.note}` : '';
  });
  m.querySelector('#am-add').addEventListener('click', () => {
    const name = m.querySelector('#am-name').value.trim();
    if (!name) return toast('薬剤名を入力してください');
    const k = C.findAntimicrobial(name);
    inf.antimicrobials.push({
      name: k ? k.name : name,
      start_date: m.querySelector('#am-start').value || todayStr(),
      spectrum: segValue(m, 'am-spec') || 'broad',
      end_date: null,
    });
    m.querySelector('#am-name').value = '';
    m.querySelector('#abx-hint').textContent = '';
    renderAms();
    refreshPreview();
  });
  m.querySelector('#inf-save').addEventListener('click', async () => {
    inf.source = m.querySelector('#inf-source').value.trim();
    inf.gram_stain = segValue(m, 'gram') || '';
    inf.organisms = collectOrgs();
    inf.culture_status = segValue(m, 'culture');
    inf.culture_date = m.querySelector('#inf-culdate').value || '';
    inf.deescalation = segValue(m, 'deesc');
    inf.crcl = m.querySelector('#inf-crcl').value === '' ? null : Number(m.querySelector('#inf-crcl').value);
    inf.crrt = segValue(m, 'crrt') === '1';
    for (const key of ['cvc', 'foley', 'vent']) {
      inf.devices[key] = {
        active: segValue(m, 'dev-' + key) === '1',
        start_date: m.querySelector('#dev-date-' + key).value || '',
      };
      if (inf.devices[key].active && !inf.devices[key].start_date) {
        inf.devices[key].start_date = todayStr();
      }
    }
    await db.put('infections', inf);
    m.close();
    render();
  });
}

function openLabModal(patient, infection) {
  const m = openModal(`
    <div class="modal-head">検査値を追加 ${esc(patient.bed_label)}</div>
    <div class="modal-body form">
      <div class="form-row">
        <label>体温 <input type="number" step="0.1" id="lab-temp" inputmode="decimal"></label>
        <label>WBC <input type="number" step="0.1" id="lab-wbc" inputmode="decimal"></label>
      </div>
      <div class="form-row">
        <label>CRP <input type="number" step="0.1" id="lab-crp" inputmode="decimal"></label>
        <label>PCT <input type="number" step="0.01" id="lab-pct" inputmode="decimal"></label>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="lab-save">追加</button>
    </div>`);
  m.querySelector('#lab-save').addEventListener('click', async () => {
    const num = id => {
      const v = m.querySelector(id).value;
      return v === '' ? null : Number(v);
    };
    infection.infection_labs = infection.infection_labs || [];
    infection.infection_labs.push({
      t: new Date().toISOString(),
      temp: num('#lab-temp'), wbc: num('#lab-wbc'), crp: num('#lab-crp'), pct: num('#lab-pct'),
    });
    await db.put('infections', infection);
    m.close();
    render();
  });
}

// ---------------------------------------------------------------- 申し送り一覧（PDF）

function treatmentOptions(patient) {
  const opts = [];
  const v = patient.ventilator;
  if (v) {
    const parts = [v.mode, v.vt ? `VT${v.vt}` : '', v.peep != null ? `PEEP${v.peep}` : '', v.fio2 != null ? `FiO₂${v.fio2}%` : '']
      .filter(Boolean).join(' ');
    opts.push(`人工呼吸器${parts ? '（' + parts + '）' : ''}`);
  }
  if (patient.support && patient.support.crrt) opts.push('持続血液浄化(CRRT)');
  if (patient.support && patient.support.mcs && patient.support.mcs !== 'none') opts.push('補助循環(' + patient.support.mcs + ')');
  return opts;
}

async function renderHandoff(shiftId) {
  const bundle = await loadBundle(shiftId);
  const { shift, patients, patientRounds, rounds, infections } = bundle;
  if (!shift) return renderHome();
  const round = activeRound(rounds);
  const rows = patients.map(p => patientRowData(p, patientRounds, infections.get(p.id), round));
  rows.sort((a, b) => (b.patient.pinned === true) - (a.patient.pinned === true) || compareBed(a, b));

  const card = r => {
    const p = r.patient;
    const opts = treatmentOptions(p);
    const infHtml = infectionSummaryHTML(r.infection);
    const hasInf = r.infection && ((r.infection.organisms || []).length || (r.infection.antimicrobials || []).length || r.infection.source);
    return `
    <div class="ho-card">
      <div class="ho-head">
        <span class="ho-room">${esc(p.facility)} ${esc(p.bed_label)}</span>
        <span class="ho-demo">${p.age != null ? p.age + '歳' : '年齢-'} / ${p.sex === 'female' ? '女性' : '男性'} / ${esc(p.anon_id)}</span>
        <span class="ho-score muted">${(r.lastPR && r.lastPR.vitals && Object.keys(r.lastPR.vitals).length) ? 'NEWS2' : 'スコア'} ${r.ews}</span>
      </div>
      <div class="ho-body">
        <div class="ho-row"><span class="ho-k">診断</span><span>${esc(p.dx_summary || '—')}</span></div>
        <div class="ho-row"><span class="ho-k">治療</span><span>${opts.length ? opts.map(esc).join(' ／ ') : '—'}${p.sedation ? ' ／ 鎮静あり' : ''}</span></div>
        <div class="ho-row"><span class="ho-k">感染</span><span>${hasInf ? infHtml : '—'}</span></div>
        <div class="ho-row"><span class="ho-k">前帯懸念</span><span>${esc(p.concerns || '—')}</span></div>
        <div class="ho-row ho-topic"><span class="ho-k">TOPIC</span><span>${esc(p.handoff_topics || '—')}</span></div>
        <div class="ho-row"><span class="ho-k">メモ</span><span>${esc(p.memo || '—')}</span></div>
      </div>
    </div>`;
  };

  shell(`
    <section class="card no-print">
      <div class="detail-head">
        <button class="btn" id="ho-back">← 患者リスト</button>
        <h2>申し送り一覧 <span class="muted">${esc(shift.date)} / ${(shift.facilities || []).join('・')} / ${patients.length}名</span></h2>
        <div class="detail-actions">
          <button class="btn btn-primary" id="ho-print">📄 PDFエクスポート（印刷）</button>
        </div>
      </div>
      <p class="hint">「PDFエクスポート」で印刷ダイアログを開き、送信先を「PDFで保存」にすると全患者を1つのPDFにできます（iPad: 共有→プリント→ピンチでPDF）。</p>
    </section>

    <div class="handoff-sheet">
      <div class="ho-title only-print">遠隔ICU 申し送り一覧　${esc(shift.date)}　${(shift.facilities || []).join('・')}　${patients.length}名</div>
      ${rows.length ? rows.map(card).join('') : '<p class="empty">患者がいません</p>'}
    </div>`, 'roster');

  $('#ho-back').addEventListener('click', () => nav(`#/roster/${shiftId}`));
  $('#ho-print').addEventListener('click', () => window.print());
}

// ---------------------------------------------------------------- シフトサマリ

async function renderSummary(shiftId) {
  const bundle = await loadBundle(shiftId);
  const { shift, rounds, patients, patientRounds, interventions, flips } = bundle;
  if (!shift) return renderHome();
  const summary = L.computeShiftSummary({ patients, rounds, patientRounds, interventions, flips });
  const open = shift.status !== 'closed';

  const tbl = (title, obj, labelMap = {}) => {
    const entries = Object.entries(obj);
    if (!entries.length) return '';
    return `<div class="mini-table"><h4>${title}</h4><table class="table"><tbody>
      ${entries.map(([k, v]) => `<tr><td>${esc(labelMap[k] || k)}</td><td class="num">${v}</td></tr>`).join('')}
    </tbody></table></div>`;
  };

  shell(`
    <section class="card">
      <h2>シフト集計 ${esc(shift.date)} ${open ? '<span class="chip chip-open">進行中（プレビュー）</span>' : '<span class="chip chip-muted">確定</span>'}</h2>
      <div class="stat-row">
        <div class="stat"><div class="stat-label">総介入数</div><div class="stat-value">${summary.total_interventions}</div></div>
        <div class="stat"><div class="stat-label">先回り的中率</div>
          <div class="stat-value">${summary.precision == null ? '—' : Math.round(summary.precision * 100) + '%'}</div>
          <div class="stat-sub">先回り化 ${summary.flip_hit}/${summary.flip_total} が的中</div></div>
        <div class="stat"><div class="stat-label">取り逃し（現場が先・待機のまま）</div><div class="stat-value">${summary.misses}</div></div>
        <div class="stat"><div class="stat-label">ラウンド実施</div><div class="stat-value">${rounds.length}回</div>
          <div class="stat-sub">${rounds.length > 1 ? '間隔 ' + rounds.slice(1).map((r, i) => L.fmtDuration(L.roundInterval(rounds[i], r))).join(' / ') : '—'}</div></div>
      </div>
      <div class="mini-tables">
        ${tbl('誰が先に気づいたか', summary.by_source, SOURCE_LABEL)}
        ${tbl('区分別', summary.by_category, { proactive: '先回り', reactive: '待機からの反応' })}
        ${tbl('拠点別', summary.by_facility)}
        ${tbl('ラウンド別', summary.by_round)}
        ${tbl('領域別', summary.by_domain, DOMAIN_LABEL)}
      </div>
      <div class="btn-row">
        <button class="btn" id="back-roster">← 患者リスト</button>
        ${open ? '<button class="btn btn-danger" id="close-shift">シフトを終了（確定）</button>' : ''}
      </div>
    </section>`, 'summary');

  $('#back-roster').addEventListener('click', () => nav(`#/roster/${shiftId}`));
  $('#close-shift')?.addEventListener('click', async () => {
    const ar = activeRound(rounds);
    if (ar) return toast(`ラウンド${ar.round_number}が進行中です。先に終了してください`);
    const ok = await confirmDialog('シフトを終了して確定しますか？（以後読み取り専用・的中率が確定します）', { okLabel: '終了する', danger: true });
    if (!ok) return;
    for (const f of flips) {
      f.resulted_in_intervention = summary.hitFlipIds.has(f.id);
      await db.put('raceflips', f);
    }
    shift.status = 'closed';
    shift.closed_at = new Date().toISOString();
    const { hitFlipIds, ...persistable } = summary;
    shift.summary = persistable;
    await db.put('shifts', shift);
    toast('シフトを確定しました');
    render();
  });
}

// ---------------------------------------------------------------- 蓄積ダッシュボード

async function renderDashboard() {
  const [shifts, flips, interventions, patientRounds] = await Promise.all([
    db.all('shifts'), db.all('raceflips'), db.all('interventions'), db.all('patient_rounds'),
  ]);
  const closed = shifts.filter(s => s.status === 'closed' && s.summary);
  const closedIds = new Set(closed.map(s => s.id));
  const closedFlips = flips.filter(f => closedIds.has(f.shift_id));
  const closedIvs = interventions.filter(iv => closedIds.has(iv.shift_id));

  const trend = L.precisionTrend(closed.map(s => ({ shift: s, summary: s.summary })));
  const points = trend.map(t => ({ y: t.precision, label: t.date.slice(5) }));

  const byFacility = L.precisionBy(closedFlips, f => f.features?.facility);
  const byTime = L.precisionBy(closedFlips, f => f.features?.time_block === 'night' ? '夜勤' : '日勤');
  const bySed = L.precisionBy(closedFlips, f => f.features?.sedation ? '鎮静あり' : '鎮静なし');
  const tagFlips = closedFlips.flatMap(f => (f.reason_tags || []).map(tag => ({ ...f, _tag: tag })));
  const byTag = L.precisionBy(tagFlips, f => f._tag);

  const winFacility = L.raceWinRate(closedIvs, iv => {
    const f = flips.find(x => x.patient_id === iv.patient_id);
    return f?.features?.facility || '—';
  });
  const winTime = L.raceWinRate(closedIvs, iv => L.timeBlock(new Date(iv.timestamp)) === 'night' ? '夜勤' : '日勤');

  const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
  const precTable = (title, rows) => `
    <div class="mini-table"><h4>${title}</h4>
      ${rows.length ? `<table class="table"><thead><tr><th>条件</th><th>フリップ</th><th>的中</th><th>precision</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.key)}</td><td class="num">${r.total}</td><td class="num">${r.hit}</td><td class="num">${pct(r.precision)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">データなし</p>'}
    </div>`;

  // フィードバック: precision が高い / 空振りが多い条件（n>=2）
  const allConds = [
    ...byFacility.map(r => ({ ...r, axis: '拠点' })),
    ...byTime.map(r => ({ ...r, axis: '時間帯' })),
    ...bySed.map(r => ({ ...r, axis: '鎮静' })),
    ...byTag.map(r => ({ ...r, axis: '理由' })),
  ].filter(r => r.total >= 2 && r.precision != null);
  const best = [...allConds].sort((a, b) => b.precision - a.precision).slice(0, 3);
  const worst = [...allConds].sort((a, b) => a.precision - b.precision).slice(0, 3);

  shell(`
    <section class="card">
      <h2>蓄積分析 <span class="muted">確定シフト ${closed.length}件</span></h2>
      <h3>先回り的中率の推移（シフトを重ねるほど上がるか）</h3>
      ${lineChart(points)}
    </section>
    <section class="card">
      <h3>条件別の的中率（先回り化した患者の分解）</h3>
      <div class="mini-tables">
        ${precTable('拠点', byFacility)}
        ${precTable('時間帯', byTime)}
        ${precTable('鎮静', bySed)}
        ${precTable('選定理由タグ', byTag)}
      </div>
      <h3>eRN 先着率（eRNが先 / eRNが先＋現場が先）</h3>
      <div class="mini-tables">
        ${[['拠点', winFacility], ['時間帯', winTime]].map(([t, rows]) => `
          <div class="mini-table"><h4>${t}</h4>
            ${rows.length ? `<table class="table"><thead><tr><th>条件</th><th>eRN</th><th>現場</th><th>先着率</th></tr></thead><tbody>
              ${rows.map(r => `<tr><td>${esc(r.key)}</td><td class="num">${r.ern}</td><td class="num">${r.floor}</td><td class="num">${pct(r.rate)}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">データなし</p>'}
          </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h3>フィードバック（次シフトの選定補正へ）</h3>
      ${allConds.length ? `
        <p><strong>precision が高い条件:</strong> ${best.map(r => `${r.axis}=${esc(r.key)}（${pct(r.precision)}, n=${r.total}）`).join(' / ') || '—'}</p>
        <p><strong>空振りが多い条件:</strong> ${worst.map(r => `${r.axis}=${esc(r.key)}（${pct(r.precision)}, n=${r.total}）`).join(' / ') || '—'}</p>`
        : '<p class="empty">シフトの蓄積が増えると条件別フィードバックが表示されます（各条件 n≥2）</p>'}
    </section>
    <section class="card">
      <h3>エクスポート</h3>
      <div class="btn-row">
        <button class="btn" id="exp-json">JSON 全体</button>
        <button class="btn" id="exp-pr">CSV: PatientRound</button>
        <button class="btn" id="exp-iv">CSV: 介入</button>
        <button class="btn" id="exp-rf">CSV: 役割切替</button>
      </div>
    </section>`, 'dashboard');

  $('#exp-json').addEventListener('click', exportJSON);
  $('#exp-pr').addEventListener('click', () => exportPatientRounds(patientRounds));
  $('#exp-iv').addEventListener('click', () => exportInterventions(interventions));
  $('#exp-rf').addEventListener('click', () => exportFlips(flips));
}

async function exportJSON() {
  const stores = ['shifts', 'rounds', 'patients', 'patient_rounds', 'infections', 'interventions', 'raceflips', 'settings'];
  const dump = {};
  for (const s of stores) dump[s] = await db.all(s);
  download(`ern-export-${todayStr()}.json`, JSON.stringify(dump, null, 2), 'application/json');
}

function exportPatientRounds(rows) {
  download(`ern-patient-rounds-${todayStr()}.csv`, L.toCSV(rows, [
    { label: 'id', get: r => r.id },
    { label: 'shift_id', get: r => r.shift_id },
    { label: 'patient_id', get: r => r.patient_id },
    { label: 'round_number', get: r => r.round_number },
    { label: 'at', get: r => r.at },
    { label: 'news2_or_score', get: r => r.ews },
    { label: 'resp_rate', get: r => r.vitals?.resp_rate ?? '' },
    { label: 'spo2', get: r => r.vitals?.spo2 ?? '' },
    { label: 'on_oxygen', get: r => r.vitals?.on_oxygen ?? '' },
    { label: 'sbp', get: r => r.vitals?.sbp ?? '' },
    { label: 'pulse', get: r => r.vitals?.pulse ?? '' },
    { label: 'temp', get: r => r.vitals?.temp ?? '' },
    { label: 'consciousness', get: r => r.vitals?.consciousness ?? '' },
    { label: 'acuity', get: r => r.acuity ?? '' },
    { label: 'drs', get: r => r.drs ?? '' },
    { label: 'race_layer', get: r => r.race_layer },
    { label: 'entry_status', get: r => r.entry_status },
    { label: 'device_warn', get: r => r.infection_trigger_snapshot?.device_warn ?? '' },
    { label: 'dot_warn', get: r => r.infection_trigger_snapshot?.dot_warn ?? '' },
    { label: 'deesc_due', get: r => r.infection_trigger_snapshot?.deesc_due ?? '' },
    { label: 'note', get: r => r.note },
  ]), 'text/csv');
}

function exportInterventions(rows) {
  download(`ern-interventions-${todayStr()}.csv`, L.toCSV(rows, [
    { label: 'id', get: r => r.id },
    { label: 'shift_id', get: r => r.shift_id },
    { label: 'patient_id', get: r => r.patient_id },
    { label: 'round_id', get: r => r.round_id ?? '' },
    { label: 'timestamp', get: r => r.timestamp },
    { label: 'trigger_source', get: r => r.trigger_source },
    { label: 'category', get: r => r.category },
    { label: 'domain', get: r => r.domain },
    { label: 'outcome', get: r => r.outcome },
    { label: 'note', get: r => r.note },
  ]), 'text/csv');
}

function exportFlips(rows) {
  download(`ern-raceflips-${todayStr()}.csv`, L.toCSV(rows, [
    { label: 'id', get: r => r.id },
    { label: 'shift_id', get: r => r.shift_id },
    { label: 'patient_id', get: r => r.patient_id },
    { label: 'round_number', get: r => r.round_number ?? '' },
    { label: 'at', get: r => r.at },
    { label: 'ews', get: r => r.features?.ews ?? '' },
    { label: 'cvc_days', get: r => r.features?.cvc_days ?? '' },
    { label: 'foley_days', get: r => r.features?.foley_days ?? '' },
    { label: 'vent_days', get: r => r.features?.vent_days ?? '' },
    { label: 'dot_max', get: r => r.features?.dot_max ?? '' },
    { label: 'sedation', get: r => r.features?.sedation ?? '' },
    { label: 'facility', get: r => r.features?.facility ?? '' },
    { label: 'time_block', get: r => r.features?.time_block ?? '' },
    { label: 'floor_context', get: r => r.features?.floor_context ?? '' },
    { label: 'reason_tags', get: r => (r.reason_tags || []).join('|') },
    { label: 'resulted_in_intervention', get: r => r.resulted_in_intervention ?? '' },
  ]), 'text/csv');
}

// ---------------------------------------------------------------- 設定

async function renderSettings() {
  shell(`
    <section class="card form">
      <h2>設定</h2>
      <h3>感染トリガー閾値（roster 警告の自動判定）</h3>
      <div class="form-row">
        <label>CVC 警告（日）<input type="number" id="st-cvc" min="1" value="${settings.device_warn_days.cvc}"></label>
        <label>尿カテ 警告（日）<input type="number" id="st-foley" min="1" value="${settings.device_warn_days.foley}"></label>
        <label>人工呼吸 警告（日）<input type="number" id="st-vent" min="1" value="${settings.device_warn_days.vent}"></label>
      </div>
      <label>DOT 警告（日）<input type="number" id="st-dot" min="1" value="${settings.dot_warn_days}"></label>
      <h3>ラウンド</h3>
      <label>既定ラウンド回数（新規シフトの初期値）
        <input type="number" id="st-rounds" min="1" max="12" value="${settings.round_count_default}">
        <span class="hint">回数は目安。ラウンドの開始タイミング・間隔は各シフトで可変（実測時刻を記録）。</span>
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" id="st-save">保存</button>
      </div>
      <h3>データ</h3>
      <p class="hint">全データは端末内（IndexedDB）にのみ保存されます。バックアップは蓄積ダッシュボードのエクスポートを使用してください。</p>
      <button class="btn btn-danger" id="st-wipe">全データを消去</button>
    </section>`, 'settings');

  $('#st-save').addEventListener('click', async () => {
    settings = {
      ...settings,
      key: 'app',
      device_warn_days: {
        cvc: Number($('#st-cvc').value) || 7,
        foley: Number($('#st-foley').value) || 5,
        vent: Number($('#st-vent').value) || 5,
      },
      dot_warn_days: Number($('#st-dot').value) || 7,
      round_count_default: Number($('#st-rounds').value) || 4,
    };
    await db.put('settings', settings);
    toast('設定を保存しました');
  });
  $('#st-wipe').addEventListener('click', async () => {
    const ok = await confirmDialog('端末内の全データ（全シフト・全患者・全ログ）を消去します。エクスポート済みであることを確認してください。', { okLabel: '完全に消去', danger: true });
    if (!ok) return;
    await db.clearAll();
    localStorage.removeItem('ern.currentShift');
    toast('消去しました');
    nav('#/home');
  });
}

boot();
