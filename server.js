const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const querystring = require('querystring');
const iconv = require('iconv-lite');
const crypto = require('crypto');

// Encode a string to GBK URL-encoded format (for Discuz forum search)
function gbkUrlEncode(str) {
  const gbkBuf = iconv.encode(str, 'gbk');
  let result = '';
  for (const byte of gbkBuf) {
    if ((byte >= 0x30 && byte <= 0x39) || // 0-9
        (byte >= 0x41 && byte <= 0x5A) || // A-Z
        (byte >= 0x61 && byte <= 0x7A) || // a-z
        byte === 0x2D || byte === 0x2E || byte === 0x5F || byte === 0x7E) { // -._~
      result += String.fromCharCode(byte);
    } else {
      result += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return result;
}

const PORT = process.env.PORT || 3456;
const CSRC_HOST = '219.141.221.17';
const CSRC_HOSTNAME = 'neris.csrc.gov.cn';
const CNINFO_HOST = '118.112.231.185';
const CNINFO_HOSTNAME = 'www.cninfo.com.cn';
const CNINFO_STATIC_HOST = '118.112.231.185';
const CNINFO_STATIC_HOSTNAME = 'static.cninfo.com.cn';
const ESNAI_HOST = '101.91.176.95';
const ESNAI_HOSTNAME = 'www.esnai.cn';
const ESNAI_BBS_HOSTNAME = 'bbs.esnai.cn';

// MIME types for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===== 用户认证模块 =====
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadJSON(file, def) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : def; } catch(e) { return def; } }
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); }
function hashPwd(pw) { return crypto.createHash('sha256').update(pw + 'cwrch-salt-2026').digest('hex'); }
function newToken() { return crypto.randomUUID(); }
function getCookie(req, name) {
  return (req.headers.cookie || '').split(';').reduce((r, c) => {
    const [k, ...v] = c.trim().split('='); if (k && v.length) r[k] = v.join('='); return r;
  }, {})[name] || null;
}
function checkAuth(req) { const t = getCookie(req, 'token'); return t ? (loadJSON(SESSIONS_FILE, {})[t] || null) : null; }

async function parseBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve(Object.fromEntries(new URLSearchParams(b))); }
    });
  });
}

function sendJSON(res, code, data, extraHeaders) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders||{}) };
  res.writeHead(code, h); res.end(JSON.stringify(data));
}

function handleRegister(req, res) {
  parseBody(req).then(b => {
    const { email, password, name } = b;
    if (!email || !password) return sendJSON(res, 400, { error: '邮箱和密码不能为空' });
    if (password.length < 6) return sendJSON(res, 400, { error: '密码至少6位' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJSON(res, 400, { error: '邮箱格式不正确' });
    const users = loadJSON(USERS_FILE, {});
    if (users[email]) return sendJSON(res, 409, { error: '该邮箱已注册' });
    users[email] = { email, password: hashPwd(password), name: name || email.split('@')[0], createdAt: Date.now() };
    saveJSON(USERS_FILE, users);
    const token = newToken();
    const sessions = loadJSON(SESSIONS_FILE, {});
    sessions[token] = { email, name: users[email].name, createdAt: Date.now() };
    saveJSON(SESSIONS_FILE, sessions);
    sendJSON(res, 201, { ok: true, name: users[email].name }, { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}` });
  });
}

function handleLogin(req, res) {
  parseBody(req).then(b => {
    const { email, password } = b;
    const users = loadJSON(USERS_FILE, {});
    if (!users[email] || users[email].password !== hashPwd(password)) return sendJSON(res, 401, { error: '邮箱或密码错误' });
    const token = newToken();
    const sessions = loadJSON(SESSIONS_FILE, {});
    sessions[token] = { email, name: users[email].name, createdAt: Date.now() };
    saveJSON(SESSIONS_FILE, sessions);
    sendJSON(res, 200, { ok: true, name: users[email].name }, { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}` });
  });
}

function handleLogout(req, res) {
  const token = getCookie(req, 'token');
  if (token) { const s = loadJSON(SESSIONS_FILE, {}); delete s[token]; saveJSON(SESSIONS_FILE, s); }
  sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
}

function handleSession(req, res) {
  const user = checkAuth(req);
  sendJSON(res, 200, user ? { loggedIn: true, email: user.email, name: user.name } : { loggedIn: false });
}

// Serve static files
function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// Proxy search request to CSRC API
function proxySearch(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const params = querystring.parse(body);
    const postData = querystring.stringify(params);

    const options = {
      hostname: CSRC_HOST,
      path: '/falvfagui/multipleFindController/solrSearch',
      method: 'POST',
      headers: {
        'Host': CSRC_HOSTNAME,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://neris.csrc.gov.cn/falvfagui/multipleFindController/indexJsp',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      rejectUnauthorized: false,
    };

    console.log(`[Search] Query: ${params.secFutrsLawName || '(empty)'}, page: ${params.pageNo || 1}`);

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });

    proxyReq.on('error', e => {
      console.error('Proxy error:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ success: false, msg: '代理请求失败: ' + e.message }));
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
}

// Proxy law detail request
function proxyDetail(req, res) {
  const query = url.parse(req.url, true).query;
  const detailPath = '/falvfagui/rdqsHeader/mainbody?' + querystring.stringify(query);

  const options = {
      hostname: CSRC_HOST,
      path: detailPath,
      method: 'GET',
      headers: {
        'Host': CSRC_HOSTNAME,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://neris.csrc.gov.cn/falvfagui/multipleFindController/indexJsp',
    },
    rejectUnauthorized: false,
  };

  console.log(`[Detail] ID: ${query.secFutrsLawId}`);

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });

  proxyReq.on('error', e => {
    res.writeHead(502);
    res.end('代理请求失败');
  });
  proxyReq.end();
}

// Proxy autocomplete (hint) request
function proxyHint(req, res) {
  const query = url.parse(req.url, true).query;
  const hintPath = '/falvfagui/multipleFindController/searchClue?' + querystring.stringify(query);

  const options = {
      hostname: CSRC_HOST,
      path: hintPath,
      method: 'GET',
      headers: {
        'Host': CSRC_HOSTNAME,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://neris.csrc.gov.cn/falvfagui/multipleFindController/indexJsp',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    rejectUnauthorized: false,
  };

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });

  proxyReq.on('error', e => {
    res.writeHead(502);
    res.end('[]');
  });
  proxyReq.end();
}

// --- CNINFO (巨潮资讯网) proxy functions ---

