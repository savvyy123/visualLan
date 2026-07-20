// brush.js — Curvilinear Pixel Stretching エンジン
// ライブ描画と高解像度リプレイの両方がこのエンジンを通るため、
// 同じストロークデータからどの解像度でも同じ結果が再現される。

// プレビュー基準幅。ステップ長はこの解像度で1pxになるようスケールする
const BASE_W = 1200;

// スムージング(EMA)適用後の軌跡の全長を求める。
// 実際の描画はEMA後の軌跡を進むため、生の点列で測ると終端に届かず
// 抜きのテーパーが途中で切れてしまう。テーパー計算は必ずこちらの長さを使う
function smoothedPathLength(points, smoothing, W, H) {
  if (!points || points.length < 2) return 0;
  const k = 1 - smoothing;
  let sx = points[0].x * W;
  let sy = points[0].y * H;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const nx = sx + (points[i].x * W - sx) * k;
    const ny = sy + (points[i].y * H - sy) * k;
    len += Math.hypot(nx - sx, ny - sy);
    sx = nx;
    sy = ny;
  }
  return len;
}

// ---- かすれ筆の先端 ----
// スライスの列(=毛束)ごとに滑らかな1Dノイズを持ち、テーパー係数fが下がるほど
// ノイズの高い毛束から抜け落ちる。ポスターの筆が離れる瞬間のかすれを再現する。
// シードはストローク開始点から導出するので、リプレイ/書き出しでも同じかすれ方になる
function makeBristles(width, seed) {
  const noise = new Float32Array(width);
  const freq = Math.max(3, width / 10); // 毛束の太さ(幅の約1/10)
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < width; i++) {
    const v = 0.65 * valueNoise(i / freq, 0.37, seed)
      + 0.35 * valueNoise((i / freq) * 2.7, 7.91, seed + 13);
    noise[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(1e-6, mx - mn);
  for (let i = 0; i < width; i++) noise[i] = (noise[i] - mn) / range;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;
  return { noise, canvas, ctx: canvas.getContext('2d') };
}

// スライスを毛束マスク付きで描く(呼び出し側でtranslate/rotate済みの前提)
function drawBristleSlice(ctx, slice, bristles, f, len) {
  const w = bristles.canvas.width;
  const m = bristles.ctx;
  m.clearRect(0, 0, w, 1);
  m.drawImage(slice, 0, 0);
  let run = -1;
  for (let i = 0; i <= w; i++) {
    const drop = i < w && bristles.noise[i] >= f;
    if (drop && run < 0) {
      run = i;
    } else if (!drop && run >= 0) {
      m.clearRect(run, 0, i - run, 1);
      run = -1;
    }
  }
  ctx.drawImage(bristles.canvas, 0, 0, w, 1, -w / 2, -len, w, len * 2);
}

// ストローク開始点からかすれ用シードを決定的に導出する
function tipSeedFrom(points) {
  const p0 = (points && points[0]) || { x: 0.5, y: 0.5 };
  return (Math.floor(p0.x * 99991) + Math.floor(p0.y * 77347) * 131) | 0;
}

export function drawCover(ctx, img, W, H) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(W / iw, H / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

export class StrokeEngine {
  // Curvilinear Pixel Stretching (曲線追従の引き伸ばし)
  // 進行方向に垂直な1pxスライスを掴み、軌跡に沿って回転させながら連続スタンプする。
  // canvas: サンプリング元かつ描画先（写真+既存ストロークの合成キャンバス）
  // stroke: { widthN, mode, smoothing, points } — 座標・幅は正規化(0..1)
  constructor(canvas, stroke) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stroke = stroke;
    this.W = canvas.width;
    this.H = canvas.height;
    this.brushPx = Math.max(2, Math.round(stroke.widthN * this.W));
    this.step = this.W / BASE_W;
    this.start = null;
    this.smoothed = null;
    this.prev = null;
    this.slice = null;
    this.sliceCtx = null;
    this.acc = 0;
    // 採取遅延: 固定スライスで「最初のスタンプの色帯」を掴むため、
    // 指定距離ぶん軌跡を進んでからサンプリングする(0なら開始点で掴む)
    this.sampleDelay = (stroke.sampleDelayN || 0) * this.W;
    this.travel = 0;
    this.lastSm = null;
    // 先端表現: 'point'=尖り / 'brush'=かすれ(毛束が抜け落ちる)
    this.tip = stroke.tip || 'point';
    this.tipSeed = tipSeedFrom(stroke.points);
    this.bristles = null;
    this.angSm = null; // 接線角のスムージング(急カーブで帯が折れて割れるのを防ぐ)
    // 筆のテーパー: 全長を先に測り、入りと抜きで幅を絞る
    this.dist = 0;
    this.totalLen = smoothedPathLength(stroke.points, stroke.smoothing, this.W, this.H);
    this.taperLen = Math.min(this.totalLen * 0.4, this.brushPx * 2.5);
  }

  // 現在位置での筆圧的な幅係数(0..1)。両端で尖る
  _taperFactor() {
    if (this.taperLen <= 0 || this.totalLen <= 0) return 1;
    const tin = Math.min(1, this.dist / this.taperLen);
    const tout = Math.max(0, Math.min(1, (this.totalLen - this.dist) / this.taperLen));
    return Math.pow(tin, 1.3) * Math.pow(tout, 1.3);
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (!this.start) {
      this.start = { x, y };
      this.smoothed = { x, y };
      return;
    }
    const k = 1 - this.stroke.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    if (!this.slice) {
      // 進行方向が定まる(+採取遅延ぶん進む)まで待ってからサンプリング
      if (this.lastSm) {
        this.travel += Math.hypot(this.smoothed.x - this.lastSm.x, this.smoothed.y - this.lastSm.y);
      }
      this.lastSm = { x: this.smoothed.x, y: this.smoothed.y };
      if (this.travel < this.step * 2 + this.sampleDelay) return;
      const dx = this.smoothed.x - this.start.x;
      const dy = this.smoothed.y - this.start.y;
      const grabX = this.sampleDelay > 0 ? this.smoothed.x : this.start.x;
      const grabY = this.sampleDelay > 0 ? this.smoothed.y : this.start.y;
      this._sampleSlice(grabX, grabY, Math.atan2(dy, dx) + Math.PI / 2);
      this.prev = { x: grabX, y: grabY };
    }
    this._advanceTo(this.smoothed.x, this.smoothed.y);
  }

  _advanceTo(tx, ty) {
    const dx = tx - this.prev.x;
    const dy = ty - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const angle = Math.atan2(dy, dx);
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.step - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this.dist += this.step;
      // 角度もEMAで滑らかに追従させ、カーブの回転を複数ステップに分散する
      // (急カーブで回転が跳ぶと、帯の外側に楔状の隙間が開いて折れ・分裂に見える)
      if (this.angSm == null) {
        this.angSm = angle;
      } else {
        const da = Math.atan2(Math.sin(angle - this.angSm), Math.cos(angle - this.angSm));
        this.angSm += da * 0.25;
      }
      this._stamp(cx, cy, this.angSm);
    }
    this.prev = { x: tx, y: ty };
  }

  // 点(x,y)を中心に、normalAngle方向へ幅brushPxの1pxスライスを合成キャンバスから抜き出す
  _sampleSlice(x, y, normalAngle) {
    if (!this.slice) {
      this.slice = document.createElement('canvas');
      this.slice.width = this.brushPx;
      this.slice.height = 1;
      this.sliceCtx = this.slice.getContext('2d');
    }
    const s = this.sliceCtx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, this.brushPx, 1);
    s.translate(this.brushPx / 2, 0.5);
    s.rotate(-normalAngle);
    s.translate(-x, -y);
    // 全面ではなくスライス周辺だけを切り出して描く(スミアの毎ステップ実行に耐えるため)
    const r = this.brushPx / 2 + 2;
    const sx = Math.max(0, Math.floor(x - r));
    const sy = Math.max(0, Math.floor(y - r));
    const sw = Math.min(this.W, Math.ceil(x + r)) - sx;
    const sh = Math.min(this.H, Math.ceil(y + r)) - sy;
    if (sw <= 0 || sh <= 0) return;
    s.drawImage(this.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  _stamp(x, y, tangentAngle) {
    const f = this._taperFactor();
    if (f <= 0) return;
    if (this.tip !== 'brush' && this.brushPx * f < 0.7) return;
    if (this.stroke.mode === 'smear') {
      // 連続再サンプル: 現在位置(直前のスタンプ結果や下のスタンプを含む)から拾い直す。
      // 自分の帯とスタンプを拾い続けるので、スタンプの色がリボン状に途切れず伸びる
      this._sampleSlice(x, y, tangentAngle + Math.PI / 2);
    }
    const ctx = this.ctx;
    const len = this.step * 2; // ステップ間隔より長く描いて隙間を消す
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tangentAngle + Math.PI / 2);
    if (this.tip === 'brush' && f < 1) {
      // かすれ: 幅は保ったまま、毛束を抜きながら先端へ向かう
      if (!this.bristles) this.bristles = makeBristles(this.brushPx, this.tipSeed);
      drawBristleSlice(ctx, this.slice, this.bristles, f, len);
    } else {
      // 尖り: スライスの中央だけを切り出して描くことで、縞の縮尺を保ったまま幅を絞る
      const w = this.brushPx * f;
      const srcX = (this.brushPx - w) / 2;
      ctx.drawImage(
        this.slice,
        srcX, 0, w, 1,
        -w / 2, -len, w, len * 2
      );
    }
    ctx.restore();
  }
}

