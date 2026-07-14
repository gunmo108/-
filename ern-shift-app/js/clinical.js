// 臨床計算・知識モジュール（純粋関数・DOM/DB 非依存・テスト対象）
//
// ⚠️ 重要：本モジュールの判定・計算・薬剤情報はすべて「学習・参考用」であり、
// 最終判断の代替ではない。用量・適応・スペクトラムは施設のアンチバイオグラム、
// 添付文書、薬剤師・ICT・専門医の助言に従うこと。数値は成人・一般的な目安。

export const DISCLAIMER =
  '本表示は学習・参考用です。臨床判断・処方の代替ではありません。施設基準・添付文書・専門家の助言を優先してください。';

// ============================================================
// NEWS2（National Early Warning Score 2, RCP 2017）
// ============================================================
// 各パラメータのカットオフは RCP NEWS2 の公式配点表に準拠。
// 教育ノートは初学者向けの簡潔な根拠。

export const NEWS2_GUIDE = {
  resp_rate: {
    label: '呼吸数',
    unit: '回/分',
    normal: '12–20',
    note: '最も鋭敏な悪化サイン。頻呼吸(≥25)は代謝性アシドーシス代償や呼吸不全の初期に先行することが多い。徐呼吸(≤8)は中枢抑制・切迫呼吸停止。',
  },
  spo2: {
    label: 'SpO₂',
    unit: '%',
    normal: 'Scale1: ≥96 / Scale2(CO₂ナルコーシスリスク): 88–92',
    note: 'Scale2 はII型呼吸不全(COPD等で高CO₂血症リスク)向けの目標域。該当患者のみ主治医指示で使用。',
  },
  o2: {
    label: '酸素投与',
    unit: '',
    normal: 'room air',
    note: '酸素投与中というだけで+2点。「SpO₂は保たれていても酸素を要している」状態を検出する。',
  },
  sbp: {
    label: '収縮期血圧',
    unit: 'mmHg',
    normal: '111–219',
    note: '低血圧(≤90)は3点。ショックの晩期サイン——頻脈・頻呼吸が先行することが多い点に注意。',
  },
  pulse: {
    label: '心拍数',
    unit: '回/分',
    normal: '51–90',
    note: '頻脈は発熱・疼痛・脱水・出血・不整脈など多因子。徐脈(≤40)は薬剤・伝導障害・頭蓋内圧亢進。',
  },
  consciousness: {
    label: '意識(ACVPU)',
    unit: '',
    normal: 'A(清明)',
    note: 'A=清明, C=新規の錯乱/せん妄, V=呼びかけ反応, P=痛み反応, U=無反応。C以下はすべて3点。新規のせん妄も含める。',
  },
  temp: {
    label: '体温',
    unit: '℃',
    normal: '36.1–38.0',
    note: '低体温(≤35)は敗血症・甲状腺機能低下等で3点。高齢者は感染でも発熱しにくい。',
  },
};

// 各サブスコア（0-3）。数値が null/未入力なら null を返し、合計から除外。
export function news2Sub(vitals = {}) {
  const s = {};
  const v = vitals;

  s.resp_rate = band(v.resp_rate, [
    [8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3],
  ]);

  // SpO2: scale 1（既定） / scale 2（高CO2血症リスク）
  if (v.spo2 == null) {
    s.spo2 = null;
  } else if (v.spo2_scale === 2) {
    s.spo2 = spo2Scale2(v.spo2, !!v.on_oxygen);
  } else {
    s.spo2 = band(v.spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]);
  }

  s.o2 = v.on_oxygen == null ? null : (v.on_oxygen ? 2 : 0);

  s.sbp = band(v.sbp, [
    [90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3],
  ]);

  s.pulse = band(v.pulse, [
    [40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3],
  ]);

  s.consciousness = v.consciousness == null ? null
    : (v.consciousness === 'A' ? 0 : 3);

  s.temp = v.temp == null ? null : (
    v.temp <= 35.0 ? 3 :
    v.temp <= 36.0 ? 1 :
    v.temp <= 38.0 ? 0 :
    v.temp <= 39.0 ? 1 : 2
  );

  return s;
}

function band(x, thresholds) {
  if (x == null || isNaN(x)) return null;
  for (const [max, score] of thresholds) if (x <= max) return score;
  return thresholds[thresholds.length - 1][1];
}