// POST proxy helper for cninfo
function cninfoPost(apiPath, params, req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const mergedParams = { ...querystring.parse(body), ...params };
    // cninfo requires plate to be non-empty; default to all markets if not set
    if (!mergedParams.plate) mergedParams.plate = 'sz;sh;bj';
    const postData = querystring.stringify(mergedParams);

    const options = {
      hostname: CNINFO_HOST,
      path: apiPath,
      method: 'POST',
      servername: CNINFO_HOSTNAME,
      headers: {
        'Host': CNINFO_HOSTNAME,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      rejectUnauthorized: false,
    };

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });

    proxyReq.on('error', e => {
      console.error('Cninfo proxy error:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
}

// GET proxy helper for cninfo
function cninfoGet(apiPath, req, res) {
  const options = {
    hostname: CNINFO_HOST,
    path: apiPath,
    method: 'GET',
    servername: CNINFO_HOSTNAME,
    headers: {
      'Host': CNINFO_HOSTNAME,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.cninfo.com.cn/',
      'Accept': 'application/json',
    },
    rejectUnauthorized: false,
  };

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });

  proxyReq.on('error', e => {
    console.error('Cninfo GET error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  proxyReq.end();
}

// --- CNINFO Full-text Search ---

// Fetch and parse PDF content from static.cninfo.com.cn
function fetchPdfContent(adjunctUrl) {
  return new Promise((resolve) => {
    if (!adjunctUrl || !adjunctUrl.endsWith('.PDF')) {
      resolve(null);
      return;
    }
    const pdfPath = '/' + adjunctUrl;
    const options = {
      hostname: CNINFO_STATIC_HOST,
      path: pdfPath,
      method: 'GET',
      servername: CNINFO_STATIC_HOSTNAME,
      headers: {
        'Host': CNINFO_STATIC_HOSTNAME,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://www.cninfo.com.cn/',
      },
      rejectUnauthorized: false,
    };

    const proxyReq = https.request(options, proxyRes => {
      if (proxyRes.statusCode !== 200) {
        resolve(null);
        return;
      }
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        try {
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          resolve({
            text: result.text || '',
            pages: result.totalPages || result.numpages || 1,
            size: buffer.length,
          });
        } catch (e) {
          console.error('[CninfoPDF] Parse error:', e.message);
          resolve(null);
        }
      });
    });

    proxyReq.on('error', e => {
      console.error('[CninfoPDF] Download error:', e.message);
      resolve(null);
    });
    proxyReq.end();
  });
}

// Batch fetch PDF content for search results with concurrency control
async function batchFetchPdfContent(announcements, batchSize = 5, maxItems = 5) {
  const items = announcements.slice(0, maxItems);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (a) => {
      const pdfData = await fetchPdfContent(a.adjunctUrl);
      return {
        announcementId: a.announcementId,
        fullText: pdfData ? pdfData.text : null,
        pdfPages: pdfData ? pdfData.pages : 0,
      };
    }));
    for (const br of batchResults) {
      const ann = announcements.find(a => a.announcementId === br.announcementId);
      if (ann) {
        ann.fullText = br.fullText;
        ann.pdfPages = br.pdfPages;
      }
    }
  }
}