// ---- インクミックス(流体撹拌)エフェクト用の決定的ノイズ ----
// 解像度非依存の値ノイズ。同じ座標+シードなら常に同じ値を返すので、
// プレビューとA1書き出しで同一の混ざり方が再現される
function hashNoise(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 974711) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hashNoise(ix, iy, seed);
  const b = hashNoise(ix + 1, iy, seed);
  const c = hashNoise(ix, iy + 1, seed);
  const d = hashNoise(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export class InkMixEngine {
  // ストローク軌跡に沿って、周囲のキャンバスをカールノイズの渦で撹拌する。
  // TouchDesignerで検証したドメインワープ方式: 流線を積分した先を1回だけ
  // サンプリングするので、反復フィードバックのような滲み/崩れが出ない
  constructor(canvas, stroke) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    const ef = stroke.effect;
    this.radius = Math.max(4, (ef.widthN * this.W) / 2);
    this.mix = ef.mix ?? 1;
    this.seed = (ef.seed ?? 1) | 0;
    this.stepPx = Math.max(2, this.radius * 0.9);
    this.smoothing = stroke.smoothing ?? 0;
    this.smoothed = null;
    this.prev = null;
    this.acc = 0;
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (!this.smoothed) {
      this.smoothed = { x, y };
      this.prev = { x, y };
      this._apply(x, y);
      return;
    }
    const k = 1 - this.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    const dx = this.smoothed.x - this.prev.x;
    const dy = this.smoothed.y - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.stepPx - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this._apply(cx, cy);
    }
    this.prev = { x: this.smoothed.x, y: this.smoothed.y };
  }

  // (cx,cy)を中心に半径R内のピクセルを、カール場の流線に沿ってワープさせる
  _apply(cx, cy) {
    const R = this.radius;
    const x0 = Math.max(0, Math.floor(cx - R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(this.W, Math.ceil(cx + R));
    const y1 = Math.min(this.H, Math.ceil(cy + R));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return;
    const img = this.ctx.getImageData(x0, y0, w, h);
    const src = img.data;
    const out = new Uint8ClampedArray(src); // 円の外はそのまま残る

    // カール場は粗いグリッドで前計算し、積分時はバイリニア補間で引く(毎ピクセル直接評価は重い)
    const cell = Math.max(2, R / 20);
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const gvx = new Float32Array(gw * gh);
    const gvy = new Float32Array(gw * gh);
    const fscale = 1 / (R * 1.7); // 渦の周期は半径の約1.7倍
    const e = 0.22;
    const seed = this.seed;
    const field = (fx, fy) =>
      valueNoise(fx, fy, seed) + 0.45 * valueNoise(fx * 2.3 + 13.1, fy * 2.3 + 7.7, seed + 7);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const px = (x0 + i * cell) * fscale;
        const py = (y0 + j * cell) * fscale;
        const ddx = field(px + e, py) - field(px - e, py);
        const ddy = field(px, py + e) - field(px, py - e);
        gvx[j * gw + i] = ddy / (2 * e);
        gvy[j * gw + i] = -ddx / (2 * e);
      }
    }

    const STEPS = 12;
    const R2 = R * R;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const ax = x0 + px;
        const ay = y0 + py;
        const dxc = ax - cx;
        const dyc = ay - cy;
        const d2 = dxc * dxc + dyc * dyc;
        if (d2 >= R2) continue;
        // 中心ほど強く、縁でゼロになる減衰(境界の継ぎ目を消す)
        const t2 = d2 / R2;
        const fall = (1 - t2) * (1 - t2);
        const hstep = (this.mix * fall * R * 0.5) / STEPS;
        let sx = px;
        let sy = py;
        for (let s = 0; s < STEPS; s++) {
          // グリッドのバイリニア補間でカールを取得
          let gu = sx / cell;
          let gv = sy / cell;
          gu = gu < 0 ? 0 : gu > gw - 2 ? gw - 2 : gu;
          gv = gv < 0 ? 0 : gv > gh - 2 ? gh - 2 : gv;
          const gi = gu | 0;
          const gj = gv | 0;
          const tx = gu - gi;
          const ty = gv - gj;
          const i00 = gj * gw + gi;
          const i10 = i00 + 1;
          const i01 = i00 + gw;
          const i11 = i01 + 1;
          const vx = (gvx[i00] + (gvx[i10] - gvx[i00]) * tx) * (1 - ty)
            + (gvx[i01] + (gvx[i11] - gvx[i01]) * tx) * ty;
          const vy = (gvy[i00] + (gvy[i10] - gvy[i00]) * tx) * (1 - ty)
            + (gvy[i01] + (gvy[i11] - gvy[i01]) * tx) * ty;
          sx += vx * hstep;
          sy += vy * hstep;
        }
        // ワープ先をバイリニアサンプリング
        let fx = sx < 0 ? 0 : sx > w - 1.001 ? w - 1.001 : sx;
        let fy = sy < 0 ? 0 : sy > h - 1.001 ? h - 1.001 : sy;
        const ix = fx | 0;
        const iy = fy | 0;
        const bx = fx - ix;
        const by = fy - iy;
        const s00 = (iy * w + ix) * 4;
        const s10 = s00 + 4;
        const s01 = s00 + w * 4;
        const s11 = s01 + 4;
        const o = (py * w + px) * 4;
        for (let k = 0; k < 4; k++) {
          const a = src[s00 + k] + (src[s10 + k] - src[s00 + k]) * bx;
          const b = src[s01 + k] + (src[s11 + k] - src[s01 + k]) * bx;
          out[o + k] = a + (b - a) * by;
        }
      }
    }
    this.ctx.putImageData(new ImageData(out, w, h), x0, y0);
  }
}

