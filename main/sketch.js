import { Pane } from 'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { drawCover, replayStroke, createEngines, buildCaptionTrack } from './brush.js';
import { startHandTracking, stopHandTracking, handCursors, HAND_POINTER_ID } from './hand.js';
import { initCropTool } from './crop.js';
import { makeDraggable } from './drag.js';

const A1 = { w: 594, h: 841 };
const PREVIEW_W = 1200;
const PREVIEW_H = Math.round(PREVIEW_W * (A1.h / A1.w));
const DPI_SIZE = { 150: [3508, 4967], 300: [7016, 9933] };
// タイポ(背景の文字組み)のバリエーション。UIで切り替える
const TYPO_SRC = {
  ver1: 'assets/posterVisualLan.png',
  ver2: 'assets/posterVisualLanVer2.png',
  ver3: 'assets/posterVisualLanVer3.png',
  ver4: 'assets/posterVisualLanVer4.png',
  ver5: 'assets/posterVisualLanVer5.png',
  ver6: 'assets/posterVisualLanVer6.png',
};

const view = document.getElementById('view');
view.width = PREVIEW_W;
view.height = PREVIEW_H;
const vctx = view.getContext('2d');

// 写真+ストロークの合成レイヤー（サンプリング対象）。タイポは含めない
const art = document.createElement('canvas');
art.width = PREVIEW_W;
art.height = PREVIEW_H;

const OBJECT_SRC = {
  tomatoes: 'assets/objects/tomatoes.png',
  lettuce: 'assets/objects/lettuce.png',
  bag: 'assets/objects/bag.png',
  basket: 'assets/objects/basket.png',
  cart: 'assets/objects/cart.png',
  // TouchDesignerで生成した透過エフェクト(assets/td/stamps)。
  // アルファだけを使い、色は「スタンプ色」でJS側で着色する
  tdCircle: 'assets/td/stamps/circle_black.png',
  tdTri: 'assets/td/stamps/tri_black.png',
  tdSquare: 'assets/td/stamps/square_black.png',
  tdSplat: 'assets/td/stamps/splat_black.png',
};

const state = {
  photo: null,
  typo: null,
  typoPreview: null, // タイポの白文字版をプレビュー解像度でキャッシュ(difference合成用)
  strokes: [],
  images: {},
  selected: null, // 選択モードで掴んでいるストローク
  takes: [], // Enterキーで登録した作品(それぞれ{ id, strokes })。Qキーで順番に再生する
};

// takes(登録済み作品)はlocalStorageに永続化する
const TAKES_STORAGE_KEY = 'vl_takes';

function cloneStrokes(strokes) {
  return JSON.parse(JSON.stringify(strokes));
}

function loadTakesFromStorage() {
  try {
    const raw = localStorage.getItem(TAKES_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) state.takes = parsed;
  } catch (err) {
    console.warn('登録済み作品の読み込みに失敗しました:', err);
  }
}

function saveTakesToStorage() {
  try {
    localStorage.setItem(TAKES_STORAGE_KEY, JSON.stringify(state.takes));
  } catch (err) {
    console.warn('登録済み作品の保存に失敗しました(容量オーバー等):', err);
  }
}

// タイポ合成: 下地の暗い部分では白文字、明るい部分では黒文字として描く。
// 下地をグレースケール→反転→強コントラストで白黒2値化し、タイポのアルファで切り抜くと
// そのまま「明暗に応じた文字色」のレイヤーになる(補色化はしない)
function drawTypoAdaptive(destCtx, backdrop, typoAlpha, W, H, work) {
  const w = work.getContext('2d');
  w.save();
  w.globalCompositeOperation = 'source-over';
  w.clearRect(0, 0, W, H);
  w.filter = 'grayscale(1) invert(1) contrast(4000%)';
  w.drawImage(backdrop, 0, 0, W, H);
  w.filter = 'none';
  w.globalCompositeOperation = 'destination-in';
  w.drawImage(typoAlpha, 0, 0, W, H);
  w.restore();
  destCtx.drawImage(work, 0, 0);
}

function cacheTypoPreview() {
  if (!state.typo) return;
  const c = document.createElement('canvas');
  c.width = PREVIEW_W;
  c.height = PREVIEW_H;
  drawCover(c.getContext('2d'), state.typo, PREVIEW_W, PREVIEW_H);
  state.typoPreview = c;
  artDirty = true;
}

// プレビュー用のタイポ合成ワークキャンバス(毎フレームの確保を避ける)
const typoWork = document.createElement('canvas');
typoWork.width = PREVIEW_W;
typoWork.height = PREVIEW_H;
// drawTypoAdaptiveは内部でdestCtxにも描くが、フェードインの不透明度は
// vctxへ貼る側で別途制御したいので、ここでは使い捨ての描画先として渡す
const typoDummyDest = document.createElement('canvas');
typoDummyDest.width = PREVIEW_W;
typoDummyDest.height = PREVIEW_H;
const typoDummyCtx = typoDummyDest.getContext('2d');

for (const [id, src] of Object.entries(OBJECT_SRC)) {
  const img = new Image();
  img.src = src;
  state.images[id] = img;
}

// TDスプレーノイズ(透過)。スタンプ画像のシルエットに質感として流し込む
const SPRAY_SRC = {
  black: 'assets/td/stamps/spray_black.png',
  white: 'assets/td/stamps/spray_white.png',
};
const sprayTex = {};
for (const [k, src] of Object.entries(SPRAY_SRC)) {
  const img = new Image();
  img.src = src;
  sprayTex[k] = img;
}

// 元画像のアルファ(シルエット)でスプレーを切り抜いた質感付き画像を生成してキャッシュする。
// 生成したcanvasはstate.imagesに入るので、リプレイ/書き出しでも同じIDで参照できる。
// color: 'native'=固有色(スプレーをマスクにして元の色を残す) / 'black' / 'white'
function texturedImageId(baseId, color) {
  const id = `${baseId}@spray-${color}`;
  if (state.images[id]) return id;
  const base = state.images[baseId];
  const spray = color === 'native' ? sprayTex.black : sprayTex[color];
  if (!base || !base.complete || !base.naturalWidth || !spray || !spray.complete) {
    return baseId; // 未ロード時は素の画像で描く
  }
  const c = document.createElement('canvas');
  c.width = base.naturalWidth;
  c.height = base.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(base, 0, 0);
  // 固有色: スプレーのアルファで抜くだけなので、点の色は元画像のまま残る
  ctx.globalCompositeOperation = color === 'native' ? 'destination-in' : 'source-in';
  drawCover(ctx, spray, c.width, c.height);
  state.images[id] = c;
  return id;
}

// TDスタンプ(スプレー/スプラッター)を任意色に着色したバリアントを生成してキャッシュする。
// アルファ(質感)はそのまま、色だけを差し替える
function tintedImageId(baseId, color) {
  const id = `${baseId}@tint-${color}`;
  if (state.images[id]) return id;
  const base = state.images[baseId];
  if (!base || !base.complete || !base.naturalWidth) return baseId;
  const c = document.createElement('canvas');
  c.width = base.naturalWidth;
  c.height = base.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  state.images[id] = c;
  return id;
}

