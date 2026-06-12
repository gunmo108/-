/* Node上でのスモークテスト:
 * DOMをスタブ化して全JSを読み込み、データ整合性チェックと
 * ラン全体(戦闘/報酬/ショップ/休憩/イベント/編成/ボス)のシミュレーションを行う。
 *   実行: node test/smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = ['js/data.js', 'js/sfx.js', 'js/fx.js', 'js/battle.js', 'js/run.js', 'js/main.js'];

const prelude = `
function __stubEl() {
  return {
    innerHTML: '', textContent: '', className: '', disabled: false, id: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
    offsetWidth: 1,
    addEventListener() {},
  };
}
globalThis.document = {
  getElementById: () => __stubEl(),
  createElement: () => __stubEl(),
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = {};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] !== undefined ? this._m[k] : null; },
  setItem(k, v) { this._m[k] = String(v); },
};
const __origSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => __origSetTimeout(fn, Math.min(ms || 0, 2));
`;

const testCode = `
function assert(cond, msg) {
  if (!cond) { throw new Error('ASSERT FAIL: ' + msg); }
}

(async () => {
  // ---------- データ整合性 ----------
  for (const [pid, p] of Object.entries(PARTS)) {
    assert(SLOTS.includes(p.slot), pid + ': 不正なslot');
    assert(p.hp > 0 && p.rarity >= 1 && p.rarity <= 3, pid + ': hp/rarity不正');
    for (const cid of p.cards) assert(CARDS[cid], pid + ': 未定義カード ' + cid);
  }
  for (const [cid, c] of Object.entries(CARDS)) {
    assert(['shoot', 'melee', 'support', 'none'].includes(c.attr), cid + ': attr不正');
    assert(c.cost >= 0, cid + ': cost不正');
  }
  for (const [eid, e] of Object.entries(ENEMIES)) {
    assert(e.parts.length >= 1, eid + ': parts空');
    const keys = e.parts.map((p) => p.key);
    for (const m of e.moves) assert(keys.includes(m.part), eid + ': moveの部位不明 ' + m.part);
    for (const idx of e.script) assert(e.moves[idx], eid + ': script範囲外 ' + idx);
    const headKey = e.parts[0].key;
    assert(e.moves.some((m) => m.part === headKey), eid + ': 頭部/コアの行動が無い(全部位破壊で詰む)');
  }
  for (const pool of Object.values(ENEMY_POOLS)) {
    for (const id of pool) assert(ENEMIES[id], 'ENEMY_POOLS: 未定義 ' + id);
  }
  for (const types of FLOOR_PLAN) {
    for (const t of types) assert(NODE_INFO[t], 'FLOOR_PLAN: 未定義ノード ' + t);
  }
  for (const id of Object.values(STARTER)) assert(PARTS[id], 'STARTER: 未定義 ' + id);
  for (let r = 1; r <= 3; r++) assert(partsByRarity(r).length > 0, 'レアリティ' + r + 'のパーツ無し');
  console.log('OK: データ整合性');

  // ---------- 戦闘シミュレーション ----------
  async function simBattle() {
    for (let t = 0; t < 60 && B && !B.over; t++) {
      let safety = 25;
      while (!B.over && safety-- > 0) {
        const i = B.hand.findIndex((c) => CARDS[c.defId].cost <= B.energy);
        if (i < 0) break;
        await playCard(i);
        // ターゲットをランダムに切り替えて部位破壊系も通す
        if (B && !B.over && Math.random() < 0.4) {
          setTarget(Math.floor(Math.random() * B.enemy.parts.length));
        }
      }
      if (!B || B.over) break;
      await endTurn();
    }
    await sleep(30);
  }

  // ---------- フルラン ----------
  let cleared = false;
  let died = false;
  newRun();
  assert(run.parts.head && run.parts.rarm && run.parts.larm && run.parts.legs, '初期装備不足');
  while (run.floor <= MAX_FLOOR) {
    const types = FLOOR_PLAN[run.floor - 1];
    const t = types[Math.floor(Math.random() * types.length)];
    if (t === 'battle' || t === 'elite' || t === 'boss') {
      startBattle(t);
      assert(B.deck.length + B.hand.length > 0, 'デッキが空のまま戦闘開始');
      await simBattle();
      if (run.parts.head.hp <= 0) { died = true; break; }
      if (t === 'boss') { cleared = true; break; }
      // 報酬: 取得と編成 / スキップを交互に検証
      if (Math.random() < 0.5) {
        const opts = rollRewardParts(t);
        assert(opts.length === 3, '報酬候補が3つない');
        takeReward(opts[0]);
        closeEquip(); // → advanceFloor
      } else {
        skipReward();
      }
    } else if (t === 'shop') {
      run.credits += 100;
      openShop();
      buyPart(0);
      shopRepair('rarm');
      shopRepairAll();
      advanceFloor();
    } else if (t === 'rest') {
      openRest();
      advanceFloor();
    } else if (t === 'event') {
      openEvent();
      resolveEvent(Math.floor(Math.random() * 2));
      advanceFloor();
    }
    assert(run.floor <= MAX_FLOOR + 1, 'フロアが異常進行');
  }
  console.log('OK: フルラン (floor=' + run.floor + ', cleared=' + cleared + ', died=' + died + ', kills=' + run.kills + ', maxCombo=x' + run.maxCombo + ')');

  // ---------- コンボ倍率の単体検証 ----------
  newRun();
  startBattle('battle');
  B.comboLv = 0; B.comboAttr = null;
  assert(curMult() === 1, '初期倍率は×1のはず');
  B.comboLv = 2; assert(curMult() === 2, 'Lv2は×2のはず');
  B.comboLv = 3; assert(curMult() === 4, 'Lv3は×4のはず');
  B.comboLv = 5; assert(curMult() === 16, 'Lv5は×16のはず');
  B.comboLv = 9; assert(curMult() === 16, '上限×16のはず');
  run.parts.head = mkPart('h_berserk');
  assert(comboCap() === 32, 'バーサクヘッドで上限×32のはず');
  B.comboLv = 9; assert(curMult() === 32, 'バーサク時×32のはず');
  // プレビュー倍率
  B.comboLv = 2; B.comboAttr = 'shoot';
  assert(prospectiveMult(CARDS.rifle) === 4, '同属性プレビューはLv+1の倍率');
  assert(prospectiveMult(CARDS.saber) === 1, '異属性プレビューは×1');
  assert(prospectiveMult(CARDS.charge) === 1, '無属性プレビューは×1');
  console.log('OK: コンボ倍率計算');

  // ---------- 全イベント分岐 ----------
  newRun();
  run.credits = 500;
  for (const ev of EVENTS) {
    for (let c = 0; c < ev.choices.length; c++) {
      currentEvent = ev;
      resolveEvent(c);
    }
  }
  console.log('OK: 全イベント分岐');

  // ---------- ボス直行(高耐久編成) ----------
  newRun();
  run.floor = MAX_FLOOR;
  run.parts.head = mkPart('h_guard');
  run.parts.rarm = mkPart('ra_laser');
  run.parts.larm = mkPart('la_shield');
  run.parts.legs = mkPart('lg_tank');
  startBattle('boss');
  assert(B.enemy.def.boss, 'ボスが出現していない');
  await simBattle();
  console.log('OK: ボス戦シミュレーション (enemy head hp=' + B.enemy.parts[0].hp + ', player head hp=' + run.parts.head.hp + ')');

  console.log('SMOKE TEST: ALL PASS');
})().catch((e) => {
  console.error('SMOKE TEST FAILED:', e);
  process.exit(1);
});
`;

const script = prelude
  + files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n')
  + testCode;

vm.runInThisContext(script, { filename: 'smoke-bundle.js' });
