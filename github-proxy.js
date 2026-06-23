// GitHub 加速代理 - 本地运行，通过最优IP转发GitHub流量
// 用法: node github-proxy.js
// 然后设置系统代理为 http://127.0.0.1:8888

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');

const PROXY_PORT = 8888;

// GitHub CDN 最优IP映射（实时可用）
const GITHUB_IPS = {
  'github.com': '20.205.243.166',
  'www.github.com': '20.205.243.166',
  'api.github.com': '140.82.121.6',
  'raw.githubusercontent.com': '185.199.110.133',
  'github.githubassets.com': '185.199.108.215',
  'codeload.github.com': '20.205.243.165',
  'objects.githubusercontent.com': '185.199.110.133',
  'github-releases.githubusercontent.com': '185.199.110.133',
  'avatars.githubusercontent.com': '185.199.110.215',
  'user-images.githubusercontent.com': '185.199.110.133',
};

function getGitHubIP(hostname) {
  // 精确匹配
  if (GITHUB_IPS[hostname]) return GITHUB_IPS[hostname];
  // 子域名匹配
  if (hostname.endsWith('.github.com') || hostname.endsWith('.githubusercontent.com')) {
    return '20.205.243.166';
  }
  return null;
}

// HTTP/HTTPS 代理
const server = http.createServer((req, res) => {
  const targetUrl = req.url;
  
  // 只处理 GitHub 相关请求
  if (!targetUrl.includes('github.com') && !targetUrl.includes('githubusercontent.com')) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('This proxy only handles GitHub requests');
    return;
  }

  const parsed = url.parse(targetUrl);
  const githubIP = getGitHubIP(parsed.hostname);
  
  if (!githubIP) {
    res.writeHead(502);
    res.end('No GitHub IP mapped');
    return;
  }

  const options = {
    hostname: githubIP,
    port: parsed.port || 443,
    path: parsed.path,
    method: req.method,
    headers: { ...req.headers, host: parsed.hostname },
    servername: parsed.hostname,
    rejectUnauthorized: false,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end('Proxy error: ' + e.message);
  });

  req.pipe(proxyReq);
});

// CONNECT 方法（处理 HTTPS）
server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  const githubIP = getGitHubIP(hostname);

  if (!githubIP) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
    return;
  }

  const serverSocket = net.connect(port || 443, githubIP, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', () => {
    clientSocket.end();
  });
  clientSocket.on('error', () => {
    serverSocket.end();
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`🟢 GitHub 加速代理已启动: http://127.0.0.1:${PROXY_PORT}`);
  console.log(`   请在系统代理中设置 HTTP/HTTPS 代理为 127.0.0.1:${PROXY_PORT}`);
  console.log(`   或设置环境变量: set HTTP_PROXY=http://127.0.0.1:${PROXY_PORT}`);
  console.log(`                    set HTTPS_PROXY=http://127.0.0.1:${PROXY_PORT}`);
  console.log(`   加速域名: ${Object.keys(GITHUB_IPS).length} 个`);
});
