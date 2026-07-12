// eRN 勤務管理アプリ 本体
// ラウンドは固定スケジュールを持たない（間隔は可変）: eRN が任意のタイミングで
// 開始・終了し、実測の開始時刻・前ラウンドからの間隔を記録・表示する。

import { db, uid } from './db.js';
import * as L from './logic.js';
import {
  $, $$, esc, fmtTime, fmtDateTime, todayStr,
  openModal, toast, confirmDialog,
  segmented, segValue, segValues, wireSegments,
  sparkline, deltaBadge, lineChart, download,
} from './ui.js';

const FACILITIES = ['KRC', 'SMM'];
const REASON_TAGS = ['呼吸悪化', '循環不安定', '感染兆候', 'device長期', '鎮静深い', '現場体制薄い', 'トレンド不穏', 'その他'];
const DOMAIN_LABEL = { resp: '呼吸', circ: '循環', infection: '感染', sedation: '鎮静', other: 'その他' };
const SOURCE_LABEL = { eRN: 'eRN発', floor: '現場発', alert: 'アラート発', device: 'device起因' };

let settings = { ...L.DEFAULT_SETTINGS };

// ---------------------------------------------------------------- 起動

async function boot() {
  const saved = await db.get('settings', 'app');
  if (saved) settings = { ...L.DEFAULT_SETTINGS, ...saved };
  wireSegments(document.body);
  window.addEventListener('hashchange', render);
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
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
  if (last) return { ews: last.ews, race_layer: last.race_layer, note: last.note };
  return { ews: patient.initial_ews ?? 0, race_layer: patient.race_layer, note: '' };
}

function patientRowData(patient, prs, infection, round) {
  const own = prs.filter(pr => pr.patient_id === patient.id);
  const { values, latest, delta } = L.ewsSeries(own);
  const ews = latest != null ? latest : (patient.initial_ews ?? 0);
  const triggers = L.infectionTriggers(infection, settings);
  const score = L.riskScore({ ews, delta, triggers, proactive: patient.race_layer === 'proactive' });
  const currentPR = round ? own.find(pr => pr.round_id === round.id) : null;
  return { patient, values, ews, delta, triggers, score, currentPR, own };
}

// ---------------------------------------------------------------- 共通レイアウト

function shell(content, active) {
  const shiftId = currentShiftId();
  const tabs = [
    ['roster', 'Roster', shiftId ? `#/roster/${shiftId}` : '#/home'],
    ['summary', 'サマリ', shiftId ? `#/summary/${shiftId}` : '#/home'],
    ['dashboard', '蓄積', '#/dashboard'],
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

  const rows = patients.map(p => patientRowData(p, patientRounds, infections.get(p.id), round));
  rows.sort((a, b) =>
    (b.patient.pinned === true) - (a.patient.pinned === true) || b.score - a.score);

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

    <section class="roster">
      ${shown.length ? shown.map(r => rosterRow(r, round, readonly)).join('')
        : `<p class="empty">${patients.length ? '未確認の患者はありません' : '患者を追加してください'}</p>`}
    </section>

    ${readonly ? '' : `
    <div class="fab-bar">
      <button class="btn" id="add-patient">＋患者</button>
      <button class="btn btn-primary" id="log-intervention">＋介入記録</button>
      <button class="btn" id="to-summary">シフトサマリ →</button>
    </div>`}
  `, 'roster');

  // events
  if (!readonly) {
    $('#add-patient')?.addEventListener('click', () => openPatientModal(shift, null));
    $('#log-intervention')?.addEventListener('click', () => openInterventionModal(bundle, round, null));
    $('#to-summary')?.addEventListener('click', () => nav(`#/summary/${shiftId}`));
    $('#start-round')?.addEventListener('click', () => startRound(shift, rounds));
    $('#end-round')?.addEventListener('click', () => endRound(bundle, round, rows));
    $('#view').addEventListener('segchange', e => {
      if (e.detail.name === 'filter') {
        sessionStorage.setItem('ern.rosterFilter', e.detail.value);
        render();
      }
    });
  }

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
}