const BARCODE_FONT = 'Libre Barcode 39';
const barcodeFont = new FontFace(BARCODE_FONT, 'url(assets/fonts/LibreBarcode39-Regular.ttf)');
barcodeFont.load().then((f) => document.fonts.add(f));

const params = {
  brushType: 'stamp',
  stampImage: 'tomatoes',
  stampTexture: false,
  stampTextureColor: 'native',
  stampColor: '#000000',
  stampSize: 150,
  spacing: 80,
  rotate: true,
  animDelay: 0.4,
  animDuration: 0.7,
  barcodeText: 'IDC VISUAL LAN',
  barcodeSize: 120,
  barcodeColor: '#000000',
  effectType: 'stretch',
  effectWidth: 100,
  effectBlur: 12,
  effectShowHead: true,
  tipStyle: 'brush',
  pathText: true,
  pathTextContent: '新しい食品のカタチ',
  pathTextSize: 34,
  pathTextMargin: 24,
  brushWidth: 60,
  smoothing: 0.75,
  typoVisible: true,
  typoVersion: 'ver6',
  handTracking: false,
  rightHandBrush: 'stamp',
  leftHandBrush: 'stampTex',
  dpi: 150,
};

function resetBase(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.photo) drawCover(ctx, state.photo, canvas.width, canvas.height);
}

function redrawArt() {
  resetBase(art);
  for (const stroke of state.strokes) replayStroke(art, stroke, state.images);
  artDirty = true;
}

// ---- ライブ描画 ----
// 描いた軌跡は即描画せず、ポインタを離した後に遅延+イージングでリプレイする。
// マウスと左右の手で同時に描けるよう、ポインタIDごとにライブストロークを持つ
const liveStrokes = new Map(); // pointerId -> stroke
const anims = []; // { stroke, engines, fed, start }
// artの見た目が変わったフレームだけ、タイポの明暗合成(重いcanvasフィルタ)を作り直す
let artDirty = true;
// パステキストの演出(線の描き終わり後に 出現→静止→消滅)。作品キャンバスには焼き込まない
const captionAnims = []; // { slots, sizePx, offPx, color, start }

// pointerIdからどの手か(手以外はundefined)
const POINTER_HAND = { [HAND_POINTER_ID.left]: 'left', [HAND_POINTER_ID.right]: 'right' };

// ブラシ種別からストロークデータを組み立てる
// kind: 'stamp' | 'stampTex'(TDノイズ質感を強制) | 'barcode' | 'stretch'
function makeStroke(kind) {
  // エフェクトはCurvilinear Pixel Stretching(曲線追従の引き伸ばし)のみ。
  // 画像スタンプでは「画像そのものの断面」がチューブ状に伸び、
  // バーコードではキャンバスから掴んだ色帯が伸びる
  // ストレッチは「最初に掴んだ断面を伸ばし続ける」固定方式、ボカシは軌跡沿いの霞
  let effect = null;
  if (kind !== 'stretch' && params.effectType !== 'none') {
    effect = params.effectType === 'blur'
      ? {
          type: 'blur',
          widthN: params.effectWidth / PREVIEW_W,
          blurN: params.effectBlur / PREVIEW_W,
        }
      : {
          type: 'stretch',
          widthN: params.effectWidth / PREVIEW_W,
          mode: 'fixed',
          showHead: params.effectShowHead,
        };
  }
  // パステキスト: ONならストロークに沿う文字をデータとして記録(リプレイでも同じ位置に出る)。
  // 余白はストロークの端から測るので、ストローク半幅を足したオフセットを持たせる
  let caption = null;
  if (params.pathText) {
    let half = 0;
    if (kind === 'stretch') half = params.brushWidth / 2;
    else if (kind === 'barcode') half = params.barcodeSize / 2;
    else half = (params.effectType !== 'none' ? params.effectWidth : params.stampSize) / 2;
    caption = {
      text: params.pathTextContent,
      sizeN: params.pathTextSize / PREVIEW_W,
      offsetN: (half + params.pathTextMargin) / PREVIEW_W,
    };
  }
  if (kind === 'stretch') {
    // ストレッチブラシ: キャンバス(背景・既存描画)を拾いながら引き伸ばす(スミア)
    return {
      type: 'stretch',
      widthN: params.brushWidth / PREVIEW_W,
      mode: 'smear',
      smoothing: params.smoothing,
      tip: params.tipStyle,
      caption,
      points: [],
    };
  }
  if (kind === 'barcode') {
    return {
      type: 'text',
      // Code 39は大文字英数と - . $ / + % 空白のみ対応
      text: params.barcodeText.toUpperCase(),
      fontFamily: BARCODE_FONT,
      color: params.barcodeColor,
      sizeN: params.barcodeSize / PREVIEW_W,
      spacingN: params.spacing / PREVIEW_W,
      rotate: true, // バーコードは常に進行方向へ回転
      smoothing: params.smoothing,
      tip: params.tipStyle,
      effect,
      caption,
      points: [],
    };
  }
  // スタンプ: TDスタンプは選択色で着色、オブジェクト画像は質感指定に従う。
  // kindが'td〜'の場合は共有の「画像」設定に関わらずその幾何学スタンプで描く
  let imageId = kind.startsWith('td') ? kind : params.stampImage;
  const isTdStamp = imageId.startsWith('td');
  if (isTdStamp) {
    imageId = tintedImageId(imageId, params.stampColor);
  } else if (kind === 'stampTex' || params.stampTexture) {
    imageId = texturedImageId(imageId, params.stampTextureColor);
  }
  return {
    type: 'image',
    imageId,
    sizeN: params.stampSize / PREVIEW_W,
    spacingN: params.spacing / PREVIEW_W,
    // オブジェクト画像は回転なし(正面のまま)、TD系はチェックボックスに従う
    rotate: isTdStamp ? params.rotate : false,
    smoothing: params.smoothing,
    tip: params.tipStyle,
    effect,
    caption,
    points: [],
  };
}

// 短い溜め→一気に走る→長くスッと抜ける。緩急を強調しつつ両端がなめらかに繋がる
const easeStroke = (t) => {
  if (t >= 1) return 1;
  const a = Math.pow(t, 1.7); // 入りの溜め
  return 1 - Math.pow(1 - a, 6); // 抜けの減速
};

// アニメーション1件を組み立てる。進行は点の個数ではなく弧長で測る:
// ゆっくり描いた区間(点が密)で這うように遅くなるムラをなくし、一定の速度感で走らせる
function makeAnim(stroke) {
  const pts = stroke.points;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(
      (pts[i].x - pts[i - 1].x) * PREVIEW_W,
      (pts[i].y - pts[i - 1].y) * PREVIEW_H
    );
  }
  return {
    stroke,
    engines: createEngines(art, stroke, state.images),
    fed: 0,
    start: performance.now(),
    cum,
    total: pts.length ? cum[pts.length - 1] : 0,
  };
}

function pointFromEvent(e) {
  const r = view.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height,
  };
}

// ---- 選択/移動 ----
// 描いたストロークをオブジェクトとして扱う: クリックで選択、ドラッグで移動、Deleteで削除
let dragSel = null; // { last: {x,y}, dx, dy } 移動量は正規化座標で持つ

