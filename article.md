# 我用原生 Node.js 手搓了一个"财务人超市"——聚合证监会、巨潮、12366、会计视野四大数据源

> 一个财务从业者的自用小工具：零框架、纯原生，从本地跑到腾讯云 SCF，踩过的坑全记录。

---

## 一、缘起：财务人的"多平台之苦"

做财务、审计、投行的人每天都要查好几类信息：

- **证监会法规**——查最新的监管规定、规范性文件
- **巨潮公告**——看上市公司年报、各类公告
- **12366 税务咨询**——查税务问题的官方答复口径
- **会计视野论坛**——看 CPA 同行的实务讨论

四个网站，四个登录，四种搜索逻辑，来回切换效率极低。

于是我用 **纯原生 Node.js + HTML/CSS/JS**，不依赖任何前端框架、后端框架，手搓了一个聚合搜索平台——**财务人超市**。

---

## 二、技术架构

```
┌─────────────────────────────────────────────┐
│          浏览器（纯 HTML/CSS/JS）             │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐   │
│  │证监会  │ │巨潮   │ │税务   │ │视野   │   │
│  │法规栏 │ │公告栏 │ │咨询栏 │ │论坛栏 │   │
│  └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘   │
└──────┼─────────┼─────────┼─────────┼─────────┘
       │  Fetch  │         │         │
       ▼         ▼         ▼         ▼
┌─────────────────────────────────────────────┐
│           Node.js 后端（无框架）              │
│  • 认证（SHA-256 + Cookie Session）          │
│  • API 代理（绕过 CORS/反爬）                │
│  • GBK 解码（iconv-lite）                    │
│  • PDF 解析（pdf-parse）                     │
│  • HTML 内容提取（正则解析）                  │
└──────┬──────────┬──────────┬────────────────┘
       │          │          │
       ▼          ▼          ▼
  ┌────────┐ ┌────────┐ ┌────────┐
  │ 证监会  │ │ 巨潮   │ │ 12366  │
  │(CSRC)  │ │(Cninfo)│ │(Tax)  │
  └────────┘ └────────┘ └────────┘
       │
       ▼
  ┌────────┐
  │会计视野 │
  │(Esnai) │
  └────────┘
```

### 为什么选原生 Node.js？

不用 Express、Koa，直接上 `http.createServer`。原因是：

1. **极致可控**——每个请求的路由、header、Body 处理都在眼前
2. **零依赖臃肿**——除了 `pdf-parse`（PDF 正文提取）和 `iconv-lite`（GBK 编解码）两个功能模块，没有其他 npm 包
3. **部署灵活**——一个 `server.js` + 两个静态 HTML，丢到哪里都能跑

前端同样纯原生，没有任何打包工具、框架。所有 CSS 内联到 `<style>`，JS 全写在 `<script>` 标签里。两个文件（`login.html` + `index.html`）搞定全部 UI。

---

## 三、核心功能详解

### 3.1 证监会法规搜索

证监会法规数据库（`neris.csrc.gov.cn`）提供 Solr 全文检索接口，但直接在浏览器调用会遇到 CORS 限制。我在后端做了一个**透明代理层**：

```javascript
// server.js 中的代理模式（脱敏版）
function proxyCSRC(keyword, filters) {
  const formData = querystring.stringify({
    keyword: keyword,
    wenhao: filters.wenhao,
    fawenjg: filters.org,
    // ... 更多检索参数
  });

  const options = {
    hostname: 'neris.csrc.gov.cn',
    path: '/falvfagui/multipleFindController/solrSearch',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0',
    }
  };

  // 返回结果自动转换为 JSON，前端直接消费
}
```

结果在前端渲染为表格，点击法规名称弹出模态框，直接展示法规正文 HTML。

### 3.2 巨潮公告 + PDF 全文搜索

巨潮资讯网的接口返回的是 **PDF 公告附件链接**，而不是文本内容。为了做到"文件正文全文搜索"，我做了两步处理：

1. **代理搜索**——转发用户关键词到巨潮的全文检索接口
2. **自动拉取 + 解析 PDF**——拿到结果后，用 `pdf-parse` 自动下载前 5 条结果的 PDF 附件，提取文本内容，把正文片段内嵌到搜索结果中返回给前端

这样用户不用点开公告链接，直接在搜索结果里就能看到匹配到的正文段落，关键词高亮。

### 3.3 会计视野论坛：GBK + 自动登录

会计视野论坛是 **Discuz 系统**，页面编码是 **GBK 而非 UTF-8**。Node.js 原生不支持 GBK，这里用 `iconv-lite` 做编解码。

论坛的搜索功能需要登录后才能使用，所以我还实现了自动登录：

```javascript
// 自动登录会计视野论坛（脱敏版）
async function esnaiLogin() {
  const formData = querystring.stringify({
    username: 'YOUR_USERNAME',
    password: 'YOUR_PASSWORD',
    loginsubmit: 'yes',
  });

  // POST 到 bbs.esnai.cn/member.php?mod=logging&action=login
  // 保存 Cookie 供后续搜索使用
}
```

