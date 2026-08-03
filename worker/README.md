# 安全 Gemini 代理

这个 Worker 是网页访问 Gemini 的唯一入口。`GEMINI_API_KEY` 只存在于 Cloudflare Secret 中，
不会发送到浏览器，也不会写入 Git 仓库。

## 部署

1. 将 `wrangler.toml` 中的 `ALLOWED_ORIGINS` 改为精确的 GitHub Pages Origin，例如
   `https://example.github.io`。不要填写 `*`。
2. 在 `worker/` 目录运行：

   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put LODGE_ACCESS_TOKEN
   npx wrangler deploy
   ```

3. 在网页“安全 AI 代理”中填入 Worker URL 和 `LODGE_ACCESS_TOKEN`。
   Worker URL 可安全保存；访问令牌只保存在当前页面内存中，刷新后必须重新输入。

## 上线前安全清单

- 如果 Gemini Key 曾经写入网页或浏览器，请在 Google AI Studio 立即撤销并重新创建。
- 为 Worker 路由启用 Cloudflare Rate Limiting/WAF，限制每个 IP 的请求频率与每日额度。
- 将 Gemini 项目的消费额度与告警设为可承受的最低值。
- 不要把 `LODGE_ACCESS_TOKEN` 写进 HTML、GitHub Actions 日志或仓库变量输出。
- 定期轮换两个 Secret；怀疑泄漏时先撤销，再调查。
