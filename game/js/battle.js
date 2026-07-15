'use strict';
/* =========================================================
 * 戦闘システム
 *  - 装備パーツからデッキ構築
 *  - 同属性チェインでダメージ/ブロック/修理が倍々(×2,×4,×8,×16...)
 *  - 部位破壊: 敵頭部破壊=勝利 / 自頭部破壊=敗北
 * ========================================================= */

let B = null; // 戦闘状態

// ---------- パッシブ ----------
function passiveVal(key) {
  let v = 0;
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (p && p.hp > 0) {
      const pas = PARTS[p.defId].passive;
      if (pas && pas[key]) v += pas[key];
    }
  }
  return v;
}
function comboCap() {
  return Math.max(16, passiveVal('comboCap'));
}
function playerEvade() {
  const lg = run.parts.legs;
  if (!lg || lg.hp <= 0) return 0;
  return PARTS[lg.defId].evade || 0;
}
function multFor(lv) {
  return lv <= 1 ? 1 : Math.min(2 ** (lv - 1), comboCap());
}
function curMult() {
  return multFor(B.comboLv);
}
// このカードを今出した場合の倍率(手札プレビュー用)
function prospectiveMult(cd) {
  if (cd.neutral) return 1;
  const lv = (B.comboAttr === cd.attr || B.comboAttr === 'any') ? B.comboLv + 1 : 1;
  return multFor(lv);
}

// ---------- 戦闘開始 ----------
function buildDeck() {
  const deck = [];
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (!p || p.hp <= 0) continue;
    for (const cid of PARTS[p.defId].cards) {
      deck.push({ uid: uid(), defId: cid, src: slot });
    }
  }
  return shuffle(deck);
}

function startBattle(kind) {
  const poolKey = kind === 'boss' ? 'boss' : kind === 'elite' ? 'elite' : null;
  const defId = poolKey ? pick(ENEMY_POOLS[poolKey]) : pick(poolForFloor(run.floor));
  const edef = ENEMIES[defId];
  const scale = edef.boss ? 1 : floorScale(run.floor);
  B = {
    kind, scale,
    enemy: {
      def: edef,
      name: edef.name,
      parts: edef.parts.map((p) => ({
        key: p.key, name: p.name,
        hp: Math.round(p.hp * scale), maxHp: Math.round(p.hp * scale),
      })),
      block: 0, vuln: 0, scriptIdx: 0, intent: null, dmgMul: 1, enraged: false,
    },
    deck: buildDeck(), discard: [], hand: [],
    energy: 0, maxEnergy: 0, block: 0,
    comboAttr: null, comboLv: 0,
    targetIdx: 0,
    turn: 0, over: false, busy: false,
  };
  if (passiveVal('startCombo') > 0) {
    B.comboLv = passiveVal('startCombo');
    B.comboAttr = 'any';
  }
  show('screen-battle');
  setEnemyIntent();
  startPlayerTurn();
  if (kind === 'boss') fxBanner('BOSS<br><span class="banner-sub">Ω-FRAME 起動</span>', 5, 1500);
  else if (kind === 'elite') fxBanner('ELITE', 4, 1100);
}

// ---------- ターン進行 ----------
function startPlayerTurn() {
  B.turn++;
  B.block = passiveVal('turnBlock');
  B.energy = 3 + passiveVal('energy');
  B.maxEnergy = B.energy;
  drawCards(5 + passiveVal('draw'));
  B.busy = false;
  renderBattle();
}

function drawCards(n) {
  for (let i = 0; i < n; i++) {
    if (B.hand.length >= 8) break;
    if (B.deck.length === 0) {
      if (B.discard.length === 0) break;
      B.deck = shuffle(B.discard);
      B.discard = [];
    }
    B.hand.push(B.deck.pop());
  }
}