export class ImageStretchEngine {
  // 画像スタンプ用の Curvilinear Pixel Stretching:
  // スタンプ画像の中央を通る縦断面(1px)を、軌跡に沿って回転させながら掃引する。
  // キャンバスからは何も拾わないので、背景に関係なく「画像そのもの」がチューブ状に伸びる。
  // 透明部分は透明のまま掃引されるため、画像の輪郭がそのまま筋になる
  constructor(canvas, stroke, image) {
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    this.stroke = stroke;
    this.image = image;
    this.crossPx = Math.max(2, Math.round(stroke.effect.widthN * this.W));
    this.sizePx = stroke.sizeN * this.W; // 先頭に1個だけ置くスタンプのサイズ
    this.step = this.W / BASE_W;
    this.start = null;
    this.smoothed = null;
    this.prev = null;
    this.slice = null;
    this.acc = 0;
    this.angSm = null; // 接線角のスムージング(急カーブで帯が折れて割れるのを防ぐ)
    this.headDrawn = false;
    // 先頭に1個だけ置くスタンプの表示可否。falseなら線(チューブ)だけになる
    this.showHead = stroke.effect.showHead !== false;
    this.single = (stroke.points || []).length < 2; // クリックのみ=スタンプ1個で終わり
    // 先端表現: 'point'=尖り / 'brush'=かすれ
    this.tip = stroke.tip || 'point';
    this.tipSeed = tipSeedFrom(stroke.points);
    this.bristles = null;
    // 筆のテーパー: 入りと抜きでチューブが尖る
    this.dist = 0;
    this.totalLen = smoothedPathLength(stroke.points, stroke.smoothing, this.W, this.H);
    this.taperLen = Math.min(this.totalLen * 0.4, this.crossPx * 2.5);
  }

