# FastOutlook

本地运行的 Outlook 邮件抓取工具。

支持：

- 批量导入账号
- `IMAP OAuth2` / `Microsoft Graph`
- 关键词和发件人筛选
- 后台抓取，刷新页面不中断
- 验证码优先模式：默认只看最近邮件，自动提取并高亮验证码
- 快速刷新：普通列表只抓取轻量邮件头，正文点击后按需加载
- 多账号并发抓取，可通过 `FETCH_CONCURRENCY` 调整并发数
- 点击查看邮件正文
- Docker / Docker Compose 部署
- 打包为单文件 `exe`

## 开发启动

```bash
npm install
npm run dev
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3001`

## Docker 部署

Docker Compose：

```bash
docker compose up -d --build
```

访问：

```text
http://127.0.0.1:3001
```

数据会保存到 `fastoutlook-data` volume 的 `/app/data` 中。

单独使用 Docker：

```bash
docker build -t fastoutlook .
docker run -d --name fastoutlook \
  -p 3001:3001 \
  -e DOCKER=1 \
  -e HOST=0.0.0.0 \
  -e FETCH_CONCURRENCY=5 \
  -v fastoutlook-data:/app/data \
  fastoutlook
```

## 打包 EXE

```bash
npm run build:exe
```

输出文件：

```text
release/OutlookFastMail.exe
```

## 验证码模式

默认开启「只看验证码」，适合登录/注册验证码场景：

- 默认只抓最近 `30` 分钟、每账号 `2` 封左右的新邮件
- 可把扫描数量调到 `1/2/3/5/10` 封，验证码场景建议保持 `1-2` 封
- 能从中文/英文验证码邮件中提取 `4-10` 位数字或字母数字验证码
- 结果卡片会直接高亮验证码，点击验证码即可复制
- 结果区提供「复制最新验证码」按钮
- 如果要看普通历史邮件，关闭「只看验证码」即可

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

- `HOST`：监听地址，本地默认 `127.0.0.1`，Docker 默认 `0.0.0.0`
- `FETCH_CONCURRENCY`：多账号抓取并发数，默认 `5`，最大 `20`
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_TENANT`
- `MS_REDIRECT_URI`

## 注意

- `data/store.json` 包含本地账号和 token，不要提交
- 不要提交 `.env`、`node_modules/`、`dist/`、`build/`、`release/`
- 只用于读取你自己有权限访问的邮箱
