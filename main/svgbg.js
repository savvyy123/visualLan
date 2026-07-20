// svgbg.js — SVG背景(写真/タイトルロゴ/キャッチコピー/バーコード/クレジット等)を
// 要素ごとに分類し、レイヤー単位で表示/非表示を切り替えられるようにする。
// 書き出しは既存のタイポパイプライン(state.typo)に渡せる高解像度canvasとして行う。

// 要素をどのレイヤーに分類するか。SVGにgによるグルーピングが無いため、
// タグの種類・サイズ・テキスト内容から推定する(2つの元データに対して検証済み)
function classify(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'image') {
    const w = parseFloat(el.getAttribute('width') || '0');
    return w >= 1000 ? 'photo' : 'barcode'; // 大きい画像=背景写真、小さい画像=バーコード
  }
  if (tag === 'rect' || tag === 'path' || tag === 'polygon') return 'title'; // ブロック体ロゴタイプ
  if (tag === 'circle') return 'corner'; // JUロゴの丸数字
  if (tag === 'text') {
    const t = (el.textContent || '').trim();
    if (t.length > 100) return 'credits'; // 乗組員リスト(長文)
    if (t.includes('授業')) return 'classInfo';
    if (t.includes('食品') || t.includes('カタチ')) return 'tagline';
    return 'corner'; // JU / 数字 / 2026 などの短いテキスト
  }
  return null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// url のSVGを取得し、レイヤーごとに<g>でラップしたオブジェクトを返す。
// <g>にまとめておくことで、表示/非表示だけでなく位置・サイズもレイヤー単位で
// 編集できるようになる(グループ内の要素どうしの相対位置は保たれる)
export async function loadSvgBackground(url) {
  const res = await fetch(url);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svgEl = doc.documentElement;

  const layers = {};
  for (const child of Array.from(svgEl.children)) {
    if (child.tagName.toLowerCase() === 'defs') continue;
    const key = classify(child);
    if (!key) continue;
    (layers[key] || (layers[key] = [])).push(child);
  }

  const groups = {};
  for (const key of Object.keys(layers)) {
    const els = layers[key];
    const g = doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-layer', key);
    els[0].parentNode.insertBefore(g, els[0]);
    for (const el of els) g.appendChild(el); // 元の相対順序を保ったまま移動
    groups[key] = g;
  }

  // スケールの基準点(レイヤーの中心)を求めるため、一時的に非表示DOMへ接続してgetBBoxする
  // (パース直後のSVGはドキュメントに属していないためgetBBoxが正しく取れない)
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
  document.body.appendChild(host);
  const liveSvg = svgEl.cloneNode(true);
  host.appendChild(liveSvg);
  const pivots = {};
  for (const key of Object.keys(groups)) {
    const liveG = liveSvg.querySelector(`[data-layer="${key}"]`);
    let bbox = { x: 0, y: 0, width: 0, height: 0 };
    try {
      if (liveG) bbox = liveG.getBBox();
    } catch { /* 取得できない場合は原点を基準にする */ }
    pivots[key] = { cx: bbox.x + bbox.width / 2, cy: bbox.y + bbox.height / 2 };
  }
  host.remove();

  return { svgEl, layers, groups, pivots };
}

// レイヤーの表示/非表示を切り替える(パース済みDOMを直接ミューテートする)
export function setLayerVisible(bg, key, visible) {
  const g = bg.groups[key];
  if (g) g.style.display = visible ? '' : 'none';
}

// レイヤーの位置(dx,dy)と倍率(scale)を設定する。
// 拡大縮小はレイヤー自身の中心を基準に行うので、scale=1,dx=0,dy=0で元の見た目に戻る
export function setLayerTransform(bg, key, { dx = 0, dy = 0, scale = 1 } = {}) {
  const g = bg.groups[key];
  if (!g) return;
  const p = bg.pivots[key] || { cx: 0, cy: 0 };
  g.setAttribute(
    'transform',
    `translate(${dx} ${dy}) translate(${p.cx} ${p.cy}) scale(${scale}) translate(${-p.cx} ${-p.cy})`
  );
}

// 現在の表示/変形状態を保ったまま、export用に独立した複製を作る。
// (画面表示に使っているbgの状態を、書き出しの一時的な表示切り替えで壊さないため)
export function cloneForExport(bg) {
  const svgEl = bg.svgEl.cloneNode(true);
  const groups = {};
  for (const key of Object.keys(bg.groups)) {
    groups[key] = svgEl.querySelector(`[data-layer="${key}"]`);
  }
  return { svgEl, groups, layers: bg.layers, pivots: bg.pivots };
}

// 現在の表示状態のまま、SVGソース文字列として書き出す(レイヤー別のベクター書き出し用)
export function serializeSvgBackground(bg) {
  return new XMLSerializer().serializeToString(bg.svgEl);
}

// 現在の表示状態のまま、W×Hのcanvasにラスタライズして返す
export async function rasterizeSvgBackground(bg, W, H) {
  const xml = new XMLSerializer().serializeToString(bg.svgEl);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('SVG背景のラスタライズに失敗しました'));
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(img, 0, 0, W, H);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}
