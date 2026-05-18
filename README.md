# FastOutlook

本地运行的 Outlook 邮件抓取工具。

支持：

- 批量导入账号
- `IMAP OAuth2` / `Microsoft Graph`
- 关键词和发件人筛选
- 后台抓取，刷新页面不中断
- 点击查看邮件正文
- 打包为单文件 `exe`

## 开发启动

```bash
npm install
npm run dev
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3001`

## 打包 EXE

```bash
npm run build:exe
```

输出文件：

```text
release/OutlookFastMail.exe
```

## 导入格式

```text
email----password----client_id----refresh_token
email|refresh_token|client_id|client_secret|tenant
```

也支持：

```json
{"email":"me@outlook.com","refreshToken":"0.AAA...","clientId":"...","tenant":"consumers"}
```

## 环境变量

复制模板：

```bash
copy .env.example .env
```

常用项：

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_TENANT`
- `MS_REDIRECT_URI`

## 注意

- `data/store.json` 包含本地账号和 token，不要提交
- 不要提交 `.env`、`node_modules/`、`dist/`、`build/`、`release/`
- 只用于读取你自己有权限访问的邮箱