登录成功后可走论坛内置的全文检索（搜索帖子正文+回复），速度比抓取快得多。

### 3.4 12366 税务咨询

国家税务总局 12366 纳税服务平台提供了一套 JSON API，支持按地区（`jg` 参数）、日期（`lykssj`/`lyjssj` 参数）筛选。搜索结果列表只显示问题和回复摘要，我另外实现了**自动拉取详情**：

```javascript
// 批量拉取前 5 条结果的官方答复
const replies = await Promise.all(
  items.slice(0, 5).map(item =>
    fetch(`/nszx/onlinemessage/detail?id=${item.code}`)
      .then(parseReplyHTML) // 解析回复机构、时间、内容
  )
);
```

前 5 条直接内嵌答复内容，其余提供链接跳转原文。

---

## 四、认证系统

自建了一个轻量认证系统：

| 环节 | 实现方式 |
|------|----------|
| 注册 | 邮箱格式校验 + 密码 >= 6 位 |
| 密码存储 | SHA-256 哈希 + 固定盐值 |
| Session | UUID token → Cookie（HttpOnly + 30 天） |
| 数据持久化 | JSON 文件（`data/users.json`、`data/sessions.json`） |

没有数据库，没有 Redis，两个 JSON 文件搞定所有用户和 session 管理——简单直接，对小流量场景完全够用。

---

## 五、部署到腾讯云 SCF 的踩坑记录

本地跑通后，自然想把服务挂到云上。首选 **腾讯云 SCF（Serverless Cloud Function）**，免费额度每月 100 万次调用。

### 坑 1：冷启动优化

第一个版本上传后，冷启动要 **120 秒+**，原因是代码包里有 `pdf-parse` 的 4.6MB 依赖。解决办法：

1. **去掉 Web 版依赖**——`pdf-parse` 同时打包了 Node 版和浏览器版，删掉 `dist/pdf-parse/web` 和 `dist/worker` 这 2.8MB
2. **懒加载 pdf-parse**——只在需要解析 PDF 时才 `require`
3. **iconv-lite 保留必要编码表**——只留 GBK 相关的 300KB

优化后代码包从 10MB 精简到 **97KB**，冷启动降到 **< 1 秒**。

### 坑 2：Content-Disposition: attachment

SCF 的 HTTP 函数 URL 在所有响应头中自动追加 `Content-Disposition: attachment`，导致浏览器**直接下载 HTML 页面而不是渲染**。

这是一个很坑的行为——你在服务端代码里无论设置什么 header，SCF 网关都会覆盖成 `attachment`。

经过多轮尝试（设置 `Content-Disposition: inline`、改用 `text/plain` 内容类型、使用 data URI 重定向...），最终发现 SCF 的 **"函数 URL"** 机制与 **HTTP 触发器** 表现不同，正确创建函数 URL 后这个 header 问题才解决。

> **经验**：SCF HTTP 函数务必通过控制台「函数URL」功能创建访问链接，不要用旧版「触发管理」。

### 坑 3：账户余额

SCF 虽然免费，但开通需要账户里至少有 **10 元余额**用于激活服务。余额不会被消耗（除非超出免费额度），纯粹是开通门槛。

---

## 六、最终方案：SCF + Cloudflare Tunnel 双保险

考虑到 SCF 的函数 URL 存在上述坑点，我同时跑了两套方案：

| 方案 | 网址 | 特点 |
|------|------|------|
| Cloudflare Tunnel | `*.trycloudflare.com` | 电脑运行即上线，完全免费，延迟极低 |
| 腾讯云 SCF | `*.tencentscf.com` | 永久固定域名，无需电脑在线 |

两套方案指向同一套代码，互为备份。

---

## 七、项目数字

```
总代码量：    ~3,900 行（server.js 1,953 + index.html 1,889 + login.html）
外部依赖：    2 个 npm 包（pdf-parse, iconv-lite）
数据源：     4 个（证监会、巨潮、12366、会计视野）
API 端点：   14 个
标签页：     5 个
认证方式：   Cookie Session + JSON 文件
前端框架：   无（原生三件套）
后端框架：   无（http.createServer）
SCF 包大小： 97KB（优化后）
冷启动时间： < 1 秒
```

---

## 八、写给自己

做这个项目的初衷很简单——我就是那个每天要在四个网站之间横跳的财务人。用最少的依赖、最短的代码栈、最直白的方式把重复劳动自动化，比什么都重要。

没有用 React 不是因为不会，而是因为不需要。一个 Node.js 进程 + 两个 HTML 文件，能跑、好用、能维护，就是最好的技术方案。

如果你也是财务/审计/投行从业者，或者对"原生无框架全栈开发"感兴趣，欢迎交流。

---

*文章首发于腾讯云社区，代码已做脱敏处理。*
