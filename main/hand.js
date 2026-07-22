// hand.js — MediaPipe HandLandmarker によるハンドトラッキング入力(両手対応)
// 各手の人差し指の先(ランドマーク8)をカーソルにし、親指(4)とのピンチ中だけ描画する。
// 手ごとに固有のpointerIdで合成PointerEventを流すので、左右同時に別ストロークを描ける。

import { makeDraggable } from './drag.js';

const MP_VERSION = '0.10.14';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// ピンチ判定は手の大きさ(手首0→中指付け根9)に対する比率で行い、
// ヒステリシスでチャタリングを防ぐ
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;
// ピンチ比が瞬間的にPINCH_OFFを超えても、すぐには離した扱いにしない。
// 手の向きが変わった一瞬だけ数値が揺れて線が途切れるのを防ぐ
const PINCH_RELEASE_GRACE_MS = 120;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ---- 1ユーロフィルタ ----
// 止まっている時は強めに滑らかにして手ぶれ(検出ノイズ)を消し、
// 素早く動いた瞬間は自動で滑らかさを弱めて遅れが出ないようにする適応フィルタ。
// 固定係数のEMAだと「静止時のブレを消す」と「動いた時に遅れない」を両立できないため採用
class OneEuroFilter {
  constructor() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t, minCutoff, beta, dCutoff = 1) {
    if (this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(dCutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }
}

// Tweakpaneから調整する想定のフィルタ強度。
// minCutoff: 大きいほど、止まっている時の細かい震えが早く消える(その分、動き出しの追従が少し重くなる)
// beta: 大きいほど、素早く動いた時に遅れが出にくくなる(その分、静止直後は少し敏感になりやすい)
export const handFilterParams = { minCutoff: 0.08, beta: 3 };

// 手の可動域をキャンバス全体に引き伸ばすための倍率。カメラに映る範囲全体を
// 動かさなくても、中心(0.5,0.5)まわりの少しの動きでキャンバス端まで届くようにする
export const handRangeParams = { gain: 1.6 };

// 手ごとの合成ポインタID(sketch.js側でどちらの手か判別するのに使う)
export const HAND_POINTER_ID = { left: 998, right: 999 };

let landmarker = null;
let video = null;
let stream = null;
let rafId = 0;
let running = false;
let lastVideoTime = -1;

// 検出が1フレームだけ途切れても、すぐに手を見失った扱い(=ストロークを打ち切り)には
// せず、この時間だけは「まだ描いている」として粘る。検出のちらつきで線が途中で
// 切れてしまうのを防ぐため
const LOSE_GRACE_MS = 250;
const lastSeenAt = { left: -Infinity, right: -Infinity };

// フレームループから参照する両手のカーソル状態(正規化キャンバス座標)
const cursors = {
  left: {
    x: 0.5, y: 0.5, active: false, drawing: false,
    fx: new OneEuroFilter(), fy: new OneEuroFilter(), pinchAboveOffSince: null,
  },
  right: {
    x: 0.5, y: 0.5, active: false, drawing: false,
    fx: new OneEuroFilter(), fy: new OneEuroFilter(), pinchAboveOffSince: null,
  },
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
  const now = performance.now();
  const t = now / 1000; // 1ユーロフィルタはHz(秒)基準の係数を使うため
  const fx = c.fx.filter(rawX, t, handFilterParams.minCutoff, handFilterParams.beta);
  const fy = c.fy.filter(rawY, t, handFilterParams.minCutoff, handFilterParams.beta);
  // 中心(0.5, 0.5)まわりにゲインをかけ、カメラ全体を動かさなくても
  // キャンバス端まで届くようにする
  const g = handRangeParams.gain;
  c.x = clamp01(0.5 + (fx - 0.5) * g);
  c.y = clamp01(0.5 + (fy - 0.5) * g);
  c.active = true;

  const pinch = dist(lm[4], lm[8]) / Math.max(1e-6, dist(lm[0], lm[9]));
  if (!c.drawing && pinch < PINCH_ON) {
    c.drawing = true;
    c.pinchAboveOffSince = null;
    dispatchPointer(view, 'pointerdown', hand);
  } else if (c.drawing) {
    if (pinch > PINCH_OFF) {
      // 一瞬だけ閾値を超えても即終了にはせず、猶予時間だけ様子を見る
      if (c.pinchAboveOffSince === null) c.pinchAboveOffSince = now;
      if (now - c.pinchAboveOffSince > PINCH_RELEASE_GRACE_MS) {
        c.drawing = false;
        c.pinchAboveOffSince = null;
        dispatchPointer(view, 'pointerup', hand);
      } else {
        dispatchPointer(view, 'pointermove', hand);
      }
    } else {
      c.pinchAboveOffSince = null;
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
  c.pinchAboveOffSince = null;
  // 次に検出した瞬間、古い時刻からの差分で暴れないようフィルタをリセットしておく
  c.fx.reset();
  c.fy.reset();
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
    makeDraggable(video, video, { storageKey: 'vl_handcam_pos' });
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
    const now = performance.now();
    if (res.landmarks) {
      for (let i = 0; i < res.landmarks.length; i++) {
        // handednessはセルフィー(鏡像)前提のラベルなので、そのままユーザーの左右に対応する
        const label = res.handednesses?.[i]?.[0]?.categoryName || 'Right';
        const hand = label === 'Left' ? 'left' : 'right';
        if (seen[hand]) continue; // 同ラベルが2つ出たら先勝ち
        seen[hand] = true;
        lastSeenAt[hand] = now;
        updateHand(view, hand, res.landmarks[i]);
      }
    }
    for (const hand of ['left', 'right']) {
      if (!seen[hand] && now - lastSeenAt[hand] > LOSE_GRACE_MS) {
        loseHand(view, hand);
      }
    }
  };
  loop();
}

export function stopHandTracking(view) {
  running = false;
  cancelAnimationFrame(rafId);
  for (const hand of ['left', 'right']) {
    loseHand(view, hand);
    lastSeenAt[hand] = -Infinity;
  }
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
