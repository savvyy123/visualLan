// hand.js — MediaPipe HandLandmarker によるハンドトラッキング入力(両手対応)
// 各手の人差し指の先(ランドマーク8)をカーソルにし、親指(4)とのピンチ中だけ描画する。
// 手ごとに固有のpointerIdで合成PointerEventを流すので、左右同時に別ストロークを描ける。

const MP_VERSION = '0.10.14';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// ピンチ判定は手の大きさ(手首0→中指付け根9)に対する比率で行い、
// ヒステリシスでチャタリングを防ぐ
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;
const CURSOR_SMOOTH = 0.45; // カーソルEMA係数(大きいほど機敏)

// 手ごとの合成ポインタID(sketch.js側でどちらの手か判別するのに使う)
export const HAND_POINTER_ID = { left: 998, right: 999 };

let landmarker = null;
let video = null;
let stream = null;
let rafId = 0;
let running = false;
let lastVideoTime = -1;

// フレームループから参照する両手のカーソル状態(正規化キャンバス座標)
const cursors = {
  left: { x: 0.5, y: 0.5, active: false, drawing: false },
  right: { x: 0.5, y: 0.5, active: false, drawing: false },
};

export function handCursors() {
  return cursors;
}

function dispatchPointer(view, type, hand) {
  const c = cursors[hand];
  const r = view.getBoundingClientRect();
  view.dispatchEvent(new PointerEvent(type, {
    clientX: r.left + c.x * r.width,
    clientY: r.top + c.y * r.height,
    pointerId: HAND_POINTER_ID[hand],
    bubbles: true,
  }));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function updateHand(view, hand, lm) {
  const c = cursors[hand];
  // 鏡像(セルフィー)にして、指の動きと画面の動きを一致させる
  const rawX = 1 - lm[8].x;
  const rawY = lm[8].y;
  if (!c.active) {
    c.x = rawX;
    c.y = rawY;
  } else {
    c.x += (rawX - c.x) * CURSOR_SMOOTH;
    c.y += (rawY - c.y) * CURSOR_SMOOTH;
  }
  c.active = true;

  const pinch = dist(lm[4], lm[8]) / Math.max(1e-6, dist(lm[0], lm[9]));
  if (!c.drawing && pinch < PINCH_ON) {
    c.drawing = true;
    dispatchPointer(view, 'pointerdown', hand);
  } else if (c.drawing) {
    if (pinch > PINCH_OFF) {
      c.drawing = false;
      dispatchPointer(view, 'pointerup', hand);
    } else {
      dispatchPointer(view, 'pointermove', hand);
    }
  }
}

function loseHand(view, hand) {
  const c = cursors[hand];
  // 手を見失ったら描画中のストロークは確定する
  if (c.drawing) {
    c.drawing = false;
    dispatchPointer(view, 'pointerup', hand);
  }
  c.active = false;
}

export async function startHandTracking(view) {
  if (running) return;
  running = true;
  try {
    if (!landmarker) {
      const { FilesetResolver, HandLandmarker } = await import(BUNDLE_URL);
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    }
    video = document.createElement('video');
    video.id = 'handcam';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    stopHandTracking(view);
    throw err;
  }

  const loop = () => {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    const seen = { left: false, right: false };
    if (res.landmarks) {
      for (let i = 0; i < res.landmarks.length; i++) {
        // handednessはセルフィー(鏡像)前提のラベルなので、そのままユーザーの左右に対応する
        const label = res.handednesses?.[i]?.[0]?.categoryName || 'Right';
        const hand = label === 'Left' ? 'left' : 'right';
        if (seen[hand]) continue; // 同ラベルが2つ出たら先勝ち
        seen[hand] = true;
        updateHand(view, hand, res.landmarks[i]);
      }
    }
    for (const hand of ['left', 'right']) {
      if (!seen[hand]) loseHand(view, hand);
    }
  };
  loop();
}

export function stopHandTracking(view) {
  running = false;
  cancelAnimationFrame(rafId);
  for (const hand of ['left', 'right']) loseHand(view, hand);
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  if (video) {
    video.remove();
    video = null;
  }
  lastVideoTime = -1;
}