// Proxy fulltext search request to cninfo
async function cninfoFulltextSearch(req, res) {
  const query = url.parse(req.url, true).query;
  const searchkey = query.searchkey || '';
  const pageNum = query.pageNum || '1';
  const stock = query.stock || '';
  const sdate = query.sdate || '';
  const edate = query.edate || '';
  const category = query.category || '';  // 公告类型
  const isfulltext = query.isfulltext || 'true';  // 全文/标题切换

  const params = new URLSearchParams();
  params.set('searchkey', searchkey);
  params.set('sdate', sdate);
  params.set('edate', edate);
  params.set('isfulltext', isfulltext);
  params.set('sortName', 'nothing');
  params.set('sortType', 'desc');
  params.set('pageNum', pageNum);
  if (stock) params.set('stock', stock);
  if (category) params.set('column', category);

  const apiPath = '/new/fulltextSearch/full?' + params.toString();

  const options = {
    hostname: CNINFO_HOST,
    path: apiPath,
    method: 'GET',
    servername: CNINFO_HOSTNAME,
    headers: {
      'Host': CNINFO_HOSTNAME,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Referer': 'https://www.cninfo.com.cn/new/fulltextSearch',
      'X-Requested-With': 'XMLHttpRequest',
    },
    rejectUnauthorized: false,
  };

  console.log(`[CninfoFulltext] keyword="${searchkey}" stock="${stock}" page=${pageNum} isft=${isfulltext} cat=${category}`);

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', async () => {
      try {
        const parsed = JSON.parse(data);
        // Batch fetch PDF full text for top results (inline display like esnai)
        if (parsed.announcements && parsed.announcements.length > 0) {
          console.log(`[CninfoFulltext] Fetching PDF content for ${Math.min(5, parsed.announcements.length)} results...`);
          await batchFetchPdfContent(parsed.announcements, 5, 5);
          console.log('[CninfoFulltext] Done fetching PDF content');
        }
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(parsed));
      } catch (e) {
        // If parsing fails, return raw data
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      }
    });
  });

  proxyReq.on('error', e => {
    console.error('Cninfo fulltext error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  proxyReq.end();
}

// Fetch HTML5 announcement content from dataclouds.cninfo.com.cn
function cninfoHtml5Content(req, res) {
  const query = url.parse(req.url, true).query;
  const htmlUrl = query.url || '';

  if (!htmlUrl || !htmlUrl.includes('cninfo.com.cn')) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  // Parse the URL to get the path
  const urlObj = url.parse(htmlUrl);
  const htmlPath = urlObj.pathname;

  const options = {
    hostname: CNINFO_STATIC_HOST,
    path: htmlPath,
    method: 'GET',
    servername: CNINFO_DATACLOUDS_HOSTNAME,
    headers: {
      'Host': CNINFO_DATACLOUDS_HOSTNAME,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://www.cninfo.com.cn/',
    },
    rejectUnauthorized: false,
  };

  console.log(`[CninfoHtml5] path=${htmlPath}`);

  const proxyReq = https.request(options, proxyRes => {
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      const html = raw.toString('utf-8');

      // Extract text content from the HTML5 page
      // The HTML5 pages have structured content with .page divs containing tables
      let title = '';
      const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();

      // Extract all text from .pa (page content) divs
      let content = '';
      const pageRegex = /<div class="pa"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="pa"|<div class="page"|$)/g;
      let pageMatch;
      let pages = [];
      while ((pageMatch = pageRegex.exec(html)) !== null) {
        let pageHtml = pageMatch[1];
        // Remove scripts and styles
        pageHtml = pageHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
        pageHtml = pageHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
        // Convert to text
        let text = pageHtml
          .replace(/<br\s*\/?>/g, '\n')
          .replace(/<\/p>/g, '\n')
          .replace(/<\/tr>/g, '\n')
          .replace(/<\/td>/g, '\t')
          .replace(/<\/th>/g, '\t')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#\d+;/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (text.length > 10) {
          pages.push(text);
        }
      }

      // If no .pa divs found, try extracting from table cells
      if (pages.length === 0) {
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let tdMatch;
        const texts = [];
        while ((tdMatch = tdRegex.exec(html)) !== null) {
          let text = tdMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .trim();
          if (text.length > 2) texts.push(text);
        }
        content = texts.join('\n');
      } else {
        content = pages.join('\n\n--- Page Break ---\n\n');
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        title,
        content,
        pages: pages.length,
        rawSize: raw.length,
      }));
    });
  });

  proxyReq.on('error', e => {
    console.error('Cninfo HTML5 error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  proxyReq.end();
}

// --- ESNAI (中国会计视野) proxy functions ---

// ESNAI session cookies for authenticated access
let esnaiCookies = {};
let esnaiLoggedIn = false;
let esnaiLoginRetryTime = 0;

// ESNAI credentials (auto-login so end users don't need to)
const ESNAI_USERNAME = '李华2013';
const ESNAI_PASSWORD = 'Lihua2013.';
// GBK encoding of 李华2013 = C0 EE BB AA 32 30 31 33
const ESNAI_USERNAME_GBK = '%C0%EE%BB%AA2013';

function getEsnaiCookieString() {
  return Object.entries(esnaiCookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseEsnaiSetCookies(headers) {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return;
  for (const sc of (Array.isArray(setCookies) ? setCookies : [setCookies])) {
    const match = sc.match(/^([^=]+)=([^;]*)/);
    if (match) {
      const name = match[1].trim();
      const value = match[2].trim();
      if (value === 'deleted' || value === '') {
        delete esnaiCookies[name];
      } else {
        esnaiCookies[name] = value;
      }
    }
  }
}

// Login to esnai forum (Discuz X3.4)
function esnaiLogin() {
  return new Promise((resolve) => {
    const loginPagePath = '/member.php?mod=logging&action=login';

    // Step 1: Fetch login page to get formhash + loginhash
    const pageOptions = {
      hostname: ESNAI_HOST,
      path: loginPagePath,
      method: 'GET',
      servername: ESNAI_HOSTNAME,
      headers: {
        'Host': ESNAI_BBS_HOSTNAME,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://bbs.esnai.cn/',
      },
      rejectUnauthorized: false,
    };

    if (Object.keys(esnaiCookies).length > 0) {
      pageOptions.headers['Cookie'] = getEsnaiCookieString();
    }

    const pageReq = https.request(pageOptions, (pageRes) => {
      parseEsnaiSetCookies(pageRes.headers);
      const chunks = [];
      pageRes.on('data', c => chunks.push(c));
      pageRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        let html;
        try { html = new TextDecoder('gbk').decode(raw); }
        catch(e) { html = raw.toString('utf-8'); }

        // Extract formhash and loginhash
        const fhMatch = html.match(/name="formhash"\s+value="([a-f0-9]+)"/);
        const lhMatch = html.match(/loginhash=(\w+)/);
        const formhash = fhMatch ? fhMatch[1] : '';
        const loginhash = lhMatch ? lhMatch[1] : '';

        if (!formhash) {
          console.error('[EsnaiLogin] Failed to get formhash');
          resolve(false);
          return;
        }

        // Step 2: POST login credentials
        const postData = `formhash=${formhash}&referer=${encodeURIComponent('https://bbs.esnai.cn/')}&loginfield=username&username=${ESNAI_USERNAME_GBK}&password=${ESNAI_PASSWORD}&questionid=0&answer=&cookietime=2592000`;

        const loginOptions = {
          hostname: ESNAI_HOST,
          path: `/member.php?mod=logging&action=login&loginsubmit=yes&loginhash=${loginhash}`,
          method: 'POST',
          servername: ESNAI_HOSTNAME,
          headers: {
            'Host': ESNAI_BBS_HOSTNAME,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Referer': `https://bbs.esnai.cn/member.php?mod=logging&action=login`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
          rejectUnauthorized: false,
        };

        if (Object.keys(esnaiCookies).length > 0) {
          loginOptions.headers['Cookie'] = getEsnaiCookieString();
        }

        const loginReq = https.request(loginOptions, (loginRes) => {
          parseEsnaiSetCookies(loginRes.headers);
          const loginChunks = [];
          loginRes.on('data', c => loginChunks.push(c));
          loginRes.on('end', () => {
            const loginRaw = Buffer.concat(loginChunks);
            let loginHtml;
            try { loginHtml = new TextDecoder('gbk').decode(loginRaw); }
            catch(e) { loginHtml = loginRaw.toString('utf-8'); }

            // Check for success
            const hasAuth = !!esnaiCookies['WINS_8799_auth'] || loginHtml.includes('succeedhandle') || loginHtml.includes('欢迎您回来');
            const isLocked = loginHtml.includes('密码错误次数过多') || loginHtml.includes('15 分钟');

            if (hasAuth) {
              esnaiLoggedIn = true;
              console.log('[EsnaiLogin] ✅ Login successful');
              resolve(true);
            } else if (isLocked) {
              esnaiLoggedIn = false;
              esnaiLoginRetryTime = Date.now() + 16 * 60 * 1000; // retry in 16 minutes
              console.log('[EsnaiLogin] ⏳ Account locked, will retry in 15 min');
              resolve(false);
            } else {
              esnaiLoggedIn = false;
              esnaiLoginRetryTime = Date.now() + 60 * 1000; // retry in 1 min
              console.log('[EsnaiLogin] ❌ Login failed, will use fallback search');
              resolve(false);
            }
          });
        });

        loginReq.on('error', (e) => {
          console.error('[EsnaiLogin] POST error:', e.message);
          resolve(false);
        });

        loginReq.write(postData);
        loginReq.end();
      });
    });

    pageReq.on('error', (e) => {
      console.error('[EsnaiLogin] GET error:', e.message);
      resolve(false);
    });

    pageReq.end();
  });
}

// Fetch a page from esnai (GBK for bbs, UTF-8 for www), with cookie support and redirect following
function esnaiFetch(pathname, useBBS, callback, _redirectCount) {
  const redirects = _redirectCount || 0;
  if (redirects > 5) {
    callback('Too many redirects', null, 0);
    return;
  }

  const hostHeader = useBBS ? ESNAI_BBS_HOSTNAME : ESNAI_HOSTNAME;

  const options = {
    hostname: ESNAI_HOST,
    path: pathname,
    method: 'GET',
    servername: ESNAI_HOSTNAME,
    headers: {
      'Host': hostHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': useBBS ? 'https://bbs.esnai.cn/' : 'https://www.esnai.cn/',
    },
    rejectUnauthorized: false,
  };

  // Include session cookies for authenticated access
  if (useBBS && Object.keys(esnaiCookies).length > 0) {
    options.headers['Cookie'] = getEsnaiCookieString();
  }

  const proxyReq = https.request(options, proxyRes => {
    parseEsnaiSetCookies(proxyRes.headers);

    // Follow 301/302 redirects
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      let loc = proxyRes.headers.location;
      // Ensure path starts with /
      if (loc.startsWith('http://') || loc.startsWith('https://')) {
        // Extract path from full URL
        loc = loc.replace(/^https?:\/\/[^/]+/, '');
      }
      if (!loc.startsWith('/')) {
        loc = '/' + loc;
      }
      // Consume the response body
      proxyRes.on('data', () => {});
      proxyRes.on('end', () => {
        esnaiFetch(loc, useBBS, callback, redirects + 1);
      });
      return;
    }

    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      let decoded;
      if (useBBS) {
        // GBK encoding for forum pages
        try {
          decoded = new TextDecoder('gbk').decode(raw);
        } catch (e) {
          decoded = raw.toString('utf-8');
        }
      } else {
        decoded = raw.toString('utf-8');
      }
      callback(null, decoded, proxyRes.statusCode);
    });
  });

  proxyReq.on('error', e => {
    callback(e.message, null, 0);
  });

  proxyReq.end();
}