  _taperFactor() {
    if (this.taperLen <= 0 || this.totalLen <= 0) return 1;
    const tin = Math.min(1, this.dist / this.taperLen);
    const tout = Math.max(0, Math.min(1, (this.totalLen - this.dist) / this.taperLen));
    return Math.pow(tin, 1.3) * Math.pow(tout, 1.3);
  }

  // 画像の中央1px列(縦断面)を横向きスライスに転置する
  _buildSlice() {
    const iw = this.image.naturalWidth || this.image.width;
    const ih = this.image.naturalHeight || this.image.height;
    if (!iw) return false;
    this.slice = document.createElement('canvas');
    this.slice.width = this.crossPx;
    this.slice.height = 1;
    const s = this.slice.getContext('2d');
    s.setTransform(1, 0, 0, 1, 0, 1);
    s.scale(this.crossPx / ih, 1);
    s.rotate(-Math.PI / 2);
    s.drawImage(this.image, iw / 2, 0, 1, ih, 0, 0, 1, ih);
    return true;
  }

  // 先頭のスタンプ(1個だけ)。以降はチューブの線だけを見せる
  _drawHead(x, y, angle) {
    const iw = this.image.naturalWidth || this.image.width;
    const ih = this.image.naturalHeight || this.image.height;
    if (!iw) return;
    const dw = this.sizePx;
    const dh = this.sizePx * (ih / iw);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    ctx.drawImage(this.image, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (this.single) {
      // クリックのみ: 通常のスタンプと同じく1個置く(表示OFFなら何も描かない)
      if (!this.headDrawn) {
        this.headDrawn = true;
        if (this.showHead) this._drawHead(x, y, 0);
      }
      return;
    }
    if (!this.start) {
      this.start = { x, y };
      this.smoothed = { x, y };
      return;
    }
    const k = 1 - this.stroke.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    if (!this.slice) {
      // 進行方向が定まるまで待ってから掃引を開始
      const dx = this.smoothed.x - this.start.x;
      const dy = this.smoothed.y - this.start.y;
      if (Math.hypot(dx, dy) < this.step * 2) return;
      if (!this._buildSlice()) return; // 画像未ロード時は描かない
      // 1個目のスタンプを置き、その上をチューブが走り出す(表示OFFなら線だけになる)
      if (!this.headDrawn) {
        this.headDrawn = true;
        if (this.showHead) {
          this._drawHead(
            this.start.x, this.start.y,
            this.stroke.rotate ? Math.atan2(dy, dx) : 0
          );
        }
      }
      this.prev = { x: this.start.x, y: this.start.y };
    }
    this._advanceTo(this.smoothed.x, this.smoothed.y);
  }

  _advanceTo(tx, ty) {
    const dx = tx - this.prev.x;
    const dy = ty - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const angle = Math.atan2(dy, dx);
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.step - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this.dist += this.step;
      // 角度もEMAで滑らかに追従させ、カーブの回転を複数ステップに分散する
      // (急カーブで回転が跳ぶと、帯の外側に楔状の隙間が開いて折れ・分裂に見える)
      if (this.angSm == null) {
        this.angSm = angle;
      } else {
        const da = Math.atan2(Math.sin(angle - this.angSm), Math.cos(angle - this.angSm));
        this.angSm += da * 0.25;
      }
      this._stamp(cx, cy, this.angSm);
    }
    this.prev = { x: tx, y: ty };
  }