async function endTurn() {
  if (!B || B.busy || B.over) return;
  B.busy = true;
  SFX.click();
  B.discard.push(...B.hand);
  B.hand = [];
  renderBattle();
  await sleep(350);
  await enemyTurn();
  if (B.over) return;
  startPlayerTurn();
}

// ---------- カードプレイ ----------
async function playCard(i) {
  if (!B || B.busy || B.over) return;
  const ci = B.hand[i];
  if (!ci) return;
  const cd = CARDS[ci.defId];
  if (cd.cost > B.energy) {
    fxPop($('b-energy'), 'エナジー不足', 'warn');
    return;
  }
  B.busy = true;
  B.energy -= cd.cost;
  B.hand.splice(i, 1);

  // --- コンボ更新 ---
  let comboUp = false;
  if (!cd.neutral) {
    if (B.comboAttr === cd.attr || B.comboAttr === 'any') {
      B.comboLv++;
      comboUp = B.comboLv > 1;
    } else {
      B.comboLv = 1;
    }
    B.comboAttr = cd.attr;
  }
  if (cd.chargeCombo) {
    B.comboLv += cd.chargeCombo;
    if (!B.comboAttr) B.comboAttr = 'any';
    comboUp = true;
  }
  const mult = cd.neutral ? 1 : curMult();
  if (comboUp) {
    const m = curMult();
    run.maxCombo = Math.max(run.maxCombo, m);
    SFX.combo(B.comboLv);
    const tier = m >= 16 ? 4 : m >= 8 ? 3 : m >= 4 ? 2 : 1;
    fxBanner(`COMBO <span class="x">×${m}</span>`, tier, 700);
    fxShake(Math.min(B.comboLv, 6));
  }

  // --- 効果適用 ---
  if (cd.energy) B.energy += cd.energy;
  if (cd.draw) drawCards(cd.draw);
  if (cd.block) {
    B.block += cd.block * mult;
    SFX.block();
    fxPop($('p-block'), '+' + cd.block * mult, 'block-fx');
  }
  if (cd.heal) repairWeakest(cd.heal * mult);
  if (cd.vuln) {
    B.enemy.vuln = Math.max(B.enemy.vuln, cd.vuln);
    fxPop($('e-robot'), '解析済 被ダメ+30%', 'warn');
  }
  if (cd.selfHead) {
    const h = run.parts.head;
    h.hp = Math.max(1, h.hp - cd.selfHead);
    fxPop($('p-robot'), '-' + cd.selfHead, 'dmg');
  }
  renderBattle();
  if (cd.dmg) await attackEnemy(cd, mult);
  if (cd.finisher) {
    B.comboLv = 0;
    B.comboAttr = null;
    fxBanner('CHAIN RELEASE', 2, 700);
  }
  B.discard.push(ci);
  B.busy = false;
  renderBattle();
  checkBattleEnd();
}

function firstAliveEnemyPart() {
  // 頭部(index0)以外を優先的にデフォルトターゲットへ
  for (let i = B.enemy.parts.length - 1; i >= 0; i--) {
    if (B.enemy.parts[i].hp > 0) return i;
  }
  return 0;
}