function strokeHitRadius(stroke) {
  let r = 12; // 細いストロークでも掴めるよう最低半径を確保
  if (stroke.type === 'image' || stroke.type === 'text') {
    r = Math.max(r, (stroke.sizeN * PREVIEW_W) / 2);
  } else if (stroke.type === 'stretch') {
    r = Math.max(r, (stroke.widthN * PREVIEW_W) / 2);
  }
  return r;
}

// 点pから、ストロークの軌跡(折れ線)までの最短距離(プレビューpx)
function distToStroke(p, stroke) {
  const pts = stroke.points;
  const px = p.x * PREVIEW_W;
  const py = p.y * PREVIEW_H;
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x1 = pts[i].x * PREVIEW_W;
    const y1 = pts[i].y * PREVIEW_H;
    if (i === pts.length - 1) {
      min = Math.min(min, Math.hypot(px - x1, py - y1));
      break;
    }
    const x2 = pts[i + 1].x * PREVIEW_W;
    const y2 = pts[i + 1].y * PREVIEW_H;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
  }
  return min;
}

// 最前面(後に描いたもの)から順にヒットテスト
function pickStroke(p) {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (distToStroke(p, s) <= strokeHitRadius(s)) return s;
  }
  return null;
}

// ---- リプレイ演出 ----
// Aキーで、描いた軌跡を白紙から順番にアニメーション再生する
let replayQueue = null; // 再生待ちのストローク列(先頭から順に演出)
const FADE_OUT_MS = 450; // 開始時、今の見た目が消えるまでのフェード時間
let fadeOut = null; // { canvas, start } 消える瞬間の見た目を焼き付けたスナップショット
// true の間にフェードアウトが完了すると、その瞬間に背景レイヤーを切り替える
// (ストロークが完全に消えるのと同じタイミングで背景も切り替わるようにするため)
let typoSwapPending = false;
const TYPO_FADE_IN_MS = 450; // 次の背景レイヤーがフェードインする時間(FADE_OUT_MSと揃える)
let typoFadeIn = null; // { start } 背景切り替え直後、透明度0からのフェードイン管理

function startReplayShow() {
  if (!state.strokes.length) return;
  anims.length = 0;
  captionAnims.length = 0;
  state.selected = null;

  // 消える瞬間の見た目(タイポ込みの現在表示)をそのまま撮って、フェードアウトの素材にする
  const snap = document.createElement('canvas');
  snap.width = PREVIEW_W;
  snap.height = PREVIEW_H;
  snap.getContext('2d').drawImage(view, 0, 0);
  fadeOut = { canvas: snap, start: performance.now() };

  replayQueue = state.strokes.slice();
  resetBase(art); // 白紙(写真レイヤーのみ)に戻してから積み上げ直す
  artDirty = true;
}

// 描画操作や削除が入ったら演出は中断し、完成状態に戻す
function cancelReplayShow() {
  fadeOut = null;
  typoSwapPending = false;
  if (sequence) {
    stopSequencePlayback();
    return;
  }
  if (!replayQueue) return;
  replayQueue = null;
  anims.length = 0;
  captionAnims.length = 0;
  redrawArt();
}

// ---- 連続再生(Qキー): 登録済みの作品(takes)を1件ずつフェード→再生し、最後まで行ったらループする ----
const SEQUENCE_HOLD_MS = 2000; // 1件描き終えてから、次のフェードアウトに移るまでの静止時間
let sequence = null; // { savedStrokes, index, holding, holdUntil }

function playSequenceTake(index) {
  state.strokes = cloneStrokes(state.takes[index].strokes);
  startReplayShow();
  // 背景の切り替えはここでは行わず、フェードアウトが完全に終わった瞬間まで待つ
  // (ストロークが消えるのと背景が変わるタイミングを合わせるため)
  typoSwapPending = true;
}

function startSequencePlayback() {
  if (!state.takes.length || sequence) return;
  sequence = { savedStrokes: state.strokes, index: 0, holding: false, holdUntil: 0 };
  console.log(`連続再生を開始します(${state.takes.length}件)`);
  playSequenceTake(0);
}

function stopSequencePlayback() {
  if (!sequence) return;
  const restore = sequence.savedStrokes;
  sequence = null;
  replayQueue = null;
  fadeOut = null;
  typoSwapPending = false;
  anims.length = 0;
  captionAnims.length = 0;
  state.selected = null;
  state.strokes = restore;
  redrawArt();
  console.log('連続再生を停止しました');
}

function toggleSequencePlayback() {
  if (sequence) stopSequencePlayback();
  else startSequencePlayback();
}

function advanceSequence() {
  if (!sequence) return;
  sequence.index = (sequence.index + 1) % state.takes.length;
  playSequenceTake(sequence.index);
}

function deleteSelected() {
  if (!state.selected) return;
  const i = state.strokes.indexOf(state.selected);
  if (i >= 0) {
    state.strokes.splice(i, 1);
    replayQueue = null;
    anims.length = 0;
    captionAnims.length = 0;
    redrawArt();
  }
  state.selected = null;
}

view.addEventListener('pointerdown', (e) => {
  try { view.setPointerCapture(e.pointerId); } catch { /* 合成イベント等では不可 */ }
  cancelReplayShow();
  const hand = POINTER_HAND[e.pointerId];
  // 選択モードはマウス/ペン操作のみ。手はいつでも自分のブラシで描く
  if (!hand && params.brushType === 'select') {
    const p = pointFromEvent(e);
    state.selected = pickStroke(p);
    dragSel = state.selected ? { last: p, dx: 0, dy: 0 } : null;
    return;
  }
  const kind = hand
    ? (hand === 'right' ? params.rightHandBrush : params.leftHandBrush)
    : params.brushType;
  const stroke = makeStroke(kind);
  stroke.points.push(pointFromEvent(e));
  liveStrokes.set(e.pointerId, stroke);
});

view.addEventListener('pointermove', (e) => {
  if (!POINTER_HAND[e.pointerId] && dragSel && state.selected) {
    const p = pointFromEvent(e);
    dragSel.dx += p.x - dragSel.last.x;
    dragSel.dy += p.y - dragSel.last.y;
    dragSel.last = p;
    return;
  }
  const stroke = liveStrokes.get(e.pointerId);
  if (stroke) stroke.points.push(pointFromEvent(e));
});

view.addEventListener('pointerup', (e) => {
  if (!POINTER_HAND[e.pointerId] && dragSel) {
    // 移動確定: 点列そのものをずらして全体を再描画(書き出しにもそのまま反映される)
    if (state.selected && (dragSel.dx || dragSel.dy)) {
      for (const pt of state.selected.points) {
        pt.x += dragSel.dx;
        pt.y += dragSel.dy;
      }
      anims.length = 0;
      redrawArt();
    }
    dragSel = null;
    return;
  }
  const stroke = liveStrokes.get(e.pointerId);
  if (stroke) {
    liveStrokes.delete(e.pointerId);
    // スタンプ系はクリック1回(1点)でも残す。ストレッチは軌跡が必要
    const min = stroke.type === 'stretch' ? 2 : 1;
    if (stroke.points.length >= min) {
      state.strokes.push(stroke);
      anims.push(makeAnim(stroke));
    }
  }
});