  _stamp(x, y, tangentAngle) {
    const f = this._taperFactor();
    if (f <= 0) return;
    if (this.tip !== 'brush' && this.crossPx * f < 0.7) return;
    const ctx = this.ctx;
    const len = this.step * 2; // ステップ間隔より長く描いて隙間を消す
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tangentAngle + Math.PI / 2);
    if (this.tip === 'brush' && f < 1) {
      // かすれ: 幅は保ったまま、毛束を抜きながら先端へ向かう
      if (!this.bristles) this.bristles = makeBristles(this.crossPx, this.tipSeed);
      drawBristleSlice(ctx, this.slice, this.bristles, f, len);
    } else {
      const w = this.crossPx * f;
      const srcX = (this.crossPx - w) / 2;
      ctx.drawImage(
        this.slice,
        srcX, 0, w, 1,
        -w / 2, -len, w, len * 2
      );
    }
    ctx.restore();
  }
}

export class BlurEngine {
  // ボカシ: ストロークの軌跡に沿った「方向性のあるモーションブラー」。
  // 進行方向の接線に沿って多重サンプルを引き伸ばし、動きの尾を作る。
  // 直交方向には軽いソフトネスのみ。円の縁は放射状フォールオフで馴染ませる
  constructor(canvas, stroke) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    const ef = stroke.effect;
    this.radius = Math.max(4, (ef.widthN * this.W) / 2);
    this.blurPx = Math.max(1, (ef.blurN || 0.01) * this.W);
    this.streak = this.blurPx * 3; // 進行方向へ伸ばす長さ
    this.stepPx = Math.max(2, this.radius * 0.5);
    this.smoothing = stroke.smoothing ?? 0;
    this.smoothed = null;
    this.prev = null;
    this.acc = 0;
    this.angSm = null; // 接線角のスムージング
    // 作業キャンバスは1回だけ確保。ストリークとぼかしが縁から透明を拾わないよう余白を持つ
    this.margin = Math.ceil(this.blurPx + this.streak / 2 + 4);
    const size = Math.ceil((this.radius + this.margin) * 2);
    this.size = size;
    this.tmp = document.createElement('canvas');
    this.tmp.width = size;
    this.tmp.height = size;
    this.tmpCtx = this.tmp.getContext('2d');
    this.blurred = document.createElement('canvas');
    this.blurred.width = size;
    this.blurred.height = size;
    this.blurCtx = this.blurred.getContext('2d');
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (!this.smoothed) {
      this.smoothed = { x, y };
      this.prev = { x, y };
      return; // 方向が定まってから始める
    }
    const k = 1 - this.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    const dx = this.smoothed.x - this.prev.x;
    const dy = this.smoothed.y - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const angle = Math.atan2(dy, dx);
    if (this.angSm == null) {
      this.angSm = angle;
    } else {
      const da = Math.atan2(Math.sin(angle - this.angSm), Math.cos(angle - this.angSm));
      this.angSm += da * 0.3;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.stepPx - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this._apply(cx, cy, this.angSm);
    }
    this.prev = { x: this.smoothed.x, y: this.smoothed.y };
  }

  _apply(cx, cy, ang) {
    const size = this.size;
    const R = this.radius;
    const x0 = Math.round(cx - size / 2);
    const y0 = Math.round(cy - size / 2);
    const sx = Math.max(0, x0);
    const sy = Math.max(0, y0);
    const ex = Math.min(this.W, x0 + size);
    const ey = Math.min(this.H, y0 + size);
    if (ex <= sx || ey <= sy) return;
    // 周辺を白余白付きでコピー(キャンバス外から透明を拾って暗くならないように)
    const t = this.tmpCtx;
    t.fillStyle = '#fff';
    t.fillRect(0, 0, size, size);
    t.drawImage(this.canvas, sx, sy, ex - sx, ey - sy, sx - x0, sy - y0, ex - sx, ey - sy);
    // 進行方向への多重サンプル(モーションブラー) + 直交方向は軽いガウス
    const b = this.blurCtx;
    b.clearRect(0, 0, size, size);
    b.filter = `blur(${Math.max(0.5, this.blurPx * 0.35)}px)`;
    const N = 9;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let i = 0; i < N; i++) {
      const o = (i / (N - 1) - 0.5) * this.streak;
      b.globalAlpha = 1 / (i + 1); // 逐次平均: N枚の均等合成になる
      b.drawImage(this.tmp, ca * o, sa * o);
    }
    b.globalAlpha = 1;
    b.filter = 'none';
    // 円形フォールオフで切り抜いて貼り戻す
    b.globalCompositeOperation = 'destination-in';
    const g = b.createRadialGradient(size / 2, size / 2, R * 0.25, size / 2, size / 2, R);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, size, size);
    b.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.blurred, x0, y0);
  }
}

