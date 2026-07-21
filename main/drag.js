// drag.js — 固定表示パネル(Tweakpane / croptool / handcam等)をハンドルドラッグで移動可能にする共通ユーティリティ。
// 位置はlocalStorageに保存し、再読み込み後も復元する。

const MOVE_THRESHOLD = 4;

export function makeDraggable(handle, target, { storageKey } = {}) {
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;

  function clampToViewport(x, y) {
    const maxX = Math.max(0, window.innerWidth - target.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - target.offsetHeight);
    return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)];
  }

  function applyPosition(x, y) {
    target.style.left = `${x}px`;
    target.style.top = `${y}px`;
    target.style.right = 'auto';
    target.style.bottom = 'auto';
  }

  function restore() {
    if (!storageKey) return;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    try {
      const { left, top } = JSON.parse(raw);
      const [x, y] = clampToViewport(left, top);
      applyPosition(x, y);
    } catch {
      // 破損データは無視してデフォルト位置のまま
    }
  }

  function save(x, y) {
    if (!storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ left: x, top: y }));
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    moved = false;
    const rect = target.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch { /* 一部環境でpointerId未認識時に発生 */ }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD)) {
      moved = true;
    }
    if (!moved) return;
    const [x, y] = clampToViewport(origX + dx, origY + dy);
    applyPosition(x, y);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* 未捕捉時は無視 */ }
    if (moved) {
      const rect = target.getBoundingClientRect();
      save(rect.left, rect.top);
      // ドラッグ後のclickでボタン本来の動作(折りたたみ等)が発火しないようにする
      handle.addEventListener('click', (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
      }, { capture: true, once: true });
    }
  }

  handle.style.cursor = 'move';
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);

  restore();
}