// ---- ガイド表示 ----
// 描画待ちの軌跡を灰色で示す。実描画が追いつくと消えていく
function drawGuide(points, from = 0, straight = false) {
  const n = points.length - from;
  if (n < 1) return;
  vctx.save();
  vctx.strokeStyle = 'rgba(130, 130, 130, 0.75)';
  vctx.fillStyle = 'rgba(130, 130, 130, 0.75)';
  vctx.lineWidth = 2;
  vctx.lineJoin = 'round';
  vctx.lineCap = 'round';
  if (n === 1) {
    vctx.beginPath();
    vctx.arc(points[from].x * PREVIEW_W, points[from].y * PREVIEW_H, 4, 0, Math.PI * 2);
    vctx.fill();
  } else if (straight) {
    // ストレッチは実描画が直線なので、ガイドも現在位置→終点の直線で見せる
    const last = points[points.length - 1];
    vctx.beginPath();
    vctx.moveTo(points[from].x * PREVIEW_W, points[from].y * PREVIEW_H);
    vctx.lineTo(last.x * PREVIEW_W, last.y * PREVIEW_H);
    vctx.stroke();
  } else {
    vctx.beginPath();
    vctx.moveTo(points[from].x * PREVIEW_W, points[from].y * PREVIEW_H);
    for (let i = from + 1; i < points.length; i++) {
      vctx.lineTo(points[i].x * PREVIEW_W, points[i].y * PREVIEW_H);
    }
    vctx.stroke();
  }
  vctx.restore();
}

// ---- 表示ループ ----
// 1フレームが例外を投げてもrequestAnimationFrameの再スケジュールだけは必ず行う。
// (末尾のrequestAnimationFrame呼び出し手前で例外が出ると、ループそのものが
//  二度と回らなくなり「背景の文字が最初から出ない」ような症状につながるため)
function frame(now = performance.now()) {
  try {
    frameBody(now);
  } catch (err) {
    console.error('frame() error:', err);
  }
  requestAnimationFrame(frame);
}

function frameBody(now) {
  // 遅延+イージングで、点列を進行度ぶんだけエンジンに流し込む
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i];
    const t = (now - a.start - params.animDelay * 1000) / (params.animDuration * 1000);
    if (t < 0) continue;
    const progress = easeStroke(t);
    // 弧長ベース: 進行度ぶんの距離に達するまで記録済みの点を順に流し込む
    const targetLen = progress * a.total;
    const pts = a.stroke.points;
    while (a.fed < pts.length && (a.total === 0 || a.cum[a.fed] <= targetLen)) {
      const pt = pts[a.fed++];
      for (const en of a.engines) en.addPoint(pt.x, pt.y);
      artDirty = true;
    }
    if (t >= 1) {
      anims.splice(i, 1);
      // 線が描き終わったらパステキストの演出を開始
      if (a.stroke.caption && a.stroke.caption.text) {
        const track = buildCaptionTrack(art, a.stroke);
        if (track && track.chars.length) captionAnims.push({ track, start: now });
      }
    }
  }
  // リプレイ演出: 前のストロークを描き終えたら次を投入する
  // (フェードアウトが終わるまでは、最初のストロークの投入を待つ)
  if (replayQueue) {
    if (!replayQueue.length && !anims.length) {
      replayQueue = null; // 全部描き終わった
      if (sequence && !sequence.holding) {
        // 連続再生中: しばらく静止表示してから次の作品のフェードアウトに移る
        sequence.holding = true;
        sequence.holdUntil = now + SEQUENCE_HOLD_MS;
      }
    } else if (!anims.length && !fadeOut) {
      anims.push(makeAnim(replayQueue.shift()));
    }
  }
  if (sequence && sequence.holding && now >= sequence.holdUntil) {
    sequence.holding = false;
    advanceSequence();
  }
  vctx.drawImage(art, 0, 0);
  if (params.typoVisible && state.typoPreview) {
    // artが変化したフレームだけ明暗合成(フィルタ処理)をやり直し、
    // 変化がない間は前フレームのtypoWorkをそのまま貼るだけにして負荷を下げる
    if (artDirty) {
      drawTypoAdaptive(typoDummyCtx, art, state.typoPreview, PREVIEW_W, PREVIEW_H, typoWork);
      artDirty = false;
    }
    // 背景切り替え直後はここでフェードイン(透明度0→1)させる。
    // ストロークの描き始めと同じ瞬間にtypoFadeInがセットされるので、自然と同期する
    if (typoFadeIn) {
      const ft = (now - typoFadeIn.start) / TYPO_FADE_IN_MS;
      if (ft >= 1) {
        typoFadeIn = null;
        vctx.drawImage(typoWork, 0, 0);
      } else {
        vctx.save();
        vctx.globalAlpha = Math.max(0, ft);
        vctx.drawImage(typoWork, 0, 0);
        vctx.restore();
      }
    } else {
      vctx.drawImage(typoWork, 0, 0);
    }
  }
  // ガイド: ドラッグ中の軌跡と、描画待ち〜描画中の残り区間
  // (Aキーのリプレイ演出中はガイドを出さず、描画だけを見せる)
  for (const stroke of liveStrokes.values()) {
    drawGuide(stroke.points, 0, stroke.type === 'stretch');
  }
  if (!replayQueue) {
    for (const a of anims) {
      drawGuide(a.stroke.points, a.fed, a.stroke.type === 'stretch');
    }
  }
  // 選択中のオブジェクトの枠(ドラッグ中は移動先を追従)
  if (params.brushType === 'select' && state.selected) {
    drawSelection(state.selected, dragSel);
  }
  // パステキスト: 線に沿って流れるマーキー。
  // 速いスピードで中央まで流れ込み → ごくゆっくり前進し続け(止まり切らない) →
  // 加速して終端へ流れ過ぎ、フェードゾーンで部分的に消えていく
  const CAP_IN = 0.7; // 中央到達までの時間
  const CAP_DRIFT = 1.8; // 微速前進の時間
  const CAP_OUT = 0.9; // 流れ出る時間
  const capInEase = (t) => 1 - Math.pow(1 - Math.min(1, t), 3.5); // 初速早め
  const capOutEase = (t) => Math.pow(Math.min(1, t), 2.5); // 加速して抜ける
  for (let i = captionAnims.length - 1; i >= 0; i--) {
    const c = captionAnims[i];
    const tr = c.track;
    const el = (now - c.start) / 1000;
    const sC = (tr.totalOff - tr.blockW) / 2; // 中央に置いたときのブロック先頭位置
    const drift = tr.sizePx * 0.6; // 微速前進の総移動量
    let s;
    if (el < CAP_IN) {
      s = -tr.blockW + (sC + tr.blockW) * capInEase(el / CAP_IN);
    } else if (el < CAP_IN + CAP_DRIFT) {
      s = sC + drift * ((el - CAP_IN) / CAP_DRIFT);
    } else {
      const t2 = (el - CAP_IN - CAP_DRIFT) / CAP_OUT;
      if (t2 >= 1) {
        captionAnims.splice(i, 1);
        continue;
      }
      s = sC + drift + (tr.totalOff - (sC + drift)) * capOutEase(t2);
    }
    const fade = tr.sizePx * 1.6; // 両端のフェードゾーン(部分的に現れ/消える)
    vctx.save();
    vctx.font = `${tr.sizePx}px sans-serif`;
    vctx.textAlign = 'center';
    vctx.textBaseline = 'middle';
    vctx.fillStyle = tr.color;
    const off = tr.offPx + tr.sizePx * 0.5;
    for (const chSlot of tr.chars) {
      const soff = s + chSlot.rel;
      const aIn = Math.min(1, Math.max(0, soff / fade));
      const aOut = Math.min(1, Math.max(0, (tr.totalOff - soff) / fade));
      const alpha = Math.min(aIn, aOut);
      if (alpha <= 0.01) continue;
      const p = tr.at(soff);
      const ox = Math.cos(p.ang - Math.PI / 2) * off;
      const oy = Math.sin(p.ang - Math.PI / 2) * off;
      vctx.save();
      vctx.globalAlpha = alpha;
      vctx.translate(p.x + ox, p.y + oy);
      vctx.rotate(p.ang);
      vctx.fillText(chSlot.ch, 0, 0);
      vctx.restore();
    }
    vctx.restore();
  }
  // ハンドトラッキングのカーソル(右手=グリーン/左手=オレンジ、ピンチ中は塗りつぶし)
  const HAND_COLORS = {
    right: ['#31ff79', 'rgba(49, 255, 121, 0.6)'],
    left: ['#ffa23e', 'rgba(255, 162, 62, 0.6)'],
  };
  const hcs = handCursors();
  for (const hand of ['left', 'right']) {
    const hc = hcs[hand];
    if (!hc.active) continue;
    vctx.save();
    vctx.strokeStyle = HAND_COLORS[hand][0];
    vctx.fillStyle = HAND_COLORS[hand][1];
    vctx.lineWidth = 2;
    vctx.beginPath();
    vctx.arc(hc.x * PREVIEW_W, hc.y * PREVIEW_H, hc.drawing ? 10 : 14, 0, Math.PI * 2);
    if (hc.drawing) vctx.fill();
    vctx.stroke();
    vctx.restore();
  }
  // Aキー演出の開始直後: 直前の見た目のスナップショットを、下のまっさらな状態の上に
  // 不透明度を落としながら重ねることで「各要素がふわっと消える」ように見せる
  if (fadeOut) {
    const t = (now - fadeOut.start) / FADE_OUT_MS;
    if (t >= 1) {
      fadeOut = null;
      if (typoSwapPending) {
        // 前の作品が完全に消えた瞬間に合わせて背景レイヤーを切り替える
        typoSwapPending = false;
        randomizeTypoVersion();
      }
    } else {
      vctx.save();
      vctx.globalAlpha = 1 - t;
      vctx.drawImage(fadeOut.canvas, 0, 0);
      vctx.restore();
    }
  }
}

