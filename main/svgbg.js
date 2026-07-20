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

// url のSVGを取得し、レイヤーごとの要素配列を持つオブジェクトを返す
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
  return { svgEl, layers };
}

// レイヤーの表示/非表示を切り替える(パース済みDOMを直接ミューテートする)
export function setLayerVisible(bg, key, visible) {
  const els = bg.layers[key];
  if (!els) return;
  for (const el of els) el.style.display = visible ? '' : 'none';
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