async function attackEnemy(cd, mult) {
  const hits = cd.hits || 1;
  for (let h = 0; h < hits; h++) {
    if (B.enemy.parts[0].hp <= 0) break;
    let tp = B.enemy.parts[B.targetIdx];
    if (!tp || tp.hp <= 0) {
      B.targetIdx = firstAliveEnemyPart();
      tp = B.enemy.parts[B.targetIdx];
    }
    if (!tp || tp.hp <= 0) break;
    let dmg = cd.dmg * mult;
    if (B.enemy.vuln > 0) dmg = Math.round(dmg * 1.3);
    if (!cd.pierce && B.enemy.block > 0) {
      const ab = Math.min(B.enemy.block, dmg);
      B.enemy.block -= ab;
      dmg -= ab;
      if (ab > 0) fxPop($('e-block'), 'BLOCK', 'block-fx');
    }
    cd.attr === 'melee' ? SFX.slash() : SFX.shoot();
    if (dmg > 0) {
      tp.hp = Math.max(0, tp.hp - dmg);
      const el = $('e-part-' + B.targetIdx);
      const cls = mult >= 8 ? 'dmg-huge' : mult >= 2 ? 'dmg-big' : 'dmg';
      fxPop(el, dmg, cls);
      fxFlash(el);
      fxShake(1 + Math.log2(Math.max(1, mult)));
      SFX.hit();
      if (tp.hp <= 0) await onEnemyPartBroken(B.targetIdx);
    }
    // ミサイル飛散: 初撃のみ他部位へ
    if (cd.splash && h === 0 && B.enemy.parts[0].hp > 0) {
      const others = B.enemy.parts.map((p, idx) => ({ p, idx }))
        .filter((o) => o.idx !== B.targetIdx && o.p.hp > 0);
      if (others.length) {
        const o = pick(others);
        const sd = cd.splash * mult;
        o.p.hp = Math.max(0, o.p.hp - sd);
        fxPop($('e-part-' + o.idx), sd, 'dmg');
        if (o.p.hp <= 0) await onEnemyPartBroken(o.idx);
      }
    }
    renderBattle();
    if (hits > 1) await sleep(170);
  }
}

async function onEnemyPartBroken(idx) {
  const tp = B.enemy.parts[idx];
  const el = $('e-part-' + idx);
  SFX.broken();
  fxParticles(el, '#ff5a3c', 18);
  fxPop(el, tp.name + ' 破壊!!', 'dmg-huge');
  fxShake(5);
  if (idx !== 0) run.credits += 6; // 部位破壊ボーナス
  // 破壊された部位を予告していたら行動を組み直す
  if (B.enemy.intent && B.enemy.intent.part === tp.key && idx !== 0) setEnemyIntent();
  // ボスのエンレイジ
  const def = B.enemy.def;
  if (def.enrage && !B.enemy.enraged) {
    const brokenCount = B.enemy.parts.filter((p, i) => i > 0 && p.hp <= 0).length;
    if (brokenCount >= def.enrage.broken) {
      B.enemy.enraged = true;
      B.enemy.dmgMul = def.enrage.mul;
      fxBanner('ENRAGE<br><span class="banner-sub">敵の攻撃力上昇!</span>', 5, 1300);
      if (B.enemy.intent && B.enemy.intent.dmg) {
        B.enemy.intent.shownDmg = Math.round(B.enemy.intent.dmg * B.scale * B.enemy.dmgMul);
      }
    }
  }
  await sleep(300);
}

// ---------- 敵ターン ----------
function pickPlayerTargetSlot() {
  const cands = [];
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (p && p.hp > 0) {
      const w = slot === 'head' ? 1 : 3;
      for (let i = 0; i < w; i++) cands.push(slot);
    }
  }
  return cands.length ? pick(cands) : 'head';
}

function setEnemyIntent() {
  const e = B.enemy;
  const def = e.def;
  let mv = null;
  for (let t = 0; t < def.script.length; t++) {
    const cand = def.moves[def.script[e.scriptIdx % def.script.length]];
    e.scriptIdx++;
    const part = e.parts.find((p) => p.key === cand.part);
    if (part && part.hp > 0) { mv = cand; break; }
  }
  if (!mv) {
    const alive = e.parts.find((p) => p.hp > 0);
    mv = { name: 'もがく', icon: '⚔', part: alive ? alive.key : 'core', dmg: 4 };
  }
  const intent = Object.assign({}, mv);
  if (intent.dmg) {
    intent.shownDmg = Math.round(intent.dmg * B.scale * e.dmgMul);
    intent.targetSlot = pickPlayerTargetSlot();
  }
  if (intent.block) intent.shownBlock = Math.round(intent.block * B.scale);
  if (intent.heal) intent.shownHeal = Math.round(intent.heal * B.scale);
  e.intent = intent;
}

