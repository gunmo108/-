import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

const NOW = new Date('2026-07-12T10:00:00');

test('daysSince: 開始日を1日目として数える', () => {
  assert.equal(L.daysSince('2026-07-12', NOW), 1);
  assert.equal(L.daysSince('2026-07-06', NOW), 7);
  assert.equal(L.daysSince('', NOW), 0);
  assert.equal(L.daysSince('2026-08-01', NOW), 0); // 未来日は0
});

test('deviceDays: active な device のみ加算', () => {
  const dd = L.deviceDays({
    cvc: { active: true, start_date: '2026-07-06' },
    foley: { active: false, start_date: '2026-07-01' },
    vent: { active: true, start_date: '' },
  }, NOW);
  assert.deepEqual(dd, { cvc: 7, foley: 0, vent: 0 });
});

test('dotDays: 継続中は今日まで、終了済みは end_date まで', () => {
  assert.equal(L.dotDays({ start_date: '2026-07-08' }, NOW), 5);
  assert.equal(L.dotDays({ start_date: '2026-07-01', end_date: '2026-07-03' }, NOW), 3);
});

test('infectionTriggers: 3トリガーの自動判定', () => {
  const settings = { device_warn_days: { cvc: 7, foley: 5, vent: 5 }, dot_warn_days: 7 };
  const inf = {
    culture_status: 'positive',
    deescalation: 'none',
    antimicrobials: [{ name: 'MEPM', start_date: '2026-07-05', spectrum: 'broad', end_date: null }],
    devices: { cvc: { active: true, start_date: '2026-07-06' } },
  };
  const t = L.infectionTriggers(inf, settings, NOW);
  assert.equal(t.device_warn, true);  // CVC 7日 >= 7
  assert.equal(t.dot_warn, true);     // DOT 8日 >= 7
  assert.equal(t.deesc_due, true);    // 陽性 + 広域継続 + 未実施
  // de-escalation 済みなら消える
  const t2 = L.infectionTriggers({ ...inf, deescalation: 'done' }, settings, NOW);
  assert.equal(t2.deesc_due, false);
  // 感染情報なし
  assert.deepEqual(L.infectionTriggers(null, settings, NOW),
    { device_warn: false, dot_warn: false, deesc_due: false });
});

test('riskScore: 悪化幅は加点・改善は加点しない', () => {
  const base = L.riskScore({ ews: 5, delta: 0 });
  assert.ok(L.riskScore({ ews: 5, delta: 2 }) > base);
  assert.equal(L.riskScore({ ews: 5, delta: -3 }), base);
  assert.ok(L.riskScore({ ews: 5, delta: 0, triggers: { device_warn: true } }) > base);
});

test('ewsSeries: ラウンド順の系列と直近差分', () => {
  const prs = [
    { round_number: 2, ews: 4 },
    { round_number: 1, ews: 3 },
    { round_number: 3, ews: 7 },
  ];
  const s = L.ewsSeries(prs);
  assert.deepEqual(s.values, [3, 4, 7]);
  assert.equal(s.latest, 7);
  assert.equal(s.delta, 3);
  assert.equal(L.ewsSeries([]).latest, null);
});

test('roundInterval / fmtDuration: 可変ラウンド間隔の実測', () => {
  const r1 = { started_at: '2026-07-12T08:00:00' };
  const r2 = { started_at: '2026-07-12T10:35:00' };
  const ms = L.roundInterval(r1, r2);
  assert.equal(ms, (2 * 60 + 35) * 60000);
  assert.equal(L.fmtDuration(ms), '2時間35分');
  assert.equal(L.fmtDuration(25 * 60000), '25分');
  assert.equal(L.roundInterval(null, r2), null);
  assert.equal(L.fmtDuration(null), '—');
});

test('timeBlock: 7-19時が day', () => {
  assert.equal(L.timeBlock(new Date('2026-07-12T08:00:00')), 'day');
  assert.equal(L.timeBlock(new Date('2026-07-12T22:00:00')), 'night');
  assert.equal(L.timeBlock(new Date('2026-07-12T03:00:00')), 'night');
});

test('computeShiftSummary: precision と取り逃し', () => {
  const patients = [
    { id: 'p1', facility: 'KRC', race_layer: 'proactive' },
    { id: 'p2', facility: 'SMM', race_layer: 'reactive' },
  ];
  const rounds = [{ id: 'r1', round_number: 1 }];
  const patientRounds = [
    { patient_id: 'p1', round_id: 'r1', race_layer: 'proactive' },
    { patient_id: 'p2', round_id: 'r1', race_layer: 'reactive' },
  ];
  const flips = [
    { id: 'f1', patient_id: 'p1', at: '2026-07-12T08:00:00' },
    { id: 'f2', patient_id: 'p2', at: '2026-07-12T08:00:00' },
  ];
  const interventions = [
    // f1 の的中: フリップ後に needed
    { patient_id: 'p1', round_id: 'r1', timestamp: '2026-07-12T09:00:00', trigger_source: 'eRN', category: 'proactive', domain: 'resp', outcome: 'needed' },
    // p2 現場発 & reactive → 取り逃し
    { patient_id: 'p2', round_id: 'r1', timestamp: '2026-07-12T09:30:00', trigger_source: 'floor', category: 'reactive', domain: 'circ', outcome: 'miss' },
  ];
  const s = L.computeShiftSummary({ patients, rounds, patientRounds, interventions, flips });
  assert.equal(s.total_interventions, 2);
  assert.equal(s.flip_total, 2);
  assert.equal(s.flip_hit, 1);
  assert.equal(s.precision, 0.5);
  assert.equal(s.misses, 1);
  assert.ok(s.hitFlipIds.has('f1'));
  assert.equal(s.by_source.floor, 1);
  assert.equal(s.by_round.R1, 2);
});

test('computeShiftSummary: フリップなしなら precision は null', () => {
  const s = L.computeShiftSummary({});
  assert.equal(s.precision, null);
  assert.equal(s.misses, 0);
});

test('precisionTrend / precisionBy / raceWinRate', () => {
  const trend = L.precisionTrend([
    { shift: { date: '2026-07-11' }, summary: { precision: 0.5, flip_total: 2 } },
    { shift: { date: '2026-07-10' }, summary: { precision: 0.25, flip_total: 4 } },
    { shift: { date: '2026-07-09' }, summary: { precision: null } },
  ]);
  assert.deepEqual(trend.map(t => t.date), ['2026-07-10', '2026-07-11']);

  const flips = [
    { features: { facility: 'KRC' }, resulted_in_intervention: true },
    { features: { facility: 'KRC' }, resulted_in_intervention: false },
    { features: { facility: 'SMM' }, resulted_in_intervention: true },
  ];
  const by = L.precisionBy(flips, f => f.features.facility);
  const krc = by.find(r => r.key === 'KRC');
  assert.equal(krc.total, 2);
  assert.equal(krc.precision, 0.5);

  const win = L.raceWinRate([
    { trigger_source: 'eRN', timestamp: '' },
    { trigger_source: 'floor', timestamp: '' },
    { trigger_source: 'alert', timestamp: '' }, // 対象外
  ], () => 'all');
  assert.equal(win[0].rate, 0.5);
});

test('toCSV: エスケープ', () => {
  const csv = L.toCSV(
    [{ a: 'x,y', b: 'he said "hi"' }, { a: null, b: 'plain' }],
    [{ label: 'a', get: r => r.a }, { label: 'b', get: r => r.b }]
  );
  assert.equal(csv, 'a,b\n"x,y","he said ""hi"""\n,plain\n');
});