// Parse forum thread list from Discuz HTML
function parseForumThreads(html) {
  const threads = [];
  // Match tbody blocks with normalthread or stickthread IDs
  const threadRegex = /<tbody id="(?:normal|stick)thread_(\d+)"[^>]*>([\s\S]*?)<\/tbody>/g;
  let match;
  while ((match = threadRegex.exec(html)) !== null) {
    const tid = match[1];
    const content = match[2];

    // Extract title
    let titleMatch = content.match(/<a[^>]*href="thread-\d+-\d+-\d+\.html"[^>]*class="s xst"[^>]*>([^<]+)/);
    if (!titleMatch) {
      titleMatch = content.match(/<a[^>]*href="thread-\d+-\d+-\d+\.html"[^>]*>([^<]+)/);
    }
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Extract author
    let authorMatch = content.match(/<a[^>]*href="space-uid-\d+\.html"[^>]*title="([^"]+)"/);
    if (!authorMatch) {
      authorMatch = content.match(/<a[^>]*href="space-uid-\d+\.html"[^>]*>([^<]+)/);
    }
    const author = authorMatch ? authorMatch[1].trim() : '';

    // Extract date
    let dateMatch = content.match(/<em[^>]*><a[^>]*>(\d{4}-\d{1,2}-\d{1,2})/);
    if (!dateMatch) {
      dateMatch = content.match(/<em[^>]*>(\d{4}-\d{1,2}-\d{1,2})/);
    }
    if (!dateMatch) {
      dateMatch = content.match(/<span[^>]*title="(\d{4}-\d{1,2}-\d{1,2}[^"]*)"/);
    }
    const date = dateMatch ? dateMatch[1].trim() : '';

    // Extract reply and view counts
    const replyMatch = content.match(/<a[^>]*class="xi2"[^>]*>(\d+)<\/a>/);
    const replies = replyMatch ? parseInt(replyMatch[1]) : 0;
    const viewMatch = content.match(/<em[^>]*>(\d+)<\/em>/);
    const views = viewMatch ? parseInt(viewMatch[1]) : 0;

    // Check if sticky
    const isSticky = content.includes('stickthread') || content.includes('置顶');

    if (title) {
      threads.push({
        tid,
        title,
        author,
        date,
        replies,
        views,
        isSticky,
        url: `https://bbs.esnai.cn/thread-${tid}-1-1.html`,
      });
    }
  }

  // Extract total pages
  let totalPages = 1;
  const pageMatch = html.match(/<span[^>]*title="\d+ 页[^"]*"[^>]*>(\d+)<\/span>/);
  if (pageMatch) {
    totalPages = parseInt(pageMatch[1]);
  } else {
    const pageLinks = html.match(/forum-\d+-(\d+)\.html/g);
    if (pageLinks) {
      const pages = pageLinks.map(p => parseInt(p.match(/(\d+)/)[1]));
      totalPages = Math.max(...pages, 1);
    }
  }

  return { threads, totalPages };
}

// Parse article list from www.esnai.cn HTML
function parseArticleList(html) {
  const articles = [];
  // Articles are in list items with links to /YYYY/MMDD/ID.shtml
  const articleRegex = /<a[^>]*href="(https?:\/\/www\.esnai\.cn\/\d{4}\/\d{4}\/\d+\.shtml)"[^>]*title="([^"]+)"[^>]*>/g;
  let match;
  const seen = new Set();
  while ((match = articleRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    if (title && !seen.has(url)) {
      seen.add(url);
      // Try to find date near this link
      const dateMatch = html.substring(Math.max(0, match.index - 200), match.index + 200).match(/(\d{4})-(\d{2})-(\d{2})/);
      const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';
      articles.push({ url, title, date, source: '中国会计视野' });
    }
  }

  // If no title= attributes, try text content
  if (articles.length === 0) {
    const altRegex = /<a[^>]*href="(https?:\/\/www\.esnai\.cn\/\d{4}\/\d{4}\/\d+\.shtml)"[^>]*>([^<]+)<\/a>/g;
    while ((match = altRegex.exec(html)) !== null) {
      const url = match[1];
      const title = match[2].trim();
      if (title.length > 5 && !seen.has(url)) {
        seen.add(url);
        articles.push({ url, title, date: '', source: '中国会计视野' });
      }
    }
  }

  return { articles };
}

// Parse article content from www.esnai.cn HTML
function parseArticleContent(html) {
  // Extract title from h2
  let title = '';
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  if (h2Match) {
    title = h2Match[1].replace(/<[^>]+>/g, '').trim();
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  // Extract content: between </h2> and the mainContent (comments) div
  let content = '';
  const h2End = html.indexOf('</h2>');
  const mcStart = html.indexOf('class="mainContent"');
  if (h2End > 0 && mcStart > h2End) {
    let bodyHtml = html.substring(h2End + 5, mcStart);
    // Remove scripts and styles
    bodyHtml = bodyHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    bodyHtml = bodyHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

    // Extract all <p> tags
    const paragraphs = bodyHtml.match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
    const textParts = [];
    for (const p of paragraphs) {
      let text = p
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&mdash;/g, '—')
        .replace(/&ldquo;/g, '\u201C')
        .replace(/&rdquo;/g, '\u201D')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim();
      if (text.length > 3) {
        textParts.push(text);
      }
    }
    content = textParts.join('\n\n');
  }

  // Extract date
  let date = '';
  const dateMatch = html.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateMatch) {
    date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  }

  // Extract source
  let source = '';
  const sourceMatch = html.match(/来源[：:]\s*([^<\s]+)/);
  if (sourceMatch) {
    source = sourceMatch[1].trim();
  }

  return { title, content, date, source };
}

// ==================== 12366 税务咨询 ====================

// Proxy search request to 12366 messagelist API
function handleTax12366Search(req, res) {
  const query = url.parse(req.url, true).query;
  const keyword = query.keyword || '';
  const page = parseInt(query.page) || 1;
  const region = query.region || '';
  const dateStart = query.dateStart || '';
  const dateEnd = query.dateEnd || '';

  if (!keyword) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: '请输入搜索关键词' }));
    return;
  }

  const postData = querystring.stringify({
    nr: keyword,
    currentPage: page,
    jg: region,
    zxjg: '',
    lykssj: dateStart,
    lyjssj: dateEnd,
  });

  const options = {
    hostname: '12366.chinatax.gov.cn',
    path: '/nszx/onlinemessage/messagelist',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://12366.chinatax.gov.cn/nszx/onlinemessage/main',
      'Content-Length': Buffer.byteLength(postData),
    },
    timeout: 15000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', async () => {
      try {
        const result = JSON.parse(data);
        if (!result.pageSet) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'API返回数据异常', raw: data.substring(0, 200) }));
          return;
        }

        // Extract and clean results
        const items = (result.pageSet || []).map(item => ({
          code: item.code,
          title: item.title || '',
          content: item.content || '',
          unitname: item.unitname || '',
          fbsj: item.fbsj || '',
          gxsj: item.gxsj || '',
          source: item.source || '',
          // reply fields to be filled
          replyContent: null,
          replyOrg: null,
          replyTime: null,
        }));

        // Batch fetch detail pages for first 5 results to get reply content
        if (items.length > 0) {
          const batchSize = 3; // concurrent limit
          const fetchLimit = Math.min(5, items.length);
          for (let i = 0; i < fetchLimit; i += batchSize) {
            const batch = items.slice(i, i + batchSize).map(item =>
              fetchTax12366Detail(item.code).catch(() => null)
            );
            const replies = await Promise.all(batch);
            replies.forEach((reply, idx) => {
              if (reply) {
                const target = items[i + idx];
                target.replyContent = reply.content;
                target.replyOrg = reply.org;
                target.replyTime = reply.time;
              }
            });
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
          items,
          totalResults: result.maxCount || 0,
          totalPages: result.maxPage || 1,
          currentPage: result.page || page,
          pageSize: result.pageSize || 8,
        }));
      } catch (e) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: '解析失败: ' + e.message }));
      }
    });
  });

  proxyReq.on('error', (e) => {
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: '请求12366失败: ' + e.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: '请求12366超时' }));
  });

  proxyReq.write(postData);
  proxyReq.end();
}