async function enemyTurn() {
  const e = B.enemy;
  e.block = 0;
  if (e.vuln > 0) e.vuln--;
  const mv = e.intent;
  if (!mv) { setEnemyIntent(); return; }

  fxFlash($('e-robot'));
  await sleep(250);

  if (mv.shownBlock) {
    e.block += mv.shownBlock;
    SFX.block();
    fxPop($('e-block'), '+' + mv.shownBlock, 'block-fx');
    renderBattle();
    await sleep(250);
  }
  if (mv.shownHeal) {
    const cands = e.parts.filter((p) => p.hp > 0 && p.hp < p.maxHp);
    if (cands.length) {
      cands.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
      const t = cands[0];
      t.hp = Math.min(t.maxHp, t.hp + mv.shownHeal);
      SFX.heal();
      fxPop($('e-part-' + e.parts.indexOf(t)), '+' + mv.shownHeal, 'heal');
      renderBattle();
      await sleep(250);
    }
  }
  if (mv.jam) {
    if (B.comboLv > 0) {
      B.comboLv = 0;
      B.comboAttr = null;
      SFX.jam();
      fxBanner('JAMMING!!<br><span class="banner-sub">コンボ消失</span>', 3, 1000);
      renderBattle();
      await sleep(350);
    }
  }
  if (mv.shownDmg) {
    const hits = mv.hits || 1;
    for (let h = 0; h < hits; h++) {
      if (B.over) return;
      let slot = mv.targetSlot;
      if (!run.parts[slot] || run.parts[slot].hp <= 0) slot = pickPlayerTargetSlot();
      await hitPlayer(slot, mv.shownDmg, mv.sure);
      if (hits > 1) await sleep(200);
    }
  }
  if (B.over) return;
  renderBattle();
  await sleep(250);
  setEnemyIntent();
  renderBattle();
}

async function hitPlayer(slot, dmg, sure) {
  const part = run.parts[slot];
  if (!part || part.hp <= 0) return;
  const idx = SLOTS.indexOf(slot);
  const el = $('p-part-' + idx);
  // 回避判定
  if (!sure && Math.random() * 100 < playerEvade()) {
    fxPop(el, '回避!', 'evade');
    SFX.block();
    return;
  }
  let d = Math.max(0, dmg - passiveVal('armor'));
  if (B.block > 0) {
    const ab = Math.min(B.block, d);
    B.block -= ab;
    d -= ab;
    if (ab > 0) { SFX.block(); fxPop($('p-block'), '-' + ab, 'block-fx'); }
  }
  if (d > 0) {
    part.hp = Math.max(0, part.hp - d);
    SFX.hit();
    fxPop(el, d, 'dmg-big');
    fxFlash(el);
    fxShake(2.5);
    if (part.hp <= 0) await onPlayerPartBroken(slot);
  }
  renderBattle();
}

async function onPlayerPartBroken(slot) {
  const idx = SLOTS.indexOf(slot);
  const el = $('p-part-' + idx);
  SFX.broken();
  fxParticles(el, '#28e0ff', 18);
  fxShake(6);
  fxBanner(SLOT_LABEL[slot] + ' 大破!!', 4, 1100);
  // 破壊パーツのカードをデッキから消滅させる
  B.deck = B.deck.filter((c) => c.src !== slot);
  B.discard = B.discard.filter((c) => c.src !== slot);
  B.hand = B.hand.filter((c) => c.src !== slot);
  await sleep(400);
  if (slot === 'head') {
    B.over = true;
    await sleep(500);
    gameOver();
  }
}

// ---------- 勝敗 ----------
function checkBattleEnd() {
  if (B.over) return;
  if (B.enemy.parts[0].hp <= 0) battleWin();
}

