// Cloudflare Worker - 财务人超市 API 代理
// 部署：复制此代码到 Cloudflare Workers 控制台

const CSRC_HOST = '219.141.221.17';
const CNINFO_HOST = '118.112.231.185';

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Credentials': 'true'
    }});
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true'
  };

  // === Auth ===
  if (path === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await request.json();
      if (body.email === 'admin' && body.password === 'Lihua2014.') {
        const token = crypto.randomUUID();
        return new Response(JSON.stringify({ ok: true, token, name: '管理员' }), {
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': `token=${token}; Path=/; SameSite=None; Secure`, ...corsHeaders }
        });
      }
      return new Response(JSON.stringify({ ok: false, error: '密码错误' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  if (path === '/api/auth/session') {
    const cookie = request.headers.get('Cookie') || '';
    const tokenMatch = cookie.match(/token=([^;]+)/);
    if (tokenMatch) {
      return new Response(JSON.stringify({ loggedIn: true, name: '管理员' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    return new Response(JSON.stringify({ loggedIn: false }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // === CSRC Search Proxy ===
  if (path === '/api/search' && request.method === 'POST') {
    try {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const qs = params.toString();
      const proxyUrl = `http://${CSRC_HOST}/falvfagui/advSearch?${qs}`;
      
      const resp = await fetch(proxyUrl, {
        headers: {
          'Host': 'neris.csrc.gov.cn',
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://neris.csrc.gov.cn/falvfagui/'
        }
      });
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch {
        return new Response(text, {
          headers: { 'Content-Type': 'text/html', ...corsHeaders }
        });
      }
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // === Cninfo Search Proxy ===
  if (path === '/api/cninfo/search' && request.method === 'POST') {
    try {
      const body = await request.text();
      const resp = await fetch(`http://${CNINFO_HOST}/new/hisAnnouncement/query`, {
        method: 'POST',
        headers: {
          'Host': 'www.cninfo.com.cn',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.cninfo.com.cn/'
        },
        body: body
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // === Cninfo Fulltext ===
  if (path === '/api/cninfo/fulltext') {
    try {
      const qs = url.search;
      const resp = await fetch(`http://${CNINFO_HOST}/new/fulltextSearch/full${qs}`, {
        headers: {
          'Host': 'www.cninfo.com.cn',
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.cninfo.com.cn/'
        }
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // === Cninfo Stocks ===
  if (path === '/api/cninfo/stocks') {
    try {
      const resp = await fetch(`http://${CNINFO_HOST}/new/data/szse_stock.json`, {
        headers: {
          'Host': 'www.cninfo.com.cn',
          'User-Agent': 'Mozilla/5.0'
        }
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // === Inquiry Search Proxy (SSE) ===
  if (path === '/api/inquiry/search') {
    try {
      const qs = url.search;
      const resp = await fetch(`http://query.sse.com.cn/commonSoaQuery.do${qs}`, {
        headers: {
          'Host': 'query.sse.com.cn',
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Referer': 'https://www.sse.com.cn/'
        }
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found', path }), {
    status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export default {
  fetch: handleRequest
};
