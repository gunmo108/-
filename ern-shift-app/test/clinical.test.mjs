import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/clinical.js';

test('NEWS2: 正常バイタルは0点・ルーチン', () => {
  const r = C.news2({ resp_rate: 16, spo2: 98, on_oxygen: false, sbp: 120, pulse: 70, consciousness: 'A', temp: 36.8 });
  assert.equal(r.total, 0);
  assert.equal(r.band, 'zero');
  assert.equal(r.redFlag, false);
  assert.equal(r.measured, 7);
});

test('NEWS2: 各サブスコアが配点表通り', () => {
  const s = C.news2Sub({ resp_rate: 26, spo2: 91, on_oxygen: true, sbp: 90, pulse: 131, consciousness: 'V', temp: 35.0 });
  assert.equal(s.resp_rate, 3);      // ≥25
  assert.equal(s.spo2, 3);           // ≤91 scale1
  assert.equal(s.o2, 2);             // 酸素
  assert.equal(s.sbp, 3);            // ≤90
  assert.equal(s.pulse, 3);          // ≥131
  assert.equal(s.consciousness, 3);  // V
  assert.equal(s.temp, 3);           // ≤35
});

test('NEWS2: 境界値', () => {
  assert.equal(C.news2Sub({ resp_rate: 20 }).resp_rate, 0);
  assert.equal(C.news2Sub({ resp_rate: 21 }).resp_rate, 2);
  assert.equal(C.news2Sub({ pulse: 90 }).pulse, 0);
  assert.equal(C.news2Sub({ pulse: 91 }).pulse, 1);
  assert.equal(C.news2Sub({ temp: 38.0 }).temp, 0);
  assert.equal(C.news2Sub({ temp: 38.1 }).temp, 1);
  assert.equal(C.news2Sub({ sbp: 111 }).sbp, 0);
  assert.equal(C.news2Sub({ sbp: 110 }).sbp, 1);
});

test('NEWS2: 単一項目3点でmedium(red flag)', () => {
  const r = C.news2({ resp_rate: 16, spo2: 98, on_oxygen: false, sbp: 90, pulse: 70, consciousness: 'A', temp: 36.8 });
  assert.equal(r.sub.sbp, 3);
  assert.equal(r.redFlag, true);
  assert.equal(r.band, 'medium');
});

test('NEWS2: 合計7以上でhigh', () => {
  const r = C.news2({ resp_rate: 26, spo2: 92, on_oxygen: true, sbp: 100, pulse: 115, consciousness: 'A', temp: 39.5 });
  assert.ok(r.total >= 7);
  assert.equal(r.band, 'high');
});

test('NEWS2: 未入力項目は合計から除外', () => {
  const r = C.news2({ resp_rate: 26 });
  assert.equal(r.total, 3);
  assert.equal(r.measured, 1);
});

test('NEWS2 Scale2: 酸素下で97%以上は過剰酸素3点', () => {
  assert.equal(C.news2Sub({ spo2: 90, spo2_scale: 2, on_oxygen: false }).spo2, 0);
  assert.equal(C.news2Sub({ spo2: 98, spo2_scale: 2, on_oxygen: true }).spo2, 3);
  assert.equal(C.news2Sub({ spo2: 86, spo2_scale: 2 }).spo2, 1);
});

test('IBW: Devine式（男女・152.4cmで基準値）', () => {
  assert.equal(Math.round(C.idealBodyWeight(152.4, 'male')), 50);
  assert.equal(Math.round(C.idealBodyWeight(152.4, 'female') * 10) / 10, 45.5);
  assert.equal(Math.round(C.idealBodyWeight(170, 'male') * 10) / 10, 66); // 50+0.91*17.6=66.0
});