// NEWS2 Scale 2（目標 88-92%、CO2ナルコーシスリスク患者）
function spo2Scale2(spo2, onOxygen) {
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  if (!onOxygen) return 0;              // 88%以上かつ室内気は0
  // 酸素投与中:
  if (spo2 <= 92) return 0;
  if (spo2 <= 94) return 1;
  if (spo2 <= 96) return 2;
  return 3;                              // ≥97% + 酸素 = 過剰酸素
}

export function news2(vitals = {}) {
  const sub = news2Sub(vitals);
  const vals = Object.values(sub).filter(v => v != null);
  const total = vals.reduce((a, b) => a + b, 0);
  const measured = vals.length;
  const redFlag = Object.values(sub).some(v => v === 3); // 単一項目3点=red
  let band, action;
  if (measured === 0) { band = 'none'; action = 'バイタル未入力'; }
  else if (total >= 7) { band = 'high'; action = '緊急対応。連続モニタ＋医師/RRT即時。'; }
  else if (total >= 5 || redFlag) { band = 'medium'; action = '至急対応。1時間毎観察＋医師コール。'; }
  else if (total >= 1) { band = 'low'; action = '経過観察強化。4–6時間毎。'; }
  else { band = 'zero'; action = 'ルーチン監視（最低12時間毎）。'; }
  return { total, sub, measured, redFlag, band, action };
}

// ============================================================
// 人工呼吸器・呼吸メカニクス
// ============================================================

// 理想体重 IBW（Devine 式, kg）。身長 cm・性別 'male'|'female'
export function idealBodyWeight(heightCm, sex) {
  if (!heightCm || heightCm <= 0) return null;
  const base = sex === 'female' ? 45.5 : 50;
  const ibw = base + 0.91 * (heightCm - 152.4);
  return Math.max(ibw, base * 0.6); // 極端な低身長でのマイナス回避
}

// 一回換気量の IBW あたり評価。肺保護換気の目標 6 mL/kg（範囲 4–8）
export function tidalVolumeAssessment(vtMl, heightCm, sex) {
  const ibw = idealBodyWeight(heightCm, sex);
  if (!ibw || vtMl == null) return null;
  const perKg = vtMl / ibw;
  let status = 'ok';
  if (perKg > 8) status = 'high';
  else if (perKg < 4) status = 'low';
  else if (perKg > 6.5) status = 'caution';
  return {
    ibw: round1(ibw),
    perKg: round1(perKg),
    target6: Math.round(6 * ibw),      // 6 mL/kg の実容量
    range: [Math.round(4 * ibw), Math.round(8 * ibw)],
    status,
    message: status === 'high' ? `${round1(perKg)} mL/kg は目標6(範囲4–8)を超過。肺傷害(VILI)リスク。`
      : status === 'low' ? `${round1(perKg)} mL/kg は低換気。無気肺・高CO₂に注意。`
      : status === 'caution' ? `${round1(perKg)} mL/kg。目標6 mL/kg にやや高め。`
      : `${round1(perKg)} mL/kg。肺保護域(4–8)内。`,
  };
}

// ドライビングプレッシャー = プラトー圧 − PEEP（cmH₂O）。>15 で死亡率上昇(Amato 2015)
export function drivingPressure(pplat, peep) {
  if (pplat == null || peep == null) return null;
  const dp = pplat - peep;
  return {
    value: round1(dp),
    status: dp > 15 ? 'high' : dp > 13 ? 'caution' : 'ok',
    message: dp > 15 ? `ΔP ${round1(dp)} cmH₂O は>15。死亡率上昇と関連。VT減・PEEP最適化を検討。`
      : dp > 13 ? `ΔP ${round1(dp)} cmH₂O。15に近い。推移に注意。`
      : `ΔP ${round1(dp)} cmH₂O。目標≤15内。`,
  };
}

// ARDSnet Lower PEEP / Higher FiO2 テーブル（FiO2% → 推奨PEEP群 cmH₂O）
const PEEP_TABLE = [
  { fio2: 30, peep: [5] },
  { fio2: 40, peep: [5, 8] },
  { fio2: 50, peep: [8, 10] },
  { fio2: 60, peep: [10] },
  { fio2: 70, peep: [10, 12, 14] },
  { fio2: 80, peep: [14] },
  { fio2: 90, peep: [14, 16, 18] },
  { fio2: 100, peep: [18, 20, 22, 24] },
];