// Fetch and parse a single detail page for reply content
function fetchTax12366Detail(code) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '12366.chinatax.gov.cn',
      path: '/nszx/onlinemessage/detail?id=' + code,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://12366.chinatax.gov.cn/nszx/onlinemessage/main',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      // Limit response to 100KB to prevent memory issues
      let size = 0;
      const MAX_SIZE = 102400;
      
      res.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_SIZE) {
          data += chunk;
        }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        
        try {
          const reply = parseTax12366Detail(data);
          resolve(reply);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Parse detail HTML to extract reply info
function parseTax12366Detail(html) {
  // Extract answer institution (答复机构)
  const orgMatch = html.match(/答复机构[\s\S]*?<input[^>]*value="([^"]*)"[^>]*readonly/);
  const org = orgMatch ? orgMatch[1].trim() : null;

  // Extract answer time (答复时间)
  const timeMatch = html.match(/答复时间[\s\S]*?<input[^>]*value="([^"]*)"[^>]*readonly/);
  const time = timeMatch ? timeMatch[1].trim() : null;

  // Extract answer content (答复内容) - textarea content
  const contentMatch = html.match(/答复内容[\s\S]*?<textarea[^>]*readonly[^>]*>([\s\S]*?)<\/textarea>/);
  let content = null;
  if (contentMatch) {
    content = contentMatch[1]
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  }

  return { org, time, content };
}

// Handle single detail request (for viewing full reply)
function handleTax12366Detail(req, res) {
  const query = url.parse(req.url, true).query;
  const code = query.id || '';

  if (!code) {
    res.writeHead(400, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: 'Missing id parameter' }));
    return;
  }

  fetchTax12366Detail(code).then((reply) => {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(reply || { error: '无法获取详情' }));
  }).catch(() => {
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: '请求失败' }));
  });
}

// ==================== Inquiry Letter Search (IPO/再融资问询函) ====================

async function handleInquirySearch(req, res) {
  const query = url.parse(req.url, true).query;
  const company = (query.company || query.keyword || '').trim();
  const keyword = (query.keyword || '').trim();
  const exchange = query.exchange || 'all';
  const page = parseInt(query.page) || 1;
  const board = query.board || '';
  const docType = query.docType || '';
  const dateStart = query.dateStart || '';
  const dateEnd = query.dateEnd || '';

  console.log('[Inquiry] company=' + company + ' keyword=' + keyword + ' exchange=' + exchange + ' board=' + board + ' doctype=' + docType);

  const pageSize = 20;

  try {
    let results = [];

    // Search SSE - use two SQL IDs for broader coverage
    if (exchange === 'all' || exchange === 'sse') {
      // BS_GGLL: general inquiry letters (all markets)
      // BS_KCB_GGLL: 科创板 inquiry letters
      const sqlds = ['BS_GGLL', 'BS_KCB_GGLL'];
      for (const sqld of sqlds) {
        const sseUrl = 'http://query.sse.com.cn/commonSoaQuery.do?siteId=28&sqlId=' + sqld + '&channelId=10743%2C10744%2C10012&order=createTime%7Cdesc%2Cstockcode%7Casc&isPagination=true&pageHelp.pageSize=' + pageSize + '&pageHelp.pageNo=' + page + '&pageHelp.beginPage=' + page + '&pageHelp.cacheSize=1';
        try {
          const data = await fetchSSEInquiry(sseUrl);
          if (data && data.result) {
            results.push(...data.result.map(item => ({
              id: 'sse_' + sqld + '_' + (item.docURL || Date.now()).toString().replace(/[^a-z0-9]/gi, '_'),
              title: item.docTitle || '',
              stockCode: item.stockcode || '',
              stockName: item.extGSJC || '',
              company: item.extNAME || item.extGSJC || '',
              date: (item.cmsOpDate || '').substring(0, 10),
              type: item.extWTFL || '问询函',
              exchange: '上交所',
              exchangeCode: 'sse',
              board: sqld === 'BS_KCB_GGLL' ? '科创板' : parseBoard(item),
              url: item.docURL ? 'https://www.sse.com.cn' + item.docURL : '',
              content: item.docKeyword || '',
              source: '上海证券交易所'
            })));
          }
        } catch(e) { console.error('[Inquiry-SSE-' + sqld + ']', e.message); }
      }
    }

    // Search SZSE
    if (exchange === 'all' || exchange === 'szse') {
      try {
        const szseUrl = 'https://www.szse.cn/api/disc/announcement/annList?random=' + Math.random() + '&secCode=&beginDate=' + dateStart + '&endDate=' + dateEnd + '&pageIndex=' + (page - 1) + '&pageSize=' + pageSize;
        const data = await fetchSZSEInquiry(szseUrl);
        if (data && data.data) {
          results.push(...data.data.map(item => ({
            id: 'szse_' + (item.announceId || ''),
            title: item.announcementTitle || item.title || '',
            stockCode: item.secCode || item.stockCode || '',
            stockName: item.secName || item.stockName || '',
            company: item.secName || item.stockName || '',
            date: (item.announcementTime || item.declareDate || '').substring(0, 10),
            type: item.announcementType || '问询函',
            exchange: '深交所',
            exchangeCode: 'szse',
            board: parseBoardSZSE(item),
            url: item.adjunctUrl ? 'http://reportdocs.static.szse.cn/UpFiles/fxklwxhj/' + item.adjunctUrl : '',
            source: '深圳证券交易所'
          })));
        }
      } catch(e) { console.error('[Inquiry-SZSE]', e.message); }
    }
    // BSE: skipped (302 blocked)

    // Client-side filtering
    if (company || keyword) {
      const searchTerm = (company || keyword).trim();
      const kws = searchTerm.split(/\\s+/).filter(k => k.length > 0);
      results = results.filter(item => {
        const text = (item.title + ' ' + item.stockName + ' ' + item.company + ' ' + item.stockCode + ' ' + item.type).toLowerCase();
        return kws.every(kw => text.includes(kw.toLowerCase()));
      });
    }
    if (board) { results = results.filter(item => item.board && item.board.includes(board)); }
    if (docType) { results = results.filter(item => item.type && item.type.includes(docType)); }
    if (dateStart) results = results.filter(item => item.date >= dateStart);
    if (dateEnd) results = results.filter(item => item.date <= dateEnd);

    results.sort((a, b) => b.date.localeCompare(a.date));
    const total = results.length;

    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ items: results, total, page, pageSize, exchange }));
  } catch(e) {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ items: [], total: 0, error: e.message }));
  }
}