export class ImageStampEngine {
  // stroke: { type:'image', imageId, sizeN, spacingN, rotate, smoothing, points }
  constructor(canvas, stroke, image) {
    this.ctx = canvas.getContext('2d');
    this.stroke = stroke;
    this.image = image;
    this.W = canvas.width;
    this.H = canvas.height;
    this.sizePx = stroke.sizeN * this.W;
    this.stepPx = Math.max(1, stroke.spacingN * this.W);
    this.smoothed = null;
    this.prev = null;
    this.acc = 0;
    // 筆の入り抜き: 全長を先に測り、両端でスタンプを萎ませる
    this.dist = 0;
    this.totalLen = smoothedPathLength(stroke.points, stroke.smoothing, this.W, this.H);
    this.taperLen = Math.min(this.totalLen * 0.35, this.sizePx * 2.5);
    // カーブでの膨らみ: スタンプ間の向きの変化(曲率)をEMAでならして保持
    this.lastAngle = null;
    this.swell = 0;
  }

  // 現在位置でのサイズ係数。両端で萎み(0へ)、曲がりで膨らむ(最大1.6倍)
  _sizeFactor() {
    let f = 1;
    if (this.taperLen > 0 && this.totalLen > 0) {
      const tin = Math.min(1, this.dist / this.taperLen);
      const tout = Math.max(0, Math.min(1, (this.totalLen - this.dist) / this.taperLen));
      f = Math.pow(tin, 1.2) * Math.pow(tout, 1.2);
    }
    return f * (1 + 0.6 * this.swell);
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (!this.smoothed) {
      // クリックしただけでも1つスタンプする(totalLen=0ならテーパーは無効)
      this.smoothed = { x, y };
      this.prev = { x, y };
      this._stamp(x, y, 0);
      return;
    }
    const k = 1 - this.stroke.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    const dx = this.smoothed.x - this.prev.x;
    const dy = this.smoothed.y - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const angle = Math.atan2(dy, dx);
    // 曲率: 進行方向の変化が大きいほど膨らみ目標を上げ、EMAでなだらかに追従
    if (this.lastAngle !== null) {
      let da = angle - this.lastAngle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const target = Math.min(1, Math.abs(da) / 1.2);
      this.swell += (target - this.swell) * 0.35;
    }
    this.lastAngle = angle;
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.stepPx - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this.dist += this.stepPx;
      this._stamp(cx, cy, angle);
    }
    this.prev = { x: this.smoothed.x, y: this.smoothed.y };
  }

  _stamp(x, y, angle) {
    const img = this.image;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw) return; // 画像未ロードならスキップ
    const w = this.sizePx * this._sizeFactor();
    if (w < 1) return;
    const h = w * (ih / iw);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (this.stroke.rotate) ctx.rotate(angle);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