test('一回換気量: 6mL/kg目標・逸脱判定', () => {
  const ibw = C.idealBodyWeight(170, 'male'); // ≈66kg
  const ok = C.tidalVolumeAssessment(Math.round(6 * ibw), 170, 'male');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.perKg, 6);
  const high = C.tidalVolumeAssessment(Math.round(9 * ibw), 170, 'male');
  assert.equal(high.status, 'high');
  const low = C.tidalVolumeAssessment(Math.round(3 * ibw), 170, 'male');
  assert.equal(low.status, 'low');
});

test('ドライビングプレッシャー: >15で警告', () => {
  assert.equal(C.drivingPressure(30, 10).value, 20);
  assert.equal(C.drivingPressure(30, 10).status, 'high');
  assert.equal(C.drivingPressure(22, 10).status, 'ok');
  assert.equal(C.drivingPressure(25, 10).status, 'caution'); // 15
  assert.equal(C.drivingPressure(26, 10).status, 'high');    // 16
});

test('FiO2/PEEPテーブル: 逸脱評価', () => {
  assert.equal(C.fio2PeepCheck(60, 10).status, 'ok');   // 推奨[10]
  assert.equal(C.fio2PeepCheck(60, 5).status, 'low');
  assert.equal(C.fio2PeepCheck(100, 20).status, 'ok');  // 推奨18-24
  assert.equal(C.fio2PeepCheck(30, 12).status, 'high'); // 推奨[5]
});

test('分時換気量とPaCO2目標', () => {
  assert.equal(C.minuteVentilation(20, 500), 10);
  const t = C.targetMvForPaco2(10, 60, 40);
  assert.equal(t.targetMv, 15);       // 10*60/40
  assert.equal(t.deltaMv, 5);
});

test('抗菌薬: カバー判定', () => {
  assert.equal(C.covers('cez', 'mssa'), true);
  assert.equal(C.covers('cez', 'mrsa'), false);
  assert.equal(C.covers('vcm', 'mrsa'), true);
  assert.equal(C.covers('vcm', 'ecoli'), false);
  assert.equal(C.covers('mepm', 'ecoli_esbl'), true);
  assert.equal(C.covers('ctrx', 'ecoli_esbl'), false);
  assert.equal(C.covers('ctrx', 'pseudomonas'), false);
  assert.equal(C.covers('tazpipc', 'pseudomonas'), true);
  assert.equal(C.covers('mepm', 'candida'), false);
  assert.equal(C.covers('micafungin', 'candida'), true);
});

test('抗菌薬適正: カバー漏れ検出', () => {
  const f = C.assessAntibiotics({
    antimicrobials: [{ name: 'CTRX' }],
    organisms: ['pseudomonas'],
  });
  assert.ok(f.some(x => x.kind === 'gap' && x.level === 'critical'));
});

test('抗菌薬適正: 腎機能低下/CRRTで用量注意', () => {
  const f = C.assessAntibiotics({
    antimicrobials: [{ name: 'MEPM' }, { name: 'VCM' }],
    organisms: ['mrsa'],
    renal: { crrt: true },
  });
  assert.ok(f.some(x => x.kind === 'renal'));
});

test('抗菌薬適正: 耐性菌なしでの広域→de-escalation提案', () => {
  const f = C.assessAntibiotics({
    antimicrobials: [{ name: 'MEPM' }],
    organisms: ['ecoli'], // 感性大腸菌
    renal: { crcl: 90 },
  });
  assert.ok(f.some(x => x.kind === 'deescalation'));
});

test('抗菌薬適正: 嫌気カバー重複', () => {
  const f = C.assessAntibiotics({
    antimicrobials: [{ name: 'MEPM' }, { name: 'MNZ' }],
    organisms: [],
  });
  assert.ok(f.some(x => x.kind === 'redundant'));
});

test('終了した抗菌薬(end_date)は評価対象外', () => {
  const f = C.assessAntibiotics({
    antimicrobials: [{ name: 'CTRX', end_date: '2026-07-01' }],
    organisms: ['pseudomonas'],
  });
  // 現行薬が無いのでカバー漏れ判定は出ない（amKeys.length===0）
  assert.equal(f.some(x => x.kind === 'gap'), false);
});
