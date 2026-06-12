'use strict';
/* =========================================================
 * STEEL CHAIN ─鋼鉄連鎖─  ゲームデータ定義
 * ========================================================= */

// ---------- ユーティリティ ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let _uid = 1;
const uid = () => _uid++;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SLOTS = ['head', 'rarm', 'larm', 'legs'];
const SLOT_LABEL = { head: '頭部', rarm: '右腕', larm: '左腕', legs: '脚部' };

const ATTRS = {
  shoot:   { label: '射撃', icon: '◎', cls: 'shoot' },
  melee:   { label: '格闘', icon: '✦', cls: 'melee' },
  support: { label: '支援', icon: '✚', cls: 'support' },
  none:    { label: '無',   icon: '─', cls: 'none' },
};

const RARITY_LABEL = { 1: '★', 2: '★★', 3: '★★★' };
const RARITY_NAME = { 1: 'COMMON', 2: 'RARE', 3: 'EPIC' };

// ---------- カード ----------
// neutral:true のカードはコンボに影響せず、倍率も乗らない
const CARDS = {
  // 射撃
  rifle:    { name: 'ライフル',       attr: 'shoot', cost: 1, dmg: 6,            desc: '6ダメージ' },
  gatling:  { name: 'ガトリング',     attr: 'shoot', cost: 1, dmg: 2, hits: 3,   desc: '2ダメージ×3回' },
  snipe:    { name: 'スナイプ',       attr: 'shoot', cost: 2, dmg: 13, sure: true, desc: '13ダメージ / 必中' },
  missile:  { name: 'ミサイル',       attr: 'shoot', cost: 2, dmg: 8, splash: 4, desc: '8ダメージ+他部位に4' },
  laser:    { name: 'メガレーザー',   attr: 'shoot', cost: 3, dmg: 22,           desc: '22ダメージ' },
  finisher: { name: 'ジャッジメント', attr: 'shoot', cost: 2, dmg: 6, finisher: true, desc: '6ダメージ / 使用後コンボ消滅' },
  // 格闘
  saber:    { name: 'セイバー',       attr: 'melee', cost: 1, dmg: 7,            desc: '7ダメージ' },
  dual:     { name: '二連斬',         attr: 'melee', cost: 1, dmg: 3, hits: 2,   desc: '3ダメージ×2回' },
  hammer:   { name: 'ハンマー',       attr: 'melee', cost: 2, dmg: 15,           desc: '15ダメージ' },
  breaker:  { name: 'ブレイカー',     attr: 'melee', cost: 2, dmg: 10, pierce: true, desc: '10ダメージ / ブロック貫通' },
  // 支援(コンボ対象 = 倍率が乗る)
  shield:    { name: 'シールド',   attr: 'support', cost: 1, block: 6,  desc: '6ブロック' },
  bigshield: { name: '大盾展開',   attr: 'support', cost: 2, block: 14, desc: '14ブロック' },
  repair:    { name: 'リペア',     attr: 'support', cost: 1, heal: 6,   desc: '最弱部位を6修理' },
  scan:      { name: 'スキャン',   attr: 'support', cost: 1, vuln: 2,   desc: '敵の被ダメ+30%(2ターン)' },
  // 無属性(コンボに影響しない)
  charge:    { name: 'チャージ',         attr: 'none', cost: 0, chargeCombo: 1, neutral: true, desc: 'コンボLv+1' },
  boost:     { name: 'ブースト',         attr: 'none', cost: 0, energy: 1,      neutral: true, desc: 'エナジー+1' },
  analyze:   { name: '解析',             attr: 'none', cost: 1, draw: 2,        neutral: true, desc: 'カードを2枚引く' },
  overclock: { name: 'オーバークロック', attr: 'none', cost: 0, energy: 2, selfHead: 2, neutral: true, desc: 'エナジー+2 / 頭部HP-2' },
  step:      { name: 'ステップ',         attr: 'none', cost: 1, draw: 1, block: 3, neutral: true, desc: '1枚引く+3ブロック' },
  thruster:  { name: 'スラスター',       attr: 'none', cost: 0, block: 3,       neutral: true, desc: '3ブロック' },
};