// 選択枠: 軌跡の破線と、ヒット半径ぶん膨らませたバウンディングボックス
function drawSelection(stroke, drag) {
  const ox = drag ? drag.dx : 0;
  const oy = drag ? drag.dy : 0;
  const pts = stroke.points;
  if (!pts.length) return;
  vctx.save();
  vctx.strokeStyle = '#31ff79';
  vctx.lineWidth = 1.5;
  vctx.setLineDash([6, 4]);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  vctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (pts[i].x + ox) * PREVIEW_W;
    const y = (pts[i].y + oy) * PREVIEW_H;
    if (i === 0) vctx.moveTo(x, y);
    else vctx.lineTo(x, y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (pts.length > 1) vctx.stroke();
  const r = strokeHitRadius(stroke);
  vctx.strokeRect(minX - r, minY - r, maxX - minX + r * 2, maxY - minY + r * 2);
  vctx.restore();
}

// ---- 画像読み込み ----
function pickImage(onload) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => onload(img);
    img.src = URL.createObjectURL(file);
  };
  input.click();
}

// 一度読み込んだタイポ画像はキャッシュし、2回目以降の切り替えは待たずに即反映する
// (Enter/Qキーでの背景切り替えを、ストロークが消えるタイミングとぴったり合わせるため)
const typoImageCache = {};

function loadTypo(src, retriesLeft = 2) {
  const cached = typoImageCache[src];
  if (cached) {
    state.typo = cached;
    cacheTypoPreview();
    return;
  }
  const img = new Image();
  img.onload = () => {
    typoImageCache[src] = img;
    state.typo = img;
    cacheTypoPreview();
  };
  img.onerror = () => {
    if (retriesLeft > 0) {
      console.warn(`タイポ画像の読み込みに失敗、再試行します: ${src}`);
      setTimeout(() => loadTypo(src, retriesLeft - 1), 300);
    } else {
      console.error(`タイポ画像の読み込みに失敗しました: ${src}`);
    }
  };
  img.src = src;
}

// 起動時に全タイポ版をキャッシュしておく(表示中のものは変えない)。
// これでEnter/Qキーでのランダム切り替えは初回選択時から即座に反映される
function preloadAllTypoVersions() {
  for (const src of Object.values(TYPO_SRC)) {
    if (typoImageCache[src]) continue;
    const img = new Image();
    img.onload = () => {
      typoImageCache[src] = img;
    };
    img.src = src;
  }
}

// 背景レイヤー(タイポ版)を、直前と被らないようにランダムに切り替える
function randomizeTypoVersion() {
  const keys = Object.keys(TYPO_SRC);
  const candidates = keys.length > 1 ? keys.filter((k) => k !== params.typoVersion) : keys;
  const next = candidates[Math.floor(Math.random() * candidates.length)];
  params.typoVersion = next;
  loadTypo(TYPO_SRC[next]);
  pane.refresh();
  // 新しい背景は透明度0から出現させる。ストロークの描き始めと同じ瞬間に始まるよう、
  // ここ(切り替えの瞬間)でフェードインを開始する
  typoFadeIn = { start: performance.now() };
}

// ---- リセット ----
// Rキーで、描いたストロークを全部消して白紙(写真レイヤーのみ)に戻す
function resetCanvas() {
  if (!state.strokes.length) return;
  replayQueue = null;
  fadeOut = null;
  anims.length = 0;
  captionAnims.length = 0;
  state.selected = null;
  state.strokes.length = 0;
  redrawArt();
}

// ---- 作品登録(Enterキー) ----
// 今キャンバスにある全ストロークを1作品としてtakesに登録し、localStorageに保存。
// 登録後は次の作品をすぐ描き始められるよう白紙に戻す
function registerTake() {
  if (sequence || !state.strokes.length) return;
  state.takes.push({ id: Date.now(), strokes: cloneStrokes(state.strokes) });
  saveTakesToStorage();
  rebuildTakesUI();
  console.log(`作品を登録しました(全${state.takes.length}件)`);
  // ストロークが消えるのと同じタイミングで背景も切り替わるよう、リセットの直後に呼ぶ
  // (画像キャッシュ済みのタイポ版なら同期的に切り替わる)
  resetCanvas();
  randomizeTypoVersion();
}