// FiO2(%)に対する推奨PEEP域と、実PEEPの逸脱評価
export function fio2PeepCheck(fio2Percent, peep) {
  if (fio2Percent == null || peep == null) return null;
  // 直近（以上側）の行を採用
  let row = PEEP_TABLE.find(r => fio2Percent <= r.fio2) || PEEP_TABLE[PEEP_TABLE.length - 1];
  const lo = Math.min(...row.peep);
  const hi = Math.max(...row.peep);
  let status = 'ok';
  if (peep < lo - 2) status = 'low';
  else if (peep > hi + 2) status = 'high';
  else if (peep < lo || peep > hi) status = 'caution';
  return {
    recommend: row.peep,
    lo, hi, status,
    message: status === 'ok' ? `FiO₂${fio2Percent}% に対し PEEP ${peep} は推奨域(${lo}–${hi})内。`
      : status === 'low' ? `FiO₂${fio2Percent}% に対し PEEP ${peep} は低め(推奨${lo}–${hi})。虚脱・酸素化悪化に注意。`
      : status === 'high' ? `FiO₂${fio2Percent}% に対し PEEP ${peep} は高め(推奨${lo}–${hi})。過膨張・循環抑制に注意。`
      : `FiO₂${fio2Percent}% に対し PEEP ${peep}(推奨${lo}–${hi})。境界。`,
  };
}

// 分時換気量 MV(L/分) = 呼吸数 × 一回換気量(L)
export function minuteVentilation(respRate, vtMl) {
  if (respRate == null || vtMl == null) return null;
  return round2(respRate * vtMl / 1000);
}

// 目標PaCO2に必要な分時換気量。
// 前提: PaCO2 ∝ 1/肺胞換気量（CO₂産生・死腔一定）。目標MV = 現MV × 現PaCO2 / 目標PaCO2
export function targetMvForPaco2(currentMv, currentPaco2, targetPaco2 = 40) {
  if (!currentMv || !currentPaco2 || !targetPaco2) return null;
  const targetMv = currentMv * currentPaco2 / targetPaco2;
  return {
    currentMv: round2(currentMv),
    currentPaco2,
    targetPaco2,
    targetMv: round2(targetMv),
    deltaMv: round2(targetMv - currentMv),
    message: `現 PaCO₂ ${currentPaco2} を ${targetPaco2} にするには分時換気量 約${round2(targetMv)} L/分（現${round2(currentMv)}から${targetMv >= currentMv ? '+' : ''}${round2(targetMv - currentMv)}）。呼吸数か一回換気量で調整。前提: CO₂産生・死腔一定。`,
  };
}

// ============================================================
// 感染症・抗菌薬（学習/参考用の簡易ナレッジベース）
// ============================================================

// 起因菌ナレッジ。gram: 'pos'|'neg', shape, 主な特徴・耐性ヒント
export const ORGANISMS = [
  { key: 'mrsa', name: 'MRSA', jp: 'メチシリン耐性黄色ブドウ球菌', gram: 'pos', shape: 'cocci', flags: { mrsa: true } },
  { key: 'mssa', name: 'MSSA', jp: 'メチシリン感性黄色ブドウ球菌', gram: 'pos', shape: 'cocci', flags: {} },
  { key: 'strep', name: 'Streptococcus', jp: 'レンサ球菌', gram: 'pos', shape: 'cocci', flags: {} },
  { key: 'enterococcus', name: 'Enterococcus', jp: '腸球菌', gram: 'pos', shape: 'cocci', flags: { enterococcus: true } },
  { key: 'ecoli', name: 'E. coli', jp: '大腸菌', gram: 'neg', shape: 'bacilli', flags: {} },
  { key: 'ecoli_esbl', name: 'E. coli (ESBL)', jp: 'ESBL産生大腸菌', gram: 'neg', shape: 'bacilli', flags: { esbl: true } },
  { key: 'klebsiella', name: 'Klebsiella', jp: 'クレブシエラ', gram: 'neg', shape: 'bacilli', flags: {} },
  { key: 'klebsiella_esbl', name: 'Klebsiella (ESBL)', jp: 'ESBL産生クレブシエラ', gram: 'neg', shape: 'bacilli', flags: { esbl: true } },
  { key: 'pseudomonas', name: 'P. aeruginosa', jp: '緑膿菌', gram: 'neg', shape: 'bacilli', flags: { pseudomonas: true } },
  { key: 'enterobacter', name: 'Enterobacter', jp: 'エンテロバクター', gram: 'neg', shape: 'bacilli', flags: { ampc: true } },
  { key: 'anaerobe', name: 'Anaerobes', jp: '嫌気性菌', gram: 'neg', shape: '-', flags: { anaerobe: true } },
  { key: 'candida', name: 'Candida', jp: 'カンジダ', gram: 'fungus', shape: '-', flags: { fungus: true } },
];

