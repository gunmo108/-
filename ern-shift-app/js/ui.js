// DOM ヘルパ・共通 UI 部品

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- モーダル ----------------------------------------------------------

export function openModal(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => {
    wrap.remove();
    if (onClose) onClose();
  };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal').addEventListener('click', e => {
    if (e.target.closest('[data-close]')) close();
  });
  document.body.appendChild(wrap);
  wrap.close = close;
  return wrap;
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

export async function confirmDialog(msg, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const m = openModal(`
      <div class="modal-body"><p class="confirm-msg">${esc(msg)}</p></div>
      <div class="modal-actions">
        <button class="btn" data-close>キャンセル</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>
      </div>`, { onClose: () => resolve(false) });
    m.querySelector('[data-ok]').addEventListener('click', () => {
      resolve(true);
      m.querySelector('[data-ok]').removeAttribute('data-ok');
      m.close();
    });
  });
}

// ---- セグメントコントロール（1タップ選択） ------------------------------

export function segmented(name, options, selected) {
  return `<div class="seg" data-seg="${esc(name)}">${options.map(o => `
    <button type="button" class="seg-btn ${o.value === selected ? 'on' : ''}"
      data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>`;
}

export function segValue(root, name) {
  const btn = root.querySelector(`[data-seg="${name}"] .seg-btn.on`);
  return btn ? btn.dataset.value : null;
}

export function wireSegments(root) {
  root.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const seg = btn.closest('.seg');
    if (seg.dataset.multi != null) {
      btn.classList.toggle('on');
    } else {
      $$('.seg-btn', seg).forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
    }
    seg.dispatchEvent(new CustomEvent('segchange', { bubbles: true, detail: { name: seg.dataset.seg, value: btn.dataset.value } }));
  });
}

export function segValues(root, name) {
  return $$(`[data-seg="${name}"] .seg-btn.on`, root).map(b => b.dataset.value);
}

// ---- EWS スパークライン（シフト内 R1→Rn 軌跡） --------------------------
// 単一系列: ブルー。悪化/改善の矢印は記号＋数値を伴う（色のみに依存しない）。

export function sparkline(values, { w = 110, h = 26, max = 12 } = {}) {
  const pts = values.filter(v => v != null);
  if (!pts.length) return '<span class="spark-empty">—</span>';
  const pad = 3;
  const n = values.length;
  const x = i => n === 1 ? w / 2 : pad + (w - 2 * pad) * (i / (n - 1));
  const y = v => h - pad - (h - 2 * pad) * Math.min(v, max) / max;
  const coords = values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
  const poly = coords.map(c => c.map(v => v.toFixed(1)).join(',')).join(' ');
  const last = coords[coords.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${poly}" fill="none" stroke="var(--series-1)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--series-1)"/>
  </svg>`;
}

export function deltaBadge(delta) {
  if (delta == null) return '';
  if (delta > 0) return `<span class="delta delta-worse">▲+${delta}</span>`;
  if (delta < 0) return `<span class="delta delta-better">▼${delta}</span>`;
  return `<span class="delta delta-flat">→0</span>`;
}

// ---- 単一系列ラインチャート（precision 推移） ---------------------------

export function lineChart(points, { w = 640, h = 220, yMax = 1, yFmt = v => Math.round(v * 100) + '%' } = {}) {
  if (!points.length) return '<p class="empty">データがまだありません</p>';
  const padL = 44, padR = 16, padT = 14, padB = 28;
  const iw = w - padL - padR, ih = h - padT - padB;
  const x = i => points.length === 1 ? padL + iw / 2 : padL + iw * (i / (points.length - 1));
  const y = v => padT + ih * (1 - v / yMax);
  const coords = points.map((p, i) => [x(i), y(p.y)]);
  const poly = coords.map(c => c.map(v => v.toFixed(1)).join(',')).join(' ');
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map(f => f * yMax);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="推移チャート">
    ${gridVals.map(v => `
      <line x1="${padL}" y1="${y(v)}" x2="${w - padR}" y2="${y(v)}" class="grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" class="axis-label" text-anchor="end">${yFmt(v)}</text>`).join('')}
    <polyline points="${poly}" fill="none" stroke="var(--series-1)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    ${points.map((p, i) => `
      <circle cx="${coords[i][0].toFixed(1)}" cy="${coords[i][1].toFixed(1)}" r="4" fill="var(--series-1)">
        <title>${esc(p.label)}: ${yFmt(p.y)}</title>
      </circle>
      <text x="${coords[i][0].toFixed(1)}" y="${(coords[i][1] - 9 < 12 ? coords[i][1] + 18 : coords[i][1] - 9).toFixed(1)}" class="point-label"
        text-anchor="middle">${yFmt(p.y)}</text>
      <text x="${coords[i][0].toFixed(1)}" y="${h - 8}" class="axis-label" text-anchor="middle">${esc(p.label)}</text>
    `).join('')}
  </svg>`;
}

// ---- ダウンロード -------------------------------------------------------

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