// ---------- パーツ ----------
// passive: draw(毎ターン追加ドロー) / energy(エナジー+) / armor(被ダメ-) /
//          comboCap(倍率上限) / startCombo(開戦時コンボLv) / turnBlock(毎ターンブロック)
// evade: 脚部のみ。回避率(%)
const PARTS = {
  // ---- 頭部 ----
  h_std:     { slot: 'head', name: 'ノーマルヘッド',   hp: 34, rarity: 1, cards: ['analyze'], desc: '標準規格の頭部ユニット' },
  h_radar:   { slot: 'head', name: 'レーダーヘッド',   hp: 30, rarity: 2, cards: ['analyze', 'scan'], passive: { draw: 1 }, desc: '毎ターンのドロー+1' },
  h_guard:   { slot: 'head', name: 'ガードヘッド',     hp: 46, rarity: 2, cards: ['shield'], passive: { armor: 1 }, desc: '受けるダメージ-1' },
  h_lucky:   { slot: 'head', name: 'ラッキーヘッド',   hp: 28, rarity: 2, cards: ['charge', 'analyze'], passive: { startCombo: 1 }, desc: '戦闘開始時コンボLv1' },
  h_berserk: { slot: 'head', name: 'バーサクヘッド',   hp: 36, rarity: 3, cards: ['overclock'], passive: { comboCap: 32 }, desc: 'コンボ倍率上限が×32になる' },
  // ---- 右腕 ----
  ra_std:     { slot: 'rarm', name: 'スタンダードライフル', hp: 26, rarity: 1, cards: ['rifle', 'rifle'], desc: '信頼の量産型実弾兵装' },
  ra_hammer:  { slot: 'rarm', name: 'ハンマーアーム',       hp: 30, rarity: 1, cards: ['hammer', 'saber'], desc: '一撃重視の打撃兵装' },
  ra_sniper:  { slot: 'rarm', name: 'スナイパーアーム',     hp: 22, rarity: 2, cards: ['snipe', 'rifle'], desc: '回避を許さない精密射撃' },
  ra_missile: { slot: 'rarm', name: 'ミサイルポッド',       hp: 26, rarity: 2, cards: ['missile', 'missile'], desc: '複数部位を同時に削る' },
  ra_laser:   { slot: 'rarm', name: 'レーザーアーム',       hp: 24, rarity: 3, cards: ['laser', 'rifle'], desc: '最大火力の収束光学砲' },
  ra_judge:   { slot: 'rarm', name: 'ジャッジメントアーム', hp: 24, rarity: 3, cards: ['finisher', 'rifle'], desc: 'コンボを叩きつける裁きの砲' },
  // ---- 左腕 ----
  la_std:     { slot: 'larm', name: 'ガトリングアーム', hp: 26, rarity: 1, cards: ['gatling', 'gatling'], desc: '手数で押す連射兵装' },
  la_saber:   { slot: 'larm', name: 'セイバーアーム',   hp: 26, rarity: 1, cards: ['saber', 'dual'], desc: '取り回しの良い実体剣' },
  la_shield:  { slot: 'larm', name: 'シールドアーム',   hp: 34, rarity: 2, cards: ['shield', 'bigshield'], desc: '守りを固める大型盾' },
  la_breaker: { slot: 'larm', name: 'ブレイカーアーム', hp: 28, rarity: 2, cards: ['breaker', 'dual'], desc: '敵の防御ごと叩き割る' },
  la_repair:  { slot: 'larm', name: 'リペアアーム',     hp: 24, rarity: 2, cards: ['repair', 'shield'], desc: '戦闘中の自己修復を可能にする' },
  // ---- 脚部 ----
  lg_std:     { slot: 'legs', name: '二脚フレーム',   hp: 30, rarity: 1, evade: 10, cards: ['step'], desc: '回避10%' },
  lg_hover:   { slot: 'legs', name: 'ホバーレッグ',   hp: 26, rarity: 2, evade: 20, cards: ['thruster', 'step'], desc: '回避20%' },
  lg_spider:  { slot: 'legs', name: '多脚フレーム',   hp: 32, rarity: 2, evade: 15, cards: ['step', 'thruster'], desc: '回避15%' },
  lg_tank:    { slot: 'legs', name: 'タンクトレッド', hp: 44, rarity: 2, evade: 0, cards: ['shield'], passive: { turnBlock: 3 }, desc: '回避0% / 毎ターン3ブロック' },
  lg_booster: { slot: 'legs', name: 'ブースターレッグ', hp: 26, rarity: 3, evade: 10, cards: ['boost', 'step'], passive: { energy: 1 }, desc: '回避10% / エナジー+1' },
};

