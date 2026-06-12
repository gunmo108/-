'use strict';
/* 画面演出: ダメージポップ / シェイク / コンボバナー / パーティクル */

const $ = (id) => document.getElementById(id);

function elCenter(el) {
  if (!el || !el.getBoundingClientRect) return { x: innerWidth / 2, y: innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 浮き上がるテキスト。cls: dmg / dmg-big / dmg-huge / heal / block-fx / warn / evade
function fxPop(el, text, cls = 'dmg') {
  const layer = $('fx-layer');
  if (!layer) return;
  const { x, y } = elCenter(el);
  const d = document.createElement('div');
  d.className = 'fx-pop ' + cls;
  d.textContent = text;
  d.style.left = (x + rand(-24, 24)) + 'px';
  d.style.top = (y + rand(-14, 6)) + 'px';
  layer.appendChild(d);
  setTimeout(() => d.remove(), 1100);
}

function fxShake(power = 1) {
  const app = $('app');
  if (!app) return;
  const amp = Math.min(2 + power * 2.2, 18);
  app.style.setProperty('--shake-amp', amp + 'px');
  app.classList.remove('shaking');
  void app.offsetWidth; // アニメーション再トリガー
  app.classList.add('shaking');
}

// 中央に大きく出るバナー。tier 1〜5 で派手さが変わる
function fxBanner(html, tier = 1, ms = 900) {
  const layer = $('banner-layer');
  if (!layer) return;
  const d = document.createElement('div');
  d.className = 'fx-banner tier' + Math.min(tier, 5);
  d.innerHTML = html;
  layer.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

function fxParticles(el, color = '#ffb347', n = 14) {
  const layer = $('fx-layer');
  if (!layer) return;
  const { x, y } = elCenter(el);
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    p.className = 'fx-particle';
    p.style.background = color;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--dx', rand(-90, 90) + 'px');
    p.style.setProperty('--dy', rand(-100, 50) + 'px');
    layer.appendChild(p);
    setTimeout(() => p.remove(), 750);
  }
}

function fxFlash(el) {
  if (!el || !el.classList) return;
  el.classList.remove('hit-flash');
  void el.offsetWidth;
  el.classList.add('hit-flash');
}