function rosterRow(r, round, readonly) {
  const p = r.patient;
  const t = r.triggers;
  const status = !round ? '' :
    !r.currentPR ? `<span class="chip chip-todo">未確認</span>` :
    r.currentPR.entry_status === 'carried' ? `<span class="chip chip-muted">変化なし</span>` :
      `<span class="chip chip-updated">更新済</span>`;
  const flags = [
    t.device_warn ? '<span class="flag flag-warn" title="device-days 警告">dev</span>' : '',
    t.dot_warn ? '<span class="flag flag-warn" title="DOT 警告">DOT</span>' : '',
    t.deesc_due ? '<span class="flag flag-due" title="de-escalation 検討">de-esc</span>' : '',
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
    <button class="race-toggle ${p.race_layer}" data-race title="race 層を切替">
      ${p.race_layer === 'proactive' ? 'PRO' : 'REA'}
    </button>
    <div class="trend">
      ${sparkline(r.values.length ? r.values : [r.ews])}
      <span class="ews-now">EWS ${r.ews}</span>${deltaBadge(r.values.length >= 2 ? r.delta : null)}
    </div>
    <div class="flags">${flags}</div>
    <div class="row-status">${status}${carryBtn}</div>
    <button class="btn btn-icon" data-detail title="患者詳細">ⓘ</button>
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
      <div class="modal-head">未確認の proactive 患者があります</div>
      <div class="modal-body">
        <p>proactive 患者は「変化なし」一括確定できません。開いて更新してください。</p>
        <ul>${proTodo.map(r => `<li>${esc(r.patient.bed_label)}（${esc(r.patient.anon_id)}）</li>`).join('')}</ul>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close>戻る</button></div>`);
  }
  if (todo.length) {
    const ok = await confirmDialog(
      `未確認の reactive 患者が ${todo.length} 名います。前回値を引き継いで（変化なし扱い）ラウンドを終了しますか？`,
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
  if (p.race_layer === 'proactive') return toast('proactive 患者は開いて更新してください');
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
    at: new Date().toISOString(),
  });
  if (!silent) render();
}

// クイックシート: 前回値プリフィル・差分のみ編集
function openQuickSheet(bundle, round, rowData) {
  const p = rowData.patient;
  const existing = rowData.currentPR;
  const prev = existing
    ? { ews: existing.ews, race_layer: existing.race_layer, note: existing.note }
    : latestValues(p, bundle.patientRounds, round.round_number);

  const m = openModal(`
    <div class="modal-head">R${round.round_number} ${esc(p.bed_label)} <span class="muted">${esc(p.anon_id)} / ${esc(p.facility)}</span></div>
    <div class="modal-body form">
      <label>EWS（前回 ${prev.ews}）
        <div class="stepper">
          <button type="button" class="btn" data-step="-1">−</button>
          <input type="number" id="qs-ews" inputmode="numeric" min="0" max="20" value="${prev.ews}">
          <button type="button" class="btn" data-step="1">＋</button>
        </div>
      </label>
      <label>race 層
        ${segmented('race', [
          { value: 'proactive', label: 'proactive（先回り）' },
          { value: 'reactive', label: 'reactive（待機）' },
        ], prev.race_layer)}
      </label>
      <div id="flip-extra" class="flip-extra ${prev.race_layer === 'proactive' ? 'hidden' : 'hidden'}">
        <label>選定理由（reactive→proactive フリップ・複数可）
          <div class="seg seg-wrap" data-seg="reasons" data-multi>
            ${REASON_TAGS.map(t => `<button type="button" class="seg-btn" data-value="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
        </label>
        <label>現場体制メモ（任意）<input type="text" id="qs-floorctx" placeholder="例: 夜勤2名・新人あり"></label>
      </div>
      <label>メモ（任意・Scribble可）<textarea id="qs-note" rows="2">${esc(prev.note || '')}</textarea></label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="qs-save">保存（更新済）</button>
    </div>`);

  m.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const input = m.querySelector('#qs-ews');
    input.value = Math.max(0, Math.min(20, (Number(input.value) || 0) + Number(b.dataset.step)));
  }));

  m.addEventListener('segchange', e => {
    if (e.detail.name !== 'race') return;
    const flipping = prev.race_layer === 'reactive' && e.detail.value === 'proactive';
    m.querySelector('#flip-extra').classList.toggle('hidden', !flipping);
  });

  m.querySelector('#qs-save').addEventListener('click', async () => {
    const ews = Number(m.querySelector('#qs-ews').value) || 0;
    const race = segValue(m, 'race') || prev.race_layer;
    const note = m.querySelector('#qs-note').value.trim();
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

// roster 上の race トグル
async function toggleRace(bundle, round, patient) {
  if (patient.race_layer === 'proactive') {
    const ok = await confirmDialog(`${patient.bed_label} を reactive（待機）に戻しますか？`, { okLabel: '戻す' });
    if (!ok) return;
    patient.race_layer = 'reactive';
    await db.put('patients', patient);
    return render();
  }
  // reactive → proactive: フリップイベントとして理由タグ付きで記録
  const m = openModal(`
    <div class="modal-head">${esc(patient.bed_label)} を proactive に切替</div>
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
  toast('race フリップを記録しました');
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
        <label>初期EWS <input type="number" id="pt-ews" inputmode="numeric" min="0" max="20" value="${p.initial_ews ?? 0}" ${patient ? 'disabled' : ''}></label>
      </div>
      <label>診断サマリ（Scribble可）<textarea id="pt-dx" rows="2">${esc(p.dx_summary || '')}</textarea></label>
      <label>鎮静 ${segmented('sedation', [{ value: '1', label: 'あり' }, { value: '0', label: 'なし' }], p.sedation ? '1' : '0')}</label>
      ${patient ? '' : `<label>初期 race 層 ${segmented('race0', [
        { value: 'reactive', label: 'reactive（待機）' },
        { value: 'proactive', label: 'proactive（先回り）' },
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
    const rec = {
      id: p.id || uid(),
      shift_id: shift.id,
      facility: segValue(m, 'facility'),
      bed_label: bed || '-',
      anon_id: anon || '-',
      age: m.querySelector('#pt-age').value ? Number(m.querySelector('#pt-age').value) : null,
      dx_summary: m.querySelector('#pt-dx').value.trim(),
      sedation: segValue(m, 'sedation') === '1',
      initial_ews: patient ? p.initial_ews : (Number(m.querySelector('#pt-ews').value) || 0),
      race_layer: patient ? p.race_layer : (segValue(m, 'race0') || 'reactive'),
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
      <label>trigger source ${segmented('source', [
        { value: 'eRN', label: 'eRN発' }, { value: 'floor', label: '現場発' },
        { value: 'alert', label: 'アラート発' }, { value: 'device', label: 'device起因' },
      ], 'eRN')}</label>
      <label>category ${segmented('category', [
        { value: 'proactive', label: 'proactive' }, { value: 'reactive', label: 'reactive' },
      ], 'proactive')}</label>
      <label>領域 ${segmented('domain', Object.entries(DOMAIN_LABEL).map(([v, l]) => ({ value: v, label: l })), 'resp')}</label>
      <label>outcome ${segmented('outcome', [
        { value: 'needed', label: '介入要だった' }, { value: 'miss', label: '空振り' },
      ], 'needed')}</label>
      <label>内容（任意・Scribble可）<textarea id="iv-note" rows="2"></textarea></label>
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

  shell(`
    <section class="card">
      <div class="detail-head">
        <button class="btn" id="back">← Roster</button>
        <h2>${esc(patient.bed_label)} <span class="muted">${esc(patient.anon_id)} / ${esc(patient.facility)} / ${patient.age != null ? patient.age + '歳' : '年齢-'}</span></h2>
        <div class="detail-actions">
          ${readonly ? '' : `
          <button class="btn" id="pin">${patient.pinned ? '📌 ピン解除' : '📌 ピン留め'}</button>
          <button class="btn" id="edit-pt">編集</button>`}
        </div>
      </div>
      <p class="dx">${esc(patient.dx_summary || '診断サマリ未入力')} / 鎮静${patient.sedation ? 'あり' : 'なし'}</p>
      <div class="race-line">
        <span>race 層:</span>
        <button class="race-toggle ${patient.race_layer}" id="race-toggle" ${readonly ? 'disabled' : ''}>
          ${patient.race_layer === 'proactive' ? 'proactive（先回り）' : 'reactive（待機）'}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>EWS ラウンド推移</h3>
      ${own.length ? `
        <div class="ews-big">${sparkline(own.map(pr => pr.ews), { w: 320, h: 60 })}</div>
        <table class="table">
          <thead><tr><th>R</th><th>時刻</th><th>EWS</th><th>race</th><th>入力</th><th>メモ</th></tr></thead>
          <tbody>${own.map(pr => `
            <tr><td>R${pr.round_number}</td><td>${fmtTime(pr.at)}</td><td>${pr.ews}</td>
            <td>${pr.race_layer === 'proactive' ? 'PRO' : 'REA'}</td>
            <td>${pr.entry_status === 'carried' ? '変化なし' : '更新'}</td>
            <td class="note-cell">${esc(pr.note || '')}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="empty">まだ観測がありません（初期EWS: ${patient.initial_ews ?? 0}）</p>`}
    </section>

    <section class="card">
      <h3>感染治療状況
        ${triggers.device_warn ? '<span class="flag flag-warn">dev</span>' : ''}
        ${triggers.dot_warn ? '<span class="flag flag-warn">DOT</span>' : ''}
        ${triggers.deesc_due ? '<span class="flag flag-due">de-esc</span>' : ''}
      </h3>
      <div class="inf-grid">
        <div><span class="muted">感染源/疑い部位:</span> ${esc(infection.source || '—')}</div>
        <div><span class="muted">起因菌:</span> ${esc((infection.organisms || []).join(', ') || '—')}</div>
        <div><span class="muted">培養:</span> ${cultureLabel(infection.culture_status)}</div>
        <div><span class="muted">de-escalation:</span> ${deescLabel(infection.deescalation)}</div>
        <div><span class="muted">device-days:</span>
          CVC ${dd.cvc || '—'} / 尿カテ ${dd.foley || '—'} / 人工呼吸 ${dd.vent || '—'}</div>
      </div>
      ${(infection.antimicrobials || []).length ? `
      <table class="table">
        <thead><tr><th>抗菌薬</th><th>開始</th><th>DOT</th><th>スペクトラム</th><th></th></tr></thead>
        <tbody>${infection.antimicrobials.map((am, i) => `
          <tr><td>${esc(am.name)}</td><td>${esc(am.start_date)}</td>
          <td>${am.end_date ? `${L.dotDays(am)}（終了）` : L.dotDays(am)}</td>
          <td>${am.spectrum === 'broad' ? '広域' : '狭域'}</td>
          <td>${readonly || am.end_date ? '' : `<button class="btn btn-sm" data-am-stop="${i}">終了</button>`}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="empty">抗菌薬なし</p>'}
      ${(infection.infection_labs || []).length ? `
      <table class="table">
        <thead><tr><th>日時</th><th>体温</th><th>WBC</th><th>CRP</th><th>PCT</th></tr></thead>
        <tbody>${infection.infection_labs.map(l => `
          <tr><td>${fmtDateTime(l.t)}</td><td>${l.temp ?? '—'}</td><td>${l.wbc ?? '—'}</td><td>${l.crp ?? '—'}</td><td>${l.pct ?? '—'}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}
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
    $('#log-iv')?.addEventListener('click', () => openInterventionModal(bundle, activeRound(rounds), patient.id));
    $$('[data-am-stop]').forEach(b => b.addEventListener('click', async () => {
      infection.antimicrobials[Number(b.dataset.amStop)].end_date = todayStr();
      await db.put('infections', infection);
      render();
    }));
  }
}

function emptyInfection(patientId) {
  return {
    patient_id: patientId,
    source: '',
    organisms: [],
    culture_status: 'none',
    antimicrobials: [],
    deescalation: 'none',
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
      <label>起因菌（カンマ区切り・複数可）<input type="text" id="inf-org" value="${esc((inf.organisms || []).join(', '))}"></label>
      <label>培養状況 ${segmented('culture', [
        { value: 'none', label: '未提出' }, { value: 'pending', label: '結果待ち' },
        { value: 'positive', label: '陽性' }, { value: 'negative', label: '陰性' },
      ], inf.culture_status || 'none')}</label>
      <label>de-escalation ${segmented('deesc', [
        { value: 'none', label: '未' }, { value: 'due', label: '検討可' }, { value: 'done', label: '済' },
      ], inf.deescalation || 'none')}</label>
      <fieldset><legend>device-days（開始日から自動加算）</legend>
        ${devRow('cvc', 'CVC')}${devRow('foley', '尿カテ')}${devRow('vent', '人工呼吸')}
      </fieldset>
      <fieldset><legend>抗菌薬（DOT 自動計算）</legend>
        <div id="am-list">${(inf.antimicrobials || []).map((am, i) => `
          <div class="am-row" data-am="${i}">
            <span>${esc(am.name)}（${esc(am.start_date)}〜 ${am.spectrum === 'broad' ? '広域' : '狭域'}${am.end_date ? '・終了' : ''}）</span>
            <button type="button" class="btn btn-sm" data-am-del="${i}">削除</button>
          </div>`).join('')}</div>
        <div class="form-row am-new">
          <input type="text" id="am-name" placeholder="薬剤名">
          <input type="date" id="am-start" value="${todayStr()}">
          ${segmented('am-spec', [{ value: 'broad', label: '広域' }, { value: 'narrow', label: '狭域' }], 'broad')}
          <button type="button" class="btn" id="am-add">追加</button>
        </div>
      </fieldset>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn btn-primary" id="inf-save">保存</button>
    </div>`);

  const renderAms = () => {
    m.querySelector('#am-list').innerHTML = inf.antimicrobials.map((am, i) => `
      <div class="am-row" data-am="${i}">
        <span>${esc(am.name)}（${esc(am.start_date)}〜 ${am.spectrum === 'broad' ? '広域' : '狭域'}${am.end_date ? '・終了' : ''}）</span>
        <button type="button" class="btn btn-sm" data-am-del="${i}">削除</button>
      </div>`).join('');
  };
  m.addEventListener('click', e => {
    const del = e.target.closest('[data-am-del]');
    if (del) {
      inf.antimicrobials.splice(Number(del.dataset.amDel), 1);
      renderAms();
    }
  });
  m.querySelector('#am-add').addEventListener('click', () => {
    const name = m.querySelector('#am-name').value.trim();
    if (!name) return toast('薬剤名を入力してください');
    inf.antimicrobials.push({
      name,
      start_date: m.querySelector('#am-start').value || todayStr(),
      spectrum: segValue(m, 'am-spec') || 'broad',
      end_date: null,
    });
    m.querySelector('#am-name').value = '';
    renderAms();
  });
  m.querySelector('#inf-save').addEventListener('click', async () => {
    inf.source = m.querySelector('#inf-source').value.trim();
    inf.organisms = m.querySelector('#inf-org').value.split(',').map(s => s.trim()).filter(Boolean);
    inf.culture_status = segValue(m, 'culture');
    inf.deescalation = segValue(m, 'deesc');
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
      <h2>シフトサマリ ${esc(shift.date)} ${open ? '<span class="chip chip-open">進行中（プレビュー）</span>' : '<span class="chip chip-muted">確定</span>'}</h2>
      <div class="stat-row">
        <div class="stat"><div class="stat-label">総介入数</div><div class="stat-value">${summary.total_interventions}</div></div>
        <div class="stat"><div class="stat-label">proactive 的中率</div>
          <div class="stat-value">${summary.precision == null ? '—' : Math.round(summary.precision * 100) + '%'}</div>
          <div class="stat-sub">フリップ ${summary.flip_hit}/${summary.flip_total}</div></div>
        <div class="stat"><div class="stat-label">取り逃し（現場発・非proactive）</div><div class="stat-value">${summary.misses}</div></div>
        <div class="stat"><div class="stat-label">ラウンド実施</div><div class="stat-value">${rounds.length}回</div>
          <div class="stat-sub">${rounds.length > 1 ? '間隔 ' + rounds.slice(1).map((r, i) => L.fmtDuration(L.roundInterval(rounds[i], r))).join(' / ') : '—'}</div></div>
      </div>
      <div class="mini-tables">
        ${tbl('trigger source 内訳', summary.by_source, SOURCE_LABEL)}
        ${tbl('category 内訳', summary.by_category)}
        ${tbl('拠点別', summary.by_facility)}
        ${tbl('ラウンド別', summary.by_round)}
        ${tbl('領域別', summary.by_domain, DOMAIN_LABEL)}
      </div>
      <div class="btn-row">
        <button class="btn" id="back-roster">← Roster</button>
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
      <h2>蓄積ダッシュボード <span class="muted">確定シフト ${closed.length}件</span></h2>
      <h3>proactive precision の推移</h3>
      ${lineChart(points)}
    </section>
    <section class="card">
      <h3>条件別 precision（race フリップ分解）</h3>
      <div class="mini-tables">
        ${precTable('拠点', byFacility)}
        ${precTable('時間帯', byTime)}
        ${precTable('鎮静', bySed)}
        ${precTable('選定理由タグ', byTag)}
      </div>
      <h3>eRN 先着率（eRN発 / eRN発＋現場発）</h3>
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
        <button class="btn" id="exp-rf">CSV: race フリップ</button>
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
    { label: 'ews', get: r => r.ews },
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