async function battleWin() {
  B.over = true;
  run.kills++;
  SFX.fanfare();
  fxBanner('TARGET SILENCED', 3, 1300);
  await sleep(1300);
  // 自動修復ナノマシン: 生存パーツ+4
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (p && p.hp > 0) p.hp = Math.min(PARTS[p.defId].hp, p.hp + 4);
  }
  const extra = B.enemy.parts.filter((p, i) => i > 0 && p.hp <= 0).length;
  const credits = (B.kind === 'elite' ? 55 : 28) + extra * 6 + rand(0, 8);
  if (B.kind === 'boss') {
    victory();
  } else {
    openReward(credits, B.kind);
  }
}

// ---------- 戦闘中の修理 ----------
function repairWeakest(amount) {
  let target = null, worst = 1;
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (!p || p.hp <= 0) continue;
    const r = p.hp / PARTS[p.defId].hp;
    if (r < worst) { worst = r; target = { p, slot }; }
  }
  if (!target) return;
  const max = PARTS[target.p.defId].hp;
  const healed = Math.min(max - target.p.hp, amount);
  target.p.hp += healed;
  SFX.heal();
  fxPop($('p-part-' + SLOTS.indexOf(target.slot)), '+' + healed, 'heal');
}

// ---------- ターゲット選択 ----------
function setTarget(idx) {
  if (!B || B.over) return;
  if (B.enemy.parts[idx] && B.enemy.parts[idx].hp > 0) {
    B.targetIdx = idx;
    SFX.click();
    renderBattle();
  }
}

/* =========================================================
 * 戦闘画面レンダリング
 * ========================================================= */

function hpBarHTML(hp, maxHp, cls = '') {
  const r = Math.max(0, hp / maxHp);
  const col = r > 0.5 ? 'ok' : r > 0.25 ? 'mid' : 'low';
  return `<div class="hpbar ${cls}"><div class="hpfill ${col}" style="width:${r * 100}%"></div>` +
         `<span class="hptext">${hp}/${maxHp}</span></div>`;
}

function enemyRobotHTML() {
  const e = B.enemy;
  const single = e.parts.length === 1;
  const box = (idx) => {
    const p = e.parts[idx];
    if (!p) return '<div class="part-box empty"></div>';
    const broken = p.hp <= 0;
    const target = idx === B.targetIdx && !broken;
    return `<div class="part-box foe ${broken ? 'broken' : ''} ${target ? 'targeted' : ''}" id="e-part-${idx}" onclick="setTarget(${idx})">
      <div class="part-label">${p.name}${target ? '<span class="reticle">◎</span>' : ''}</div>
      ${broken ? '<div class="broken-text">破壊</div>' : hpBarHTML(p.hp, p.maxHp)}
    </div>`;
  };
  if (single) return `<div class="robot single">${box(0)}</div>`;
  return `<div class="robot">
    <div class="robot-row">${box(0)}</div>
    <div class="robot-row">${box(1)}<div class="torso foe-torso"></div>${box(2)}</div>
    <div class="robot-row">${box(3)}</div>
  </div>`;
}

function playerRobotHTML() {
  const box = (slot, idx) => {
    const p = run.parts[slot];
    if (!p) return '<div class="part-box empty"></div>';
    const def = PARTS[p.defId];
    const broken = p.hp <= 0;
    return `<div class="part-box you ${broken ? 'broken' : ''}" id="p-part-${idx}" title="${def.name}">
      <div class="part-label">${SLOT_LABEL[slot]}</div>
      ${broken ? '<div class="broken-text">大破</div>' : hpBarHTML(p.hp, def.hp)}
    </div>`;
  };
  return `<div class="robot">
    <div class="robot-row">${box('head', 0)}</div>
    <div class="robot-row">${box('rarm', 1)}<div class="torso you-torso"></div>${box('larm', 2)}</div>
    <div class="robot-row">${box('legs', 3)}</div>
  </div>`;
}