// パステキストの「トラック」構築。描画はビュー側のフレームループが行う
// (線に沿って流れるマーキー演出のため、文字位置は毎フレーム弧長から引き直す)。
// 字送りは「オフセット後の曲線」の弧長で測る(カーブの内側では曲率で間隔が潰れるため)。
// 返り値: { at(soff)→{x,y,ang}, totalOff, chars:[{ch,rel}], blockW, sizePx, offPx, color } | null
export function buildCaptionTrack(canvas, stroke) {
  const W = canvas.width;
  const H = canvas.height;
  const cap = stroke.caption || {};
  const text = cap.text || '';
  const sizePx = (cap.sizeN || 0.028) * W;
  const offPx = (cap.offsetN ?? 0.02) * W;
  const color = cap.color || '#000';
  const smoothing = stroke.smoothing ?? 0;
  const points = stroke.points || [];
  if (points.length < 2 || !text) return null;

  const k = 1 - smoothing;
  const effOff = offPx + sizePx * 0.5; // 中心線から文字中心までの距離
  const px = [];
  const py = [];
  const cum = [0];
  const cumOff = [0];
  let sx = points[0].x * W;
  let sy = points[0].y * H;
  px.push(sx);
  py.push(sy);
  let total = 0;
  let totalOff = 0;
  let prevAng = null;
  for (let i = 1; i < points.length; i++) {
    const nx2 = sx + (points[i].x * W - sx) * k;
    const ny2 = sy + (points[i].y * H - sy) * k;
    const dx = nx2 - sx;
    const dy = ny2 - sy;
    const d = Math.hypot(dx, dy);
    sx = nx2;
    sy = ny2;
    px.push(sx);
    py.push(sy);
    total += d;
    cum.push(total);
    // 左手側(文字側)へのオフセット曲線の伸縮: ds' = ds + off・dθ
    let dOff = d;
    if (d > 1e-6) {
      const ang = Math.atan2(dy, dx);
      if (prevAng != null) {
        const dth = Math.atan2(Math.sin(ang - prevAng), Math.cos(ang - prevAng));
        // 急カーブ(曲率半径<オフセット)でも字送りが止まらないよう下限は距離比例
        dOff = Math.max(d * 0.35, d + effOff * dth);
      }
      prevAng = ang;
    }
    totalOff += dOff;
    cumOff.push(totalOff);
  }
  if (total < sizePx) return null;

  let seg = 0;
  const atOff = (soff) => {
    const s = Math.min(totalOff, Math.max(0, soff));
    while (seg < cumOff.length - 2 && cumOff[seg + 1] < s) seg++;
    while (seg > 0 && cumOff[seg] > s) seg--;
    const span = Math.max(1e-6, cumOff[seg + 1] - cumOff[seg]);
    const t = Math.min(1, Math.max(0, (s - cumOff[seg]) / span));
    return {
      x: px[seg] + (px[seg + 1] - px[seg]) * t,
      y: py[seg] + (py[seg + 1] - py[seg]) * t,
    };
  };
  // 位置+接線(前後サンプリングで安定化)
  const at = (soff) => {
    const dd = Math.max(2, sizePx * 0.5);
    const a = atOff(soff - dd);
    const b = atOff(soff + dd);
    const p = atOff(soff);
    return { x: p.x, y: p.y, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  };

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.font = `${sizePx}px sans-serif`;
  const tracking = sizePx * 0.18;
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  ctx.restore();
  const blockW = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, widths.length - 1);
  // relはブロック先頭からの文字中心オフセット
  const chars = [];
  let cursor = 0;
  const textArr = [...text];
  for (let i = 0; i < widths.length; i++) {
    chars.push({ ch: textArr[i], rel: cursor + widths[i] / 2 });
    cursor += widths[i] + tracking;
  }
  return { at, totalOff, chars, blockW, sizePx, offPx, color };
}