// ---- 表示モード(F: フルスクリーン / H: UIの表示切替) ----
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => console.error('フルスクリーン化に失敗:', err));
  } else {
    document.exitFullscreen();
  }
}

let uiVisible = true;
function toggleUI() {
  uiVisible = !uiVisible;
  const disp = uiVisible ? '' : 'none';
  const paneWrap = pane.element.closest('.tp-dfwv');
  if (paneWrap) paneWrap.style.display = disp;
  const croptool = document.getElementById('croptool');
  if (croptool) croptool.style.display = disp;
  // カメラ(#handcam)はここでは触らない
}

// ---- Undo ----
function undo() {
  if (!state.strokes.length) return;
  // 進行中のアニメーションとリプレイ演出は打ち切り、残りのストロークを確定状態で再描画
  replayQueue = null;
  anims.length = 0;
  captionAnims.length = 0;
  state.strokes.pop();
  if (state.selected && !state.strokes.includes(state.selected)) state.selected = null;
  redrawArt();
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  // テキスト入力中(バーコード文言など)のBackspaceを奪わない
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'Escape') {
    state.selected = null;
    cancelReplayShow();
  } else if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey) {
    startReplayShow();
  } else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) {
    resetCanvas();
  } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) {
    toggleFullscreen();
  } else if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey) {
    toggleUI();
  } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
    registerTake();
  } else if ((e.key === 'q' || e.key === 'Q') && !e.metaKey && !e.ctrlKey) {
    toggleSequencePlayback();
  }
});