// グラム染色所見のガイド（初学者向け）
export const GRAM_GUIDE = [
  { key: 'gpc_cluster', label: 'GPC ブドウ状(cluster)', hint: 'ブドウ球菌を想起。黄色ブドウ球菌ならMRSA/MSSAの別が治療を分ける。' },
  { key: 'gpc_chain', label: 'GPC 連鎖状(chain)', hint: 'レンサ球菌・腸球菌を想起。腸球菌はセフェム無効。' },
  { key: 'gnr', label: 'GNR(グラム陰性桿菌)', hint: '腸内細菌目・緑膿菌など。ESBL/AmpC/緑膿菌かで薬剤選択が変わる。' },
  { key: 'gpr', label: 'GPR(グラム陽性桿菌)', hint: 'リステリア・クロストリジウム等。文脈依存。' },
  { key: 'gnc', label: 'GNC(グラム陰性球菌)', hint: '髄膜炎菌・モラクセラ等。' },
  { key: 'yeast', label: '酵母様真菌', hint: 'カンジダ等。抗菌薬では無効、抗真菌薬を検討。' },
];

// 抗菌薬ナレッジ。spectrum は主要カバー、broadness 1(狭)–5(広)、
// renalAdjust: 腎機能で用量調整を要するか、crrt: CRRT下の注意
export const ANTIMICROBIALS = [
  { key: 'abpc', name: 'ABPC', jp: 'アンピシリン', cls: 'ペニシリン',
    spectrum: { gramPos: true, enterococcus: true, anaerobe: false, listeria: true }, broadness: 2,
    renalAdjust: true, crrt: '用量調整要', note: '腸球菌・リステリアに有効。GNRカバーは限定的。' },
  { key: 'cez', name: 'CEZ', jp: 'セファゾリン', cls: '第1世代セフェム',
    spectrum: { gramPos: true, mssa: true }, broadness: 2,
    renalAdjust: true, crrt: '用量調整要', note: 'MSSA菌血症の第一選択。MRSA・腸球菌・多くのGNRは無効。' },
  { key: 'ctrx', name: 'CTRX', jp: 'セフトリアキソン', cls: '第3世代セフェム',
    spectrum: { gramPos: true, gramNeg: true, mssa: true }, broadness: 3,
    renalAdjust: false, crrt: '腎排泄少・調整基本不要（胆汁排泄）', note: '市中肺炎・腎盂腎炎等に汎用。緑膿菌・ESBL・腸球菌は無効。' },
  { key: 'cfpm', name: 'CFPM', jp: 'セフェピム', cls: '第4世代セフェム',
    spectrum: { gramPos: true, gramNeg: true, pseudomonas: true, ampc: true }, broadness: 4,
    renalAdjust: true, crrt: '用量調整要・脳症に注意', note: '緑膿菌・AmpC産生菌をカバー。ESBLは不確実。腎機能低下で神経毒性。' },
  { key: 'tazpipc', name: 'TAZ/PIPC', jp: 'ピペラシリン/タゾバクタム', cls: 'βラクタム/阻害剤',
    spectrum: { gramPos: true, gramNeg: true, pseudomonas: true, anaerobe: true, enterococcus: true }, broadness: 4,
    renalAdjust: true, crrt: '用量調整要', note: '緑膿菌+嫌気性菌+腸球菌。広域。ESBLは重症では非推奨。' },
  { key: 'mepm', name: 'MEPM', jp: 'メロペネム', cls: 'カルバペネム',
    spectrum: { gramPos: true, gramNeg: true, pseudomonas: true, anaerobe: true, esbl: true, ampc: true }, broadness: 5,
    renalAdjust: true, crrt: '用量調整要', note: '最広域の一つ。ESBL確実。腸球菌faecium・MRSA・非定型は無効。乱用は耐性化を招く。' },
  { key: 'vcm', name: 'VCM', jp: 'バンコマイシン', cls: 'グリコペプチド',
    spectrum: { gramPos: true, mrsa: true, enterococcus: true }, broadness: 2,
    renalAdjust: true, crrt: 'TDM必須・CRRTで除去される', note: 'MRSA第一選択。GNRは無効。TDM(トラフ/AUC)で腎障害回避。' },
  { key: 'linezolid', name: 'LZD', jp: 'リネゾリド', cls: 'オキサゾリジノン',
    spectrum: { gramPos: true, mrsa: true, vre: true }, broadness: 2,
    renalAdjust: false, crrt: '調整不要', note: 'MRSA・VRE。腎調整不要だが長期で血小板減少・乳酸アシドーシス。' },
  { key: 'mnz', name: 'MNZ', jp: 'メトロニダゾール', cls: 'ニトロイミダゾール',
    spectrum: { anaerobe: true }, broadness: 1,
    renalAdjust: false, crrt: '調整不要', note: '嫌気性菌・C.difficile。好気性GNR/GPCは無効。' },
  { key: 'lvfx', name: 'LVFX', jp: 'レボフロキサシン', cls: 'フルオロキノロン',
    spectrum: { gramPos: true, gramNeg: true, pseudomonas: true, atypical: true }, broadness: 3,
    renalAdjust: true, crrt: '用量調整要', note: '非定型カバー・経口良好。耐性増加・腱障害・QT延長に注意。' },
  { key: 'micafungin', name: 'MCFG', jp: 'ミカファンギン', cls: 'キャンディン',
    spectrum: { fungus: true }, broadness: 2,
    renalAdjust: false, crrt: '調整不要', note: 'カンジダ第一選択級。腎調整不要。' },
];

