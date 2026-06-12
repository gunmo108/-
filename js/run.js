'use strict';
/* =========================================================
 * ラン進行: マップ / 報酬 / ショップ / 休憩 / イベント / 編成 / 勝敗
 * ========================================================= */

let run = null;
let equipReturn = null; // 編成画面を閉じた後の遷移先

function mkPart(defId) {
  return { uid: uid(), defId, hp: PARTS[defId].hp };
}

function newRun() {
  run = {
    floor: 1,
    credits: 30,
    parts: {
      head: mkPart(STARTER.head),
      rarm: mkPart(STARTER.rarm),
      larm: mkPart(STARTER.larm),
      legs: mkPart(STARTER.legs),
    },
    inventory: [],
    kills: 0,
    maxCombo: 1,
  };
}

// ---------- 共通HUD ----------
function hudHTML(showEquip) {
  return `<span class="hud-chip">FLOOR ${run.floor}/${MAX_FLOOR}</span>
    <span class="hud-chip gold">${run.credits} ¢</span>
    ${showEquip ? '<button class="btn small" onclick="openEquip(null)">機体編成</button>' : ''}`;
}

// ---------- マップ ----------
function renderMap() {
  show('screen-map');
  $('map-hud').innerHTML = hudHTML(true);
  // フロアトラック
  let track = '';
  for (let f = MAX_FLOOR; f >= 1; f--) {
    const types = FLOOR_PLAN[f - 1];
    const icons = types.map((t) => NODE_INFO[t].icon).join(' / ');
    const cls = f === run.floor ? 'current' : f < run.floor ? 'done' : '';
    track += `<div class="track-row ${cls}"><span class="track-num">${f}</span><span class="track-icons">${icons}</span></div>`;
  }
  $('map-track').innerHTML = `<div class="track-title">ROUTE</div>` + track;
  // 現フロアの選択肢
  $('map-floor-title').textContent = `FLOOR ${run.floor} ── 進行ルートを選択`;
  const types = FLOOR_PLAN[run.floor - 1];
  $('map-choices').innerHTML = types.map((t) => {
    const info = NODE_INFO[t];
    let sub = '';
    if (t === 'battle') sub = '敵性機体と交戦。撃破でパーツとクレジットを入手';
    if (t === 'elite') sub = '危険な強敵。報酬は高レアリティ確定';
    if (t === 'shop') sub = 'パーツ購入と機体修理';
    if (t === 'rest') sub = '全パーツのHPを45%回復(大破も復旧)';
    if (t === 'event') sub = '何が起こるかわからない';
    if (t === 'boss') sub = '最終目標 Ω-FRAME。撃破せよ';
    return `<button class="node-btn node-${t}" onclick="enterNode('${t}')">
      <span class="node-icon">${info.icon}</span>
      <span class="node-label">${info.label}</span>
      <span class="node-sub">${sub}</span>
    </button>`;
  }).join('');
  // 機体サマリ
  $('map-robot').innerHTML = `<div class="panel-title">現在の機体</div>` + robotSummaryHTML();
}

function robotSummaryHTML() {
  return SLOTS.map((slot) => {
    const p = run.parts[slot];
    if (!p) return '';
    const def = PARTS[p.defId];
    const broken = p.hp <= 0;
    return `<div class="sum-row ${broken ? 'broken' : ''}">
      <span class="sum-slot">${SLOT_LABEL[slot]}</span>
      <span class="sum-name">${def.name}</span>
      ${broken ? '<span class="broken-text">大破</span>' : hpBarHTML(p.hp, def.hp, 'slim')}
    </div>`;
  }).join('');
}

function enterNode(type) {
  SFX.click();
  if (type === 'battle') startBattle('battle');
  else if (type === 'elite') startBattle('elite');
  else if (type === 'boss') startBattle('boss');
  else if (type === 'shop') openShop();
  else if (type === 'rest') openRest();
  else if (type === 'event') openEvent();
}

function advanceFloor() {
  run.floor++;
  renderMap();
}

// ---------- 汎用パネル ----------
function openPanel(bodyHTML, withHud = true) {
  show('screen-panel');
  $('panel-hud').innerHTML = withHud ? hudHTML(false) : '';
  $('panel-body').innerHTML = bodyHTML;
}

// ---------- 報酬 ----------
function rollRewardParts(kind) {
  const w = kind === 'elite'
    ? { 1: 0, 2: 70, 3: 30 }
    : run.floor <= 4 ? { 1: 70, 2: 27, 3: 3 }
    : run.floor <= 8 ? { 1: 45, 2: 45, 3: 10 }
    : { 1: 25, 2: 55, 3: 20 };
  const opts = [];
  let guard = 30;
  while (opts.length < 3 && guard-- > 0) {
    const roll = rand(1, 100);
    const r = roll <= w[1] ? 1 : roll <= w[1] + w[2] ? 2 : 3;
    const id = pick(partsByRarity(r));
    if (!opts.includes(id)) opts.push(id);
  }
  return opts;
}

