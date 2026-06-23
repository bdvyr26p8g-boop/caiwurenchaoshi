# 财务人超市 🛒

聚合证监会法规、上市公司公告、IPO问询函、会计视野论坛、12366税务咨询的一站式检索平台。

## 功能

| 标签页 | 数据源 | 说明 |
|--------|--------|------|
| 📋 公告与问询 | 巨潮资讯网 + 上交所 + 深交所 | 上市公司公告全文检索 + IPO/再融资问询函 |
| ⚖️ 法律法规 | 中国证监会法规数据库 | 关键词/文号/发文单位/日期筛选 |
| 📚 会计视野 | bbs.esnai.cn | 论坛全文搜索，支持版块和日期筛选 |
| 💼 税务咨询 | 12366纳税服务平台 | 税务问答检索，支持地区和日期筛选 |

## 技术栈

- **前端**：原生 HTML/CSS/JS，零框架
- **后端**：Node.js 原生 http 模块，零框架
- **依赖**：pdf-parse（PDF正文解析）、iconv-lite（GBK编解码）

## 本地运行

```bash
npm install
node server.js
# 访问 http://localhost:3456
```

## 部署

### Render（免费后端）
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### GitHub Pages（免费前端）
将 `public/` 部署到 GitHub Pages，API 地址指向 Render 后端。

## 许可证

MIT