async function fetchSSEInquiry(sseUrl) {
  return new Promise(r => {
    const u = new URL(sseUrl);
    const req = require('http').request({
      hostname: u.hostname, path: u.pathname + u.search, timeout: 15000, servername: 'query.sse.com.cn',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.sse.com.cn/disclosure/credibility/supervision/inquiries/' }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
    req.on('error', () => r(null)); req.end();
  });
}

async function fetchSZSEInquiry(szseUrl) {
  return new Promise(r => {
    const u = new URL(szseUrl);
    require('https').get({ hostname: u.hostname, path: u.pathname + u.search, rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.szse.cn/disclosure/supervision/inquire/index.html' }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); })
    .on('error', () => r(null));
  });
}

// Board detection from SSE data
function parseBoard(item) {
  const code = item.stockcode || '';
  if (/^68/.test(code)) return '科创板';
  if (/^60/.test(code)) return '主板';
  return '';
}
function parseBoardSZSE(item) {
  const code = item.secCode || item.stockCode || '';
  if (/^30/.test(code)) return '创业板';
  if (/^00[012]/.test(code)) return '主板';
  return '';
}

// Handle esnai forum request
function handleEsnaiForum(req, res) {
  const query = url.parse(req.url, true).query;
  const fid = parseInt(query.fid) || 7;
  const page = parseInt(query.page) || 1;
  const keyword = (query.keyword || '').trim();

  const path = `/forum-${fid}-${page}.html`;
  console.log(`[EsnaiForum] fid=${fid} page=${page} keyword="${keyword}"`);

  esnaiFetch(path, true, (err, html, status) => {
    if (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err }));
      return;
    }

    const result = parseForumThreads(html);

    // Filter by keyword if provided
    if (keyword) {
      result.threads = result.threads.filter(t =>
        t.title.toLowerCase().includes(keyword.toLowerCase())
      );
      result.filtered = result.threads.length;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result));
  });
}

// Handle esnai articles request
function handleEsnaiArticles(req, res) {
  const query = url.parse(req.url, true).query;
  const category = query.category || '47';
  const keyword = (query.keyword || '').trim();

  const path = `/${category}/`;
  console.log(`[EsnaiArticles] category=${category} keyword="${keyword}"`);

  esnaiFetch(path, false, (err, html, status) => {
    if (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err }));
      return;
    }

    const result = parseArticleList(html);

    // Filter by keyword if provided
    if (keyword) {
      result.articles = result.articles.filter(a =>
        a.title.toLowerCase().includes(keyword.toLowerCase())
      );
      result.filtered = result.articles.length;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result));
  });
}

// Handle esnai article detail request
function handleEsnaiArticle(req, res) {
  const query = url.parse(req.url, true).query;
  const articleUrl = query.url || '';

  if (!articleUrl || !articleUrl.includes('esnai.cn')) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }

  // Extract path from URL
  const urlObj = url.parse(articleUrl);
  const path = urlObj.pathname;

  console.log(`[EsnaiArticle] path=${path}`);

  esnaiFetch(path, false, (err, html, status) => {
    if (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err }));
      return;
    }

    const result = parseArticleContent(html);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result));
  });
}

// --- ESNAI Full-text Search (post + reply content) ---

// Parse Discuz search results page
function parseDiscuzSearchResults(html) {
  const results = [];
  // Discuz X3.4 search results are in <li class="pbw" id="TID"> blocks
  const liRegex = /<li class="pbw"[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = liRegex.exec(html)) !== null) {
    const tid = match[1];
    const block = match[2];

    // Extract title and URL
    const titleMatch = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? titleMatch[2].replace(/<[^>]+>/g, '').trim() : '';
    const threadUrl = titleMatch ? titleMatch[1] : '';

    // Extract reply count and view count from <p class="xg1">
    const statsMatch = block.match(/<p class="xg1">([^<]*)<\/p>/);
    let stats = statsMatch ? statsMatch[1].trim() : '';

    // Extract content snippet - the <p> without class (second p after xg1)
    const pTags = block.match(/<p>([\s\S]*?)<\/p>/g);
    let content = '';
    if (pTags && pTags.length > 0) {
      // The content snippet is in the first <p> without class
      content = pTags[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    }

    // Extract author
    const authorMatch = block.match(/<a[^>]*href="space-uid-\d+\.html"[^>]*>([^<]+)/);
    const author = authorMatch ? authorMatch[1].trim() : '';

    // Extract forum name
    const forumMatch = block.match(/<a[^>]*href="forum-\d+-\d+\.html"[^>]*class="xi1"[^>]*>([^<]+)/);
    const forum = forumMatch ? forumMatch[1].trim() : '';

    // Extract date - look for date pattern in spans
    const dateMatch = block.match(/<span>(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})<\/span>/) ||
                      block.match(/<span>(\d{4}-\d{1,2}-\d{1,2})<\/span>/);
    const date = dateMatch ? dateMatch[1].trim() : '';

    if (title) {
      results.push({ tid, title, content, author, forum, date, url: threadUrl, stats });
    }
  }

  // Extract total results count
  let totalResults = 0;
  const totalMatch = html.match(/相关内容\s*(\d+)\s*个/) || html.match(/找到约\s*([\d,]+)\s*个结果/);
  if (totalMatch) {
    totalResults = parseInt(totalMatch[1].replace(/,/g, ''));
  }

  // Extract pagination
  let totalPages = 1;
  const pageMatch = html.match(/<a[^>]*class="last"[^>]*>(\d+)<\/span>/) ||
    html.match(/<span[^>]*class="last"[^>]*>(\d+)<\/span>/);
  if (pageMatch) {
    totalPages = parseInt(pageMatch[1]);
  }

  return { results, totalResults, totalPages };
}

// Parse Discuz thread page to extract posts and replies
function parseThreadContent(html) {
  let title = '';
  const titleMatch = html.match(/<span id="thread_subject"[^>]*>([\s\S]*?)<\/span>/);
  if (titleMatch) {
    title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
  }

  const posts = [];
  // Find all postmessage IDs to locate posts
  const postmsgRegex = /id="postmessage_(\d+)"/g;
  const postIds = [];
  let pidMatch;
  while ((pidMatch = postmsgRegex.exec(html)) !== null) {
    postIds.push(pidMatch[1]);
  }

  for (let i = 0; i < postIds.length; i++) {
    const pid = postIds[i];
    const nextPid = postIds[i + 1];

    // Find the content block for this postmessage
    const contentStart = html.indexOf(`id="postmessage_${pid}"`);
    if (contentStart < 0) continue;

    // Find the end - either the next postmessage or a reasonable distance
    let contentEnd;
    if (nextPid) {
      contentEnd = html.indexOf(`id="postmessage_${nextPid}"`);
      // Go back to find the enclosing td/div
      contentEnd = html.lastIndexOf('</td>', contentEnd);
      if (contentEnd < 0) contentEnd = html.lastIndexOf('</div>', contentEnd);
    } else {
      // Last post - find the closing of the content area
      contentEnd = html.indexOf('<div class="pct">', contentStart + 100);
      if (contentEnd < 0) contentEnd = contentStart + 10000;
    }

    if (contentEnd < contentStart) contentEnd = contentStart + 5000;
    const contentBlock = html.substring(contentStart, contentEnd);

    // Extract post content from <td class="t_f" id="postmessage_XXX">...</td>
    let postContent = '';
    const contentMatch = contentBlock.match(/>([\s\S]*?)<\/td>/);
    if (contentMatch) {
      postContent = contentMatch[1];
    } else {
      // Try div-based content
      postContent = contentBlock.replace(/^>[^<]*/, '').replace(/<\/?(?:td|div)[^>]*>/g, '');
    }

    postContent = postContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—')
      .replace(/&ldquo;/g, '\u201C')
      .replace(/&rdquo;/g, '\u201D')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Look backward from contentStart to find author and date in the same post block
    const searchStart = Math.max(0, contentStart - 5000);
    const preBlock = html.substring(searchStart, contentStart);

    // Extract author from the nearest authi div before this postmessage
    let author = '';
    const authiMatches = preBlock.match(/<div class="authi"><a[^>]*>([^<]+)/g);
    if (authiMatches && authiMatches.length > 0) {
      const lastAuth = authiMatches[authiMatches.length - 1].match(/>([^<]+)$/);
      if (lastAuth) author = lastAuth[1].trim();
    }

    // Extract date from authorposton
    let date = '';
    const dateMatches = preBlock.match(/<em[^>]*id="authorposton\d+"[^>]*>发表于\s*([^<]+)/g);
    if (dateMatches && dateMatches.length > 0) {
      const lastDateMatch = dateMatches[dateMatches.length - 1].match(/发表于\s*([^<]+)/);
      if (lastDateMatch) date = lastDateMatch[1].trim();
    } else {
      const dateMatch2 = preBlock.match(/<em[^>]*>发表于\s*([^<]+)/g);
      if (dateMatch2 && dateMatch2.length > 0) {
        const lastDate = dateMatch2[dateMatch2.length - 1].match(/发表于\s*([^<]+)/);
        if (lastDate) date = lastDate[1].trim();
      }
    }

    const isOP = i === 0;

    if (postContent) {
      posts.push({ pid, author, date, content: postContent, isOP });
    }
  }

  // Extract total pages
  let totalPages = 1;
  const pageMatch = html.match(/<a[^>]*class="last"[^>]*>(\d+)<\/span>/) ||
    html.match(/thread-\d+-(\d+)-\d+\.html/g);
  if (pageMatch) {
    if (typeof pageMatch === 'string') {
      totalPages = parseInt(pageMatch.match(/(\d+)/)[1]);
    } else if (Array.isArray(pageMatch)) {
      const pages = pageMatch.map(p => parseInt(p.match(/thread-\d+-(\d+)/)[1]));
      totalPages = Math.max(...pages, 1);
    }
  }

  return { title, posts, totalPages };
}