// ---- 書き出し（ストロークを高解像度でリプレイ） ----
async function exportPNG() {
  const [W, H] = DPI_SIZE[params.dpi];
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  if (state.photo) drawCover(ctx, state.photo, W, H);
  for (const stroke of state.strokes) replayStroke(c, stroke, state.images);
  if (params.typoVisible && state.typo) {
    const typoHi = document.createElement('canvas');
    typoHi.width = W;
    typoHi.height = H;
    drawCover(typoHi.getContext('2d'), state.typo, W, H);
    const work = document.createElement('canvas');
    work.width = W;
    work.height = H;
    drawTypoAdaptive(ctx, c, typoHi, W, H, work);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `visualLan_A1_${params.dpi}dpi_${Date.now()}.png`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ファイル名に使えない文字を置換する
function sanitizeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

// ストローク1本の内容が分かる短いラベルを作る(ファイル名用)
function strokeLabel(stroke) {
  if (stroke.type === 'image') return `stamp_${sanitizeFileName(stroke.imageId)}`;
  if (stroke.type === 'text') return 'barcode';
  if (stroke.type === 'stretch') return 'stretch';
  return stroke.type || 'stroke';
}

// ---- レイヤー別書き出し(背景写真/ストロークごとの描画/タイポを個別ファイルにしてZIPにまとめる) ----
// 写真・描画は背景透過PNG。タイポは(実際の見た目と一致するよう)明暗適応の色つき透過PNG1枚にする
// 2枚のcanvasを比較し、変化があったピクセルだけを残した(他は透明)canvasを返す。
// ストレッチ/ボカシなど「既存キャンバスの内容を読んで描く」エフェクトは、単独の空白
// canvasに再生すると読み取り元が無く消えてしまうため、必ずこの差分方式で切り出す
function diffCanvas(before, after, W, H) {
  const bd = before.getContext('2d').getImageData(0, 0, W, H).data;
  const ad = after.getContext('2d').getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  const op = od.data;
  for (let i = 0; i < ad.length; i += 4) {
    if (bd[i] !== ad[i] || bd[i + 1] !== ad[i + 1] || bd[i + 2] !== ad[i + 2] || bd[i + 3] !== ad[i + 3]) {
      op[i] = ad[i]; op[i + 1] = ad[i + 1]; op[i + 2] = ad[i + 2]; op[i + 3] = ad[i + 3];
    } // 変化なしの画素はop[i+3]=0のまま(=透明)で初期化済み
  }
  octx.putImageData(od, 0, 0);
  return out;
}

async function exportLayers(onProgress) {
  const [W, H] = DPI_SIZE[params.dpi];
  const zip = new JSZip();
  let idx = 1;
  const pad = () => String(idx++).padStart(2, '0');
  const blank = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const toPngBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

  // 1. 背景写真/TDテクスチャ
  if (state.photo) {
    const c = blank();
    drawCover(c.getContext('2d'), state.photo, W, H);
    zip.file(`${pad()}_photo.png`, await toPngBlob(c));
  }

  // 白地+写真を敷いた土台。通常の描画(resetBase)と同じ状態から始める。
  // タイポの明暗適応判定の下地にも、ストロークの差分抽出の基準にもこれを使う
  let cumulative = blank();
  {
    const cctx = cumulative.getContext('2d');
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, W, H);
    if (state.photo) drawCover(cctx, state.photo, W, H);
  }

  // 2. 描画(ストロークごとに個別ファイル)。各ストロークは「直前までの状態」との差分だけを
  // 抜き出すので、キャンバスの色を吸い取って伸ばすストレッチブラシのような、既存内容に
  // 依存するエフェクトでも正しく独立したレイヤーになる
  if (state.strokes.length) {
    for (let i = 0; i < state.strokes.length; i++) {
      const stroke = state.strokes[i];
      onProgress?.(`描画 ${i + 1}/${state.strokes.length}`);
      const before = cumulative;
      const after = blank();
      after.getContext('2d').drawImage(before, 0, 0);
      replayStroke(after, stroke, state.images);
      const layer = diffCanvas(before, after, W, H);
      const n = String(i + 1).padStart(2, '0');
      zip.file(`${pad()}_drawing_${n}_${strokeLabel(stroke)}.png`, await toPngBlob(layer));
      cumulative = after;
    }
  }

  // 3. タイポ: 実際の見た目(明暗に応じた白/黒反転)と一致する透過PNGにする。
  // 下地は白地+写真+全ストローク(=cumulative)と、画面表示・PNG一括書き出しと全く同じもの
  if (params.typoVisible && state.typo) {
    const typoHi = document.createElement('canvas');
    typoHi.width = W;
    typoHi.height = H;
    drawCover(typoHi.getContext('2d'), state.typo, W, H);
    const out = blank();
    const dummy = blank();
    drawTypoAdaptive(dummy.getContext('2d'), cumulative, typoHi, W, H, out);
    zip.file(`${pad()}_typo.png`, await toPngBlob(out));
  }

  if (idx === 1) return; // 書き出す要素が無い

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zipBlob);
  a.download = `visualLan_A1_layers_${params.dpi}dpi_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- UI ----
// 使う流れの順に配置する: ブラシを選ぶ → そのブラシの設定 → エフェクト → 背景 →
// ハンド入力/演出 → 書き出し。選択中のブラシに関係あるフォルダだけを自動で開き、
// 状況に合わない項目(TD色と質感、エフェクトのモード等)は隠す
const pane = new Pane({ title: 'A1 Poster Tool' });
{
  const paneWrap = pane.element.closest('.tp-dfwv');
  const paneHandle = pane.element.querySelector(':scope > .tp-rotv_b');
  if (paneWrap && paneHandle) {
    makeDraggable(paneHandle, paneWrap, { storageKey: 'vl_pane_pos' });
  }
}

const COLOR_PRESETS = [
  { text: 'グリーン #31ff79', value: '#31ff79' },
  { text: '黒 #000000', value: '#000000' },
  { text: '白 #ffffff', value: '#ffffff' },
];

// -- 1. ブラシ選択(共通) --
pane.addBinding(params, 'brushType', {
  label: 'ブラシ',
  options: {
    '画像スタンプ': 'stamp',
    'バーコード': 'barcode',
    'ストレッチ(背景を引き伸ばす)': 'stretch',
    '選択/移動': 'select',
  },
}).on('change', () => {
  // 描画モードに戻ったら選択は解除
  if (params.brushType !== 'select') state.selected = null;
  syncBrushUI();
});
pane.addBinding(params, 'smoothing', { label: 'スムージング', min: 0, max: 0.95 });

// -- 2. ブラシ別設定(選択中のものだけ開く) --
const stampFolder = pane.addFolder({ title: '画像スタンプ設定' });
// 「画像」はカスタムスタンプ(左余白の切り取りツールで追加)を動的に増やせるよう
// addBindingではなくlistブレードにし、optionsを実行時に差し替えられるようにする
const STAMP_BASE_OPTIONS = [
  { text: 'トマト', value: 'tomatoes' },
  { text: 'レタス', value: 'lettuce' },
  { text: 'レジ袋', value: 'bag' },
  { text: '買い物かご', value: 'basket' },
  { text: 'カート', value: 'cart' },
  { text: 'TD: スプレー丸', value: 'tdCircle' },
  { text: 'TD: スプレー三角', value: 'tdTri' },
  { text: 'TD: スプレー四角', value: 'tdSquare' },
  { text: 'TD: スプラッター', value: 'tdSplat' },
];
const customStampOptions = [];
const stampImageBlade = stampFolder.addBlade({
  view: 'list',
  label: '画像',
  options: STAMP_BASE_OPTIONS,
  value: params.stampImage,
});
stampImageBlade.on('change', (ev) => {
  params.stampImage = ev.value;
  syncBrushUI();
});

// 左余白の切り取りツール: 読み込んだ画像から範囲を選び、カスタムスタンプとして登録する
function registerCustomStamp(id, label, canvasImg) {
  state.images[id] = canvasImg;
  customStampOptions.push({ text: label, value: id });
  stampImageBlade.options = [...STAMP_BASE_OPTIONS, ...customStampOptions];
  params.stampImage = id;
  stampImageBlade.value = id;
  syncBrushUI();
}
initCropTool(registerCustomStamp);
stampFolder.addBinding(params, 'stampSize', { label: 'サイズ', min: 20, max: 600, step: 1 });
stampFolder.addBinding(params, 'spacing', { label: '間隔', min: 5, max: 400, step: 1 });
const uiRotate = stampFolder.addBinding(params, 'rotate', { label: '進行方向に回転(TD系)' });
// TDスタンプ選択時だけ表示
const uiStampColor = stampFolder.addBinding(params, 'stampColor', { label: '色', view: 'color' });
const uiStampColorPreset = stampFolder.addBlade({
  view: 'list',
  label: '色プリセット',
  options: COLOR_PRESETS,
  value: params.stampColor,
});
uiStampColorPreset.on('change', (ev) => {
  params.stampColor = ev.value;
  pane.refresh();
});
// オブジェクト画像選択時だけ表示
const uiStampTexture = stampFolder.addBinding(params, 'stampTexture', { label: 'TDノイズ質感' });
const uiStampTextureColor = stampFolder.addBinding(params, 'stampTextureColor', {
  label: '質感の色',
  options: { '固有色': 'native', '黒': 'black', '白': 'white' },
});

const barcodeFolder = pane.addFolder({ title: 'バーコード設定', expanded: false });
barcodeFolder.addBinding(params, 'barcodeText', { label: 'テキスト' });
barcodeFolder.addBinding(params, 'barcodeSize', { label: 'サイズ', min: 60, max: 400, step: 1 });
barcodeFolder.addBinding(params, 'barcodeColor', { label: '色', view: 'color' });
barcodeFolder.addBlade({
  view: 'list',
  label: '色プリセット',
  options: COLOR_PRESETS,
  value: params.barcodeColor,
}).on('change', (ev) => {
  params.barcodeColor = ev.value;
  pane.refresh();
});

const stretchFolder = pane.addFolder({ title: 'ストレッチ設定', expanded: false });
stretchFolder.addBinding(params, 'brushWidth', { label: 'ブラシ幅', min: 4, max: 300, step: 1 });
stretchFolder.addBinding(params, 'tipStyle', {
  label: '先端',
  options: { 'かすれ(ブラシ)': 'brush', '尖り': 'point' },
}).on('change', () => pane.refresh());

// -- 3. エフェクト(ストロークに重ねる引き伸ばし) --
const effectFolder = pane.addFolder({ title: 'エフェクト(ストロークに重ねる)' });
effectFolder.addBinding(params, 'effectType', {
  label: '種類',
  options: {
    'なし': 'none',
    'ストレッチ(引き伸ばし)': 'stretch',
    'ボカシ(霞の帯)': 'blur',
  },
}).on('change', syncBrushUI);
const uiEffectWidth = effectFolder.addBinding(params, 'effectWidth', { label: '幅', min: 4, max: 400, step: 1 });
const uiEffectBlur = effectFolder.addBinding(params, 'effectBlur', { label: '強さ(ボカシ)', min: 2, max: 60, step: 1 });
// ストレッチは先頭に1個だけスタンプが乗る(チューブの起点)。これ自体の表示も選べる
const uiEffectShowHead = effectFolder.addBinding(params, 'effectShowHead', { label: '先頭のスタンプを表示' });
const TIP_OPTIONS = { 'かすれ(ブラシ)': 'brush', '尖り': 'point' };
const uiEffectTip = effectFolder.addBinding(params, 'tipStyle', { label: '先端', options: TIP_OPTIONS });
uiEffectTip.on('change', () => pane.refresh());

// -- 3.5 パステキスト(ストロークに沿う文字) --
const captionFolder = pane.addFolder({ title: 'パステキスト', expanded: false });
captionFolder.addBinding(params, 'pathText', { label: 'ストロークに添える' });
captionFolder.addBinding(params, 'pathTextContent', { label: 'テキスト' });
captionFolder.addBinding(params, 'pathTextSize', { label: 'サイズ', min: 10, max: 120, step: 1 });
captionFolder.addBinding(params, 'pathTextMargin', { label: '余白', min: 0, max: 120, step: 1 });

// -- 4. 背景レイヤー(タイポ/テクスチャ/写真) --
const bgFolder = pane.addFolder({ title: '背景レイヤー', expanded: false });
bgFolder.addBinding(params, 'typoVisible', { label: 'タイポ表示' });
bgFolder.addBinding(params, 'typoVersion', {
  label: 'タイポ版',
  options: {
    'Ver.1 (縦組み)': 'ver1',
    'Ver.2 (横組み)': 'ver2',
    'Ver.3': 'ver3',
    'Ver.4': 'ver4',
    'Ver.5': 'ver5',
    'Ver.6': 'ver6',
  },
}).on('change', (ev) => {
  loadTypo(TYPO_SRC[ev.value]);
});
bgFolder.addButton({ title: 'タイポPNGを差し替え' }).on('click', () => {
  pickImage((img) => {
    state.typo = img;
    cacheTypoPreview();
  });
});
// TouchDesignerで生成して assets/td に書き出したテクスチャ群
const TD_TEXTURES = {
  'なし': '',
  'シェイプ+スプレー': 'assets/td/shapes_spray.png',
  'スプレーグラデーション': 'assets/td/spray_gradient.png',
  'インクスプラッター': 'assets/td/splatter.png',
};
bgFolder.addBlade({
  view: 'list',
  label: 'TDテクスチャ',
  options: Object.entries(TD_TEXTURES).map(([text, value]) => ({ text, value })),
  value: '',
}).on('change', (ev) => {
  if (!ev.value) {
    state.photo = null;
    redrawArt();
    return;
  }
  const img = new Image();
  img.onload = () => {
    state.photo = img;
    redrawArt();
  };
  img.src = ev.value;
});
bgFolder.addButton({ title: '写真を読み込む' }).on('click', () => {
  pickImage((img) => {
    state.photo = img;
    redrawArt();
  });
});

// -- 5. ハンドトラッキング --
const handFolder = pane.addFolder({ title: 'ハンドトラッキング', expanded: false });
const handToggle = handFolder.addBinding(params, 'handTracking', { label: '手で描く' });
// 手ごとのブラシ。スタンプ画像・サイズ・色などの詳細は各フォルダの設定を共有する
const HAND_BRUSH_OPTIONS = {
  'スタンプ(素)': 'stamp',
  'スタンプ(TDノイズ質感)': 'stampTex',
  'TD: スプレー丸': 'tdCircle',
  'TD: スプレー三角': 'tdTri',
  'TD: スプレー四角': 'tdSquare',
  'TD: スプラッター': 'tdSplat',
  'バーコード': 'barcode',
  'ストレッチ(背景)': 'stretch',
};
handFolder.addBinding(params, 'rightHandBrush', { label: '右手ブラシ', options: HAND_BRUSH_OPTIONS });
handFolder.addBinding(params, 'leftHandBrush', { label: '左手ブラシ', options: HAND_BRUSH_OPTIONS });
handToggle.on('change', async (ev) => {
  if (ev.value) {
    try {
      await startHandTracking(view);
    } catch (err) {
      console.error('ハンドトラッキング開始に失敗:', err);
      params.handTracking = false;
      pane.refresh();
    }
  } else {
    stopHandTracking(view);
  }
});

// -- 6. アニメーション(描画演出のテンポ。Aキー=全ストローク再生) --
const animFolder = pane.addFolder({ title: 'アニメーション (Aキーで全再生)', expanded: false });
animFolder.addBinding(params, 'animDelay', { label: '遅延(秒)', min: 0, max: 3, step: 0.1 });
animFolder.addBinding(params, 'animDuration', { label: '描画時間(秒)', min: 0.1, max: 5, step: 0.1 });

// -- 6.5 登録作品(Enterで登録/Qキーで連続再生)の管理 --
const takesFolder = pane.addFolder({ title: '登録作品(Enter/Q)', expanded: false });
const clearTakesBtn = takesFolder.addButton({ title: '全て削除' });
clearTakesBtn.on('click', () => {
  if (!state.takes.length) return;
  state.takes.length = 0;
  saveTakesToStorage();
  rebuildTakesUI();
});
let takeRowBlades = [];
function rebuildTakesUI() {
  for (const blade of takeRowBlades) takesFolder.remove(blade);
  takeRowBlades = state.takes.map((take, i) => {
    const row = takesFolder.addButton({ title: '削除', label: `作品 ${i + 1}`, index: i });
    row.on('click', () => {
      state.takes.splice(i, 1);
      saveTakesToStorage();
      rebuildTakesUI();
    });
    return row;
  });
}

// -- 7. 編集/書き出し --
pane.addButton({ title: 'Undo (⌘Z)' }).on('click', undo);
pane.addButton({ title: '選択を削除 (Delete)' }).on('click', deleteSelected);

const exFolder = pane.addFolder({ title: '書き出し', expanded: false });
exFolder.addBinding(params, 'dpi', {
  label: '解像度',
  options: { '150dpi (3508×4967)': 150, '300dpi (7016×9933)': 300 },
});
const exBtn = exFolder.addButton({ title: 'PNG書き出し' });
exBtn.on('click', async () => {
  exBtn.title = '書き出し中…';
  await new Promise((r) => setTimeout(r, 50));
  try {
    await exportPNG();
  } finally {
    exBtn.title = 'PNG書き出し';
  }
});
// 写真/描画(ストロークごと)/タイポを個別の透過PNGにしてZIPで書き出す
const EX_LAYERS_LABEL = 'レイヤー別書き出し (PNG, ZIP)';
const exLayersBtn = exFolder.addButton({ title: EX_LAYERS_LABEL });
exLayersBtn.on('click', async () => {
  exLayersBtn.title = '書き出し中…';
  await new Promise((r) => setTimeout(r, 50));
  try {
    await exportLayers((msg) => { exLayersBtn.title = msg; });
  } finally {
    exLayersBtn.title = EX_LAYERS_LABEL;
  }
});

// 選択中のブラシ/エフェクト/スタンプ画像に応じて、関係あるフォルダを開き無関係な項目を隠す
function syncBrushUI() {
  const t = params.brushType;
  stampFolder.expanded = t === 'stamp';
  barcodeFolder.expanded = t === 'barcode';
  stretchFolder.expanded = t === 'stretch';
  const isTd = params.stampImage.startsWith('td');
  uiStampColor.hidden = !isTd;
  uiStampColorPreset.hidden = !isTd;
  uiStampTexture.hidden = isTd;
  uiStampTextureColor.hidden = isTd;
  uiRotate.hidden = !isTd; // 回転の選択はTD系スタンプのみ(画像=オフ固定/バーコード=オン固定)
  uiEffectWidth.hidden = params.effectType === 'none';
  uiEffectTip.hidden = params.effectType !== 'stretch';
  uiEffectBlur.hidden = params.effectType !== 'blur';
  uiEffectShowHead.hidden = params.effectType !== 'stretch';
}
syncBrushUI();

// ---- 起動 ----
resetBase(art);
loadTypo(TYPO_SRC[params.typoVersion]);
preloadAllTypoVersions();
loadTakesFromStorage();
rebuildTakesUI();
frame();

// デバッグ/外部連携用(TD連携時にも使う想定)
window.__vl = {
  state, params, anims, captionAnims, art, loadTypo, TYPO_SRC,
  pickStroke, deleteSelected, redrawArt, texturedImageId, tintedImageId,
  startReplayShow, isReplaying: () => !!replayQueue,
  registerCustomStamp, exportLayers,
  registerTake, toggleSequencePlayback, isSequencePlaying: () => !!sequence,
};
