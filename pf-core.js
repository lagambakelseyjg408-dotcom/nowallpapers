/* 无墙论文查询 · 核心逻辑（由 tools/build-static.js 生成，请勿手改） */
(function () {
  var __defs = {}, __cache = {};
  function __define(name, fn) { __defs[name] = fn; }
  function __require(name) {
    name = String(name).replace(/^\.\//, '');
    if (__cache[name]) return __cache[name].exports;
    var m = { exports: {} };
    __cache[name] = m;
    __defs[name](m, m.exports, __require);
    return m.exports;
  }
__define("util", function (module, exports, require) {
/** 文本 / 标识符 清洗工具 */

function cleanText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<jats:[^>]+>/g, ' ')
    .replace(/<\/jats:[^>]+>/g, ' ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化标题用于去重（去掉标点、变音符号、大小写差异） */
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

function doiFrom(v) {
  if (!v) return '';
  const m = String(v).match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  if (!m) return '';
  return m[0].replace(/[.,;:\]\)]+$/, '').toLowerCase();
}

function yearOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1000 && v < 3000 ? v : null;
  const m = String(v).match(/(1[5-9]\d{2}|20\d{2}|21\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

/** OpenAlex 的倒排索引摘要 → 正常文本 */
function deinvert(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const slots = [];
  let max = 0;
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p !== 'number' || p < 0) continue;
      slots[p] = word;
      if (p > max) max = p;
    }
  }
  const out = [];
  for (let i = 0; i <= max; i++) out.push(slots[i] || '');
  return cleanText(out.join(' '));
}

function cjkRatio(s) {
  const str = String(s || '');
  if (!str) return 0;
  const cjk = (str.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const total = (str.match(/[^\s]/g) || []).length || 1;
  return cjk / total;
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

/** 从作者名猜姓氏（用于 GB/T 7714 / BibTeX key） */
function splitName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return { first: '', last: '' };
  if (/[\u3400-\u9fff]/.test(n)) {
    // 中文姓名：前 1~2 字为姓
    return { first: n.length > 2 ? n.slice(n.length - 2) : '', last: n.slice(0, n.length > 2 ? n.length - 2 : 1) };
  }
  const parts = n.split(' ');
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function initials(first) {
  return String(first || '')
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join('');
}

/** 统一作者结构：{name, orcid} */
function normalizeAuthors(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => {
      if (!a) return null;
      if (typeof a === 'string') return { name: cleanText(a), orcid: '' };
      const name = cleanText(a.name || a.display_name || a.raw_name || '');
      if (!name) return null;
      return { name, orcid: a.orcid || a.ORCID || '' };
    })
    .filter(Boolean);
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    if (x == null) continue;
    const k = typeof x === 'string' ? x : JSON.stringify(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  cleanText,
  normTitle,
  doiFrom,
  yearOf,
  deinvert,
  cjkRatio,
  truncate,
  splitName,
  initials,
  normalizeAuthors,
  uniq,
  clampInt,
  sleep,
};

});
__define("merge", function (module, exports, require) {
const U = require('util');

/** 源权重：影响合并后的排序位次，不代表数据质量评价 */
const SOURCE_WEIGHT = {
  openalex: 1.15,
  crossref: 1.0,
  doaj: 0.95,
  eric: 0.95,
  europepmc: 0.9,
  arxiv: 0.8,
};

const OA_RANK = { gold: 4, hybrid: 3, green: 2, bronze: 1, closed: 0 };

function isBlank(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

function mergeBatches(batches) {
  const clusters = new Map();
  const rawCount = batches.reduce((n, b) => n + (b.items ? b.items.length : 0), 0);

  for (const batch of batches) {
    if (!batch || !batch.items) continue;
    batch.items.forEach((item, pos) => {
      if (!item || !item.title) return;
      const key = item.doi ? `doi:${item.doi}` : `t:${U.normTitle(item.title)}`;
      let c = clusters.get(key);
      if (!c) {
        c = {
          ...item,
          authors: item.authors ? [...item.authors] : [],
          links: { ...(item.links || {}), pdf: [...((item.links && item.links.pdf) || [])] },
          ids: { ...(item.ids || {}) },
          topics: [...(item.topics || [])],
          sources: [item.source],
          _score: 0,
          _hits: [],
        };
        clusters.set(key, c);
      } else {
        // 合并：保留更完整的信息
        for (const f of ['doi', 'title', 'year', 'date', 'venue', 'publisher', 'type', 'volume', 'issue', 'pages', 'abstract', 'language']) {
          if (isBlank(c[f]) && !isBlank(item[f])) c[f] = item[f];
        }
        if ((item.abstract || '').length > (c.abstract || '').length) c.abstract = item.abstract;
        if ((item.cited || 0) > (c.cited || 0)) c.cited = item.cited;
        if ((item.authors || []).length > (c.authors || []).length && item.authors.length) {
          c.authors = [...item.authors];
        }
        if (!c.sources.includes(item.source)) c.sources.push(item.source);
        c.ids = { ...c.ids, ...(item.ids || {}) };
        c.topics = U.uniq([...(c.topics || []), ...(item.topics || [])]).slice(0, 6);
        c.links.pdf = U.uniq([...(c.links.pdf || []), ...((item.links && item.links.pdf) || [])]);
        c.links.landing = c.links.landing || (item.links && item.links.landing) || '';
        c.links.doi = c.links.doi || (item.links && item.links.doi) || '';
        if (item.oa) {
          c.oa = c.oa || { isOa: false, status: '', urls: [] };
          c.oa.isOa = c.oa.isOa || item.oa.isOa;
          c.oa.urls = U.uniq([...(c.oa.urls || []), ...(item.oa.urls || [])]);
          if ((OA_RANK[item.oa.status] || 0) > (OA_RANK[c.oa.status] || 0)) c.oa.status = item.oa.status;
        }
        c.retracted = c.retracted || item.retracted;
      }
      const w = (SOURCE_WEIGHT[item.source] || 0.8) * (1 / (1 + pos * 0.65));
      c._score += w;
      c._hits.push({ source: item.source, pos });
    });
  }

  const items = [];
  for (const c of clusters.values()) {
    // 综合分：多源命中 + 被引 + 开放获取 + 有摘要
    const citedBoost = Math.log10(1 + Math.max(0, c.cited || 0)) * 0.42;
    const oaBoost = c.oa && c.oa.isOa ? 0.55 : 0;
    const absBoost = (c.abstract || '').length > 120 ? 0.18 : 0;
    const retractPenalty = c.retracted ? -2 : 0;
    c.score = Number((c._score + citedBoost + oaBoost + absBoost + retractPenalty).toFixed(4));
    c.id = c.doi ? `doi:${c.doi}` : c.id;
    if (!c.oa) c.oa = { isOa: false, status: '', urls: [] };
    c.oa.urls = U.uniq((c.oa.urls || []).concat(c.links.pdf || [])).slice(0, 6);
    delete c._score;
    delete c._hits;
    items.push(c);
  }

  return items;
}

function sortItems(items, sort) {
  const arr = [...items];
  if (sort === 'cited') {
    arr.sort((a, b) => (b.cited || 0) - (a.cited || 0) || b.score - a.score);
  } else if (sort === 'newest') {
    arr.sort((a, b) => (b.year || 0) - (a.year || 0) || b.score - a.score);
  } else if (sort === 'oldest') {
    arr.sort((a, b) => (a.year || 9999) - (b.year || 9999) || b.score - a.score);
  } else {
    arr.sort((a, b) => b.score - a.score);
  }
  return arr;
}

function matchesFields(item, f) {
  if (!f) return true;
  const t = String(item.title || '').toLowerCase();
  const au = (item.authors || []).map((a) => a.name || a).join(' ').toLowerCase();
  const ve = String(item.venue || '').toLowerCase();
  if (f.title && !t.includes(String(f.title).toLowerCase())) return false;
  if (f.author && !au.includes(String(f.author).toLowerCase())) return false;
  if (f.venue && !ve.includes(String(f.venue).toLowerCase())) return false;
  if (f.abstract && !String(item.abstract || '').toLowerCase().includes(String(f.abstract).toLowerCase())) return false;
  return true;
}

function search(batches, opts = {}) {
  const { sort = 'relevance', oaOnly = false, page = 1, per = 20, yearFrom, yearTo, fields } = opts;
  let merged = mergeBatches(batches);
  const rawCount = batches.reduce((n, b) => n + ((b && b.items && b.items.length) || 0), 0);

  if (fields) merged = merged.filter((x) => matchesFields(x, fields));
  if (oaOnly) merged = merged.filter((x) => x.oa && x.oa.isOa);
  if (yearFrom) merged = merged.filter((x) => !x.year || x.year >= yearFrom);
  if (yearTo) merged = merged.filter((x) => !x.year || x.year <= yearTo);

  const sorted = sortItems(merged, sort);
  const start = (page - 1) * per;
  const slice = sorted.slice(start, start + per);

  return {
    items: slice,
    stats: {
      raw: rawCount,
      merged: merged.length,
      deduped: rawCount - merged.length,
      page,
      per,
      hasMore: start + per < merged.length,
    },
  };
}

module.exports = { mergeBatches, sortItems, search, matchesFields };

});
__define("cite", function (module, exports, require) {
const U = require('util');

const TYPE_MAP_GB = {
  article: 'J',
  'journal-article': 'J',
  'posted-content': 'J/OL',
  preprint: 'J/OL',
  book: 'M',
  monograph: 'M',
  'book-chapter': 'M',
  'proceedings-article': 'C',
  dissertation: 'D',
  thesis: 'D',
  report: 'R',
  dataset: 'DS',
  review: 'J',
  'peer-review': 'J',
  editorial: 'J',
  letter: 'J',
};

function gbType(t) {
  return TYPE_MAP_GB[String(t || '').toLowerCase()] || 'J';
}

/** 是否中文姓名 */
function isCjk(name) {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(name || ''));
}

/** 拆分「名 姓」 */
function parts(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return { given: '', family: '' };
  if (isCjk(n)) return { given: '', family: n };
  if (n.includes(',')) {
    const [family, given] = n.split(',');
    return { given: (given || '').trim(), family: (family || '').trim() };
  }
  const seg = n.split(' ');
  if (seg.length === 1) return { given: '', family: seg[0] };
  return { given: seg.slice(0, -1).join(' '), family: seg[seg.length - 1] };
}

function initialsSpaced(given) {
  const list = String(given || '')
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase());
  return list.join(' ');
}

function initialsDotted(given) {
  const list = String(given || '')
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`);
  return list.join(' ');
}

/* ------------------------------- GB/T 7714-2015 ------------------------------- */

function gbAuthor(a) {
  const name = typeof a === 'string' ? a : a.name;
  if (!name) return '';
  const { given, family } = parts(name);
  if (isCjk(name)) return family;
  if (!given) return family.toUpperCase();
  return `${family.toUpperCase()} ${initialsSpaced(given)}`.trim();
}

function gbAuthors(authors) {
  const list = (authors || []).map(gbAuthor).filter(Boolean);
  if (!list.length) return '';
  const cjkAny = (authors || []).some((a) => isCjk(typeof a === 'string' ? a : a.name));
  if (list.length <= 3) return list.join(', ');
  return `${list.slice(0, 3).join(', ')}, ${cjkAny ? '等' : 'et al.'}`;
}

function gbCite(p, index) {
  const t = gbType(p.type);
  const authors = gbAuthors(p.authors);
  const title = (p.title || '').replace(/\s+$/g, '').replace(/\.$/, '');
  const venue = p.venue || p.publisher || '';
  const year = p.year || '';
  const vol = p.volume || '';
  const iss = p.issue || '';
  const pages = String(p.pages || '').replace(/-/g, '-');
  let s = '';
  if (authors) s += `${authors}. `;
  s += `${title}[${t}]. `;
  if (venue) s += `${venue}`;
  if (year) s += `${venue ? ', ' : ''}${year}`;
  if (vol) s += `, ${vol}`;
  if (iss) s += `(${iss})`;
  if (pages) s += `: ${pages}`;
  s += '.';
  if (p.ids && p.ids.arxiv) s += ` arXiv:${p.ids.arxiv}.`;
  if (p.doi) s += ` DOI: ${p.doi}.`;
  const prefix = index ? `[${index}] ` : '';
  return (prefix + s).replace(/\s+/g, ' ').trim();
}

/* ---------------------------------- APA 7 ---------------------------------- */

function apaAuthor(a) {
  const name = typeof a === 'string' ? a : a.name;
  if (!name) return '';
  const { given, family } = parts(name);
  if (isCjk(name)) return family;
  const ini = initialsDotted(given);
  return ini ? `${family}, ${ini}` : family;
}

function apaAuthors(authors) {
  const list = (authors || []).map(apaAuthor).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length <= 20) return `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`;
  return `${list.slice(0, 19).join(', ')}, ... ${list[list.length - 1]}`;
}

function apaCite(p) {
  const authors = apaAuthors(p.authors);
  const year = p.year ? `(${p.year}).` : '(n.d.).';
  const title = (p.title || '').replace(/\.$/, '');
  const venue = p.venue || '';
  let src = '';
  if (venue) {
    src = venue;
    if (p.volume) src += `, ${p.volume}` + (p.issue ? `(${p.issue})` : '');
    else if (p.issue) src += `, (${p.issue})`;
    if (p.pages) src += `, ${p.pages}`;
    src += '.';
  } else if (p.pages) {
    src = `${p.pages}.`;
  }
  const doi = p.doi
    ? ` https://doi.org/${p.doi}`
    : p.links && p.links.landing
      ? ` ${p.links.landing}`
      : '';
  const head = `${authors ? authors + ' ' : ''}${year} ${title ? title + '. ' : ''}`;
  return `${head}${src}${doi}`.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------- MLA 9 ---------------------------------- */

function mlaAuthor(a) {
  const name = typeof a === 'string' ? a : a.name;
  if (!name) return '';
  const { given, family } = parts(name);
  if (isCjk(name)) return family;
  return given ? `${family}, ${given}` : family;
}

function mlaCite(p) {
  const list = (p.authors || []).map(mlaAuthor).filter(Boolean);
  let authors = '';
  if (list.length === 1) authors = list[0];
  else if (list.length === 2) authors = `${list[0]}, and ${list[1]}`;
  else if (list.length > 2) authors = `${list[0]}, et al.`;
  const title = p.title ? `"${p.title.replace(/\.$/, '')}."` : '';
  const venue = p.venue ? `${p.venue},` : '';
  const vol = p.volume ? `vol. ${p.volume},` : '';
  const iss = p.issue ? `no. ${p.issue},` : '';
  const year = p.year ? `${p.year},` : '';
  const pages = p.pages ? `pp. ${p.pages},` : '';
  const doi = p.doi ? `doi:${p.doi}.` : '';
  return [authors, title, venue, vol, iss, year, pages, doi].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/* --------------------------------- Chicago --------------------------------- */

function chicagoCite(p) {
  const list = (p.authors || []).map(mlaAuthor).filter(Boolean);
  let authors = '';
  if (list.length === 1) authors = list[0];
  else if (list.length === 2) authors = `${list[0]}, and ${list[1]}`;
  else if (list.length > 2) authors = `${list[0]} et al.`;
  const title = p.title ? `"${p.title.replace(/\.$/, '')}."` : '';
  const venue = p.venue || '';
  const vol = p.volume ? ` ${p.volume}` : '';
  const iss = p.issue ? `, no. ${p.issue}` : '';
  const year = p.year ? ` (${p.year})` : '';
  const pages = p.pages ? `: ${p.pages}` : '';
  return `${authors} ${title} ${venue}${vol}${iss}${year}${pages}.`.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------- BibTeX --------------------------------- */

function texEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function bibKey(p) {
  const first = (p.authors && p.authors[0] && (p.authors[0].name || p.authors[0])) || 'anon';
  const fam = parts(first).family || 'anon';
  const word = String(p.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .find((w) => w && !['the', 'a', 'an', 'on', 'of', 'in', 'for', 'and', 'to'].includes(w));
  return `${fam.toLowerCase().replace(/[^a-z]/g, '')}${p.year || 'nd'}${word || ''}`;
}

function bibtex(p) {
  const isJournal = ['article', 'journal-article', 'review', 'editorial', 'letter'].includes(String(p.type || '').toLowerCase());
  const isPreprint = String(p.type || '').toLowerCase() === 'preprint';
  const isBook = ['book', 'monograph'].includes(String(p.type || '').toLowerCase());
  const isChapter = String(p.type || '').toLowerCase() === 'book-chapter';
  const isConf = ['proceedings-article'].includes(String(p.type || '').toLowerCase());
  const kind = isBook ? 'book' : isChapter ? 'incollection' : isConf ? 'inproceedings' : isJournal || isPreprint ? 'article' : 'misc';
  const authors = (p.authors || []).map((a) => {
    const name = typeof a === 'string' ? a : a.name;
    const { given, family } = parts(name);
    return isCjk(name) ? name : `${family}, ${given}`.replace(/,\s*$/, '');
  }).filter(Boolean).join(' and ');

  const fields = [];
  const add = (k, v) => {
    if (v) fields.push(`  ${k} = {${v}}`);
  };
  add('title', texEscape(p.title));
  add('author', texEscape(authors));
  if (isPreprint) add('journal', `arXiv preprint arXiv:${(p.ids && p.ids.arxiv) || ''}`);
  else if (isJournal || isConf || isChapter) add(isChapter ? 'booktitle' : 'journal', texEscape(p.venue));
  else add('howpublished', texEscape(p.venue || p.publisher));
  if (isBook || isChapter) add('publisher', texEscape(p.publisher));
  add('year', p.year);
  add('volume', p.volume);
  add('number', p.issue);
  add('pages', String(p.pages || '').replace(/-/g, '--'));
  add('doi', p.doi);
  if (!p.doi && p.ids && p.ids.arxiv) add('eprint', p.ids.arxiv);
  add('language', p.language && p.language !== 'en' ? p.language : '');
  return `@${kind}{${bibKey(p)},\n${fields.join(',\n')}\n}`;
}

/* ----------------------------------- RIS ----------------------------------- */

function ris(p) {
  const ty = ['article', 'journal-article', 'review', 'editorial', 'letter'].includes(String(p.type || '').toLowerCase())
    ? 'JOUR'
    : ['book', 'monograph'].includes(String(p.type || '').toLowerCase())
      ? 'BOOK'
      : String(p.type || '').toLowerCase() === 'book-chapter'
        ? 'CHAP'
        : 'GEN';
  const lines = [`TY  - ${ty}`];
  for (const a of p.authors || []) {
    const name = typeof a === 'string' ? a : a.name;
    const { given, family } = parts(name);
    lines.push(`AU  - ${isCjk(name) ? name : `${family}, ${given}`.replace(/,\s*$/, '')}`);
  }
  if (p.title) lines.push(`TI  - ${p.title}`);
  if (p.venue) lines.push(`JO  - ${p.venue}`);
  if (p.year) lines.push(`PY  - ${p.year}`);
  if (p.volume) lines.push(`VL  - ${p.volume}`);
  if (p.issue) lines.push(`IS  - ${p.issue}`);
  const [sp, ep] = String(p.pages || '').split(/[-–]/);
  if (sp) lines.push(`SP  - ${sp}`);
  if (ep) lines.push(`EP  - ${ep}`);
  if (p.publisher) lines.push(`PB  - ${p.publisher}`);
  if (p.doi) lines.push(`DO  - ${p.doi}`);
  if (p.links && p.links.landing) lines.push(`UR  - ${p.links.landing}`);
  if (p.abstract) lines.push(`AB  - ${p.abstract}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

/* --------------------------------- EndNote -------------------------------- */

function endnote(p) {
  const lines = [`%0 ${ris(p).match(/TY  - (\w+)/)[1] === 'JOUR' ? 'Journal Article' : 'Generic'}`];
  for (const a of p.authors || []) {
    const name = typeof a === 'string' ? a : a.name;
    const { given, family } = parts(name);
    lines.push(`%A ${isCjk(name) ? name : `${family}, ${given}`.replace(/,\s*$/, '')}`);
  }
  if (p.title) lines.push(`%T ${p.title}`);
  if (p.venue) lines.push(`%J ${p.venue}`);
  if (p.year) lines.push(`%D ${p.year}`);
  if (p.volume) lines.push(`%V ${p.volume}`);
  if (p.issue) lines.push(`%N ${p.issue}`);
  if (p.pages) lines.push(`%P ${p.pages}`);
  if (p.publisher) lines.push(`%I ${p.publisher}`);
  if (p.doi) lines.push(`%R ${p.doi}`);
  if (p.links && p.links.landing) lines.push(`%U ${p.links.landing}`);
  if (p.abstract) lines.push(`%X ${p.abstract}`);
  return lines.join('\n');
}

/* ---------------------------------- 入口 ---------------------------------- */

const FORMATS = {
  gb: { label: 'GB/T 7714', fn: gbCite },
  apa: { label: 'APA 7', fn: apaCite },
  mla: { label: 'MLA 9', fn: mlaCite },
  chicago: { label: 'Chicago', fn: chicagoCite },
  bibtex: { label: 'BibTeX', fn: bibtex },
  ris: { label: 'RIS', fn: ris },
  endnote: { label: 'EndNote', fn: endnote },
};

function formatPaper(p, fmt, index) {
  const f = FORMATS[fmt] || FORMATS.gb;
  return f.fn(p, index);
}

function formatList(papers, fmt) {
  const list = papers || [];
  if (fmt === 'bibtex') return list.map(bibtex).join('\n\n');
  if (fmt === 'ris') return list.map(ris).join('\n\n');
  if (fmt === 'endnote') return list.map(endnote).join('\n\n');
  return list.map((p, i) => formatPaper(p, fmt, i + 1)).join('\n');
}

module.exports = { FORMATS, formatPaper, formatList, gbCite, apaCite, bibtex, ris, parts };

});
__define("insight", function (module, exports, require) {
/**
 * 机器速读：只根据题录与摘要做规则的「结构化解读」。
 * 不调用任何大模型，不臆造结论；信息不足时如实标注。
 */

const METHOD_RULES = [
  ['问卷/量表', /\b(questionnaire|survey|likert|scale|inventory)\b/i],
  ['实验/准实验', /\b(experiment|experimental|randomi[sz]ed|control group|treatment group|quasi-experimental|pre-?test|post-?test)\b/i],
  ['访谈/质性', /\b(interview|focus group|qualitative|thematic analysis|narrative|ethnograph)/i],
  ['语料库/文本分析', /\b(corpus|corpora|text analysis|computational|natural language processing|nlp|machine learning|automated)/i],
  ['纵向追踪', /\b(longitudinal|over (a|one|two|three|four|five) (semester|year|weeks|months)|time[- ]series)\b/i],
  ['混合方法', /\b(mixed[- ]method)/i],
  ['元分析', /\b(meta[- ]analys)/i],
  ['课堂干预', /\b(intervention|instructional|pedagogical|teaching experiment|curriculum)\b/i],
  ['眼动/认知测量', /\b(eye[- ]tracking|reaction time|cognitive load|working memory)\b/i],
];

const REVIEW_RE = /\b(systematic review|literature review|narrative review|scoping review|this review|we review|review of (the )?literature|synthesi[sz]|state of the art)\b/i;
const EMPIRICAL_RE = /\b(participants|sample|subjects|respondents|dataset|data set|data (were|was)|experiment|survey|questionnaire|interview|quasi-experimental|control group|case study|corpus|essays|texts|longitudinal|empirical|this (study|paper|article|research) (addresses|aims|sets|examines|investigates|explores|analy[sz]es|reports|presents|draws|uses|employs|tests|compares|evaluates)|the present (study|paper)|we (examine|investigate|analy[sz]e|report|test|compare|explore)|results (show|indicate|suggest|reveal|demonstrate)|findings (show|indicate|suggest|reveal)|were (analy[sz]ed|collected|administered|rated|scored)|analys[ie]s|regression|scores)\b/i;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectKind(p) {
  const t = String(p.type || '').toLowerCase();
  const title = norm(p.title);
  if (t === 'preprint') return '预印本';
  if (t === 'dissertation' || t === 'thesis') return '学位论文';
  if (t === 'book' || t === 'monograph') return '专著';
  if (t === 'book-chapter') return '专著章节';
  if (t === 'proceedings-article') return '会议论文';
  if (REVIEW_RE.test(title)) return '综述';
  if (t === 'review') return '综述';
  return '期刊论文';
}

function detectApproach(text, hasAbstract) {
  if (REVIEW_RE.test(text)) return '综述性';
  if (EMPIRICAL_RE.test(text)) return '实证研究';
  if (!hasAbstract) return '待判断';
  return '理论/观点';
}

function detectMethods(text) {
  const out = [];
  for (const [label, re] of METHOD_RULES) {
    if (re.test(text)) out.push(label);
  }
  // 元分析本身是综述方法，避免和「实验」并列太多
  return out.slice(0, 4);
}

function detectSample(text) {
  let m = text.match(/\bn\s*=\s*(\d{2,5})\b/i);
  if (m) return `${m[1]} 人/单位`;
  m = text.match(/\b(\d{2,5})\s+(?:students|participants|learners|subjects|undergraduates|postgraduates|teachers|respondents|papers|articles|studies|essays|texts)\b/i);
  if (m) return `${m[1]} 例`;
  m = text.match(/\b(\d{2,5})\s*(?:participants|students)\b/i);
  if (m) return `${m[1]} 例`;
  return '';
}

function buildReadTip(p, kind) {
  const cited = p.cited || 0;
  const year = p.year || 0;
  const now = new Date().getFullYear();
  const oa = !!(p.oa && p.oa.isOa);
  const tips = [];

  if (kind === '预印本') {
    tips.push('预印本，未完成正式同行评审，引用时注明版本与日期。');
  } else if (oa) {
    tips.push('有开放获取全文，建议先看 Methods 与 Findings，再回看 Discussion 的局限部分。');
  } else {
    tips.push('暂无免费全文，先用摘要判断相关性，值得再走文献传递或向作者索取。');
  }

  if (cited >= 200) tips.push(`被引 ${cited} 次，是该主题的常引文献，适合作为理论或方法的支撑。`);
  else if (cited >= 50) tips.push(`被引 ${cited} 次，引用量中等偏上，可作方法参照。`);
  else if (cited >= 10) tips.push(`被引 ${cited} 次，可作为同方向的对照研究。`);
  else if (year && now - year <= 2) tips.push('发表很新、引用还少，适合放在「研究现状」末尾说明前沿。');

  if (p.retracted) tips.push('⚠ 该文被标记为已撤稿，不要引用。');
  return tips.join(' ');
}

function buildUseTip(approach, kind, methods) {
  if (kind === '综述') {
    return '可直接作为文献综述的骨架：先看它的分类框架，再顺着参考文献找原始研究。';
  }
  if (kind === '预印本') {
    return '可作为最新进展的线索，但正式引用前建议核对期刊最终版。';
  }
  if (approach === '实证研究') {
    const m = methods.length ? `它用的是「${methods[0]}」这条路` : '它给了具体的研究设计';
    return `${m}，重点看研究设计能否迁移到你的对象：样本、工具、评分标准都能作方法学参照。`;
  }
  if (approach === '综述性') {
    return '综述类，适合放在概念界定或研究脉络梳理处，用来支撑「为什么这个题目值得研究」。';
  }
  return '偏理论/观点，适合放在概念界定或理论框架部分，引用时注意区分主张与证据。';
}

function buildInsight(p) {
  const abstract = String(p.abstract || '');
  const text = `${p.title || ''} ${abstract}`;
  const kind = detectKind(p);
  const hasAbstract = abstract.trim().length > 80;
  const approach = detectApproach(text, hasAbstract);
  const methods = detectMethods(abstract || text);
  const sample = detectSample(abstract || '');

  const topics = (p.topics || []).filter(Boolean).slice(0, 3);

  return {
    auto: true,
    kind,
    approach,
    methods,
    sample,
    topics,
    readTip: buildReadTip(p, kind),
    useTip: buildUseTip(approach, kind, methods),
    confidence: hasAbstract ? 'high' : 'meta',
    summary: [
      kind,
      approach !== '待判断' ? approach : '',
      methods.length ? methods.join(' / ') : '',
      sample ? `样本 ${sample}` : '',
    ].filter(Boolean).join(' · '),
  };
}

module.exports = { buildInsight };

});
__define("access", function (module, exports, require) {
/**
 * 可达性判定：这篇论文的「出版社页面」在墙内能不能打开。
 * 依据是 2026-11 实测的域名清单 + DOI 前缀归属。
 * 注意：判定的是「出版社站点」，不是「有没有全文」——
 * 很多被墙的论文在机构仓储里有开放副本，那才是重点。
 */

const BLOCKED_HOSTS = [
  'tandfonline.com',
  'sagepub.com',
  'journals.sagepub.com',
  'emerald.com',
  'emeraldinsight.com',
  'onlinelibrary.wiley.com',
  'wiley.com',
  'sciencedirect.com',
  'elsevier.com',
  'researchgate.net',
  'academia.edu',
  'brill.com',
  'cambridge.org',
  'taylorandfrancis.com',
];

// 实测可直连（用于「墙内可开」的正向判断）
const OPEN_HOSTS = [
  'jstor.org',
  'muse.jhu.edu',
  'degruyter.com',
  'intellectbooks.com',
  'intellectdiscover.com',
  'springeropen.com',
  'link.springer.com',
  'nature.com',
  'plos.org',
  'frontiersin.org',
  'mdpi.com',
  'arxiv.org',
  'ncbi.nlm.nih.gov',
  'europepmc.org',
  'doaj.org',
  'core.ac.uk',
  'zenodo.org',
  'ssrn.com',
  'eric.ed.gov',
  'files.eric.ed.gov',
  'journal.transformativeworks.org',
  'scilit.net',
]; 

const DOI_PUBLISHERS = [
  ['10.1080', 'Taylor & Francis'],
  ['10.4324', 'Routledge（T&F）'],
  ['10.1201', 'CRC（T&F）'],
  ['10.1177', 'SAGE'],
  ['10.1111', 'Wiley'],
  ['10.1002', 'Wiley'],
  ['10.1016', 'Elsevier'],
  ['10.1108', 'Emerald'],
  ['10.1057', 'Palgrave Macmillan'],
  ['10.4135', 'SAGE'],
];

const OPEN_PUBLISHER_HINTS = ['intellect', 'de gruyter', 'jstor', 'project muse', 'muse', 'springer', 'zenodo', 'cîrcle', 'circle'];

const PUBLISHER_HINTS = [
  ['taylor', 'Taylor & Francis'],
  ['routledge', 'Routledge（T&F）'],
  ['sage', 'SAGE'],
  ['wiley', 'Wiley'],
  ['elsevier', 'Elsevier'],
  ['emerald', 'Emerald'],
  ['brill', 'Brill'],
  ['cambridge university press', 'Cambridge UP'],
];

/* 机构仓储常见特征（域名里带这些词的一般都可直连） */
const OPEN_PATTERNS = [
  'dspace', 'repositor', 'digitalcommons', 'eprints', 'openrepository',
  'figshare', 'hal.science', 'diva-portal', 'researchgate.net'.slice(0, 0),
];

function hostOf(u) {
  if (!u) return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function matchList(host, list) {
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith('.' + d));
}

function matchPattern(host) {
  if (!host) return false;
  return OPEN_PATTERNS.some((p) => p && host.includes(p));
}

function isBlockedHost(host) {
  if (!host) return false;
  if (isOpenHost(host)) return false;
  return matchList(host, BLOCKED_HOSTS);
}

function isOpenHost(host) {
  return matchList(host, OPEN_HOSTS) || matchPattern(host);
}

function publisherFromDoi(doi) {
  const d = String(doi || '');
  for (const [prefix, name] of DOI_PUBLISHERS) {
    if (d.startsWith(prefix)) return name;
  }
  return '';
}

function publisherHint(name) {
  const n = String(name || '').toLowerCase();
  for (const [needle, label] of PUBLISHER_HINTS) {
    if (n.includes(needle)) return label;
  }
  return '';
}

/**
 * 返回 { wall, label, via }
 *   wall:
 *     'open'    墙内就能打开全文（有开放副本且在可直连域名）
 *     'blocked' 出版社站点在墙外
 *     'closed'  站点能打开，但要订阅
 *     'unknown' 判断不了
 */
function classify(p) {
  const pdfs = []
    .concat((p.links && p.links.pdf) || [])
    .concat((p.oa && p.oa.urls) || [])
    .filter(Boolean);

  // 1) 有开放副本，且托管在可直连域名 → 墙内就能下
  for (const u of pdfs) {
    const h = hostOf(u);
    if (!h) continue;
    if (!isBlockedHost(h) && !matchList(h, [])) {
      return {
        wall: 'open',
        label: '墙内可下',
        via: h,
        note: `开放副本在 ${h}，国内可直连`,
      };
    }
  }

  // 2) 落在被墙的出版社域名
  const hosts = [hostOf(p.links && p.links.landing)].concat(pdfs.map(hostOf)).filter(Boolean);
  for (const h of hosts) {
    if (isBlockedHost(h)) {
      return {
        wall: 'blocked',
        label: '墙外站点',
        via: h,
        note: `${h} 在国内被防火墙阻断，页面打不开`,
      };
    }
  }

  // 2.5) 标了开放获取、又没落在被墙域名 → 墙内能开
  if (p.oa && p.oa.isOa) {
    const h = hosts[0] || '';
    const pubOpen = OPEN_PUBLISHER_HINTS.some((k) => String(p.publisher || '').toLowerCase().includes(k) || String(p.venue || '').toLowerCase().includes(k));
    if (!h || pubOpen || (p.oa.urls || []).length) {
      return { wall: 'open', label: '墙内可下', via: h || '开放获取', note: '开放获取，链接不在被墙域名' };
    }
  }

  // 3) 用 DOI 前缀 / 出版社名兜底（DOI 解析后多半跳到被墙域名）
  const pubOpenHint = OPEN_PUBLISHER_HINTS.filter((k) => (String(p.publisher || '') + ' ' + String(p.venue || '')).toLowerCase().includes(k));
  if (pubOpenHint.length && !hosts.some(isBlockedHost)) {
    return { wall: 'closed', label: '可直连', via: p.publisher || p.venue || '', note: `${p.publisher || p.venue} 国内可直连（可能需要订阅）` };
  }
  const pub = publisherFromDoi(p.doi) || publisherHint(p.publisher) || publisherHint(p.venue);
  if (pub) {
    return {
      wall: 'blocked',
      label: '墙外站点',
      via: pub,
      note: `DOI 解析到 ${pub}，其站点在国内被阻断`,
    };
  }

  // 4) 已知可直连域名 / 出版社
  for (const h of hosts) {
    if (isOpenHost(h)) {
      return { wall: 'closed', label: '可直连', via: h, note: `${h} 国内可直连，但可能需要订阅` };
    }
  }
  if (OPEN_PUBLISHER_HINTS.some((k) => String(p.publisher || '').toLowerCase().includes(k))) {
    return { wall: 'closed', label: '可直连', via: p.publisher || '', note: `${p.publisher} 国内可直连` };
  }

  return { wall: 'unknown', label: '', via: '', note: '' };
}

module.exports = { classify, isBlockedHost, isOpenHost, hostOf, BLOCKED_HOSTS, OPEN_HOSTS, DOI_PUBLISHERS };

});
  window.PF = {
    util: __require('util'),
    merge: __require('merge'),
    cite: __require('cite'),
    insight: __require('insight'),
    access: __require('access'),
  };
})();