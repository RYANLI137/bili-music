'use strict';

const params = new URLSearchParams(location.search);
let state = {
  bvid: params.get('bvid') || '',
  cid: params.get('cid') || '',
  page: Number(params.get('page') || 1) || 1,
  title: params.get('title') || '',
};

function playerSrc({ bvid, cid, page }) {
  const q = new URLSearchParams({
    bvid: String(bvid || ''),
    high_quality: '1',
    danmaku: '0',
    autoplay: '1',
  });
  if (cid) q.set('cid', String(cid));
  if (page > 1) q.set('page', String(page));
  return `https://player.bilibili.com/player.html?${q}`;
}

function webUrl({ bvid, page }) {
  return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`;
}

function render() {
  const title = document.getElementById('title');
  const wrap = document.getElementById('wrap');
  title.textContent = state.title ? `${state.title} · 原视频` : '原视频';
  document.title = title.textContent;
  if (!state.bvid) {
    wrap.innerHTML = '<div class="empty">缺少视频信息</div>';
    return;
  }
  wrap.innerHTML = `<iframe
      src="${playerSrc(state)}"
      allow="fullscreen; autoplay"
      allowfullscreen
      scrolling="no"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
    ></iframe>`;
}

document.getElementById('btnEnlarge').onclick = () => videoApi.enlarge();
document.getElementById('btnFs').onclick = () => videoApi.toggleFullscreen();
document.getElementById('btnWeb').onclick = () => videoApi.openWeb({ bvid: state.bvid, page: state.page });
document.getElementById('btnClose').onclick = () => videoApi.close();

videoApi.onLoad((data) => {
  state = { ...state, ...data, page: Number(data.page || 1) || 1 };
  render();
});

render();