// Helper: fetch thread content (posts + replies) for a single tid
function fetchThreadPosts(tid) {
  return new Promise((resolve) => {
    const path = `/thread-${tid}-1-1.html`;
    esnaiFetch(path, true, (err, html, status) => {
      if (err || !html) {
        resolve(null);
        return;
      }
      // Skip guest-inaccessible pages
      if (html.includes('游客') && html.includes('无法进行')) {
        resolve(null);
        return;
      }
      try {
        const parsed = parseThreadContent(html);
        resolve(parsed);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// Helper: batch fetch full thread content for search results with concurrency control
// Attaches a `posts` array (main post + replies) to each result item.
async function batchFetchThreadPosts(results, batchSize = 5, maxItems = 10) {
  const items = results.slice(0, maxItems);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (r) => {
      const threadData = await fetchThreadPosts(r.tid);
      return {
        tid: r.tid,
        posts: threadData ? (threadData.posts || []) : [],
        threadTitle: threadData ? (threadData.title || '') : '',
        threadTotalPages: threadData ? (threadData.totalPages || 1) : 1,
      };
    }));
    // Attach posts back to the corresponding result objects
    for (const br of batchResults) {
      const result = results.find(r => r.tid === br.tid);
      if (result) {
        result.posts = br.posts;
        result.threadTotalPages = br.threadTotalPages;
        if (br.threadTitle && !result.title) result.title = br.threadTitle;
      }
    }
  }
}

// Handle esnai full-text search (searches post + reply content)
async function handleEsnaiSearch(req, res) {
  const query = url.parse(req.url, true).query;
  const keyword = (query.keyword || '').trim();
  const fid = parseInt(query.fid) || 7;
  const page = parseInt(query.page) || 1;
  const dateStart = query.dateStart || '';  // 时间段筛选
  const dateEnd = query.dateEnd || '';

  console.log(`[EsnaiSearch] keyword="${keyword}" fid=${fid} page=${page} dateStart=${dateStart} dateEnd=${dateEnd} loggedIn=${esnaiLoggedIn}`);

  if (!keyword) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: '请输入搜索关键词' }));
    return;
  }

  // Try logged-in search first
  if (esnaiLoggedIn) {
    try {
      const searchPath = `/search.php?mod=forum&searchsubmit=yes&srchtxt=${gbkUrlEncode(keyword)}&srchtype=fulltext&page=${page}`;
      const searchResult = await new Promise((resolve, reject) => {
        esnaiFetch(searchPath, true, (err, html, status) => {
          if (err) reject(err);
          else resolve({ html, status });
        });
      });

      if (searchResult.status === 200 && !searchResult.html.includes('您需要先登录')) {
        const parsed = parseDiscuzSearchResults(searchResult.html);
        parsed.searchMode = 'login';
        parsed.loggedIn = true;

        // Fetch full thread content (main post + replies) for each search result
        // so the frontend can display complete replies inline without extra clicks.
        console.log(`[EsnaiSearch] Fetching full content for ${parsed.results.length} threads...`);
        await batchFetchThreadPosts(parsed.results, 5, 10);
        console.log('[EsnaiSearch] Done fetching full content');

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(parsed));
        return;
      }
    } catch (e) {
      console.error('[EsnaiSearch] Login search failed:', e.message);
    }
  }

  // Fallback: scrape thread list + fetch individual thread content
  console.log('[EsnaiSearch] Using fallback (scrape threads)');

  // Fetch more pages since we can only do title matching without login
  const maxPages = esnaiLoggedIn ? 3 : 5;
  const allThreads = [];

  for (let p = 1; p <= maxPages; p++) {
    try {
      const listPath = `/forum-${fid}-${p}.html`;
      const listResult = await new Promise((resolve, reject) => {
        esnaiFetch(listPath, true, (err, html, status) => {
          if (err) reject(err);
          else resolve({ html, status });
        });
      });

      if (listResult.html) {
        const parsed = parseForumThreads(listResult.html);
        allThreads.push(...parsed.threads);
      }
    } catch (e) {
      console.error(`[EsnaiSearch] Failed to fetch forum page ${p}:`, e.message);
    }
  }

  console.log(`[EsnaiSearch] Found ${allThreads.length} threads in list`);

  // Filter threads by title first (quick filter)
  const titleMatches = allThreads.filter(t =>
    t.title.toLowerCase().includes(keyword.toLowerCase())
  );

  const contentMatches = [];

  // Only try content matching if logged in (guests can't view threads)
  if (esnaiLoggedIn) {
    // Fetch thread content for threads that don't match title
    const threadsToCheck = allThreads.filter(t =>
      !t.title.toLowerCase().includes(keyword.toLowerCase())
    ).slice(0, 15);

    // Fetch thread content in batches of 5
    for (let i = 0; i < threadsToCheck.length; i += 5) {
      const batch = threadsToCheck.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(async (thread) => {
        try {
          const threadPath = `/thread-${thread.tid}-1-1.html`;
          const threadResult = await new Promise((resolve, reject) => {
            esnaiFetch(threadPath, true, (err, html, status) => {
              if (err) reject(err);
              else resolve({ html, status });
            });
          });

          if (threadResult.html) {
            // Skip if it's a "guest cannot access" page
            if (threadResult.html.includes('游客') && threadResult.html.includes('无法进行')) {
              return null;
            }
            const parsed = parseThreadContent(threadResult.html);
            // Search in all posts (including replies)
            const lowerKeyword = keyword.toLowerCase();
            for (const post of parsed.posts) {
              if (post.content.toLowerCase().includes(lowerKeyword)) {
                const idx = post.content.toLowerCase().indexOf(lowerKeyword);
                const start = Math.max(0, idx - 60);
                const end = Math.min(post.content.length, idx + keyword.length + 120);
                const snippet = (start > 0 ? '...' : '') + post.content.substring(start, end) + (end < post.content.length ? '...' : '');

                return {
                  ...thread,
                  content: snippet,
                  matchedIn: post.isOP ? '主帖' : '回复',
                  matchedAuthor: post.author,
                  matchedDate: post.date,
                };
              }
            }
          }
        } catch (e) {
          // Skip failed threads
        }
        return null;
      }));

      for (const r of batchResults) {
        if (r) contentMatches.push(r);
      }
    }
  }

  // Combine results: title matches first, then content matches
  let allResults = [
    ...titleMatches.map(t => ({
      tid: t.tid,
      title: t.title,
      content: '(标题匹配)',
      author: t.author,
      forum: '',
      date: t.date,
      url: t.url,
      matchedIn: '标题',
      matchedAuthor: t.author,
      matchedDate: t.date,
    })),
    ...contentMatches,
  ];

  // 时间段筛选
  if (dateStart || dateEnd) {
    const start = dateStart ? new Date(dateStart) : null;
    const end = dateEnd ? new Date(dateEnd + 'T23:59:59') : null;
    allResults = allResults.filter(r => {
      if (!r.date) return !dateStart && !dateEnd;
      const d = new Date(r.date);
      if (isNaN(d.getTime())) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
    console.log(`[EsnaiSearch] Date filtered: ${allResults.length} results within range`);
  }

  // Fetch full thread content (main post + replies) for each result
  // so the frontend can display complete replies inline without extra clicks.
  console.log(`[EsnaiSearch] Fetching full content for ${allResults.length} results...`);
  await batchFetchThreadPosts(allResults, 5, 10);
  console.log('[EsnaiSearch] Done fetching full content');

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    results: allResults,
    totalResults: allResults.length,
    totalPages: 1,
    searchMode: 'fallback',
    loggedIn: esnaiLoggedIn,
    threadsScanned: allThreads.length,
  }));
}

