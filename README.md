# FastOutlook

一个本地运行的 Outlook 邮件抓取工具，支持：

- 批量导入 Outlook 账号
- `IMAP OAuth2` 和 `Microsoft Graph` 两种协议
- 关键词筛选、发件人筛选、数量限制
- 后台抓取任务，刷新页面不中断
- 浏览器本地记录
- 单文件 `.exe` 打包运行
- 点击邮件查看正文

## 技术栈

- 前端：React + Vite
- 后端：Express
- IMAP：[`imapflow`](https://github.com/postalsys/imapflow)
- 邮件解析：[`mailparser`](https://github.com/nodemailer/mailparser)
- Graph API：Microsoft Graph REST API

## 启动开发环境

```bash
npm install
npm run dev
```

默认地址：

- 前端：<http://127.0.0.1:5173>
- 后端：<http://127.0.0.1:3001>

## 本地直接运行

开发模式：

```bash
npm start
```

Windows 下也可以使用：

- `start-app.bat`
- `stop-app.bat`

## 打包单文件 EXE

```bash
npm run build:exe
```

生成文件位置：

```text
release/OutlookFastMail.exe
```

## 账号导入格式

支持以下格式：

```text
email----password----client_id----refresh_token
email|refresh_token|client_id|client_secret|tenant
```

也支持 JSON 行格式：

```json
{"email":"me@outlook.com","refreshToken":"0.AAA...","clientId":"...","tenant":"consumers"}
```

说明：

- `password` 字段会被忽略，实际使用的是 `refresh_token`
- `client_secret` 可以为空
- 个人 Outlook/Hotmail 账号常用 `tenant=common` 或 `tenant=consumers`

## OAuth 配置

复制模板文件：

```bash
copy .env.example .env
```

在 `.env` 中填写：

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_TENANT`
- `MS_REDIRECT_URI`

默认回调地址：

```text
http://127.0.0.1:3001/auth/callback
```

## 数据说明

本地账号数据默认保存在：

```text
data/store.json
```

这个文件包含本地导入账号信息和刷新令牌，不应提交到公开仓库。

## 发布建议

源码仓库建议只提交：

- `src/`
- `server/`
- `package.json`
- `package-lock.json`
- `.env.example`
- `.gitignore`
- `README.md`
- `vite.config.js`
- `index.html`
- `start-app.bat`
- `stop-app.bat`

不要提交：

- `data/`
- `.env`
- `node_modules/`
- `dist/`
- `build/`
- `release/`
- 日志文件

## 使用边界

这个工具仅适用于读取你自己有权访问的邮箱账号。请不要导入来源不明的 token、账号或凭据。