function comboMeterHTML() {
  const m = curMult();
  const attr = B.comboAttr && B.comboAttr !== 'any' ? ATTRS[B.comboAttr] : null;
  const cap = comboCap();
  const next = multFor(B.comboLv + 1);
  const tier = m >= 16 ? 'blazing' : m >= 4 ? 'hot' : '';
  if (B.comboLv === 0) {
    return `<div class="combo-box idle">COMBO <span class="combo-x">─</span><span class="combo-next">同属性を繋いで倍率UP (上限×${cap})</span></div>`;
  }
  return `<div class="combo-box ${tier}">
    ${attr ? `<span class="tag ${attr.cls}">${attr.label}</span>` : '<span class="tag none">FREE</span>'}
    <span class="combo-lv">Lv${B.comboLv}</span>
    <span class="combo-x">×${m}</span>
    <span class="combo-next">${m >= cap ? 'MAX!!' : `続けると ×${next}`}</span>
  </div>`;
}

function cardHTML(ci, i) {
  const cd = CARDS[ci.defId];
  const attr = ATTRS[cd.attr] || ATTRS.none;
  const m = prospectiveMult(cd);
  const playable = cd.cost <= B.energy && !B.busy;
  let preview = '';
  if (cd.dmg) {
    const total = cd.dmg * m * (cd.hits || 1);
    preview = `<div class="card-preview ${m > 1 ? 'boosted' : ''}">⚔ ${total}</div>`;
  } else if (cd.block && !cd.neutral) {
    preview = `<div class="card-preview ${m > 1 ? 'boosted' : ''}">🛡 ${cd.block * m}</div>`;
  } else if (cd.heal) {
    preview = `<div class="card-preview ${m > 1 ? 'boosted' : ''}">✚ ${cd.heal * m}</div>`;
  }
  return `<div class="card ${attr.cls} ${playable ? '' : 'unplayable'}" onclick="playCard(${i})">
    <div class="card-top"><span class="card-cost">${cd.cost}</span><span class="card-attr">${attr.icon} ${attr.label}</span></div>
    <div class="card-name">${cd.name}</div>
    <div class="card-desc">${cd.desc}</div>
    ${preview}
    <div class="card-src">${SLOT_LABEL[ci.src]}</div>
  </div>`;
}

function intentHTML() {
  const mv = B.enemy.intent;
  if (!mv) return '';
  let s = `${mv.icon} ${mv.name}`;
  if (mv.shownDmg) {
    s += ` <b>${mv.shownDmg}${mv.hits ? '×' + mv.hits : ''}</b> → ${SLOT_LABEL[mv.targetSlot] || ''}`;
  }
  if (mv.shownBlock) s += ` 🛡${mv.shownBlock}`;
  if (mv.shownHeal) s += ` ✚${mv.shownHeal}`;
  if (mv.jam) s += ' <span class="jam-warn">⚡コンボ消去</span>';
  return s;
}

function renderBattle() {
  if (!B) return;
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  set('b-floor', `FLOOR ${run.floor}/${MAX_FLOOR}`);
  set('b-credits', `${run.credits} ¢`);
  set('combo-meter', comboMeterHTML());
  set('e-name', B.enemy.name + (B.enemy.vuln > 0 ? ' <span class="vuln-tag">解析済</span>' : ''));
  set('e-intent', intentHTML());
  set('e-robot', enemyRobotHTML());
  set('p-robot', playerRobotHTML());
  set('e-block', B.enemy.block > 0 ? `🛡 ${B.enemy.block}` : '');
  set('p-block', B.block > 0 ? `🛡 ${B.block}` : '');
  set('b-deck', `山札 ${B.deck.length}`);
  set('b-discard', `捨札 ${B.discard.length}`);
  set('b-energy', `<span class="energy-num">${B.energy}</span>/${B.maxEnergy} ⚡`);
  set('hand', B.hand.map((c, i) => cardHTML(c, i)).join(''));
  const btn = $('btn-endturn');
  if (btn) btn.disabled = !!(B.busy || B.over);
}