export class TextStampEngine {
  // stroke: { type:'text', text, fontFamily, sizeN, spacingN, rotate, smoothing, points }
  constructor(canvas, stroke) {
    this.ctx = canvas.getContext('2d');
    this.stroke = stroke;
    this.W = canvas.width;
    this.H = canvas.height;
    this.sizePx = stroke.sizeN * this.W;
    this.stepPx = Math.max(1, stroke.spacingN * this.W);
    this.smoothed = null;
    this.prev = null;
    this.acc = 0;
  }

  addPoint(nx, ny) {
    const x = nx * this.W;
    const y = ny * this.H;
    if (!this.smoothed) {
      this.smoothed = { x, y };
      this.prev = { x, y };
      this._stamp(x, y, 0);
      return;
    }
    const k = 1 - this.stroke.smoothing;
    this.smoothed = {
      x: this.smoothed.x + (x - this.smoothed.x) * k,
      y: this.smoothed.y + (y - this.smoothed.y) * k,
    };
    const dx = this.smoothed.x - this.prev.x;
    const dy = this.smoothed.y - this.prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const angle = Math.atan2(dy, dx);
    const ux = dx / dist;
    const uy = dy / dist;
    let cx = this.prev.x;
    let cy = this.prev.y;
    let remaining = dist;
    while (remaining > 0) {
      const need = this.stepPx - this.acc;
      if (remaining < need) {
        this.acc += remaining;
        break;
      }
      cx += ux * need;
      cy += uy * need;
      remaining -= need;
      this.acc = 0;
      this._stamp(cx, cy, angle);
    }
    this.prev = { x: this.smoothed.x, y: this.smoothed.y };
  }

  _stamp(x, y, angle) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (this.stroke.rotate) ctx.rotate(angle);
    ctx.font = `${this.sizePx}px "${this.stroke.fontFamily}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.stroke.color || '#000';
    ctx.fillText(this.stroke.text, 0, 0);
    ctx.restore();
  }
}

// ストローク1本ぶんのエンジン列を作る。
// 先頭がメインのブラシ、後ろにエフェクト。1点ごとに順に実行することで
// 「スタンプ→その場で引き伸ばし」の重ねがけになる
export function createEngines(canvas, stroke, images) {
  const engines = [];
  const hasStretch = stroke.effect && stroke.effect.type === 'stretch';
  if (stroke.type === 'text') {
    engines.push(new TextStampEngine(canvas, stroke));
    if (hasStretch) {
      // バーコードはキャンバス採取のストレッチ(最初のスタンプは原点にフルサイズで
      // 描かれるので、開始点で掴めばバーコードの色帯になる)
      const fixed = stroke.effect.mode === 'fixed';
      const eff = new StrokeEngine(canvas, {
        widthN: stroke.effect.widthN,
        mode: stroke.effect.mode,
        smoothing: stroke.smoothing,
        tip: stroke.tip,
        points: stroke.points,
      });
      if (fixed) engines.unshift(eff);
      else engines.push(eff);
    }
  } else if (stroke.type === 'image') {
    const img = images && images[stroke.imageId];
    if (img) {
      if (hasStretch) {
        // 画像スタンプのストレッチは「画像そのもの」の断面を掃引する。
        // スタンプは先頭の1個だけ置き、以降は線(チューブ)を見せる
        engines.push(new ImageStretchEngine(canvas, stroke, img));
      } else {
        engines.push(new ImageStampEngine(canvas, stroke, img));
      }
    }
  } else {
    // ストレッチブラシ: キャンバス(背景・既存描画)を掴んで引き伸ばす
    engines.push(new StrokeEngine(canvas, stroke));
  }
  if (stroke.effect && stroke.effect.type === 'blur') {
    // ボカシ: 本体ブラシの後に走らせて、描いたものごと霞ませる
    engines.push(new BlurEngine(canvas, stroke));
  } else if (stroke.effect && stroke.effect.type === 'inkmix') {
    // 旧データ互換のために残置(UIからは作られない)
    engines.push(new InkMixEngine(canvas, stroke));
  }
  return engines;
}

export function replayStroke(canvas, stroke, images) {
  const engines = createEngines(canvas, stroke, images);
  for (const p of stroke.points) {
    for (const e of engines) e.addPoint(p.x, p.y);
  }
}
