'use strict';
/* 起動・画面遷移・入力 */

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
}

function showTitle() {
  show('screen-title');
  const best = loadBest();
  const el = $('best-score');
  if (el) {
    el.innerHTML = best
      ? `BEST SCORE <b>${best.score}</b>${best.cleared ? ' <span class="cleared">CLEARED</span>' : ''}`
      : '';
  }
}

function startRun() {
  SFX.click();
  newRun();
  renderMap();
}

function toggleHelp(open) {
  $('help-modal').classList.toggle('hidden', !open);
}

function toggleMute() {
  const m = SFX.toggleMute();
  $('mute-btn').textContent = m ? '✕' : '♪';
  $('mute-btn').classList.toggle('muted', m);
}

document.addEventListener('keydown', (e) => {
  if (!$('screen-battle').classList.contains('active')) return;
  if (e.key >= '1' && e.key <= '8') playCard(parseInt(e.key, 10) - 1);
  else if (e.key === 'e' || e.key === 'E') endTurn();
});

showTitle();
