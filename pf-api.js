/* 无墙论文查询 · 静态版接口层
 * 把 app.js 里的 /api/* 请求就地实现，不出网到自己的服务器。
 */
(function () {
  'use strict';

  function err(msg) {
    var e = new Error(msg);
    e.pf = true;
    throw e;
  }

  function parseQuery(path) {
    var i = path.indexOf('?');
    var q = {};
    if (i >= 0) {
      new URLSearchParams(path.slice(i + 1)).forEach(function (v, k) { q[k] = v; });
    }
    return q;
  }

  function apiPath(path) {
    var i = path.indexOf('?');
    return i >= 0 ? path.slice(0, i) : path;
  }

  var D = null;
  function data() {
    if (!D) D = window.PFData;
    return D;
  }

  function safe(fn) {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  window.PF_LOCAL_API = function (path, opts) {
    opts = opts || {};
    var p = apiPath(path);
    var q = parseQuery(path);
    var body = opts.body || {};

    switch (p) {
      case '/api/search':
        return safe(function () { return data().search(q); });
      case '/api/fulltext':
        if (!body.paper) return Promise.reject(new Error('缺少 paper'));
        return safe(function () { return data().fulltext(body.paper); });
      case '/api/enrich':
        return safe(function () {
          var doi = String(q.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
          var title = String(q.title || '').slice(0, 220);
          if (!doi && !title) throw new Error('缺少 doi 或标题');
          var url = doi
            ? 'https://api.semanticscholar.org/graph/v1/paper/DOI:' + encodeURIComponent(doi) + '?fields=title,abstract,tldr,openAccessPdf,isOpenAccess'
            : 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(title) + '&limit=1&fields=title,abstract,tldr,openAccessPdf,isOpenAccess';
          return fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var p = Array.isArray(d.data) ? d.data[0] : d;
              if (!p || !p.title) return { ok: true, source: 'Semantic Scholar' };
              return {
                ok: true,
                title: p.title,
                abstract: p.abstract || '',
                tldr: (p.tldr && p.tldr.text) || '',
                pdf: (p.openAccessPdf && p.openAccessPdf.url) || '',
                isOa: !!p.isOpenAccess,
                source: 'Semantic Scholar',
              };
            });
        });
      case '/api/translate':
        return safe(function () { return data().translate(body.text, body.from, body.to); });
      case '/api/shelf':
        if (opts.method === 'POST') {
          if (!body.paper) return Promise.reject(new Error('缺少 paper'));
          return Promise.resolve({ ok: true, items: data().shelfAdd(body.paper) });
        }
        if (opts.method === 'DELETE') {
          if (q.id === 'all') return Promise.resolve({ ok: true, items: data().shelfClear() });
          return Promise.resolve({ ok: true, items: data().shelfRemove(q.id) });
        }
        return Promise.resolve({ ok: true, items: data().shelfList() });
      case '/api/config':
        if (opts.method === 'POST') {
          return Promise.resolve({ ok: true, config: data().setCfg(body) });
        }
        var cfg = data().getCfg();
        return Promise.resolve({
          ok: true,
          config: cfg,
          meta: data().SOURCE_META,
          stats: { pdfCount: 0, cacheCount: 0, shelfCount: data().shelfList().length, dataDir: '浏览器本地存储' },
          version: window.PF_VERSION || '1.3.0',
        });
      case '/api/export':
        return safe(function () {
          var fmt = q.fmt || 'gb';
          var items = data().shelfList();
          if (!items.length) throw new Error('收藏夹是空的');
          var text = window.PF.cite.formatList(items, fmt);
          var ext = { bibtex: 'bib', ris: 'ris', endnote: 'enw' }[fmt] || 'txt';
          data().download('参考文献-' + fmt + '.' + ext, text, 'text/plain;charset=utf-8');
          return { ok: true, exported: true };
        });
      case '/api/cite':
        return safe(function () {
          var list = Array.isArray(body.papers) ? body.papers : body.paper ? [body.paper] : [];
          if (!list.length) throw new Error('缺少 papers');
          return { ok: true, text: window.PF.cite.formatList(list, body.fmt || 'gb'), fmt: body.fmt || 'gb' };
        });
      case '/api/health':
        return health();
      case '/api/stats':
        return Promise.resolve({ ok: true, pdfCount: 0, cacheCount: 0, shelfCount: data().shelfList().length });
      case '/api/pdf':
        // 静态版没有服务端代理：直接把链接交给浏览器打开
        return Promise.resolve({ ok: true, direct: true, url: q.u, name: q.name || '' });
      default:
        return Promise.reject(new Error('这个接口在静态版里不可用'));
    }
  };

  /* 网络体检：只测这些公开接口是否可直连（CORS 已开） */
  var PROBES = [
    { id: 'openalex', label: 'OpenAlex', url: 'https://api.openalex.org/works?per-page=1&select=id' },
    { id: 'crossref', label: 'Crossref', url: 'https://api.crossref.org/works?rows=1&select=DOI' },
    { id: 'eric', label: 'ERIC', url: 'https://api.ies.ed.gov/eric/?search=writing&format=json&rows=1' },
    { id: 'europepmc', label: 'Europe PMC', url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=test&format=json&pageSize=1' },
    { id: 'unpaywall', label: 'Unpaywall', url: 'https://api.unpaywall.org/v2/10.1038/nature12373?email=paperfree.probe@gmail.com' },
    { id: 'nstl', label: 'NSTL 文献传递', url: 'https://www.nstl.gov.cn/' },
    { id: 'ncpssd', label: '国家哲社文献中心', url: 'https://www.ncpssd.org/' },
    { id: 'twc', label: 'Transformative Works（同人研究 OA）', url: 'https://journal.transformativeworks.org/index.php/twc' },
    { id: 'core', label: 'CORE 开放仓储', url: 'https://core.ac.uk/' },
    { id: 'intellect', label: 'Intellect（Fandom Studies）', url: 'https://www.intellectbooks.com/' },
    { id: 'jstor', label: 'JSTOR', url: 'https://www.jstor.org/' },
    { id: 'muse', label: 'Project MUSE', url: 'https://muse.jhu.edu/' },
    { id: 'tandf', label: 'Taylor & Francis（多数被墙）', url: 'https://www.tandfonline.com/' },
    { id: 'sage', label: 'SAGE（多数被墙）', url: 'https://journals.sagepub.com/' },
    { id: 'emerald', label: 'Emerald', url: 'https://www.emerald.com/' },
    { id: 'researchgate', label: 'ResearchGate', url: 'https://www.researchgate.net/' },
    { id: 'google', label: 'Google 学术（对照）', url: 'https://scholar.google.com/scholar?q=test', control: true },
  ];

  function probeOne(t) {
    var t0 = Date.now();
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 9000);
    return fetch(t.url, { signal: ac.signal, mode: 'cors', cache: 'no-store' })
      .then(function (r) { clearTimeout(timer); return { id: t.id, label: t.label, ok: r.ok, status: r.status, ms: Date.now() - t0, control: !!t.control }; })
      .catch(function (e) {
        clearTimeout(timer);
        return { id: t.id, label: t.label, ok: false, status: 0, ms: Date.now() - t0, error: String(e.message || e).slice(0, 40), control: !!t.control };
      });
  }

  function health() {
    return Promise.all(PROBES.map(probeOne)).then(function (rows) {
      var real = rows.filter(function (r) { return !r.control; });
      return {
        ok: true,
        at: new Date().toISOString(),
        directReachable: real.filter(function (r) { return r.ok; }).length,
        directTotal: real.length,
        probes: rows,
        sources: [],
        openalex: { blocked: false },
        mode: 'static',
      };
    });
  }
})();