function openReward(credits, kind) {
  run.credits += credits;
  SFX.coin();
  const opts = rollRewardParts(kind);
  openPanel(`
    <h2 class="panel-h">戦闘勝利</h2>
    <p class="panel-p">+${credits} ¢ を回収 / 生存パーツ自動修復+4</p>
    <p class="panel-p">回収パーツを1つ選択:</p>
    <div class="option-row">
      ${opts.map((id) => `<div class="part-card" onclick="takeReward('${id}')">${partInfoHTML(id)}</div>`).join('')}
    </div>
    <button class="btn ghost" onclick="skipReward()">受け取らない(+10¢)</button>
  `);
}

function takeReward(defId) {
  SFX.coin();
  run.inventory.push(mkPart(defId));
  openEquip(() => advanceFloor());
}

function skipReward() {
  run.credits += 10;
  SFX.click();
  advanceFloor();
}

function partInfoHTML(defId, inst = null) {
  const def = PARTS[defId];
  const cards = def.cards.map((cid) => {
    const cd = CARDS[cid];
    const a = ATTRS[cd.attr] || ATTRS.none;
    return `<span class="mini-card ${a.cls}">${cd.name}</span>`;
  }).join('');
  const hp = inst ? `${inst.hp}/${def.hp}` : `${def.hp}`;
  return `<div class="pc-head">
      <span class="pc-slot">${SLOT_LABEL[def.slot]}</span>
      <span class="pc-rarity r${def.rarity}">${RARITY_LABEL[def.rarity]}</span>
    </div>
    <div class="pc-name">${def.name}</div>
    <div class="pc-hp">HP ${hp}${def.evade != null ? ` / 回避${def.evade}%` : ''}</div>
    <div class="pc-cards">${cards}</div>
    <div class="pc-desc">${def.desc}</div>`;
}

// ---------- 編成 ----------
function openEquip(onDone) {
  equipReturn = onDone;
  renderEquip();
}

function renderEquip() {
  const slotsHTML = SLOTS.map((slot) => {
    const p = run.parts[slot];
    return `<div class="equip-slot">
      <div class="equip-slot-title">${SLOT_LABEL[slot]}</div>
      ${p ? `<div class="part-card equipped">${partInfoHTML(p.defId, p)}</div>` : '<div class="part-card empty">なし</div>'}
    </div>`;
  }).join('');
  const invHTML = run.inventory.length
    ? run.inventory.map((p, i) =>
        `<div class="part-card inv" onclick="equipFromInv(${i})">${partInfoHTML(p.defId, p)}<div class="pc-action">クリックで装備</div></div>`
      ).join('')
    : '<p class="panel-p dim">倉庫は空だ。戦闘報酬やショップでパーツを集めよう。</p>';
  openPanel(`
    <h2 class="panel-h">機体編成</h2>
    <p class="panel-p">装備パーツのカードがそのまま戦闘デッキになる。パーツのHPは引き継がれる。</p>
    <div class="equip-grid">${slotsHTML}</div>
    <h3 class="panel-h3">倉庫(${run.inventory.length})</h3>
    <div class="option-row wrap">${invHTML}</div>
    <button class="btn big" onclick="closeEquip()">${equipReturn ? '出 発' : '戻 る'}</button>
  `);
}

function equipFromInv(i) {
  const p = run.inventory[i];
  if (!p) return;
  SFX.click();
  const slot = PARTS[p.defId].slot;
  run.inventory.splice(i, 1);
  const old = run.parts[slot];
  if (old) run.inventory.push(old);
  run.parts[slot] = p;
  renderEquip();
}

function closeEquip() {
  SFX.click();
  const cb = equipReturn;
  equipReturn = null;
  if (cb) cb();
  else renderMap();
}

// ---------- ショップ ----------
let shopStock = null;

function rollShopStock() {
  const w = run.floor <= 4 ? { 1: 55, 2: 38, 3: 7 } : { 1: 30, 2: 50, 3: 20 };
  const stock = [];
  let guard = 40;
  while (stock.length < 4 && guard-- > 0) {
    const roll = rand(1, 100);
    const r = roll <= w[1] ? 1 : roll <= w[1] + w[2] ? 2 : 3;
    const id = pick(partsByRarity(r));
    if (!stock.find((s) => s.defId === id)) {
      stock.push({ defId: id, price: partPrice(id) + rand(-5, 5), sold: false });
    }
  }
  return stock;
}