const STARTER = { head: 'h_std', rarm: 'ra_std', larm: 'la_std', legs: 'lg_std' };

function partsByRarity(r) {
  return Object.keys(PARTS).filter((id) => PARTS[id].rarity === r);
}
function partPrice(defId) {
  return { 1: 35, 2: 60, 3: 95 }[PARTS[defId].rarity];
}

// ---------- 敵 ----------
// parts[0] が頭部/コア。これを破壊すれば勝利。
// move: { name, icon, part, dmg, hits, block, jam, heal, sure }
const ENEMIES = {
  // -- 序盤(単核) --
  drone: {
    name: 'パトロールドローン', tier: 1,
    parts: [{ key: 'core', name: 'コア', hp: 30 }],
    moves: [
      { name: '射撃', icon: '⚔', part: 'core', dmg: 5 },
      { name: '突進', icon: '⚔', part: 'core', dmg: 8 },
      { name: '防御態勢', icon: '🛡', part: 'core', block: 6 },
    ],
    script: [0, 0, 1, 2],
  },
  scarab: {
    name: 'スカラベタンク', tier: 1,
    parts: [{ key: 'core', name: '装甲殻', hp: 34 }],
    moves: [
      { name: '硬化', icon: '🛡', part: 'core', block: 8, dmg: 3 },
      { name: '噛みつき', icon: '⚔', part: 'core', dmg: 7 },
    ],
    script: [0, 1, 1],
  },
  watcher: {
    name: 'ウォッチャー', tier: 1,
    parts: [{ key: 'core', name: '観測眼', hp: 26 }],
    moves: [
      { name: 'ジャミング', icon: '⚡', part: 'core', jam: true, dmg: 4 },
      { name: 'ビーム', icon: '⚔', part: 'core', dmg: 6 },
      { name: '観測シールド', icon: '🛡', part: 'core', block: 5 },
    ],
    script: [1, 0, 1, 2],
  },
  // -- 中盤(4パーツ) --
  gunner: {
    name: 'ガンナーボット', tier: 2,
    parts: [
      { key: 'head', name: '頭部', hp: 24 },
      { key: 'rarm', name: '右腕', hp: 24 },
      { key: 'larm', name: '左腕', hp: 22 },
      { key: 'legs', name: '脚部', hp: 26 },
    ],
    moves: [
      { name: 'ライフル', icon: '⚔', part: 'rarm', dmg: 9 },
      { name: 'ガトリング', icon: '⚔', part: 'larm', dmg: 3, hits: 3 },
      { name: '回避機動', icon: '🛡', part: 'legs', block: 7 },
      { name: 'ジャミング', icon: '⚡', part: 'head', jam: true, dmg: 3 },
    ],
    script: [0, 1, 2, 0, 3],
  },
  blader: {
    name: 'ブレードボット', tier: 2,
    parts: [
      { key: 'head', name: '頭部', hp: 22 },
      { key: 'rarm', name: '右腕', hp: 26 },
      { key: 'larm', name: '左腕', hp: 24 },
      { key: 'legs', name: '脚部', hp: 24 },
    ],
    moves: [
      { name: '斬撃', icon: '⚔', part: 'rarm', dmg: 11 },
      { name: '二連斬', icon: '⚔', part: 'larm', dmg: 5, hits: 2 },
      { name: '威嚇', icon: '🛡', part: 'head', block: 4 },
      { name: '蹴撃', icon: '⚔', part: 'legs', dmg: 7 },
    ],
    script: [0, 1, 3, 0, 2],
  },
  medic: {
    name: 'リペアボット', tier: 2,
    parts: [
      { key: 'head', name: '頭部', hp: 26 },
      { key: 'rarm', name: '右腕', hp: 22 },
      { key: 'larm', name: '左腕', hp: 22 },
      { key: 'legs', name: '脚部', hp: 24 },
    ],
    moves: [
      { name: 'ショックロッド', icon: '⚔', part: 'rarm', dmg: 7 },
      { name: '自己修復', icon: '✚', part: 'head', heal: 8 },
      { name: 'シールド', icon: '🛡', part: 'larm', block: 8 },
      { name: 'タックル', icon: '⚔', part: 'legs', dmg: 6 },
    ],
    script: [0, 1, 2, 0, 1, 3],
  },
  // -- 終盤 --
  tankbot: {
    name: 'フォートレス', tier: 3,
    parts: [
      { key: 'head', name: '頭部', hp: 28 },
      { key: 'rarm', name: '右腕', hp: 30 },
      { key: 'larm', name: '左腕', hp: 28 },
      { key: 'legs', name: '脚部', hp: 30 },
    ],
    moves: [
      { name: 'ロックダウン', icon: '🛡', part: 'head', block: 6 },
      { name: 'キャノン', icon: '⚔', part: 'rarm', dmg: 14 },
      { name: '装甲展開', icon: '🛡', part: 'larm', block: 10 },
      { name: '踏み潰し', icon: '⚔', part: 'legs', dmg: 8 },
    ],
    script: [2, 1, 3, 0, 1],
  },
  reaper: {
    name: 'リーパー', tier: 3,
    parts: [
      { key: 'head', name: '頭部', hp: 26 },
      { key: 'rarm', name: '右腕', hp: 28 },
      { key: 'larm', name: '左腕', hp: 26 },
      { key: 'legs', name: '脚部', hp: 26 },
    ],
    moves: [
      { name: 'ジャミング', icon: '⚡', part: 'head', jam: true, dmg: 5 },
      { name: 'デスサイズ', icon: '⚔', part: 'rarm', dmg: 13 },
      { name: 'ダブルクロー', icon: '⚔', part: 'larm', dmg: 6, hits: 2 },
      { name: '幻影機動', icon: '🛡', part: 'legs', block: 9 },
    ],
    script: [1, 2, 0, 1, 3],
  },
  // -- 強敵 --
  hunter: {
    name: 'ハンターキラー', tier: 4,
    parts: [
      { key: 'head', name: '頭部', hp: 30 },
      { key: 'rarm', name: '右腕', hp: 30 },
      { key: 'larm', name: '左腕', hp: 28 },
      { key: 'legs', name: '脚部', hp: 30 },
    ],
    moves: [
      { name: '精密射撃', icon: '⚔', part: 'rarm', dmg: 12, sure: true },
      { name: 'ジャミング', icon: '⚡', part: 'head', jam: true, dmg: 6 },
      { name: '三連射', icon: '⚔', part: 'larm', dmg: 4, hits: 3 },
      { name: 'ステルス', icon: '🛡', part: 'legs', block: 10 },
    ],
    script: [1, 0, 2, 1, 0, 3],
  },
  crusher: {
    name: 'クラッシャー', tier: 4,
    parts: [
      { key: 'head', name: '頭部', hp: 34 },
      { key: 'rarm', name: '右腕', hp: 36 },
      { key: 'larm', name: '左腕', hp: 34 },
      { key: 'legs', name: '脚部', hp: 34 },
    ],
    moves: [
      { name: '咆哮', icon: '🛡', part: 'head', block: 8 },
      { name: 'クラッシュ', icon: '⚔', part: 'rarm', dmg: 16 },
      { name: 'アイアンナックル', icon: '⚔', part: 'larm', dmg: 9 },
      { name: '地響き', icon: '⚔', part: 'legs', dmg: 7 },
    ],
    script: [1, 2, 0, 1, 3],
  },
  // -- ボス(フロア倍率は乗らない) --
  omega: {
    name: 'Ω-FRAME オメガ', tier: 5, boss: true,
    parts: [
      { key: 'head', name: '頭部', hp: 80 },
      { key: 'rarm', name: '右腕', hp: 60 },
      { key: 'larm', name: '左腕', hp: 55 },
      { key: 'legs', name: '脚部', hp: 65 },
    ],
    moves: [
      { name: 'ジャミングウェーブ', icon: '⚡', part: 'head', jam: true, dmg: 6 },
      { name: 'デスレーザー', icon: '⚔', part: 'rarm', dmg: 20 },
      { name: '連装砲', icon: '⚔', part: 'larm', dmg: 5, hits: 4 },
      { name: 'シールドフィールド', icon: '🛡', part: 'legs', block: 12 },
    ],
    script: [3, 1, 2, 0],
    enrage: { broken: 2, mul: 1.4 },
  },
};