// Handle esnai thread content (view full thread with replies)
function handleEsnaiThread(req, res) {
  const query = url.parse(req.url, true).query;
  const tid = query.tid || '';
  const page = query.page || '1';

  if (!tid) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing thread ID' }));
    return;
  }

  const path = `/thread-${tid}-${page}-1.html`;
  console.log(`[EsnaiThread] tid=${tid} page=${page}`);

  esnaiFetch(path, true, (err, html, status) => {
    if (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err }));
      return;
    }

    const result = parseThreadContent(html);
    result.tid = tid;
    result.url = `https://bbs.esnai.cn/thread-${tid}-${page}-1.html`;

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result));
  });
}

// Create server
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
    });
    res.end();
    return;
  }

  // Auth routes (no login required)
  if (parsed.pathname === '/api/auth/register' && req.method === 'POST') {
    handleRegister(req, res);
    return;
  } else if (parsed.pathname === '/api/auth/login' && req.method === 'POST') {
    handleLogin(req, res);
    return;
  } else if (parsed.pathname === '/api/auth/logout') {
    handleLogout(req, res);
    return;
  } else if (parsed.pathname === '/api/auth/session') {
    handleSession(req, res);
    return;
  }

  // Protect all business APIs - require login
  if (parsed.pathname.startsWith('/api/') && !checkAuth(req)) {
    sendJSON(res, 401, { error: '请先登录' });
    return;
  }

  // CSRC APIs
  if (parsed.pathname === '/api/search' && req.method === 'POST') {
    proxySearch(req, res);
  } else if (parsed.pathname === '/api/detail') {
    proxyDetail(req, res);
  } else if (parsed.pathname === '/api/hint') {
    proxyHint(req, res);
  }
  // Cninfo APIs
  else if (parsed.pathname === '/api/cninfo/search' && req.method === 'POST') {
    cninfoPost('/new/hisAnnouncement/query', {}, req, res);
  } else if (parsed.pathname === '/api/cninfo/stocks') {
    cninfoGet('/new/data/szse_stock.json', req, res);
  } else if (parsed.pathname === '/api/cninfo/stock-search' && req.method === 'POST') {
    cninfoPost('/new/information/topSearch/query', {}, req, res);
  } else if (parsed.pathname === '/api/cninfo/fulltext') {
    cninfoFulltextSearch(req, res);
  } else if (parsed.pathname === '/api/cninfo/html5') {
    cninfoHtml5Content(req, res);
  }
  // 12366 Tax APIs
  else if (parsed.pathname === '/api/tax12366/search') {
    handleTax12366Search(req, res);
  } else if (parsed.pathname === '/api/tax12366/detail') {
    handleTax12366Detail(req, res);
  }
  // Inquiry Letters (IPO/再融资问询函)
  else if (parsed.pathname === '/api/inquiry/search') {
    handleInquirySearch(req, res);
  }
  // Esnai APIs
  else if (parsed.pathname === '/api/esnai/forum') {
    handleEsnaiForum(req, res);
  } else if (parsed.pathname === '/api/esnai/articles') {
    handleEsnaiArticles(req, res);
  } else if (parsed.pathname === '/api/esnai/article') {
    handleEsnaiArticle(req, res);
  } else if (parsed.pathname === '/api/esnai/search') {
    handleEsnaiSearch(req, res);
  } else if (parsed.pathname === '/api/esnai/thread') {
    handleEsnaiThread(req, res);
  } else if (parsed.pathname === '/api/esnai/login-status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      loggedIn: esnaiLoggedIn,
      retryIn: esnaiLoginRetryTime > Date.now() ? Math.ceil((esnaiLoginRetryTime - Date.now()) / 1000) : 0,
    }));
  }
  // Static files / Main page
  else {
    // If not logged in, serve login page (unless requesting login page or static assets)
    const reqPath = parsed.pathname || '/';
    if (!checkAuth(req) && !reqPath.startsWith('/login') && !reqPath.match(/\.(js|css|png|svg|ico|woff2?)$/)) {
      // Serve login.html for unauthenticated users
      fs.readFile(path.join(__dirname, 'public', 'login.html'), (err, data) => {
        if (err) {
          serveStatic(req, res);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        }
      });
    } else {
      serveStatic(req, res);
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ 财务人超市服务已启动: http://localhost:${PORT}`);
  console.log(`   证监会法规 + 巨潮资讯网公告 + 会计视野 三来源检索`);
  console.log(`   按 Ctrl+C 停止服务`);

  // Auto-login to esnai forum for full-text search
  console.log('[EsnaiLogin] 正在自动登录会计视野论坛...');
  esnaiLogin().then((success) => {
    if (!success) {
      console.log('[EsnaiLogin] 登录未成功，回复内容搜索将使用抓取模式（较慢）');
    }
  });

  // Periodic retry login if not logged in
  setInterval(() => {
    if (!esnaiLoggedIn && Date.now() > esnaiLoginRetryTime) {
      console.log('[EsnaiLogin] 重试登录...');
      esnaiLogin();
    }
  }, 5 * 60 * 1000); // check every 5 minutes
});

// Export for Vercel serverless
module.exports = function handler(req, res) {
  server.emit('request', req, res);
};