function openShop() {
  shopStock = rollShopStock();
  renderShop();
}

function renderShop() {
  const items = shopStock.map((s, i) => s.sold
    ? '<div class="part-card sold">SOLD OUT</div>'
    : `<div class="part-card buy ${run.credits >= s.price ? '' : 'cantafford'}" onclick="buyPart(${i})">
        ${partInfoHTML(s.defId)}<div class="pc-action price">${s.price} ¢</div>
      </div>`
  ).join('');
  const repairs = SLOTS.map((slot) => {
    const p = run.parts[slot];
    if (!p) return '';
    const def = PARTS[p.defId];
    const need = p.hp < def.hp;
    return `<button class="btn small ${need && run.credits >= 15 ? '' : 'disabled'}" onclick="shopRepair('${slot}')">
      ${SLOT_LABEL[slot]} ${p.hp <= 0 ? '【大破】' : `${p.hp}/${def.hp}`} 修理 15¢
    </button>`;
  }).join('');
  openPanel(`
    <h2 class="panel-h">ショップ「鉄屑堂」</h2>
    <p class="panel-p">「いらっしゃい。命は売ってないが、命綱なら売ってるよ」</p>
    <div class="option-row wrap">${items}</div>
    <h3 class="panel-h3">修理サービス</h3>
    <div class="btn-row">${repairs}
      <button class="btn small ${run.credits >= 40 ? '' : 'disabled'}" onclick="shopRepairAll()">全パーツ完全修理 40¢</button>
    </div>
    <button class="btn big" onclick="advanceFloor()">店を出る</button>
  `);
}

function buyPart(i) {
  const s = shopStock[i];
  if (!s || s.sold || run.credits < s.price) return;
  run.credits -= s.price;
  s.sold = true;
  run.inventory.push(mkPart(s.defId));
  SFX.coin();
  renderShop();
}

function shopRepair(slot) {
  const p = run.parts[slot];
  if (!p || run.credits < 15) return;
  const def = PARTS[p.defId];
  if (p.hp >= def.hp) return;
  run.credits -= 15;
  p.hp = def.hp;
  SFX.heal();
  renderShop();
}

function shopRepairAll() {
  if (run.credits < 40) return;
  run.credits -= 40;
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (p) p.hp = PARTS[p.defId].hp;
  }
  for (const p of run.inventory) p.hp = PARTS[p.defId].hp;
  SFX.heal();
  renderShop();
}

// ---------- 休憩 ----------
function openRest() {
  for (const slot of SLOTS) {
    const p = run.parts[slot];
    if (!p) continue;
    const def = PARTS[p.defId];
    p.hp = Math.min(def.hp, p.hp + Math.ceil(def.hp * 0.45));
  }
  SFX.heal();
  openPanel(`
    <h2 class="panel-h">整備班キャンプ</h2>
    <p class="panel-p">整備クルーが機体を取り囲む。「ひでえ状態だな……まあ、動くようにはしてやるよ」</p>
    <p class="panel-p accent">全パーツのHPを45%回復した(大破パーツも復旧)。</p>
    <div class="map-robot inline">${robotSummaryHTML()}</div>
    <button class="btn big" onclick="advanceFloor()">出 発</button>
  `);
}

// ---------- イベント ----------
let currentEvent = null;

function openEvent() {
  currentEvent = pick(EVENTS);
  const ev = currentEvent;
  openPanel(`
    <h2 class="panel-h">${ev.name}</h2>
    <p class="panel-p">${ev.text}</p>
    <div class="btn-col">
      ${ev.choices.map((c, i) => {
        const dis = c.cost && run.credits < c.cost;
        return `<button class="btn wide ${dis ? 'disabled' : ''}" onclick="resolveEvent(${i})">${c.label}</button>`;
      }).join('')}
    </div>
  `);
}