const ENEMY_POOLS = {
  easy:  ['drone', 'scarab', 'watcher'],
  mid:   ['gunner', 'blader', 'medic'],
  hard:  ['tankbot', 'reaper', 'gunner', 'blader'],
  elite: ['hunter', 'crusher'],
  boss:  ['omega'],
};

function poolForFloor(floor) {
  if (floor <= 3) return ENEMY_POOLS.easy;
  if (floor <= 7) return ENEMY_POOLS.mid;
  return ENEMY_POOLS.hard;
}

// 非ボス敵のフロア補正
function floorScale(floor) {
  return 1 + (floor - 1) * 0.03;
}

// ---------- マップ(全12フロア / 各フロアの選択肢) ----------
const NODE_INFO = {
  battle: { label: '戦闘',     icon: '⚔' },
  elite:  { label: '強敵',     icon: '☠' },
  shop:   { label: 'ショップ', icon: '◈' },
  rest:   { label: '整備班',   icon: '✚' },
  event:  { label: '???',      icon: '?' },
  boss:   { label: 'ボス',     icon: '👑' },
};

const FLOOR_PLAN = [
  ['battle'],
  ['battle', 'event'],
  ['battle', 'shop'],
  ['battle', 'rest'],
  ['elite', 'battle'],
  ['battle', 'event'],
  ['shop', 'rest'],
  ['battle', 'event'],
  ['elite', 'battle'],
  ['rest', 'shop'],
  ['battle', 'rest'],
  ['boss'],
];
const MAX_FLOOR = FLOOR_PLAN.length;

