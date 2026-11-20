/* 无墙论文查询 — 前端逻辑（无框架） */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }

  var LS_KEY = 'nowall.v2';
  var SORTS = { relevance: '相关度', cited: '被引最多', newest: '最新发表', oldest: '最早发表' };

  var state = {
    q: '', page: 1, per: 20, sort: 'relevance', oa: false, from: '', to: '',
    sources: null, items: [], meta: null, loading: false, busy: false,
    fields: { title: '', author: '', venue: '', abstract: '' }, type: '', hideWall: false,
    shelf: [], metaSources: [], config: null, fmt: 'gb', shownBanners: []
  };

  var els = {};
  var reqId = 0;
  var sheetPushed = false;   // 当前面板是否压了一条历史记录
  var historyBusy = false;   // 由本程序主动后退时，跳过那次 popstate

  /* ---------------------------- 基础工具 ---------------------------- */

  function api(path, opts) {
    // 静态版（GitHub Pages）由 pf-api.js 在本机实现同样的接口
    if (window.PF_LOCAL_API) return window.PF_LOCAL_API(path, opts);
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: '服务返回了非 JSON 内容（' + res.status + '）' }; })
        .then(function (data) {
          if (!res.ok || data.ok === false) throw new Error(data.error || ('请求失败 ' + res.status));
          return data;
        });
    });
  }

  function toast(msg, kind, ms) {
    var box = document.createElement('div');
    box.className = 'toast' + (kind ? ' ' + kind : '');
    box.textContent = msg;
    els.toasts.appendChild(box);
    setTimeout(function () {
      box.style.transition = 'opacity .25s';
      box.style.opacity = '0';
      setTimeout(function () { box.remove(); }, 260);
    }, ms || 2400);
  }

  function copy(text, label) {
    var done = function () { toast(label || '已复制', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请长按选择', 'bad'); }
    ta.remove();
  }

  function fmtBytes(n) {
    if (!n) return '0';
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function authorsLine(authors) {
    var list = (authors || []).map(function (a) { return typeof a === 'string' ? a : a.name; }).filter(Boolean);
    if (!list.length) return '佚名';
    if (list.length <= 3) return list.join(', ');
    return list.slice(0, 3).join(', ') + ' 等 ' + list.length + ' 人';
  }

  /* ---------------------------- 偏好 ---------------------------- */

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      if (p.sort) state.sort = p.sort;
      if (typeof p.oa === 'boolean') state.oa = p.oa;
      if (p.from) state.from = p.from;
      if (p.to) state.to = p.to;
      if (Array.isArray(p.sources) && p.sources.length) state.sources = p.sources;
    } catch (e) {}
  }

  function savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        sort: state.sort, oa: state.oa, from: state.from, to: state.to, sources: state.sources
      }));
    } catch (e) {}
  }

  /* ---------------------------- 初始化 ---------------------------- */

  function cacheEls() {
    els = {
      q: $('#q'), form: $('#searchForm'), results: $('#results'), status: $('#status'),
      empty: $('#empty'), more: $('#more'), samples: $('#samples'), banners: $('#banners'),
      backdrop: $('#backdrop'), sheet: $('#sheet'), toasts: $('#toasts'),
      shelfCount: $('#shelfCount'), filters: $('#filters'), srcbar: $('#srcbar'),
      sort: $('#sort'), oa: $('#chipOa'), from: $('#yearFrom'), to: $('#yearTo'),
      chipSources: $('#chipSources'), chipAdv: $('#chipAdv'), adv: $('#adv'),
      chipWall: $('#chipWall'), manualBtn: $('#manualBtn'), manualTpl: $('#manualTpl'),
      fTitle: $('#fTitle'), fAuthor: $('#fAuthor'), fVenue: $('#fVenue'), fAbstract: $('#fAbstract'),
      fType: $('#fType'), advClear: $('#advClear'), advGo: $('#advGo')
    };
  }

  function bind() {
    els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      search(true);
    });
    els.more.addEventListener('click', function () {
      if (state.busy) return;
      state.page += 1;
      search(false);
    });
    els.sort.addEventListener('change', function () { state.sort = els.sort.value; savePrefs(); if (state.q) search(true, 'replace'); });
    els.oa.addEventListener('click', function () {
      state.oa = !state.oa;
      els.oa.classList.toggle('on', state.oa);
      savePrefs();
      if (state.q) search(true, 'replace');
    });
    function onYear() {
      state.from = els.from.value.replace(/\D/g, '').slice(0, 4);
      state.to = els.to.value.replace(/\D/g, '').slice(0, 4);
      savePrefs();
    }
    els.from.addEventListener('change', function () { onYear(); if (state.q) search(true, 'replace'); });
    els.to.addEventListener('change', function () { onYear(); if (state.q) search(true, 'replace'); });
    els.chipSources.addEventListener('click', function () {
      els.srcbar.hidden = !els.srcbar.hidden;
      els.chipSources.classList.toggle('on', !els.srcbar.hidden);
    });
    els.chipWall.addEventListener('click', function () {
      state.hideWall = !state.hideWall;
      els.chipWall.classList.toggle('on', state.hideWall);
      renderResults(false);
      if (state.q) renderStatus(state.meta || { stats: {}, sourceStats: [] });
    });
    els.manualBtn.addEventListener('click', showManual);
    els.chipAdv.addEventListener('click', function () {
      els.adv.hidden = !els.adv.hidden;
      els.chipAdv.classList.toggle('on', !els.adv.hidden);
      if (!els.adv.hidden) els.fTitle.focus();
    });
    els.advGo.addEventListener('click', function () {
      readFields();
      if (!state.q && !hasFields()) { toast('请至少填一个字段'); return; }
      search(true);
    });
    els.advClear.addEventListener('click', function () {
      els.fTitle.value = '';
      els.fAuthor.value = '';
      els.fVenue.value = '';
      els.fAbstract.value = '';
      els.fType.value = '';
      readFields();
      if (state.q) search(true, 'replace');
    });
    [els.fTitle, els.fAuthor, els.fVenue, els.fAbstract].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          readFields();
          if (!state.q && !hasFields()) { toast('请至少填一个字段'); return; }
          search(true);
        }
      });
    });
    els.fType.addEventListener('change', function () {
      state.type = els.fType.value;
      if (state.q || hasFields()) search(true, 'replace');
    });
    var onScroll = function () {
      document.documentElement.classList.toggle('scrolled', window.scrollY > 6);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    $('#btnShelf').addEventListener('click', showShelf);
    $('#btnSettings').addEventListener('click', showSettings);
    $('#btnHealth').addEventListener('click', showHealth);
    els.backdrop.addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
      if (e.key === '/' && document.activeElement !== els.q) {
        e.preventDefault();
        els.q.focus();
      }
    });
    els.results.addEventListener('click', onResultClick);
  }

  function renderSamples() {
    var samples = [
      { q: 'comic convention fandom', note: '漫展 / 同人研究：Comic-Con、cosplay 的英文主战场' },
      { q: 'anime convention cosplay', note: '动漫展与 cosplay 的实证研究（含学位论文）' },
      { q: '漫展 同人文化', note: '中文关键词 → 自动转成英文检索词' },
      { q: 'fan culture participatory', note: '参与式文化理论：Jenkins 这条脉络' }
    ];
    els.samples.innerHTML = samples.map(function (s) {
      return '<button class="sample" data-q="' + esc(s.q) + '">' + esc(s.q) +
        '<small>' + esc(s.note) + '</small></button>';
    }).join('');
    els.samples.addEventListener('click', function (e) {
      var b = e.target.closest('.sample');
      if (!b) return;
      els.q.value = b.getAttribute('data-q');
      search(true);
    });
  }

  /* ---------------------------- 配置 / 收藏 ---------------------------- */

  function loadConfig() {
    return api('/api/config').then(function (d) {
      state.config = d.config;
      state.stats = d.stats || null;
      state.metaSources = d.meta || [];
      if (!state.sources || !state.sources.length) {
        state.sources = (d.config.sources || []).slice();
      }
      if (typeof state.config.translate !== 'undefined') { /* 保留 */ }
      renderSourceChips();
      renderBannersStatic();
      return d;
    }).catch(function () { });
  }

  function loadShelf() {
    return api('/api/shelf').then(function (d) {
      state.shelf = d.items || [];
      updateShelfCount();
      return d;
    }).catch(function () { });
  }

  function updateShelfCount() {
    var to = state.shelf.length;
    var from = parseInt(els.shelfCount.textContent, 10) || 0;
    els.shelfCount.textContent = String(to);
    if (from !== to) {
      els.shelfCount.classList.remove('pop');
      void els.shelfCount.offsetWidth;
      els.shelfCount.classList.add('pop');
    }
  }

  function renderSourceChips() {
    var chosen = state.sources || [];
    els.srcbar.innerHTML = state.metaSources.map(function (m) {
      var on = chosen.indexOf(m.id) >= 0;
      return '<button class="chip' + (on ? ' on' : '') + '" data-src="' + esc(m.id) + '" title="' + esc(m.desc) + '">' +
        esc(m.label) + '</button>';
    }).join('') + '<span style="color:var(--dim-2);font-size:11.5px;align-self:center;padding-left:4px">点选切换，改完自动重搜</span>';
    els.srcbar.onclick = function (e) {
      var b = e.target.closest('[data-src]');
      if (!b) return;
      var id = b.getAttribute('data-src');
      var i = state.sources.indexOf(id);
      if (i >= 0) {
        if (state.sources.length === 1) { toast('至少保留一个数据源'); return; }
        state.sources.splice(i, 1);
      } else state.sources.push(id);
      savePrefs();
      renderSourceChips();
      if (state.q) search(true, 'replace');
    };
  }

  /* ---------------------------- 字段检索 ---------------------------- */

  function readFields() {
    state.fields = {
      title: els.fTitle.value.trim(),
      author: els.fAuthor.value.trim(),
      venue: els.fVenue.value.trim(),
      abstract: els.fAbstract.value.trim()
    };
    state.type = els.fType.value || '';
  }

  function hasFields() {
    var f = state.fields || {};
    return !!(f.title || f.author || f.venue || f.abstract);
  }

  function fillFields(f) {
    f = f || {};
    els.fTitle.value = f.title || '';
    els.fAuthor.value = f.author || '';
    els.fVenue.value = f.venue || '';
    els.fAbstract.value = f.abstract || '';
  }

  /* ---------------------------- 检索 ---------------------------- */

  function search(reset, historyMode) {
    var q = els.q.value.trim();
    if (!q) readFields();
    if (!q && !hasFields()) { els.q.focus(); toast('先输入检索词'); return; }
    if (reset) { state.page = 1; state.items = []; }
    state.q = q;
    state.busy = true;
    reqId += 1;
    var myReq = reqId;
    savePrefs();
    if (reset && historyMode !== 'none') writeHistory(historyMode || 'push');

    els.empty.hidden = true;
    els.more.hidden = true;
    if (reset) {
      els.results.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      els.status.innerHTML = '<span class="spinner"></span> 正在并发检索 ' + (state.sources || []).length + ' 个数据源…';
    } else {
      els.more.textContent = '加载中…';
    }
    document.body.classList.add('busy');

    var params = new URLSearchParams();
    params.set('q', q);
    params.set('page', String(state.page));
    params.set('per', String(state.per));
    params.set('sort', state.sort);
    params.set('oa', state.oa ? '1' : '0');
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (state.sources && state.sources.length) params.set('sources', state.sources.join(','));
    readFields();
    if (state.fields.title) params.set('title', state.fields.title);
    if (state.fields.author) params.set('author', state.fields.author);
    if (state.fields.venue) params.set('venue', state.fields.venue);
    if (state.fields.abstract) params.set('abstract', state.fields.abstract);
    if (state.type) params.set('type', state.type);

    api('/api/search?' + params.toString()).then(function (data) {
      if (myReq !== reqId) return;
      state.meta = data;
      if (reset) state.items = data.items || [];
      else {
        var seen = {};
        state.items.forEach(function (it) { seen[it.id] = 1; });
        (data.items || []).forEach(function (it) { if (!seen[it.id]) { state.items.push(it); seen[it.id] = 1; } });
      }
      renderStatus(data);
      renderBanners(data);
      renderResults(true);
      els.more.hidden = !(data.stats && data.stats.hasMore);
      els.more.textContent = '加载更多';
      if (!state.items.length) {
        els.empty.hidden = false;
        els.empty.querySelector('.empty-title').textContent = '没有找到匹配结果';
        els.empty.querySelector('.empty-sub').textContent = '换个说法、去掉年份限制，或勾选更多数据源试试';
      }
      window.scrollTo({ top: 0, behavior: reset ? 'smooth' : 'auto' });
    }).catch(function (e) {
      if (myReq !== reqId) return;
      if (reset) state.items = [];
      renderResults(false);
      els.status.innerHTML = '';
      els.more.hidden = true;
      els.more.textContent = '加载更多';
      addBanner('bad', '<b>检索失败：</b>' + esc(e.message) + '　—　检查网络后重试，或先点右上角做一次「网络体检」。');
    }).then(function () {
      if (myReq === reqId) {
        document.body.classList.remove('busy');
        state.busy = false;
        if (els.more.textContent === '加载中…') els.more.textContent = '加载更多';
      }
    });
  }

  function renderStatus(d) {
    var parts = [];
    var n = state.items.length;
    parts.push('<span><b id="resultCount">0</b> 条结果</span>');
    if (d.stats && d.stats.deduped > 0) parts.push('<span class="dot"></span><span>合并去重 ' + d.stats.deduped + ' 条</span>');
    parts.push('<span class="dot"></span><span>' + (d.took / 1000).toFixed(1) + 's</span>');
    var LBL = { title: '标题', author: '作者', venue: '期刊', abstract: '摘要' };
    var fl = [];
    ['title', 'author', 'venue', 'abstract'].forEach(function (k) {
      if (state.fields && state.fields[k]) fl.push(LBL[k] + '=' + state.fields[k]);
    });
    if (fl.length) parts.push('<span class="dot"></span><span>字段 ' + esc(fl.join(' · ')) + '</span>');
    if (state.type) {
      var TL = { article: '期刊论文', review: '综述', preprint: '预印本' };
      parts.push('<span class="dot"></span><span>' + esc(TL[state.type] || state.type) + '</span>');
    }
    var okCount = (d.sourceStats || []).filter(function (s) { return s.ok; }).length;
    parts.push('<span class="dot"></span><span>' + okCount + '/' + (d.sourceStats || []).length + ' 个源响应</span>');
    if (d.cached) parts.push('<span class="dot"></span><span>来自本地缓存</span>');
    els.status.innerHTML = parts.join('');
    countUp(document.getElementById('resultCount'), n, 520);
  }

  function countUp(el, to, ms) {
    if (!el) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !window.requestAnimationFrame) { el.textContent = String(to); return; }
    var started = 0;
    var dur = ms || 520;
    function tick(ts) {
      if (!started) started = ts;
      var t = Math.min(1, (ts - started) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(to * eased));
      if (t < 1) window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  function addBanner(kind, html, actionLabel, onAction) {
    var div = document.createElement('div');
    div.className = 'banner ' + (kind || 'info');
    div.innerHTML = '<div class="grow">' + html + '</div>';
    if (actionLabel && onAction) {
      var b = document.createElement('button');
      b.className = 'b-act';
      b.textContent = actionLabel;
      b.addEventListener('click', onAction);
      div.appendChild(b);
    }
    els.banners.appendChild(div);
  }

  function clearBanners() { els.banners.innerHTML = ''; }

  function renderBannersStatic() {
    clearBanners();
    if (state.config && !state.config.email) {
      addBanner('info', '<b>还差一步：</b>填一个邮箱，就能启用 Unpaywall 的全文定位（它只用来做开放获取匹配，不会发广告）。', '去填写', showSettings);
    }
  }

  function renderBanners(d) {
    clearBanners();
    if (state.config && !state.config.email) {
      addBanner('info', '<b>还差一步：</b>填一个邮箱，就能启用 Unpaywall 的全文定位。', '去填写', showSettings);
    }
    if (d.translatedFrom) {
      addBanner('info', '中文检索词已自动转成英文：<b>' + esc(d.translatedFrom) + '</b>（英文元数据命中率更高）');
    }
    if (d.openalex && d.openalex.blocked) {
      addBanner('warn', '<b>OpenAlex 今日免费额度用完了</b>，已自动跳过它，其他源正常。想恢复可以在设置里填入自己的 OpenAlex Key（免费）。', '设置', showSettings);
    }
    var failed = (d.sourceStats || []).filter(function (s) { return !s.ok && s.code !== 'TIMEOUT'; });
    failed.forEach(function (s) {
      var hint = s.code === 'BUDGET' ? s.error : '暂时不可用：' + (s.error || '未知原因');
      addBanner('warn', '<b>' + esc(s.label) + '</b> ' + esc(hint));
    });
  }

  /* ---------------------------- 结果渲染 ---------------------------- */

  function visibleItems() {
    if (!state.hideWall) return state.items;
    var out = state.items.filter(function (it) {
      return !(it.access && it.access.wall === 'blocked') || (it.oa && it.oa.isOa);
    });
    return out.length ? out : state.items;
  }

  function renderResults(animate) {
    els.results.classList.toggle('static', !animate);
    var list = visibleItems();
    if (!list.length) { els.results.innerHTML = ''; return; }
    els.results.innerHTML = list.map(cardHtml).join('');
  }

  function cardHtml(it, idx) {
    idx = state.items.indexOf(it);
    var badges = [];
    if (it.oa && it.oa.isOa) badges.push('<span class="badge oa">开放获取</span>');
    else badges.push('<span class="badge closed">需订阅</span>');
    if (it.type === 'preprint') badges.push('<span class="badge pre">预印本</span>');
    if (it.retracted) badges.push('<span class="badge retract">已撤稿</span>');
    if (it.doi) badges.push('<span class="badge">DOI</span>');
    if (it.sources && it.sources.length > 1) badges.push('<span class="badge">' + it.sources.length + ' 源命中</span>');
    if (it.access && it.access.wall === 'blocked') badges.push('<span class="badge wall" title="' + esc(it.access.note || '') + '">墙外站点</span>');
    else if (it.access && it.access.wall === 'open' && it.oa && it.oa.isOa) badges.push('<span class="badge inn">墙内可下</span>');
    var meta = [];
    meta.push('<span>' + esc(authorsLine(it.authors)) + '</span>');
    if (it.venue) meta.push('<span class="venue">' + esc(it.venue) + '</span>');
    if (it.year) meta.push('<span>' + it.year + '</span>');
    if (it.cited) meta.push('<span class="cite-n">被引 ' + it.cited + '</span>');

    var abs = it.abstract || '';
    var absHtml = abs
      ? '<p class="abs">' + esc(abs) + '</p>'
      : (it.access && it.access.wall === 'blocked'
        ? '<p class="abs" style="color:var(--dim-2)">摘要未收录。<button class="act primary" data-a="enrich" data-i="' + idx + '">不用梯子拉摘要</button></p>'
        : '<p class="abs" style="color:var(--dim-2)">（该来源没有提供摘要）</p>');
    var zh = it._zh ? '<div class="abs-zh"><span class="lab">中文译文</span><br>' + esc(it._zh) + '</div>' : '';
    var ins = it.insight;
    var insHtml = '';
    if (ins) {
      var line = [
        ins.kind,
        ins.approach && ins.approach !== '待判断' ? ins.approach : '',
        (ins.methods || []).slice(0, 2).join(' / '),
        ins.sample ? '样本 ' + ins.sample : ''
      ].filter(Boolean).join(' · ');
      insHtml = '<div class="insight"><div class="i-line"><span class="i-badge">速读</span>' +
        esc(line) + '</div><p class="i-tip"><b>怎么用：</b>' + esc(ins.useTip) + '</p></div>';
    }

    var saved = state.shelf.some(function (s) { return s.id === it.id; });
    var acts = [];
    acts.push('<button class="act primary" data-a="fulltext" data-i="' + idx + '">' +
      (it.oa && it.oa.isOa ? '获取全文' : '找全文') + '</button>');
    if (abs) acts.push('<button class="act" data-a="toggle" data-i="' + idx + '">' + (it._open ? '收起' : '展开摘要') + '</button>');
    acts.push('<button class="act" data-a="cite" data-i="' + idx + '">引用格式</button>');
    acts.push('<button class="act' + (saved ? ' on' : '') + '" data-a="save" data-i="' + idx + '">' + (saved ? '已收藏' : '收藏') + '</button>');
    if (abs && !it._zh) acts.push('<button class="act" data-a="trans" data-i="' + idx + '">译摘要</button>');
    if (it.doi) acts.push('<a class="act" href="https://doi.org/' + enc(it.doi) + '" target="_blank" rel="noopener">DOI ↗</a>');

    return '<article class="card' + (it._open ? ' open' : '') + '" data-i="' + idx + '" style="--i:' + Math.min(idx % 20, 10) + '">' +
      '<div class="badges">' + badges.join('') + '</div>' +
      '<h3>' + esc(it.title) + '</h3>' +
      '<div class="meta">' + meta.join('') + '</div>' +
      absHtml + zh + insHtml +
      '<div class="actions">' + acts.join('') + '</div>' +
      '</article>';
  }

  function onResultClick(e) {
    var btn = e.target.closest('[data-a]');
    if (!btn) return;
    var i = Number(btn.getAttribute('data-i'));
    var it = state.items[i];
    if (!it) return;
    var a = btn.getAttribute('data-a');
    if (a === 'fulltext') return showFulltext(it);
    if (a === 'cite') return showCite(it);
    if (a === 'save') return toggleSave(it, btn);
    if (a === 'toggle') { it._open = !it._open; renderResults(false); return; }
    if (a === 'trans') return translateItem(it, btn);
    if (a === 'enrich') return enrichItem(it, btn);
  }

  function toggleSave(it, btn) {
    var saved = state.shelf.some(function (s) { return s.id === it.id; });
    var p = saved
      ? api('/api/shelf?id=' + enc(it.id), { method: 'DELETE' })
      : api('/api/shelf', { method: 'POST', body: { paper: stripInternal(it) } });
    p.then(function (d) {
      state.shelf = d.items || [];
      updateShelfCount();
      if (btn) { btn.classList.toggle('on', !saved); btn.textContent = saved ? '收藏' : '已收藏'; }
      toast(saved ? '已从收藏夹移除' : '已收藏，可在右上角导出参考文献', saved ? '' : 'ok');
    }).catch(function (e) { toast(e.message, 'bad'); });
  }

  function enrichItem(it, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    var qs = '?doi=' + enc(it.doi || '') + '&title=' + enc(it.title || '');
    api('/api/enrich' + qs).then(function (d) {
      if (d && (d.abstract || d.tldr)) {
        it.abstract = d.abstract || it.abstract || '';
        if (d.tldr) it.tldr = d.tldr;
        renderResults(false);
        toast('已拿到摘要（来自 Semantic Scholar）', 'ok');
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '不用梯子拉摘要'; }
        toast('这个来源也没收录摘要，改用文末的文献传递通道', 'bad', 4200);
      }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '不用梯子拉摘要'; }
      toast(e.message, 'bad');
    });
  }

  function translateItem(it, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    api('/api/translate', { method: 'POST', body: { text: it.abstract, from: 'en', to: 'zh-CN' } })
      .then(function (d) {
        if (!d.ok || !d.text) throw new Error(d.error || '翻译服务没有返回结果');
        it._zh = d.text;
        renderResults(false);
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = '译摘要'; }
        toast('翻译失败：' + e.message, 'bad', 4000);
      });
  }

  /* ---------------------------- 说明书 ---------------------------- */

  function showManual() {
    var tpl = els.manualTpl;
    var html = tpl && tpl.content ? tpl.content.cloneNode(true) : null;
    openSheet('<h2>使用说明书</h2><div class="sub">先看这一页，能省很多试错</div><div id="manualBody"></div>');
    var body = document.getElementById('manualBody');
    if (html && body) body.appendChild(html);
  }

  /* ---------------------------- 面板 ---------------------------- */

  function openSheet(html) {
    els.sheet.classList.remove('closing');
    els.backdrop.classList.remove('closing');
    els.sheet.innerHTML = '<div class="sheet-grip"></div>' + html;
    els.sheet.hidden = false;
    els.backdrop.hidden = false;
    els.sheet.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    // 压一条历史记录，这样系统返回键 / 手势是「关面板」而不是「退出网页」
    if (!sheetPushed && window.history && history.pushState) {
      try { history.pushState({ pf: 'sheet' }, ''); sheetPushed = true; } catch (e) { sheetPushed = false; }
    }
  }

  function closeSheet(fromPop) {
    var wasOpen = !els.sheet.hidden;
    document.body.style.overflow = '';
    if (wasOpen) {
      els.sheet.classList.add('closing');
      els.backdrop.classList.add('closing');
      window.setTimeout(function () {
        els.sheet.hidden = true;
        els.backdrop.hidden = true;
        els.sheet.classList.remove('closing');
        els.backdrop.classList.remove('closing');
        els.sheet.innerHTML = '';
      }, 190);
    }
    if (sheetPushed && !fromPop && window.history && history.back) {
      sheetPushed = false;
      historyBusy = true;
      try { history.back(); } catch (e) { historyBusy = false; }
    } else {
      sheetPushed = false;
    }
  }

  /* ---------------- 历史记录：返回键回到上一次检索 ---------------- */

  function buildState() {
    return {
      pf: 'search',
      q: state.q,
      sort: state.sort,
      oa: state.oa ? 1 : 0,
      from: state.from || '',
      to: state.to || '',
      sources: (state.sources || []).join(','),
      fields: state.fields || {},
      type: state.type || ''
    };
  }

  function writeHistory(mode) {
    if (!window.history || !history.pushState) return;
    var url = location.pathname + (state.q ? '?q=' + encodeURIComponent(state.q) : '');
    try {
      if (mode === 'replace') history.replaceState(buildState(), '', url);
      else history.pushState(buildState(), '', url);
    } catch (e) {}
  }

  function showStart() {
    state.q = '';
    state.sort = 'relevance';
    state.oa = false;
    state.from = '';
    state.to = '';
    state.items = [];
    state.meta = null;
    els.q.value = '';
    els.sort.value = 'relevance';
    els.oa.classList.remove('on');
    els.from.value = '';
    els.to.value = '';
    renderResults(false);
    els.status.innerHTML = '';
    els.more.hidden = true;
    els.empty.hidden = false;
    els.empty.querySelector('.empty-title').textContent = '输入关键词开始检索';
    els.empty.querySelector('.empty-sub').textContent = '例子可以直接点：';
    clearBanners();
    renderBannersStatic();
  }

  function applyHistory(st) {
    if (!st || st.pf !== 'search') { showStart(); return false; }
    state.q = st.q || '';
    state.sort = st.sort || 'relevance';
    state.oa = !!Number(st.oa);
    state.from = st.from || '';
    state.to = st.to || '';
    if (st.sources) state.sources = String(st.sources).split(',');
    state.fields = st.fields || { title: '', author: '', venue: '', abstract: '' };
    state.type = st.type || '';
    fillFields(state.fields);
    els.fType.value = state.type;
    els.q.value = state.q;
    els.sort.value = state.sort;
    els.oa.classList.toggle('on', state.oa);
    els.from.value = state.from;
    els.to.value = state.to;
    renderSourceChips();
    return true;
  }

  window.addEventListener('popstate', function (e) {
    if (historyBusy) { historyBusy = false; return; }
    if (sheetPushed) { sheetPushed = false; closeSheet(true); return; }
    if (applyHistory(e.state)) search(true, 'none');
  });

  /* ---------------------------- 全文定位 ---------------------------- */

  function showFulltext(it) {
    openSheet(
      '<h2>获取全文</h2>' +
      '<div class="sub">' + esc(it.title) + '</div>' +
      '<div class="loading-line"><span class="spinner"></span> 正在查开放获取副本（Unpaywall / OpenAlex / Semantic Scholar / arXiv）…</div>'
    );
    api('/api/fulltext', { method: 'POST', body: { paper: stripInternal(it), q: state.q } })
      .then(function (d) { renderFulltext(it, d); })
      .catch(function (e) {
        openSheet('<h2>获取全文</h2><div class="sub">' + esc(it.title) + '</div>' +
          '<div class="banner bad">定位失败：' + esc(e.message) + '</div>');
      });
  }

  function stripInternal(it) {
    var o = {};
    for (var k in it) if (k.charAt(0) !== '_') o[k] = it[k];
    return o;
  }

  function renderFulltext(it, d) {
    var h = [];
    h.push('<h2>获取全文</h2>');
    h.push('<div class="sub">' + esc(it.title) + '</div>');

    if (d.pdfCount > 0) {
      h.push('<div class="banner info"><b>找到 ' + d.pdfCount + ' 个 PDF 链接</b>，' +
        (d.oaPdfCount ? '其中 ' + d.oaPdfCount + ' 个是开放获取，可直接下载。' : '但可能要订阅才能打开。') +
        '下载后会缓存在本地，之后断网也能看图。</div>');
    } else {
      h.push('<div class="banner warn"><b>公开渠道暂时没有找到免费全文。</b>这篇要么是订阅期刊，要么作者没有放开放版本。下面这些路径都能在不翻墙的前提下拿到它。</div>');
    }

    (d.candidates || []).forEach(function (c, i) {
      var pill = c.oa ? '<span class="pill oa">开放获取</span>' : '<span class="pill warn">可能需订阅</span>';
      var v = c.verified === true ? '<span class="pill oa">已验证 PDF</span>' :
        c.verified === false ? '<span class="pill">需跳转</span>' : '';
      h.push('<div class="row">' +
        '<div class="grow">' +
        '<div class="t">' + esc(c.source) + ' ' + pill + ' ' + v + '</div>' +
        '<div class="d">' + esc(c.note || '') + '<br><span style="color:var(--dim-2);word-break:break-all">' + esc(c.host || '') + '</span></div>' +
        '</div>' +
        (c.kind === 'pdf'
          ? '<button class="btn sm primary" data-dl="' + i + '">下载</button>'
          : '<button class="btn sm" data-open="' + i + '">打开</button>') +
        '</div>');
    });

    if (d.closed && (d.routes || []).length) {
      h.push('<h2 style="margin-top:18px">合规获取通道</h2>');
      h.push('<div class="sub">这些都不需要梯子，按顺序试，通常第 1～3 条就能拿到。</div>');
      d.routes.forEach(function (r, i) {
        var url = r.mailto || r.url || '';
        h.push('<div class="row">' +
          '<div class="grow">' +
          '<div class="t">' + (r.tag ? '<span class="pill oa">' + esc(r.tag) + '</span> ' : '') + esc(r.title) + '</div>' +
          '<div class="d">' + esc(r.desc || '') + '</div>' +
          '</div>' +
          (r.mailto
            ? '<button class="btn sm" data-mail="' + i + '">复制邮件</button>'
            : '<button class="btn sm" data-route="' + i + '">打开</button>') +
          '</div>');
      });
    }

    h.push('<div style="margin-top:16px;color:var(--dim-2);font-size:11.5px;line-height:1.7">' +
      '说明：这里只接开放获取（OA）与作者自存档渠道，不碰盗版镜像。' +
      '闭源论文的正规拿法是「文献传递 / 作者索取 / 学校订阅」三件事，工具能帮你把这三件事的步骤压缩成一次点击。</div>');

    openSheet(h.join(''));

    els.sheet.querySelectorAll('[data-dl]').forEach(function (b) {
      b.addEventListener('click', function () {
        downloadCandidate(it, d.candidates[Number(b.getAttribute('data-dl'))], b);
      });
    });
    els.sheet.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = d.candidates[Number(b.getAttribute('data-open'))];
        window.open(c.url, '_blank', 'noopener');
      });
    });
    els.sheet.querySelectorAll('[data-route]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = d.routes[Number(b.getAttribute('data-route'))];
        if (r.url) window.open(r.url, '_blank', 'noopener');
      });
    });
    els.sheet.querySelectorAll('[data-mail]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = d.routes[Number(b.getAttribute('data-mail'))];
        var body = decodeURIComponent(String(r.mailto || '').replace(/^mailto:\?body=/, ''));
        copy(body, '英文邮件模板已复制，粘到邮箱里改一下称呼就行');
      });
    });
  }

  function downloadCandidate(it, c, btn) {
    if (!c) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    var qs = '?u=' + enc(c.url) + '&name=' + enc(it.title || '') + '&doi=' + enc(it.doi || '');
    api('/api/pdf' + qs).then(function (r) {
      if (r && r.direct) {
        toast('已在新标签页打开（在线版不缓存 PDF）', 'ok', 3000);
        btn.disabled = false;
        btn.textContent = '打开';
        btn.onclick = function () { window.open(r.url, '_blank', 'noopener'); };
        window.open(r.url, '_blank', 'noopener');
        return;
      }
      toast('已下载并缓存到本地（' + fmtBytes(r.bytes) + '）', 'ok', 3200);
      var a = document.createElement('a');
      a.className = 'btn sm primary';
      a.textContent = '打开';
      a.href = r.downloadUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      btn.replaceWith(a);
      window.open(r.url, '_blank', 'noopener');
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '下载';
      toast(e.message, 'bad', 6000);
    });
  }

  /* ---------------------------- 引用 ---------------------------- */

  function showCite(it) {
    var fmts = [
      ['gb', '国标 GB/T 7714'], ['apa', 'APA 7'], ['bibtex', 'BibTeX'], ['ris', 'RIS'], ['endnote', 'EndNote']
    ];
    var c = it.cite || {};
    function body(fmt) {
      if (fmt === 'endnote') return c.endnote || c.ris || '';
      return c[fmt] || '';
    }
    var html = ['<h2>引用格式</h2>', '<div class="sub">' + esc(it.title) + '</div>',
      '<div class="tabs">' + fmts.map(function (f, i) {
        return '<button class="tab' + (i === 0 ? ' on' : '') + '" data-fmt="' + f[0] + '">' + esc(f[1]) + '</button>';
      }).join('') + '</div>',
      '<pre class="code" id="citeBox">' + esc(body('gb')) + '</pre>',
      '<button class="btn primary block" id="copyCite">复制这段</button>',
      '<div style="color:var(--dim-2);font-size:11.5px;margin-top:10px;line-height:1.7">' +
      '国标格式已按 GB/T 7714-2015 排版（作者 ≤3 全列，>3 用「等 / et al.」，含 [J]/[M]/[C]/[D] 标识）。' +
      'BibTeX / RIS 可以直接导入 Zotero、EndNote、NoteExpress。</div>'
    ].join('');
    openSheet(html);
    var cur = 'gb';
    els.sheet.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        cur = t.getAttribute('data-fmt');
        els.sheet.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
        $('#citeBox').textContent = body(cur);
      });
    });
    $('#copyCite').addEventListener('click', function () { copy(body(cur), '引用已复制'); });
  }

  /* ---------------------------- 收藏夹 ---------------------------- */

  function showShelf() {
    var items = state.shelf;
    var h = ['<h2>收藏夹 <span style="color:var(--dim-2);font-size:13px">' + items.length + ' 篇</span></h2>'];
    if (!items.length) {
      h.push('<div class="sub">还没有收藏。检索结果里点「收藏」，就会出现在这里，之后可以一键导出参考文献。</div>');
    } else {
      h.push('<div class="sub">可以导出成 Word/EndNote 能直接用的参考文献表。</div>');
      h.push('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        ['gb', 'apa', 'bibtex', 'ris', 'endnote'].map(function (f) {
          return '<button class="btn sm" data-exp="' + f + '">导出 ' + f.toUpperCase() + '</button>';
        }).join('') + '<button class="btn sm ghost" data-exp-clear="1">清空</button></div>');
      items.forEach(function (it) {
        h.push('<div class="shelf-item">' +
          '<div class="t">' + esc(it.title) + '</div>' +
          '<div class="m">' + esc(authorsLine(it.authors)) + (it.year ? ' · ' + it.year : '') +
          (it.venue ? ' · ' + esc(it.venue) : '') + '</div>' +
          '<div class="ops">' +
          '<button class="btn sm" data-shelf-cite="' + esc(it.id) + '">引用</button>' +
          '<button class="btn sm" data-shelf-ft="' + esc(it.id) + '">全文</button>' +
          '<button class="btn sm ghost" data-shelf-del="' + esc(it.id) + '">移除</button>' +
          '</div></div>');
      });
    }
    openSheet(h.join(''));

    els.sheet.querySelectorAll('[data-exp]').forEach(function (b) {
      b.addEventListener('click', function () {
        var fmt = b.getAttribute('data-exp');
        if (window.PF_STATIC) {
          api('/api/export?fmt=' + fmt).catch(function (e) { toast(e.message, 'bad'); });
          return;
        }
        window.location.href = '/api/export?fmt=' + fmt;
      });
    });
    var clr = els.sheet.querySelector('[data-exp-clear]');
    if (clr) clr.addEventListener('click', function () {
      api('/api/shelf?id=all', { method: 'DELETE' }).then(function () {
        state.shelf = []; updateShelfCount(); showShelf(); toast('已清空');
      });
    });
    els.sheet.querySelectorAll('[data-shelf-cite]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = state.shelf.filter(function (x) { return x.id === b.getAttribute('data-shelf-cite'); })[0];
        if (it) showCite(it);
      });
    });
    els.sheet.querySelectorAll('[data-shelf-ft]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = state.shelf.filter(function (x) { return x.id === b.getAttribute('data-shelf-ft'); })[0];
        if (it) showFulltext(it);
      });
    });
    els.sheet.querySelectorAll('[data-shelf-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        api('/api/shelf?id=' + enc(b.getAttribute('data-shelf-del')), { method: 'DELETE' }).then(function (d) {
          state.shelf = d.items || []; updateShelfCount(); showShelf();
        });
      });
    });
  }

  /* ---------------------------- 网络体检 ---------------------------- */

  function showHealth() {
    openSheet('<h2>网络体检</h2><div class="sub">正在逐个探测学术数据源…</div>' +
      '<div class="loading-line"><span class="spinner"></span> 这需要十几秒</div>');
    api('/api/health?force=1').then(function (d) {
      var h = ['<h2>网络体检</h2>'];
      h.push('<div class="banner info"><b>' + d.directReachable + '/' + d.directTotal +
        ' 个站点可直连。</b>检索接口基本都能通，所以查文献不需要梯子；出版商站点里标 ❌ 的就是被墙或被反爬拦住的——那些页面打不开，但题录和开放副本照样能拿到。</div>');
      h.push('<div class="health-grid">');
      d.probes.forEach(function (p) {
        h.push('<div class="hrow"><span class="hdot ' + (p.ok ? 'ok' : 'bad') + '"></span>' +
          '<span>' + esc(p.label) + '</span>' +
          '<span style="color:var(--dim-2);font-size:11.5px">' + (p.ok ? '正常' : (p.status ? 'HTTP ' + p.status : '不可达')) + '</span>' +
          '<span class="ms">' + (p.ms ? p.ms + ' ms' : '—') + '</span></div>');
      });
      h.push('</div>');
      var ax = d.sources || [];
      if (ax.length) {
        h.push('<h2 style="margin-top:16px">最近一次检索的响应</h2><div class="health-grid">');
        ax.forEach(function (s) {
          h.push('<div class="hrow"><span class="hdot ' + (s.ok ? 'ok' : 'bad') + '"></span>' +
            '<span>' + esc(s.label) + '</span>' +
            '<span style="color:var(--dim-2);font-size:11.5px">' + (s.ok ? (s.count + ' 条') : esc(s.error || '失败')) + '</span>' +
            '<span class="ms">' + (s.ms || 0) + ' ms</span></div>');
        });
        h.push('</div>');
      }
      h.push('<div style="margin-top:14px;color:var(--dim-2);font-size:11.5px;line-height:1.7">' +
        '顺带说明为什么这个工具不容易被墙影响：检索走的是学术机构的公开 API（Crossref、OpenAlex、ERIC 等），' +
        '它们本身在我国网络内可直连；全文优先取开放获取副本。被墙的往往是 Google 学术和几家大型出版商站点，' +
        '而这两类恰好都不是「检索必须经过」的环节。</div>');
      openSheet(h.join(''));
    }).catch(function (e) {
      openSheet('<h2>网络体检</h2><div class="banner bad">探测失败：' + esc(e.message) + '</div>');
    });
  }

  /* ---------------------------- 设置 ---------------------------- */

  function showSettings() {
    var c = state.config || {};
    var meta = state.metaSources || [];
    var h = ['<h2>设置</h2>'];
    h.push('<div class="field"><label>联系邮箱（启用 Unpaywall 全文定位）</label>' +
      '<input type="email" id="cfgEmail" placeholder="you@example.com" value="' + esc(c.email || '') + '">' +
      '<div class="hint">Unpaywall 是免费开放接口，按规范要求留一个可联系的邮箱。填了它，找全文的成功率会明显提高。</div></div>');

    h.push('<div class="field"><label>OpenAlex API Key（可选）</label>' +
      '<input type="text" id="cfgKey" placeholder="不填也能用，但每天有共享额度" value="' + esc(c.openalexKey === '已设置' ? '' : (c.openalexKey || '')) + '">' +
      '<div class="hint">OpenAlex 现在按次计费，无 Key 时全网络共享每天 $0.10。填一个自己的 Key（免费，每天 $1）更稳。' +
      '获取地址：<a href="https://openalex.org/settings/api" target="_blank" rel="noopener">openalex.org/settings/api</a></div></div>');

    h.push('<div class="switch"><div><div class="t">自动翻译</div>' +
      '<div class="d">中文关键词自动转英文；支持一键翻译英文摘要</div></div>' +
      '<input type="checkbox" id="cfgTrans" ' + (c.translate ? 'checked' : '') + '></div>');

    h.push('<div class="field" style="margin-top:16px"><label>默认数据源</label><div style="display:flex;flex-wrap:wrap;gap:7px" id="cfgSrc">');
    meta.forEach(function (m) {
      var on = (state.sources || []).indexOf(m.id) >= 0;
      h.push('<button class="chip' + (on ? ' on' : '') + '" data-cfg-src="' + esc(m.id) + '">' + esc(m.label) + '</button>');
    });
    h.push('</div><div class="hint">' + meta.map(function (m) { return esc(m.label) + '：' + esc(m.desc); }).join('<br>') + '</div></div>');

    h.push('<button class="btn primary block" id="saveCfg" style="margin-top:10px">保存设置</button>');
    h.push('<div style="margin-top:18px;border-top:1px solid var(--line);padding-top:12px;color:var(--dim-2);font-size:11.5px;line-height:1.8">' +
      '本地缓存：' + ((state.stats && state.stats.pdfCount) || 0) + ' 个 PDF · 收藏 ' + state.shelf.length + ' 篇<br>' +
      '数据目录：<span style="font-family:var(--mono)">' + esc((state.stats && state.stats.dataDir) || 'data/') + '</span><br>' +
      '无墙论文查询 v1.1 · 纯本地运行，检索词不会经过任何第三方服务器' +
      '</div>');
    openSheet(h.join(''));

    var picked = (state.sources || []).slice();
    els.sheet.querySelectorAll('[data-cfg-src]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-cfg-src');
        var i = picked.indexOf(id);
        if (i >= 0) { if (picked.length === 1) { toast('至少保留一个'); return; } picked.splice(i, 1); }
        else picked.push(id);
        b.classList.toggle('on', picked.indexOf(id) >= 0);
      });
    });

    $('#saveCfg').addEventListener('click', function () {
      var body = {
        email: $('#cfgEmail').value.trim(),
        translate: $('#cfgTrans').checked,
        sources: picked
      };
      var key = $('#cfgKey').value.trim();
      if (key) body.openalexKey = key;
      api('/api/config', { method: 'POST', body: body }).then(function (d) {
        state.config = d.config;
        state.sources = picked;
        loadConfig();
        renderSourceChips();
        savePrefs();
        renderBannersStatic();
        toast('设置已保存', 'ok');
        closeSheet();
      }).catch(function (e) { toast(e.message, 'bad'); });
    });
  }

  /* ---------------------------- 启动 ---------------------------- */

  function setupSignature() {
    var el = document.getElementById('signature');
    if (!el) return;
    if (!('IntersectionObserver' in window)) { el.classList.add('in'); return; }
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          el.classList.add('in');
          io.disconnect();
          break;
        }
      }
    }, { threshold: 0.3 });
    io.observe(el);
  }

  function boot() {
    cacheEls();
    loadPrefs();
    // 每次打开都从首页开始：不恢复上次检索词，也不自动搜
    state.q = '';
    els.sort.value = state.sort;
    els.oa.classList.toggle('on', state.oa);
    if (state.from) els.from.value = state.from;
    if (state.to) els.to.value = state.to;
    bind();
    renderSamples();
    renderBannersStatic();

    setupSignature();

    Promise.all([loadConfig(), loadShelf()]).then(function () {
      renderBannersStatic();
      els.q.value = '';
      state.q = '';
      els.empty.hidden = false;
      if (window.history && history.replaceState) {
        try { history.replaceState({ pf: 'init' }, '', location.pathname); } catch (e) {}
      }
    });

    if ('serviceWorker' in navigator && !window.PF_STATIC) {
      navigator.serviceWorker.register('/sw.js').catch(function () { });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
