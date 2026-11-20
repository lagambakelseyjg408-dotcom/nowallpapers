/* 无墙论文查询 · 浏览器版数据层
 * 纯前端：直接调用各学术机构的公开接口（都已开启 CORS）。
 * 依赖 pf-core.js 暴露的 PF.util / PF.merge / PF.cite / PF.insight
 */
(function () {
  'use strict';

  var U = window.PF.util;
  var M = window.PF.merge;
  var C = window.PF.cite;
  var I = window.PF.insight;
  var A = window.PF.access;

  var CFG_KEY = 'pf.config.v2';
  var SHELF_KEY = 'pf.shelf.v2';
  var CACHE_P = 'pf.cache.';

  var SOURCE_META = [
    { id: 'openalex', label: 'OpenAlex', group: '综合', desc: '全球最大开放学术图谱，覆盖 2.6 亿+ 作品' },
    { id: 'crossref', label: 'Crossref', group: '综合', desc: 'DOI 注册库，元数据最权威、免费无配额' },
    { id: 'eric', label: 'ERIC', group: '教育', desc: '美国教育资源信息中心，教育与语言教学专项' },
    { id: 'europepmc', label: 'Europe PMC', group: '综合', desc: '生命科学为主，含社科与全文；较慢' },
    { id: 'doaj', label: 'DOAJ', group: '开放获取', desc: '纯开放获取期刊，命中即可直接下 PDF' },
  ];

  var DEFAULTS = {
    email: '',
    openalexKey: '',
    translate: true,
    sources: ['openalex', 'crossref', 'eric'],
    perPage: 20,
    maxPdfMb: 80,
  };

  function getCfg() {
    var out = {};
    var k;
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        var v = JSON.parse(raw);
        for (k in v) if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = v[k];
      }
    } catch (e) {}
    return out;
  }

  function setCfg(patch) {
    var cur = getCfg();
    var k;
    for (k in patch || {}) if (Object.prototype.hasOwnProperty.call(cur, k)) cur[k] = patch[k];
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cur)); } catch (e) {}
    return cur;
  }

  /* ---------------------------- 网络 ---------------------------- */

  function withTimeout(promise, ms, label) {
    var timer;
    var t = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        var e = new Error(label + ' 响应超时（>' + Math.round(ms / 1000) + 's），已跳过');
        e.code = 'TIMEOUT';
        reject(e);
      }, ms);
    });
    return Promise.race([promise, t]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function req(url, opt) {
    opt = opt || {};
    var attempt = 0;
    var tries = opt.retries == null ? 1 : opt.retries;
    function go() {
      var ac = new AbortController();
      var timer = setTimeout(function () { ac.abort(); }, opt.timeout || 12000);
      return fetch(url, {
        signal: ac.signal,
        headers: opt.headers || {},
      })
        .then(function (res) {
          clearTimeout(timer);
          if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < tries) {
            attempt++;
            return new Promise(function (r) { setTimeout(r, 400 * attempt); }).then(go);
          }
          if (!res.ok) {
            var e = new Error('HTTP ' + res.status);
            e.status = res.status;
            throw e;
          }
          return res;
        })
        .catch(function (e) {
          clearTimeout(timer);
          if (attempt < tries && (e.name === 'AbortError' || /Failed to fetch|NetworkError/i.test(e.message))) {
            attempt++;
            return new Promise(function (r) { setTimeout(r, 400 * attempt); }).then(go);
          }
          if (e.name === 'AbortError') throw new Error('请求超时');
          throw e;
        });
    }
    return go();
  }

  function getJson(url, opt) {
    return req(url, opt).then(function (r) { return r.json(); });
  }

  function getText(url, opt) {
    return req(url, opt).then(function (r) { return r.text(); });
  }

  /* ---------------------------- 缓存 ---------------------------- */

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(CACHE_P + key);
      if (!raw) return undefined;
      var rec = JSON.parse(raw);
      if (!rec || rec.exp < Date.now()) return undefined;
      return rec.v;
    } catch (e) { return undefined; }
  }

  function cacheSet(key, v, ttl) {
    try {
      localStorage.setItem(CACHE_P + key, JSON.stringify({ exp: Date.now() + ttl, v: v }));
    } catch (e) {
      // 空间满了就清一遍过期缓存
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf(CACHE_P) === 0) localStorage.removeItem(k);
        }
        localStorage.setItem(CACHE_P + key, JSON.stringify({ exp: Date.now() + ttl, v: v }));
      } catch (e2) {}
    }
  }

  function cacheKey(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).slice(0, 120); }

  /* ---------------------------- 检索源 ---------------------------- */

  function yearFilter(yf, yt) {
    var f = [];
    if (yf || yt) f.push('publication_year:' + (yf || 1900) + '-' + (yt || new Date().getFullYear()));
    return f;
  }

  function passYear(y, yf, yt) {
    if (!y) return true;
    if (yf && y < yf) return false;
    if (yt && y > yt) return false;
    return true;
  }

  function passFields(item, fields) {
    if (!fields) return true;
    var t = String(item.title || '').toLowerCase();
    var au = (item.authors || []).map(function (a) { return a.name || ''; }).join(' ').toLowerCase();
    var ve = String(item.venue || '').toLowerCase();
    if (fields.title && t.indexOf(fields.title.toLowerCase()) < 0) return false;
    if (fields.author && au.indexOf(fields.author.toLowerCase()) < 0) return false;
    if (fields.venue && ve.indexOf(fields.venue.toLowerCase()) < 0) return false;
    return true;
  }

  function searchOpenAlex(ctx) {
    var cfg = ctx.cfg;
    var f = yearFilter(ctx.yearFrom, ctx.yearTo);
    if (ctx.oaOnly) f.push('is_oa:true');
    if (ctx.fields) {
      if (ctx.fields.title) f.push('title.search:' + ctx.fields.title);
      if (ctx.fields.abstract) f.push('abstract.search:' + ctx.fields.abstract);
      if (ctx.fields.author) f.push('raw_author_name.search:' + ctx.fields.author);
    }
    if (ctx.type === 'review') f.push('type:review');
    else if (ctx.type === 'preprint') f.push('type:preprint');
    else if (ctx.type === 'article') f.push('type:article');

    var q = new URLSearchParams();
    if (ctx.q) q.set('search', ctx.q);
    if (f.length) q.set('filter', f.join(','));
    q.set('page', String(ctx.page));
    q.set('per-page', String(Math.min(50, Math.max(ctx.per, 10))));
    q.set('select', 'id,doi,title,display_name,publication_year,publication_date,type,authorships,primary_location,best_oa_location,locations,open_access,cited_by_count,biblio,abstract_inverted_index,language,ids,primary_topic,keywords,is_retracted');
    if (cfg.email) q.set('mailto', cfg.email);
    if (cfg.openalexKey) q.set('api_key', cfg.openalexKey);
    var sortMap = { cited: 'cited_by_count:desc', newest: 'publication_date:desc', oldest: 'publication_date:asc' };
    if (sortMap[ctx.sort]) q.set('sort', sortMap[ctx.sort]);

    return getJson('https://api.openalex.org/works?' + q.toString(), { timeout: 12000 }).then(function (data) {
      if (data.meta && data.meta.notice) window.PF._oaNotice = String(data.meta.notice).slice(0, 200);
      var items = (data.results || []).map(function (w) {
        var doi = U.doiFrom(w.doi || (w.ids && w.ids.doi));
        var pdfs = [];
        var lands = [];
        function push(loc) {
          if (!loc) return;
          if (loc.pdf_url) pdfs.push(loc.pdf_url);
          if (loc.landing_page_url) lands.push(loc.landing_page_url);
        }
        push(w.best_oa_location);
        (w.locations || []).forEach(push);
        var venue = (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '';
        var pub = (w.primary_location && w.primary_location.source && w.primary_location.source.host_organization_name) || '';
        return {
          id: 'oa:' + String(w.id || '').split('/').pop(),
          doi: doi,
          title: U.cleanText(w.title || w.display_name),
          year: U.yearOf(w.publication_year),
          date: w.publication_date || '',
          authors: U.normalizeAuthors((w.authorships || []).map(function (a) {
            return { name: a.author && a.author.display_name, orcid: a.author && a.author.orcid };
          })),
          venue: U.cleanText(venue),
          publisher: U.cleanText(pub),
          type: w.type || 'article',
          volume: (w.biblio && w.biblio.volume) || '',
          issue: (w.biblio && w.biblio.issue) || '',
          pages: w.biblio && w.biblio.first_page ? (w.biblio.first_page + (w.biblio.last_page ? '-' + w.biblio.last_page : '')) : '',
          cited: w.cited_by_count || 0,
          abstract: U.deinvert(w.abstract_inverted_index),
          language: w.language || '',
          oa: {
            isOa: !!(w.open_access && w.open_access.is_oa),
            status: (w.open_access && w.open_access.oa_status) || '',
            urls: U.uniq(pdfs).slice(0, 4),
          },
          links: { doi: doi ? 'https://doi.org/' + doi : '', landing: U.uniq(lands)[0] || '', pdf: U.uniq(pdfs) },
          ids: { openalex: String(w.id || '').split('/').pop() },
          topics: U.uniq([].concat(
            w.primary_topic && w.primary_topic.display_name ? [w.primary_topic.display_name] : [],
            (w.keywords || []).map(function (k) { return k.display_name; })
          )).slice(0, 5),
          retracted: !!w.is_retracted,
          source: 'openalex',
        };
      });
      return { items: items, total: data.meta && data.meta.count };
    });
  }

  function searchCrossref(ctx) {
    var cfg = ctx.cfg;
    var q = new URLSearchParams();
    var hasField = ctx.fields && (ctx.fields.title || ctx.fields.author || ctx.fields.venue || ctx.fields.abstract);
    if (ctx.fields && ctx.fields.title) q.set('query.title', ctx.fields.title);
    if (ctx.fields && ctx.fields.author) q.set('query.author', ctx.fields.author);
    if (ctx.fields && ctx.fields.venue) q.set('query.container-title', ctx.fields.venue);
    if (ctx.q && !hasField) q.set('query.bibliographic', ctx.q);
    else if (!hasField) q.set('query.bibliographic', ctx.fields && ctx.fields.abstract ? ctx.fields.abstract : '');

    var f = [];
    if (ctx.yearFrom) f.push('from-pub-date:' + ctx.yearFrom + '-01-01');
    if (ctx.yearTo) f.push('until-pub-date:' + ctx.yearTo + '-12-31');
    if (ctx.type === 'article' || ctx.type === 'review') f.push('type:journal-article');
    if (f.length) q.set('filter', f.join(','));
    q.set('rows', String(Math.min(50, Math.max(ctx.per, 10))));
    q.set('offset', String((ctx.page - 1) * ctx.per));
    q.set('select', 'DOI,title,author,issued,published,container-title,volume,issue,page,publisher,type,abstract,is-referenced-by-count,link,license,ISSN,URL,subject');
    if (cfg.email) q.set('mailto', cfg.email);
    var sortMap = { cited: 'is-referenced-by-count', newest: 'published', oldest: 'published' };
    if (sortMap[ctx.sort]) {
      q.set('sort', sortMap[ctx.sort]);
      q.set('order', ctx.sort === 'oldest' ? 'asc' : 'desc');
    }

    return getJson('https://api.crossref.org/works?' + q.toString(), { timeout: 12000 }).then(function (data) {
      var msg = data.message || {};
      var items = (msg.items || []).map(function (it) {
        var doi = U.doiFrom(it.DOI);
        var dp = (it.issued && it.issued['date-parts'] && it.issued['date-parts'][0]) || [];
        var title = U.cleanText(Array.isArray(it.title) ? it.title[0] : it.title);
        var pdfs = [];
        (it.link || []).forEach(function (l) {
          if (/pdf/i.test(String(l['content-type'] || '')) || /\.pdf($|\?)/i.test(l.URL || '')) pdfs.push(l.URL);
        });
        return {
          id: 'cr:' + doi,
          doi: doi,
          title: title,
          year: U.yearOf(dp[0]),
          date: dp.join('-'),
          authors: U.normalizeAuthors((it.author || []).map(function (a) {
            return { name: [a.given, a.family].filter(Boolean).join(' ') || a.name, orcid: a.ORCID };
          })),
          venue: U.cleanText(Array.isArray(it['container-title']) ? it['container-title'][0] : it['container-title']),
          publisher: U.cleanText(it.publisher),
          type: it.type || 'article',
          volume: it.volume || '',
          issue: it.issue || '',
          pages: it.page || '',
          cited: it['is-referenced-by-count'] || 0,
          abstract: U.cleanText(it.abstract),
          language: '',
          oa: { isOa: false, status: '', urls: U.uniq(pdfs).slice(0, 3) },
          links: { doi: doi ? 'https://doi.org/' + doi : '', landing: doi ? 'https://doi.org/' + doi : it.URL || '', pdf: U.uniq(pdfs) },
          ids: {},
          topics: Array.isArray(it.subject) ? it.subject.slice(0, 3) : [],
          source: 'crossref',
        };
      });
      return { items: items, total: msg['total-results'] };
    });
  }

  function searchEric(ctx) {
    var q = new URLSearchParams();
    var parts = [];
    if (ctx.fields && ctx.fields.title) parts.push('title:"' + ctx.fields.title.replace(/"/g, '') + '"');
    if (ctx.fields && ctx.fields.author) parts.push('author:"' + ctx.fields.author.replace(/"/g, '') + '"');
    var search = parts.length ? parts.join(' AND ') : '"' + String(ctx.q || '').replace(/"/g, '') + '"';
    q.set('search', search);
    q.set('format', 'json');
    q.set('rows', String(Math.min(50, Math.max(ctx.per, 10))));
    q.set('start', String((ctx.page - 1) * ctx.per));
    q.set('fields', 'id,title,author,description,publicationdateyear,source,publisher,peerreviewed,url,e_fulltextauth,publicationtype,subject,language');

    return getJson('https://api.ies.ed.gov/eric/?' + q.toString(), { timeout: 12000 }).then(function (data) {
      var docs = (data.response && data.response.docs) || [];
      var items = docs
        .filter(function (d) { return passYear(U.yearOf(d.publicationdateyear), ctx.yearFrom, ctx.yearTo); })
        .map(function (d) {
          var id = d.id || '';
          var ft = String(d.e_fulltextauth || '').toLowerCase();
          var hasPdf = ft === 'y' || ft === 'true' || ft === 't';
          var pdf = hasPdf && id ? 'https://files.eric.ed.gov/fulltext/' + id + '.pdf' : '';
          return {
            id: 'er:' + id,
            doi: '',
            title: U.cleanText(d.title),
            year: U.yearOf(d.publicationdateyear),
            date: '',
            authors: U.normalizeAuthors((d.author || []).map(function (n) { return { name: n }; })),
            venue: U.cleanText(d.source),
            publisher: U.cleanText(d.publisher),
            type: (Array.isArray(d.publicationtype) ? d.publicationtype[0] : d.publicationtype) || 'article',
            volume: '',
            issue: '',
            pages: '',
            cited: 0,
            abstract: U.cleanText(d.description),
            language: '',
            oa: { isOa: !!pdf, status: pdf ? 'repository' : '', urls: pdf ? [pdf] : [] },
            links: { doi: '', landing: id ? 'https://eric.ed.gov/?id=' + id : U.cleanText(d.url), pdf: pdf ? [pdf] : [] },
            ids: { eric: id },
            topics: (Array.isArray(d.subject) ? d.subject : []).slice(0, 4),
            source: 'eric',
          };
        });
      return { items: items, total: data.response && data.response.numFound };
    });
  }

  function searchDoaj(ctx) {
    var q = new URLSearchParams();
    q.set('pageSize', String(Math.min(50, Math.max(ctx.per, 10))));
    q.set('page', String(ctx.page));
    var query = '"' + String(ctx.q || '').replace(/"/g, '') + '"';
    return getJson('https://doaj.org/api/search/articles/' + encodeURIComponent(query) + '?' + q.toString(), { timeout: 12000 }).then(function (data) {
      var items = (data.results || []).map(function (rec) {
        var b = rec.bibjson || {};
        var ids = b.identifier || [];
        var doi = U.doiFrom((ids.filter(function (x) { return x.type === 'doi'; })[0] || {}).id);
        var pdfs = (b.link || []).filter(function (l) {
          return /pdf/i.test(l.content_type || l.type || '') || /\.pdf($|\?)/i.test(l.url || '');
        }).map(function (l) { return l.url; });
        var landing = (b.link || []).filter(function (l) { return /fulltext|abstract|homepage/i.test(l.type || ''); })[0] || {};
        return {
          id: 'dj:' + (rec.id || doi),
          doi: doi,
          title: U.cleanText(b.title),
          year: U.yearOf(b.year),
          date: '',
          authors: U.normalizeAuthors((b.author || []).map(function (a) { return { name: a.name }; })),
          venue: U.cleanText(b.journal && b.journal.title),
          publisher: U.cleanText(b.journal && b.journal.publisher),
          type: 'article',
          volume: (b.journal && b.journal.volume) || '',
          issue: (b.journal && b.journal.number) || '',
          pages: b.start_page ? b.start_page + (b.end_page ? '-' + b.end_page : '') : '',
          cited: 0,
          abstract: U.cleanText(b.abstract),
          language: '',
          oa: { isOa: true, status: 'gold', urls: U.uniq(pdfs).slice(0, 3) },
          links: { doi: doi ? 'https://doi.org/' + doi : '', landing: landing.url || '', pdf: U.uniq(pdfs) },
          ids: {},
          topics: (b.subject || []).slice(0, 3).map(function (s) { return s.term || s; }).filter(Boolean),
          source: 'doaj',
        };
      });
      return { items: items, total: data.total };
    });
  }

  function searchEuropePmc(ctx) {
    var q = new URLSearchParams();
    var query = String(ctx.q || '');
    if (ctx.yearFrom || ctx.yearTo) {
      query += ' AND PUB_YEAR:[' + (ctx.yearFrom || 1900) + ' TO ' + (ctx.yearTo || new Date().getFullYear()) + ']';
    }
    q.set('query', query);
    q.set('format', 'json');
    q.set('pageSize', String(Math.min(50, Math.max(ctx.per, 10))));
    q.set('page', String(ctx.page));
    q.set('resultType', 'lite');
    return getJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + q.toString(), { timeout: 15000 }).then(function (data) {
      var list = (data.resultList && data.resultList.result) || [];
      var items = list.map(function (r) {
        var pmcid = r.pmcid || '';
        var pdf = pmcid ? 'https://europepmc.org/articles/' + pmcid + '?pdf=render' : '';
        return {
          id: 'ep:' + (r.id || r.pmid || r.doi),
          doi: U.doiFrom(r.doi),
          title: U.cleanText(r.title),
          year: U.yearOf(r.pubYear),
          date: '',
          authors: U.normalizeAuthors(String(r.authorString || '').split(',').map(function (n) { return { name: n.trim() }; })),
          venue: U.cleanText(r.journalTitle),
          publisher: '',
          type: 'article',
          volume: r.journalVolume || '',
          issue: r.issue || '',
          pages: r.pageInfo || '',
          cited: Number(r.citedByCount) || 0,
          abstract: U.cleanText(r.abstractText),
          language: '',
          oa: { isOa: String(r.isOpenAccess) === 'Y' || !!pmcid, status: pmcid ? 'green' : '', urls: pdf ? [pdf] : [] },
          links: { doi: r.doi ? 'https://doi.org/' + U.doiFrom(r.doi) : '', landing: pmcid ? 'https://europepmc.org/article/MED/' + (r.pmid || r.id) : '', pdf: pdf ? [pdf] : [] },
          ids: { pmcid: pmcid, pmid: r.pmid || '' },
          topics: [],
          source: 'europepmc',
        };
      });
      return { items: items, total: data.hitCount };
    });
  }

  var ADAPTERS = {
    openalex: searchOpenAlex,
    crossref: searchCrossref,
    eric: searchEric,
    doaj: searchDoaj,
    europepmc: searchEuropePmc,
  };

  var BUDGET = { openalex: 11000, crossref: 11000, eric: 11000, doaj: 10000, europepmc: 15000 };
  var SOFT = 9000;

  function runSources(ids, ctx) {
    var chosen = (ids || Object.keys(ADAPTERS)).filter(function (id) { return ADAPTERS[id]; });
    var arrived = [];
    var released = false;

    var tasks = chosen.map(function (id) {
      var t0 = Date.now();
      return withTimeout(Promise.resolve().then(function () { return ADAPTERS[id](ctx); }), BUDGET[id] || 11000, id)
        .then(function (r) {
          var rec = { id: id, ok: true, ms: Date.now() - t0, items: r.items || [], total: r.total };
          if (!released) arrived.push(rec);
          return rec;
        })
        .catch(function (e) {
          var rec = { id: id, ok: false, ms: Date.now() - t0, items: [], error: String(e.message || e).slice(0, 160), code: e.code || '' };
          if (!released) arrived.push(rec);
          return rec;
        });
    });

    var all = Promise.all(tasks);
    var soft = new Promise(function (r) { setTimeout(function () { r('soft'); }, SOFT); });

    return Promise.race([all.then(function () { return 'all'; }), soft]).then(function (who) {
      if (who !== 'soft') return arrived;
      released = true;
      var got = {};
      arrived.forEach(function (r) { got[r.id] = 1; });
      var out = arrived.slice();
      chosen.forEach(function (id) {
        if (!got[id]) {
          out.push({ id: id, ok: false, ms: SOFT, items: [], error: '超过 ' + SOFT / 1000 + 's 未返回，已跳过', code: 'TIMEOUT' });
        }
      });
      return out;
    });
  }

  /* ---------------------------- 检索主流程 ---------------------------- */

  function attachExtras(items) {
    return items.map(function (p) {
      var out = {};
      for (var k in p) out[k] = p[k];
      out.cite = {
        gb: C.formatPaper(p, 'gb'),
        apa: C.formatPaper(p, 'apa'),
        bibtex: C.formatPaper(p, 'bibtex'),
        ris: C.formatPaper(p, 'ris'),
        endnote: C.formatPaper(p, 'endnote'),
      };
      out.insight = I.buildInsight(p);
      out.access = A.classify(p);
      return out;
    });
  }

  function search(params) {
    var cfg = getCfg();
    var q = String(params.q || '').trim();
    var fields = {
      title: (params.title || '').trim(),
      author: (params.author || '').trim(),
      venue: (params.venue || '').trim(),
      abstract: (params.abstract || '').trim(),
    };
    var hasFields = fields.title || fields.author || fields.venue || fields.abstract;
    if (!q && !hasFields) return Promise.reject(new Error('请输入检索词'));

    var page = Math.max(1, parseInt(params.page, 10) || 1);
    var per = Math.min(50, Math.max(5, parseInt(params.per, 10) || cfg.perPage));
    var sort = ['relevance', 'cited', 'newest', 'oldest'].indexOf(params.sort) >= 0 ? params.sort : 'relevance';
    var oaOnly = params.oa === '1' || params.oa === true;
    var yearFrom = parseInt(params.from, 10) || null;
    var yearTo = parseInt(params.to, 10) || null;
    var type = params.type || '';

    var wanted = (params.sources ? String(params.sources).split(',') : cfg.sources).filter(function (id) { return ADAPTERS[id]; });
    if (!wanted.length) wanted = ['crossref'];

    var ctx = {
      q: q, fields: hasFields ? fields : null, page: page, per: Math.min(50, Math.round(per * 1.3)),
      sort: sort, oaOnly: oaOnly, yearFrom: yearFrom, yearTo: yearTo, type: type, cfg: cfg,
    };

    var ck = cacheKey(['s', q, fields, wanted.join(','), page, per, sort, oaOnly, yearFrom, yearTo, type]);
    var hit = cacheGet(ck);
    if (hit) { hit.cached = true; return Promise.resolve(hit); }

    var t0 = Date.now();
    return runSources(wanted, ctx).then(function (batches) {
      var merged = M.search(batches, {
        sort: sort, oaOnly: oaOnly, page: page, per: per, yearFrom: yearFrom, yearTo: yearTo,
        fields: hasFields ? fields : null,
      });
      var payload = {
        ok: true,
        q: q,
        qUsed: q,
        translatedFrom: '',
        page: page,
        per: per,
        sort: sort,
        oaOnly: oaOnly,
        yearFrom: yearFrom,
        yearTo: yearTo,
        fields: hasFields ? fields : null,
        type: type,
        sourcesWanted: wanted,
        items: attachExtras(merged.items),
        stats: merged.stats,
        sourceStats: batches.map(function (b) {
          var meta = SOURCE_META.filter(function (m) { return m.id === b.id; })[0] || {};
          return { id: b.id, label: meta.label || b.id, ok: b.ok, ms: b.ms, count: (b.items || []).length, total: b.total, error: b.error || '', code: b.code || '' };
        }),
        openalex: { blocked: false, notice: window.PF._oaNotice || '' },
        took: Date.now() - t0,
        cached: false,
        at: new Date().toISOString(),
        mode: 'static',
      };
      if (merged.items.length) cacheSet(ck, payload, 30 * 60 * 1000);
      return payload;
    });
  }

  /* ---------------------------- 全文定位 ---------------------------- */

  function unpaywall(doi, cfg) {
    if (!doi) return Promise.resolve([]);
    if (!cfg.email) return Promise.resolve([]);
    return getJson('https://api.unpaywall.org/v2/' + encodeURIComponent(doi) + '?email=' + encodeURIComponent(cfg.email), { timeout: 12000 })
      .then(function (d) {
        return (d.oa_locations || []).map(function (l) {
          var url = l.url_for_pdf || l.url;
          if (!url) return null;
          return {
            url: url,
            source: 'Unpaywall',
            kind: /\.pdf($|\?)|\/pdf\/|download_pdf/i.test(url) ? 'pdf' : 'landing',
            oa: true,
            note: '开放获取副本（' + (l.host_type || '仓储') + (l.version ? '，' + l.version : '') + '）',
          };
        }).filter(Boolean);
      })
      .catch(function () { return []; });
  }

  function openalexLocations(doi, cfg) {
    if (!doi) return Promise.resolve([]);
    var url = 'https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi) +
      '?select=id,doi,best_oa_location,locations,open_access' + (cfg.openalexKey ? '&api_key=' + encodeURIComponent(cfg.openalexKey) : '');
    return getJson(url, { timeout: 12000, retries: 0 })
      .then(function (d) {
        var locs = [];
        if (d.best_oa_location) locs.push(d.best_oa_location);
        (d.locations || []).forEach(function (l) { locs.push(l); });
        return locs
          .filter(function (l) { return l && l.pdf_url && l.is_oa; })
          .map(function (l) {
            return { url: l.pdf_url, source: 'OpenAlex', kind: 'pdf', oa: true, note: '开放获取 PDF（' + (l.version || '已发表版') + '）' };
          });
      })
      .catch(function () { return []; });
  }

  function s2(doi, title) {
    if (!doi && !title) return Promise.resolve([]);
    var url = doi
      ? 'https://api.semanticscholar.org/graph/v1/paper/DOI:' + encodeURIComponent(doi) + '?fields=title,openAccessPdf,isOpenAccess'
      : 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + encodeURIComponent(title) + '&limit=1&fields=title,openAccessPdf,isOpenAccess';
    return getJson(url, { timeout: 12000, retries: 0 })
      .then(function (d) {
        var p = Array.isArray(d.data) ? d.data[0] : d;
        if (p && p.openAccessPdf && p.openAccessPdf.url) {
          return [{ url: p.openAccessPdf.url, source: 'Semantic Scholar', kind: 'pdf', oa: true, note: '开放获取 PDF（S2 收录）' }];
        }
        return [];
      })
      .catch(function () { return []; });
  }

  function buildRoutes(p) {
    var title = p.title || '';
    var authors = (p.authors || []).map(function (a) { return a.name || a; }).filter(Boolean);
    var first = authors[0] || '';
    var subject = encodeURIComponent('Request for full text: ' + title);
    var body = encodeURIComponent(
      'Dear ' + (first || 'Professor') + ',\n\n' +
      'I am a graduate student working on a literature review related to this topic. ' +
      'I am writing to kindly ask whether you could share a copy of your paper:\n\n  ' +
      title + '\n  ' + (p.venue || '') + (p.year ? ', ' + p.year : '') + '\n' +
      (p.doi ? '  DOI: ' + p.doi + '\n' : '') +
      '\nThe full text is not accessible through my institution. A personal-use copy would help me a lot. ' +
      'I will cite it properly and not redistribute it.\n\nThank you very much.\n\nBest regards,\n[你的姓名]\n[单位 / 邮箱]'
    );
    var routes = [
      { kind: 'nstl', title: 'NSTL 原文传递（国家科技图书文献中心）', desc: '国内直连，注册后按页付费，通常几小时到邮箱。外文期刊覆盖很全。', url: 'https://www.nstl.gov.cn/', tag: '推荐' },
      { kind: 'ncpssd', title: '国家哲学社会科学文献中心', desc: '人文社科外文文献免费检索与传递。', url: 'https://www.ncpssd.org/' },
      { kind: 'ucdrs', title: '全国图书馆参考咨询联盟', desc: '有图书馆账号即可免费申请原文传递。', url: 'http://www.ucdrs.superlib.net/' },
      { kind: 'author', title: '直接向作者索取（免费、成功率高）', desc: '点开是一封写好的英文邮件，填称呼即可发送。', mailto: 'mailto:?subject=' + subject + '&body=' + body },
      { kind: 'lib', title: '通过学校图书馆入口访问', desc: '校内网或学校 VPN 下，出版商通常会放行全文。', url: p.doi ? 'https://doi.org/' + p.doi : (p.links && p.links.landing) || '' },
    ];
    return routes.filter(function (r) { return r.url || r.mailto; });
  }

  function fulltext(p) {
    var cfg = getCfg();
    var doi = U.doiFrom(p.doi);
    var own = [];
    ((p.oa && p.oa.urls) || []).forEach(function (u) { own.push(u); });
    ((p.links && p.links.pdf) || []).forEach(function (u) { own.push(u); });

    return Promise.all([
      unpaywall(doi, cfg),
      openalexLocations(doi, cfg),
      s2(doi, p.title),
      Promise.resolve(own.map(function (u) {
        return {
          url: u,
          source: '检索结果',
          kind: /\.pdf($|\?)|\/pdf\/|pdf=render|download_pdf/i.test(u) ? 'pdf' : 'landing',
          oa: !!(p.oa && p.oa.isOa),
          note: p.oa && p.oa.isOa ? '结果页标注的开放获取链接' : '出版社链接（可能需要订阅）',
        };
      })),
    ]).then(function (res) {
      var all = [].concat(res[0] || [], res[1] || [], res[2] || [], res[3] || []);
      var seen = {};
      var candidates = [];
      all.forEach(function (c) {
        if (!c || !c.url) return;
        var key = c.url.split('#')[0];
        if (seen[key]) return;
        seen[key] = 1;
        try { c.host = new URL(key).hostname.replace(/^www\./, ''); } catch (e) { c.host = ''; }
        c.wall = A.isBlockedHost(c.host) ? 'blocked' : 'open';
        candidates.push(c);
      });
      candidates.sort(function (a, b) {
        return (b.oa ? 1 : 0) - (a.oa ? 1 : 0) || (b.kind === 'pdf' ? 1 : 0) - (a.kind === 'pdf' ? 1 : 0);
      });
      var pdfs = candidates.filter(function (c) { return c.kind === 'pdf'; });
      var closed = pdfs.filter(function (c) { return c.oa; }).length === 0;
      return {
        ok: true,
        doi: doi,
        candidates: candidates.slice(0, 10),
        pdfCount: pdfs.length,
        oaPdfCount: pdfs.filter(function (c) { return c.oa; }).length,
        closed: closed,
        routes: closed ? buildRoutes(p) : [],
        mode: 'static',
      };
    });
  }

  /* ---------------------------- 翻译 / 收藏 / 导出 ---------------------------- */

  function translate(text, from, to) {
    var cfg = getCfg();
    if (!cfg.translate) return Promise.resolve({ ok: false, error: '翻译功能已关闭' });
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return Promise.resolve({ ok: false, error: '没有可翻译的内容' });
    var chunks = [];
    var rest = t;
    while (rest.length > 450) {
      var cut = rest.lastIndexOf('. ', 450);
      if (cut < 200) cut = 450;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) chunks.push(rest);

    var out = [];
    var chain = Promise.resolve();
    chunks.slice(0, 6).forEach(function (c) {
      chain = chain.then(function () {
        var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(c) + '&langpair=' + encodeURIComponent((from || 'en') + '|' + (to || 'zh-CN'));
        if (cfg.email) url += '&de=' + encodeURIComponent(cfg.email);
        return getJson(url, { timeout: 12000, retries: 0 }).then(function (d) {
          var s = Number(d && d.responseStatus);
          var txt = d && d.responseData && d.responseData.translatedText;
          if (s === 200 && txt) out.push(txt);
        }).catch(function () {});
      });
    });
    return chain.then(function () {
      if (!out.length) return { ok: false, error: '翻译服务暂时不可用（可能超出免费额度）' };
      return { ok: true, text: out.join(' ') };
    });
  }

  function shelfList() {
    try { return JSON.parse(localStorage.getItem(SHELF_KEY) || '[]'); } catch (e) { return []; }
  }
  function shelfSave(list) {
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(list.slice(0, 800))); } catch (e) {}
    return list;
  }
  function shelfAdd(p) {
    var list = shelfList();
    var i = -1;
    list.forEach(function (x, idx) { if (x.id === p.id) i = idx; });
    if (i >= 0) list[i] = p; else list.unshift(p);
    return shelfSave(list);
  }
  function shelfRemove(id) {
    return shelfSave(shelfList().filter(function (x) { return x.id !== id; }));
  }
  function shelfClear() { return shelfSave([]); }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
  }

  window.PFData = {
    SOURCE_META: SOURCE_META,
    DEFAULTS: DEFAULTS,
    getCfg: getCfg,
    setCfg: setCfg,
    search: search,
    fulltext: fulltext,
    translate: translate,
    shelfList: shelfList,
    shelfAdd: shelfAdd,
    shelfRemove: shelfRemove,
    shelfClear: shelfClear,
    download: download,
    adapters: Object.keys(ADAPTERS),
  };
})();
