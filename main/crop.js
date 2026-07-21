// crop.js — 画像を読み込んでトリミングし、カスタムスタンプとして登録するツール。
// キャンバスの外(左余白)に固定表示される作業パネル。作品には直接描画しない。

import { makeDraggable } from './drag.js';

const PREVIEW_MAX = 240; // プレビュー領域の一辺の最大サイズ(px)
const HANDLE_R = 9; // リサイズハンドルの当たり半径(px)

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function corners(r) {
  return [
    ['tl', r.x, r.y],
    ['tr', r.x + r.w, r.y],
    ['bl', r.x, r.y + r.h],
    ['br', r.x + r.w, r.y + r.h],
  ];
}

// onAdd(id, label, canvas): 切り取り確定時に呼ばれる。canvasは元画像解像度で切り出し済み
export function initCropTool(onAdd) {
  const wrap = document.createElement('div');
  wrap.id = 'croptool';

  const title = document.createElement('div');
  title.className = 'croptool-title';
  title.textContent = '画像を切り取ってスタンプに追加';
  wrap.appendChild(title);

  const loadBtn = document.createElement('button');
  loadBtn.textContent = '画像を読み込む';
  wrap.appendChild(loadBtn);

  const hint = document.createElement('div');
  hint.className = 'croptool-hint';
  hint.textContent = 'ドラッグで移動 / 四隅でリサイズ';
  wrap.appendChild(hint);

  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_MAX;
  canvas.height = PREVIEW_MAX;
  wrap.appendChild(canvas);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'この範囲をスタンプに追加';
  addBtn.disabled = true;
  wrap.appendChild(addBtn);

  document.body.appendChild(wrap);
  makeDraggable(title, wrap, { storageKey: 'vl_croptool_pos' });

  const ctx = canvas.getContext('2d');
  let img = null;
  let dispW = 0;
  let dispH = 0;
  let dispX = 0;
  let dispY = 0;
  let scale = 1; // プレビュー描画のスケール(元画像→プレビュー)
  let rect = null; // プレビュー座標系での選択矩形 {x,y,w,h}

  function fitImage() {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    scale = Math.min(PREVIEW_MAX / iw, PREVIEW_MAX / ih);
    dispW = iw * scale;
    dispH = ih * scale;
    dispX = (PREVIEW_MAX - dispW) / 2;
    dispY = (PREVIEW_MAX - dispH) / 2;
    const rw = dispW * 0.6;
    const rh = dispH * 0.6;
    rect = { x: dispX + (dispW - rw) / 2, y: dispY + (dispH - rh) / 2, w: rw, h: rh };
  }

  function draw() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, PREVIEW_MAX, PREVIEW_MAX);
    if (!img) return;
    ctx.drawImage(img, dispX, dispY, dispW, dispH);
    if (!rect) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(dispX, dispY, dispW, rect.y - dispY); // 上
    ctx.fillRect(dispX, rect.y + rect.h, dispW, dispY + dispH - (rect.y + rect.h)); // 下
    ctx.fillRect(dispX, rect.y, rect.x - dispX, rect.h); // 左
    ctx.fillRect(rect.x + rect.w, rect.y, dispX + dispW - (rect.x + rect.w), rect.h); // 右
    ctx.restore();
    ctx.strokeStyle = '#31ff79';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.fillStyle = '#31ff79';
    for (const [, hx, hy] of corners(rect)) {
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
    }
  }

  function hitTest(px, py) {
    if (!rect) return null;
    for (const [name, hx, hy] of corners(rect)) {
      if (Math.hypot(px - hx, py - hy) <= HANDLE_R) return name;
    }
    if (px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h) return 'move';
    return null;
  }

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  let drag = null;
  let start = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!rect) return;
    const p = pointFromEvent(e);
    drag = hitTest(p.x, p.y);
    if (drag) {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      start = { p, rect: { ...rect } };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !start) return;
    const p = pointFromEvent(e);
    const dx = p.x - start.p.x;
    const dy = p.y - start.p.y;
    const r0 = start.rect;
    const minS = 16;
    const r = { ...r0 };
    if (drag === 'move') {
      r.x = clamp(r0.x + dx, dispX, dispX + dispW - r0.w);
      r.y = clamp(r0.y + dy, dispY, dispY + dispH - r0.h);
    } else {
      if (drag.includes('l')) {
        const nx = clamp(r0.x + dx, dispX, r0.x + r0.w - minS);
        r.w = r0.w - (nx - r0.x);
        r.x = nx;
      }
      if (drag.includes('r')) {
        const nx2 = clamp(r0.x + r0.w + dx, r0.x + minS, dispX + dispW);
        r.w = nx2 - r0.x;
      }
      if (drag.includes('t')) {
        const ny = clamp(r0.y + dy, dispY, r0.y + r0.h - minS);
        r.h = r0.h - (ny - r0.y);
        r.y = ny;
      }
      if (drag.includes('b')) {
        const ny2 = clamp(r0.y + r0.h + dy, r0.y + minS, dispY + dispH);
        r.h = ny2 - r0.y;
      }
    }
    rect = r;
    draw();
  });

  window.addEventListener('pointerup', () => {
    drag = null;
    start = null;
  });

  loadBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const im = new Image();
      im.onload = () => {
        img = im;
        fitImage();
        addBtn.disabled = false;
        draw();
      };
      im.src = URL.createObjectURL(file);
    };
    input.click();
  });

  let addCount = 0;
  addBtn.addEventListener('click', () => {
    if (!img || !rect) return;
    // プレビュー座標→元画像座標に変換し、フル解像度で切り出す
    const sx = (rect.x - dispX) / scale;
    const sy = (rect.y - dispY) / scale;
    const sw = rect.w / scale;
    const sh = rect.h / scale;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
    addCount += 1;
    onAdd(`custom${addCount}`, `カスタム${addCount}`, out);
  });

  draw();
}