function resolveEvent(choice) {
  const ev = currentEvent;
  if (!ev) return;
  const c = ev.choices[choice];
  if (c.cost && run.credits < c.cost) return;
  let result = '';
  if (ev.id === 'scrapyard') {
    if (choice === 0) {
      if (rand(1, 100) <= 70) {
        const id = pick(Object.keys(PARTS));
        run.inventory.push(mkPart(id));
        result = `瓦礫の下から <b>${PARTS[id].name}</b> を発見した!(倉庫に追加)`;
        SFX.coin();
      } else {
        const h = run.parts.head;
        h.hp = Math.max(1, h.hp - 6);
        result = '不発リアクターが爆ぜた! 頭部に6ダメージ……';
        SFX.hit(); fxShake(4);
      }
    } else {
      run.credits += 15;
      result = 'スクラップを換金して +15¢。手堅い判断だ。';
      SFX.coin();
    }
  } else if (ev.id === 'cache') {
    if (choice === 0) {
      run.credits += 40;
      result = '正規の補給物資を受領。+40¢。';
      SFX.coin();
    } else if (rand(1, 100) <= 60) {
      run.credits += 90;
      result = 'ハッキング成功!! コンテナの中身を根こそぎ頂いた。+90¢!';
      SFX.fanfare();
    } else {
      for (const slot of SLOTS) {
        const p = run.parts[slot];
        if (p && p.hp > 0) p.hp = Math.max(1, p.hp - 4);
      }
      result = '防衛システム作動! 電撃が全身を貫いた。全パーツに4ダメージ……';
      SFX.jam(); fxShake(5);
    }
  } else if (ev.id === 'dock') {
    if (choice === 0) {
      let target = null, worst = 1;
      for (const slot of SLOTS) {
        const p = run.parts[slot];
        if (!p) continue;
        const r = p.hp / PARTS[p.defId].hp;
        if (r < worst) { worst = r; target = p; }
      }
      if (target) {
        target.hp = PARTS[target.defId].hp;
        result = `<b>${PARTS[target.defId].name}</b> を完全修理した。`;
      } else {
        result = '修理が必要なパーツはなかった。';
      }
      SFX.heal();
    } else {
      for (const slot of SLOTS) {
        const p = run.parts[slot];
        if (!p) continue;
        p.hp = Math.min(PARTS[p.defId].hp, p.hp + 8);
      }
      result = '全パーツに+8修理を施した。';
      SFX.heal();
    }
  } else if (ev.id === 'merchant') {
    if (choice === 0) {
      run.credits -= 30;
      const id = pick(partsByRarity(rand(1, 100) <= 60 ? 2 : 3));
      run.inventory.push(mkPart(id));
      result = `「まいどあり」── <b>${PARTS[id].name}</b> を手に入れた!(倉庫に追加)`;
      SFX.coin();
    } else {
      result = '関わらないのが一番だ。商人は肩をすくめた。';
      SFX.click();
    }
  }
  currentEvent = null;
  openPanel(`
    <h2 class="panel-h">${ev.name}</h2>
    <p class="panel-p">${result}</p>
    <button class="btn big" onclick="advanceFloor()">続 行</button>
  `);
}

// ---------- 勝敗 ----------
function calcScore() {
  return run.floor * 10 + run.kills * 15 + run.maxCombo * 5 + run.credits;
}

function saveBest(score, cleared) {
  try {
    const key = 'steelchain_best';
    const prev = JSON.parse(localStorage.getItem(key) || 'null');
    if (!prev || score > prev.score) {
      localStorage.setItem(key, JSON.stringify({ score, cleared, date: Date.now() }));
    }
  } catch (e) { /* localStorage不可環境では無視 */ }
}

function loadBest() {
  try {
    return JSON.parse(localStorage.getItem('steelchain_best') || 'null');
  } catch (e) { return null; }
}

function statsHTML() {
  return `<div class="stats">
    <div class="stat"><span>到達フロア</span><b>${run.floor} / ${MAX_FLOOR}</b></div>
    <div class="stat"><span>撃破数</span><b>${run.kills}</b></div>
    <div class="stat"><span>最大コンボ倍率</span><b>×${run.maxCombo}</b></div>
    <div class="stat"><span>所持クレジット</span><b>${run.credits} ¢</b></div>
    <div class="stat total"><span>SCORE</span><b>${calcScore()}</b></div>
  </div>`;
}

function gameOver() {
  SFX.lose();
  saveBest(calcScore(), false);
  openPanel(`
    <h2 class="panel-h lose">HEAD UNIT DESTROYED</h2>
    <p class="panel-p">頭部ユニット大破──機能停止。<br>だが鋼鉄は何度でも蘇る。</p>
    ${statsHTML()}
    <div class="btn-row center">
      <button class="btn big" onclick="startRun()">再出撃</button>
      <button class="btn ghost" onclick="showTitle()">タイトルへ</button>
    </div>
  `, false);
}

function victory() {
  SFX.fanfare();
  saveBest(calcScore() + 200, true);
  openPanel(`
    <h2 class="panel-h win">MISSION COMPLETE</h2>
    <p class="panel-p">Ω-FRAME、撃破。<br>鋼鉄の連鎖が、戦場を静寂で満たした。</p>
    ${statsHTML()}
    <p class="panel-p accent">クリアボーナス +200 SCORE</p>
    <div class="btn-row center">
      <button class="btn big" onclick="startRun()">もう一周</button>
      <button class="btn ghost" onclick="showTitle()">タイトルへ</button>
    </div>
  `, false);
}