export function findAntimicrobial(nameOrKey) {
  if (!nameOrKey) return null;
  const q = String(nameOrKey).toLowerCase().trim();
  return ANTIMICROBIALS.find(a =>
    a.key === q || a.name.toLowerCase() === q || a.jp === nameOrKey) || null;
}

export function findOrganism(nameOrKey) {
  if (!nameOrKey) return null;
  const q = String(nameOrKey).toLowerCase().trim();
  return ORGANISMS.find(o =>
    o.key === q || o.name.toLowerCase() === q || o.jp === nameOrKey) || null;
}

// ある抗菌薬が指定の起因菌をカバーするか（参考ロジック）
export function covers(amKey, organism) {
  const am = findAntimicrobial(amKey);
  const org = typeof organism === 'string' ? findOrganism(organism) : organism;
  if (!am || !org) return null;
  const sp = am.spectrum || {};
  const f = org.flags || {};
  if (f.fungus) return !!sp.fungus;
  if (f.mrsa) return !!sp.mrsa;                              // MRSAは抗MRSA薬のみ
  if (f.enterococcus) return !!(sp.enterococcus || sp.mrsa);// 腸球菌: ABPC/VCM/LZD等
  if (f.esbl) return !!(sp.esbl);                           // ESBL: 実質カルバペネム
  if (f.pseudomonas) return !!sp.pseudomonas;               // 緑膿菌: 抗緑膿菌薬
  if (f.anaerobe) return !!sp.anaerobe;
  if (org.gram === 'neg') return !!(sp.gramNeg || sp.pseudomonas || sp.esbl);
  if (org.gram === 'pos') return !!(sp.gramPos || sp.mrsa);
  return null;
}