// ---------- イベント ----------
const EVENTS = [
  {
    id: 'scrapyard',
    name: '廃棄工場',
    text: '打ち捨てられた機体の山。使えるパーツが眠っているかもしれないが、不発のリアクターも転がっている。',
    choices: [
      { label: '漁る(70%:ランダムパーツ入手 / 30%:頭部に6ダメージ)' },
      { label: '金目の物だけ回収する(+15¢)' },
    ],
  },
  {
    id: 'cache',
    name: '補給キャッシュ',
    text: '軍の無人補給コンテナを発見した。認証は生きている。',
    choices: [
      { label: '正規手順で開ける(+40¢)' },
      { label: 'ハッキングで全部抜く(60%:+90¢ / 40%:全パーツに4ダメージ)' },
    ],
  },
  {
    id: 'dock',
    name: '無人修理ドック',
    text: '稼働中の修理ドックがある。エネルギー残量は1回分。',
    choices: [
      { label: '最も損傷したパーツを完全修理' },
      { label: '全パーツに分配して+8修理' },
    ],
  },
  {
    id: 'merchant',
    name: '怪しい商人',
    text: '「兄ちゃん、いいモン持ってるよ。ワケありだけどな」',
    choices: [
      { label: 'レアパーツを買う(-30¢)', cost: 30 },
      { label: '立ち去る' },
    ],
  },
];