// 抗菌薬適正評価。参考のみ。
// input: { antimicrobials:[{name,...}], organisms:[key|obj], renal:{crcl, crrt(bool)} }
export function assessAntibiotics({ antimicrobials = [], organisms = [], renal = {} } = {}) {
  const findings = [];
  const activeAms = antimicrobials.filter(a => !a.end_date);
  const amKeys = activeAms.map(a => findAntimicrobial(a.name)).filter(Boolean);
  const orgs = organisms.map(o => (typeof o === 'string' ? findOrganism(o) : o)).filter(Boolean);

  // 1. カバー漏れ: 同定菌をどの薬もカバーしていない
  for (const org of orgs) {
    const covered = amKeys.some(am => covers(am.key, org));
    if (amKeys.length && !covered) {
      findings.push({
        level: 'critical', kind: 'gap',
        message: `${org.jp}(${org.name}) をカバーする抗菌薬が現行にありません。スペクトラム拡大を検討。`,
      });
    }
  }

  // 2. 腎機能・CRRT下の用量チェック
  const needRenal = amKeys.filter(a => a.renalAdjust);
  const lowRenal = renal.crrt || (renal.crcl != null && renal.crcl < 50);
  if (needRenal.length && lowRenal) {
    findings.push({
      level: 'warning', kind: 'renal',
      message: `腎機能低下${renal.crrt ? '/血液浄化(CRRT)' : `(CrCl ${renal.crcl})`}下で用量調整を要する薬剤: ${needRenal.map(a => a.name).join('・')}。${renal.crrt ? 'VCM等はCRRTで除去されTDM必須。' : ''}用量・投与間隔を確認。`,
    });
  }
  // VCM は同定に関わらずTDM喚起
  const vcm = amKeys.find(a => a.key === 'vcm');
  if (vcm && !lowRenal) {
    findings.push({ level: 'info', kind: 'tdm', message: 'VCM はトラフ/AUC の TDM で腎障害を回避。' });
  }

  // 3. 過剰(de-escalation 余地): 広域薬使用中に、耐性菌が同定されていない
  const hasBroad = amKeys.filter(a => a.broadness >= 4);
  const hasResistant = orgs.some(o => o.flags.mrsa || o.flags.esbl || o.flags.pseudomonas);
  if (hasBroad.length && orgs.length && !hasResistant) {
    findings.push({
      level: 'warning', kind: 'deescalation',
      message: `広域薬(${hasBroad.map(a => a.name).join('・')})使用中だが耐性菌の同定なし。培養結果に基づく de-escalation(狭域化)を検討。`,
    });
  }
  // 抗MRSA薬あるがMRSA/腸球菌が出ていない
  const antiMrsa = amKeys.filter(a => a.spectrum.mrsa);
  const needMrsa = orgs.some(o => o.flags.mrsa || o.flags.enterococcus);
  if (antiMrsa.length && orgs.length && !needMrsa) {
    findings.push({
      level: 'info', kind: 'deescalation',
      message: `抗MRSA薬(${antiMrsa.map(a => a.name).join('・')})継続中だがMRSA/腸球菌の同定なし。中止可否を検討。`,
    });
  }

  // 4. 冗長: 嫌気性カバーの重複（例 MEPM/TAZ-PIPC + MNZ）
  const antiAnaerobe = amKeys.filter(a => a.spectrum.anaerobe);
  if (antiAnaerobe.length >= 2) {
    findings.push({
      level: 'info', kind: 'redundant',
      message: `嫌気性菌カバーが重複(${antiAnaerobe.map(a => a.name).join('・')})。MNZ等の重複投与は不要な場合が多い。`,
    });
  }

  return findings;
}

// ============================================================
// 付録: ベッドサイド計算ツール
// ============================================================

// 濃度 (mg/mL) = 薬剤量(mg) / 溶液量(mL)
export function concentration(drugMg, solutionMl) {
  if (!drugMg || !solutionMl) return null;
  return drugMg / solutionMl;
}

// γ (µg/kg/min) → 流量 (mL/h)
export function gammaToRate(gamma, concMgPerMl, weightKg) {
  if (gamma == null || !concMgPerMl || !weightKg) return null;
  const ugPerMin = gamma * weightKg;            // µg/min
  const mlH = ugPerMin * 60 / (concMgPerMl * 1000);
  return round2(mlH);
}

// 流量 (mL/h) → γ (µg/kg/min)
export function rateToGamma(rateMlH, concMgPerMl, weightKg) {
  if (rateMlH == null || !concMgPerMl || !weightKg) return null;
  const ugPerMin = rateMlH * concMgPerMl * 1000 / 60;
  return round2(ugPerMin / weightKg);
}

// クレアチニンクリアランス（Cockcroft-Gault, mL/分）
// scr: 血清クレアチニン mg/dL
export function crClCockcroft(age, weightKg, scr, sex) {
  if (!age || !weightKg || !scr) return null;
  let v = (140 - age) * weightKg / (72 * scr);
  if (sex === 'female') v *= 0.85;
  return round1(v);
}

// ============================================================
// 補助
// ============================================================
function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
