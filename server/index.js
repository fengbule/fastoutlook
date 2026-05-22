import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import crypto from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { simpleParser } from 'mailparser';

const isPackaged = Boolean(process.pkg);
const currentScriptPath = isPackaged
  ? process.execPath
  : (process.argv[1] ? path.resolve(process.argv[1]) : path.resolve('server', 'index.js'));
const currentDir = path.dirname(currentScriptPath);
const rootDir = isPackaged && typeof __dirname !== 'undefined'
  ? path.resolve(__dirname, '..')
  : path.resolve(currentDir, '..');
const require = createRequire(currentScriptPath);

const appDataRoot = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dataDir = isPackaged
  ? path.join(appDataRoot, 'OutlookFastMail', 'data')
  : path.join(rootDir, 'data');
const storePath = path.join(dataDir, 'store.json');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || (process.env.DOCKER === '1' ? '0.0.0.0' : '127.0.0.1');
const fetchConcurrency = Math.max(1, Math.min(Number(process.env.FETCH_CONCURRENCY || 5), 20));

const GRAPH_SCOPES = 'openid offline_access profile email https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read';
const GRAPH_REFRESH_SCOPES = 'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read';
const IMAP_SCOPES = 'openid offline_access profile email https://outlook.office.com/IMAP.AccessAsUser.All';
const IMAP_REFRESH_SCOPES = 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All';

const pendingAuth = new Map();
const fetchTasks = new Map();
const messageDetailCache = new Map();
const accessTokenCache = new Map();
const TASK_RETENTION_LIMIT = 20;
const MESSAGE_CACHE_LIMIT = 2000;
const ACCESS_TOKEN_CACHE_SKEW_MS = 60 * 1000;
let latestTaskId = '';
let httpServer;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

function nowIso() {
  return new Date().toISOString();
}

function maybeOpenBrowser(url) {
  if (!isPackaged && process.env.AUTO_OPEN_BROWSER !== '1') return;

  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
    return;
  }

  if (process.platform === 'darwin') {
    exec(`open "${url}"`);
    return;
  }

  exec(`xdg-open "${url}"`);
}

function ensureDiagnosticsChannelCompat() {
  if (typeof diagnosticsChannel.tracingChannel === 'function') return;

  diagnosticsChannel.tracingChannel = () => ({
    traceSync(fn, thisArg, ...args) {
      return typeof fn === 'function' ? fn.apply(thisArg, args) : undefined;
    },
    subscribe() {},
    unsubscribe() {},
  });
}

function getImapFlowClass() {
  ensureDiagnosticsChannelCompat();
  return require('imapflow').ImapFlow;
}

function tokenEndpoint(tenant) {
  return `https://login.microsoftonline.com/${tenant || process.env.MS_TENANT || 'consumers'}/oauth2/v2.0/token`;
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    tenant: account.tenant || process.env.MS_TENANT || 'consumers',
    clientId: account.clientId ? mask(account.clientId) : '',
    hasRefreshToken: Boolean(account.refreshToken),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastStatus: account.lastStatus || null,
  };
}

function shortError(error) {
  const data = error?.response?.data;
  if (data?.error_description) return `${data.error}: ${data.error_description}`;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return error?.message || String(error);
}

function cleanBodyText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToText(value = '') {
  return cleanBodyText(
    decodeHtmlEntities(String(value || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|tr|table|h[1-6])>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' '),
  );
}

function buildBodyText(text, html, preview = '') {
  return cleanBodyText(text) || htmlToText(html) || cleanBodyText(preview);
}

function makeMessageCacheKey(protocol, accountId, messageId) {
  return `${String(protocol || '').toUpperCase()}:${accountId}:${messageId}`;
}

function makeAccessTokenCacheKey(protocol, account) {
  return `${String(protocol || '').toLowerCase()}:${account.id}:${account.refreshToken || account.accessToken || ''}`;
}

function getCachedAccessToken(protocol, account) {
  const cached = accessTokenCache.get(makeAccessTokenCacheKey(protocol, account));
  if (!cached) return '';
  if (Date.now() + ACCESS_TOKEN_CACHE_SKEW_MS >= cached.expiresAt) {
    accessTokenCache.delete(makeAccessTokenCacheKey(protocol, account));
    return '';
  }
  return cached.accessToken;
}

function cacheAccessToken(protocol, account, tokenData = {}) {
  if (!tokenData.access_token) return;
  const expiresIn = Math.max(Number(tokenData.expires_in || 3600), 60);
  accessTokenCache.set(makeAccessTokenCacheKey(protocol, account), {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
}

function pruneMessageDetailCache() {
  if (messageDetailCache.size <= MESSAGE_CACHE_LIMIT) return;

  const ordered = [...messageDetailCache.values()].sort((a, b) => {
    return new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime();
  });

  while (ordered.length > MESSAGE_CACHE_LIMIT) {
    const item = ordered.shift();
    if (item) {
      messageDetailCache.delete(item.key);
    }
  }
}

function cacheMessageDetail(message) {
  if (!message?.accountId || !message?.id || !message?.protocol) return;

  const key = makeMessageCacheKey(message.protocol, message.accountId, message.id);
  messageDetailCache.set(key, {
    key,
    cachedAt: nowIso(),
    message: {
      id: message.id,
      accountId: message.accountId,
      accountEmail: message.accountEmail,
      protocol: message.protocol,
      subject: message.subject,
      from: message.from,
      fromName: message.fromName,
      receivedAt: message.receivedAt,
      preview: message.preview || '',
      bodyText: message.bodyText || '',
    },
  });
  pruneMessageDetailCache();
}

function getCachedMessageDetail(protocol, accountId, messageId) {
  const key = makeMessageCacheKey(protocol, accountId, messageId);
  return messageDetailCache.get(key)?.message || null;
}

function protocolLabel(protocol) {
  return protocol === 'imap' ? 'IMAP' : 'Graph';
}

function classifyFetchError(account, protocol, error) {
  const rawMessage = shortError(error);
  const previousProtocol = account.lastStatus?.ok ? account.lastStatus.protocol : '';
  const selectedLabel = protocolLabel(protocol);
  const previousLabel = previousProtocol ? protocolLabel(previousProtocol) : '';
  let code = 'FETCH_ERROR';
  let hint = '';

  if (protocol === 'graph') {
    if (/Mail\.Read|No applicable permissions|insufficient_scope|InvalidAuthenticationToken/i.test(rawMessage)) {
      code = 'GRAPH_SCOPE_MISSING';
      hint = '这个账号看起来缺少 Graph 的 Mail.Read 权限。可以先尝试 IMAP，或重新做 Graph OAuth 授权。';
    } else if (/refresh_token|invalid_grant|AADSTS70000|AADSTS700082|AADSTS50173|not valid/i.test(rawMessage)) {
      code = 'GRAPH_TOKEN_INVALID';
      hint = previousProtocol === 'imap'
        ? `这个账号上次成功使用的是 ${previousLabel}，你当前使用的是 ${selectedLabel}，建议切回 ${previousLabel} 后重试。`
        : '这个 Graph 刷新令牌无效或已过期。可以先尝试 IMAP，或重新为该账号做 Graph 授权。';
    }
  }

  if (protocol === 'imap') {
    if (/AUTHENTICATE failed|AUTHENTICATIONFAILED|Login failed|No applicable permissions|IMAP\.AccessAsUser\.All|AUTHORIZATIONFAILED/i.test(rawMessage)) {
      code = 'IMAP_SCOPE_MISSING';
      hint = previousProtocol === 'graph'
        ? `这个账号上次成功使用的是 ${previousLabel}，你当前使用的是 ${selectedLabel}，建议切回 ${previousLabel} 后重试。`
        : '这个账号看起来缺少 IMAP 权限，或者当前令牌并不是给 IMAP 用的。可以先尝试 Graph。';
    }
  }

  if (!hint && previousProtocol && previousProtocol !== protocol && /invalid_grant|AUTHENTICATE failed|No applicable permissions|not valid/i.test(rawMessage)) {
    code = 'PROTOCOL_MISMATCH_SUSPECTED';
    hint = `这个账号上次成功使用的是 ${previousLabel}，你当前使用的是 ${selectedLabel}，建议切回 ${previousLabel} 后重试。`;
  }

  return {
    accountId: account.id,
    email: account.email,
    protocol,
    message: rawMessage,
    hint,
    code,
  };
}

function isRefreshToken(value = '') {
  return /^(0\.|M\.)/i.test(value) || value.length > 80;
}

function isGuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeAccountTokens(input = {}) {
  const normalized = { ...input };
  const refreshToken = normalized.refreshToken || normalized.refresh_token || '';
  const clientSecret = normalized.clientSecret || normalized.client_secret || '';

  normalized.refreshToken = refreshToken;
  normalized.clientSecret = clientSecret;
  delete normalized.refresh_token;
  delete normalized.client_secret;

  if (!isRefreshToken(refreshToken) && isRefreshToken(clientSecret)) {
    normalized.refreshToken = clientSecret;
    normalized.clientSecret = '';
  }

  return normalized;
}

async function readStore() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(storePath)) {
    return { accounts: [] };
  }

  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf8'));
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    let changed = false;
    const normalizedAccounts = accounts.map((account) => {
      const normalized = normalizeAccountTokens(account);
      if (
        normalized.refreshToken !== account.refreshToken
        || normalized.clientSecret !== account.clientSecret
      ) {
        changed = true;
      }
      return normalized;
    });

    const store = { ...parsed, accounts: normalizedAccounts };
    if (changed) {
      await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
    }
    return store;
  } catch {
    return { accounts: [] };
  }
}

async function writeStore(store) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
}

function makeAccountId(email, clientId = '') {
  return crypto.createHash('sha1').update(`${email.toLowerCase()}|${clientId}`).digest('hex').slice(0, 16);
}

async function upsertAccount(input) {
  const normalizedInput = normalizeAccountTokens(input);
  const email = String(normalizedInput.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('需要填写有效的邮箱地址。');
  }

  const account = {
    id: normalizedInput.id || makeAccountId(email, normalizedInput.clientId || process.env.MS_CLIENT_ID || ''),
    email,
    refreshToken: normalizedInput.refreshToken || '',
    accessToken: normalizedInput.accessToken || normalizedInput.access_token || '',
    clientId: normalizedInput.clientId || normalizedInput.client_id || process.env.MS_CLIENT_ID || '',
    clientSecret: normalizedInput.clientSecret || normalizedInput.client_secret || process.env.MS_CLIENT_SECRET || '',
    tenant: normalizedInput.tenant || process.env.MS_TENANT || 'consumers',
    createdAt: normalizedInput.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastStatus: normalizedInput.lastStatus || null,
  };

  const store = await readStore();
  const index = store.accounts.findIndex((item) => item.id === account.id || item.email === account.email);
  if (index >= 0) {
    store.accounts[index] = { ...store.accounts[index], ...account, createdAt: store.accounts[index].createdAt };
  } else {
    store.accounts.push(account);
  }

  await writeStore(store);
  return account;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  const separator = ['----', '|', ',', ';', '\t'].find((candidate) => trimmed.includes(candidate));
  const parts = separator ? trimmed.split(separator).map((item) => item.trim()) : trimmed.split(/\s+/);

  if (parts.length >= 4 && !isRefreshToken(parts[1]) && isGuid(parts[2]) && isRefreshToken(parts[3])) {
    const [email, password, clientId, refreshToken, tenant] = parts;
    return { email, password, clientId, refreshToken, tenant };
  }

  const [email, refreshToken, clientId, clientSecret, tenant] = parts;
  return { email, refreshToken, clientId, clientSecret, tenant };
}

function tenantCandidates(tenant) {
  const ordered = [
    tenant,
    'common',
    'consumers',
    'organizations',
    '9188040d-6c67-4c5b-b112-36a304b66dad',
  ].filter(Boolean);

  return [...new Set(ordered)];
}

async function saveOAuthState(account, tokenData, tenant) {
  const store = await readStore();
  const saved = store.accounts.find((item) => item.id === account.id);
  if (!saved) return;

  if (tokenData.refresh_token) saved.refreshToken = tokenData.refresh_token;
  if (tenant) saved.tenant = tenant;
  saved.updatedAt = nowIso();
  await writeStore(store);
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function saveAccountStatus(accountId, status) {
  const store = await readStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) return;

  account.lastStatus = { ...status, at: nowIso() };
  account.updatedAt = nowIso();
  await writeStore(store);
}

async function refreshAccessToken(account, protocol) {
  if (account.accessToken && !account.refreshToken) {
    return account.accessToken;
  }

  const cached = getCachedAccessToken(protocol, account);
  if (cached) return cached;

  if (!account.refreshToken) {
    throw new Error('这个账号缺少刷新令牌。');
  }

  const clientId = account.clientId || process.env.MS_CLIENT_ID;
  if (!clientId) {
    throw new Error('缺少 client_id。请在导入内容里提供，或设置 MS_CLIENT_ID。');
  }

  let lastError;
  for (const tenant of tenantCandidates(account.tenant)) {
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', account.refreshToken);
    params.set('scope', protocol === 'imap' ? IMAP_REFRESH_SCOPES : GRAPH_REFRESH_SCOPES);

    if (account.clientSecret || process.env.MS_CLIENT_SECRET) {
      params.set('client_secret', account.clientSecret || process.env.MS_CLIENT_SECRET);
    }

    try {
      const response = await axios.post(tokenEndpoint(tenant), params, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      });
      await saveOAuthState(account, response.data, tenant);
      cacheAccessToken(protocol, account, response.data);
      return response.data.access_token;
    } catch (error) {
      lastError = error;
      const message = shortError(error);
      const canTryNextTenant = /AADSTS7000012|different tenant/i.test(message);
      if (!canTryNextTenant) {
        throw error;
      }
    }
  }

  throw lastError;
}

function extractVerificationCode(...parts) {
  const text = parts
    .filter(Boolean)
    .map((part) => String(part))
    .join('\n')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, ' ');

  const labeledPatterns = [
    /(?:验证码|校验码|动态码|确认码|安全码|验证代码|verification code|security code|auth(?:entication)? code|login code|one[-\s]?time code|otp)[^\dA-Z]{0,30}([A-Z0-9]{4,10})/i,
    /([A-Z0-9]{4,10})[^\dA-Z]{0,30}(?:验证码|校验码|动态码|确认码|安全码|verification code|security code|auth(?:entication)? code|login code|one[-\s]?time code|otp)/i,
  ];

  for (const pattern of labeledPatterns) {
    const match = text.match(pattern);
    if (match?.[1] && /\d/.test(match[1])) return match[1].toUpperCase();
  }

  const fallback = text.match(/(?<![A-Z0-9])([0-9]{4,8}|[A-Z0-9]{6,10})(?![A-Z0-9])/i);
  return fallback?.[1]?.toUpperCase() || '';
}

function mailMatches(mail, query, sender, codeMode = false) {
  const q = String(query || '').trim().toLowerCase();
  const s = String(sender || '').trim().toLowerCase();
  const haystack = `${mail.subject || ''} ${mail.preview || ''} ${mail.from || ''} ${mail.verificationCode || ''}`.toLowerCase();
  if (codeMode && !mail.verificationCode && !q && !s) return false;
  if (q && !haystack.includes(q)) return false;
  if (s && !String(mail.from || '').toLowerCase().includes(s)) return false;
  return true;
}

function recentCutoffIso(recentMinutes) {
  const minutes = Math.max(1, Math.min(Number(recentMinutes) || 30, 1440));
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function isRecentEnough(value, recentMinutes) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return true;
  return time >= new Date(recentCutoffIso(recentMinutes)).getTime();
}

async function fetchGraphMail(account, { limit, query, sender, codeMode, recentMinutes }) {
  const accessToken = await refreshAccessToken(account, 'graph');
  const top = Math.max(1, Math.min(Number(limit) || 2, 50));
  const params = {
    $top: Math.max(top, codeMode ? top : 25),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,sender,receivedDateTime,bodyPreview',
  };
  if (codeMode) {
    params.$filter = `receivedDateTime ge ${recentCutoffIso(recentMinutes)}`;
  }

  const response = await axios.get('https://graph.microsoft.com/v1.0/me/messages', {
    params,
    headers: {
      authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
    timeout: 30000,
  });

  const mails = response.data.value.map((item) => {
      const detail = {
        id: item.id,
        accountId: account.id,
        accountEmail: account.email,
        protocol: 'Graph',
        subject: item.subject || '(No subject)',
        from: item.from?.emailAddress?.address || item.sender?.emailAddress?.address || '',
        fromName: item.from?.emailAddress?.name || item.sender?.emailAddress?.name || '',
        receivedAt: item.receivedDateTime,
        preview: cleanBodyText(item.bodyPreview || ''),
        bodyText: '',
      };

      const verificationCode = extractVerificationCode(detail.subject, detail.preview);
      return {
        id: detail.id,
        accountId: detail.accountId,
        accountEmail: detail.accountEmail,
        protocol: detail.protocol,
        subject: detail.subject,
        from: detail.from,
        fromName: detail.fromName,
        receivedAt: detail.receivedAt,
        preview: detail.preview || detail.bodyText.slice(0, 240),
        verificationCode,
      };
    });

  if (codeMode) {
    const missingCodeMails = mails.filter((mail) => !mail.verificationCode).slice(0, top);
    await Promise.all(missingCodeMails.map(async (mail) => {
      try {
        const detail = await fetchGraphMessageDetail(account, mail.id);
        mail.preview = detail.preview || mail.preview;
        mail.verificationCode = extractVerificationCode(detail.subject, detail.preview, detail.bodyText);
      } catch {
        // Keep preview-only result if full-body lookup fails.
      }
    }));
  }

  return mails
    .filter((mail) => mailMatches(mail, query, sender, codeMode))
    .slice(0, top);
}

function formatAddress(address = {}) {
  const mailbox = address.mailbox || '';
  const hostName = address.host || '';
  return mailbox && hostName ? `${mailbox}@${hostName}` : mailbox;
}

function imapEnvelopeDate(message) {
  const date = message.internalDate || message.envelope?.date || new Date();
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

async function fetchImapMail(account, { limit, query, sender, codeMode, recentMinutes }) {
  const ImapFlow = getImapFlowClass();
  const accessToken = await refreshAccessToken(account, 'imap');
  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: account.email,
      accessToken,
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const top = Math.max(1, Math.min(Number(limit) || 2, 50));
      const exists = client.mailbox.exists || 0;
      if (!exists) return [];

      const shouldOverfetch = Boolean(String(query || sender || '').trim());
      const start = Math.max(1, exists - Math.max(top * (codeMode ? 2 : shouldOverfetch ? 5 : 2), codeMode ? top : shouldOverfetch ? 50 : top) + 1);
      const range = `${start}:*`;
      const mails = [];

      for await (const message of client.fetch(range, { envelope: true, internalDate: true, source: Boolean(codeMode) }, { uid: true })) {
        const fromItem = message.envelope?.from?.[0] || {};
        const receivedAt = imapEnvelopeDate(message);
        if (codeMode && !isRecentEnough(receivedAt, recentMinutes)) continue;

        let preview = '点击查看邮件正文';
        let verificationCode = '';
        if (codeMode && message.source) {
          const parsed = await simpleParser(message.source);
          const text = buildBodyText(parsed?.text, parsed?.html, '');
          preview = text.replace(/\s+/g, ' ').slice(0, 240) || preview;
          verificationCode = extractVerificationCode(message.envelope?.subject, text);
        }

        const mail = {
          id: String(message.uid || message.seq),
          accountId: account.id,
          accountEmail: account.email,
          protocol: 'IMAP',
          subject: message.envelope?.subject || '(No subject)',
          from: formatAddress(fromItem),
          fromName: fromItem.name || '',
          receivedAt,
          preview,
          verificationCode,
        };

        if (mailMatches(mail, query, sender, codeMode)) {
          mails.push(mail);
        }
      }

      return mails.reverse().slice(0, top);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function fetchGraphMessageDetail(account, messageId) {
  const cached = getCachedMessageDetail('Graph', account.id, messageId);
  if (cached) return cached;

  const accessToken = await refreshAccessToken(account, 'graph');
  const response = await axios.get(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
    params: {
      $select: 'id,subject,from,sender,receivedDateTime,body,bodyPreview',
    },
    headers: {
      authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
    timeout: 30000,
  });

  const item = response.data;
  const detail = {
    id: item.id,
    accountId: account.id,
    accountEmail: account.email,
    protocol: 'Graph',
    subject: item.subject || '(No subject)',
    from: item.from?.emailAddress?.address || item.sender?.emailAddress?.address || '',
    fromName: item.from?.emailAddress?.name || item.sender?.emailAddress?.name || '',
    receivedAt: item.receivedDateTime,
    preview: item.bodyPreview || '',
    bodyText: buildBodyText(item.body?.content, '', item.bodyPreview),
  };

  cacheMessageDetail(detail);
  return detail;
}

async function fetchImapMessageDetail(account, messageId) {
  const cached = getCachedMessageDetail('IMAP', account.id, messageId);
  if (cached) return cached;

  const ImapFlow = getImapFlowClass();
  const accessToken = await refreshAccessToken(account, 'imap');
  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: account.email,
      accessToken,
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let targetMessage = null;
      for await (const message of client.fetch(String(messageId), { envelope: true, source: true, internalDate: true }, { uid: true })) {
        targetMessage = message;
        break;
      }

      if (!targetMessage) {
        throw new Error('未找到这封邮件，可能已经被移动或删除。');
      }

      const parsed = targetMessage.source ? await simpleParser(targetMessage.source) : null;
      const from = parsed?.from?.value?.[0]?.address || targetMessage.envelope?.from?.[0]?.address || '';
      const fromName = parsed?.from?.value?.[0]?.name || targetMessage.envelope?.from?.[0]?.name || '';
      const preview = String(parsed?.text || parsed?.html || '').replace(/\s+/g, ' ').slice(0, 240);

      const detail = {
        id: String(targetMessage.uid || targetMessage.seq || messageId),
        accountId: account.id,
        accountEmail: account.email,
        protocol: 'IMAP',
        subject: parsed?.subject || targetMessage.envelope?.subject || '(No subject)',
        from,
        fromName,
        receivedAt: (targetMessage.internalDate || parsed?.date || new Date()).toISOString(),
        preview,
        bodyText: buildBodyText(parsed?.text, parsed?.html, preview),
      };

      cacheMessageDetail(detail);
      return detail;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function collectMessages(accounts, protocol, options, hooks = {}) {
  const messages = [];
  const errors = [];
  let cursor = 0;

  async function worker() {
    while (cursor < accounts.length) {
      const account = accounts[cursor];
      cursor += 1;
      hooks.onAccountStart?.(account);
      try {
        const fetched = protocol === 'graph'
          ? await fetchGraphMail(account, options)
          : await fetchImapMail(account, options);

        messages.push(...fetched);
        await saveAccountStatus(account.id, { ok: true, protocol, count: fetched.length });
        hooks.onAccountSuccess?.(account, fetched);
      } catch (error) {
        const classified = classifyFetchError(account, protocol, error);
        errors.push(classified);
        await saveAccountStatus(account.id, {
          ok: false,
          protocol,
          message: classified.message,
          hint: classified.hint,
          code: classified.code,
        });
        hooks.onAccountError?.(account, classified);
      } finally {
        hooks.onAccountFinish?.(account);
      }
    }
  }

  const workerCount = Math.min(fetchConcurrency, accounts.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  messages.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return { messages, errors, total: messages.length };
}

function makeTaskId() {
  return crypto.randomBytes(8).toString('hex');
}

function pruneTasks() {
  if (fetchTasks.size <= TASK_RETENTION_LIMIT) return;

  const ordered = [...fetchTasks.values()].sort((a, b) => {
    return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  });

  while (ordered.length > TASK_RETENTION_LIMIT) {
    const task = ordered.shift();
    if (task) {
      fetchTasks.delete(task.id);
    }
  }
}

function taskStateFromResults(task) {
  if (task.errors.length && task.messages.length) return 'partial';
  if (task.errors.length) return 'failed';
  return 'completed';
}

function taskSnapshot(task) {
  return {
    id: task.id,
    status: task.status,
    protocol: task.protocol,
    query: task.query,
    sender: task.sender,
    limit: task.limit,
    totalAccounts: task.totalAccounts,
    processedAccounts: task.processedAccounts,
    currentAccountEmail: task.currentAccountEmail,
    totalMessages: task.messages.length,
    messages: task.messages,
    errors: task.errors,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function createTask(payload) {
  const task = {
    id: makeTaskId(),
    status: 'queued',
    protocol: payload.protocol === 'graph' ? 'graph' : 'imap',
    query: String(payload.query || ''),
    sender: String(payload.sender || ''),
    limit: Number(payload.limit) || 2,
    codeMode: payload.codeMode !== false,
    recentMinutes: Math.max(1, Math.min(Number(payload.recentMinutes) || 30, 1440)),
    accountIds: Array.isArray(payload.accountIds) ? payload.accountIds : [],
    totalAccounts: Array.isArray(payload.accountIds) ? payload.accountIds.length : 0,
    processedAccounts: 0,
    currentAccountEmail: '',
    messages: [],
    errors: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  fetchTasks.set(task.id, task);
  latestTaskId = task.id;
  pruneTasks();
  return task;
}

async function runTask(task) {
  task.status = 'running';
  task.updatedAt = nowIso();

  try {
    const store = await readStore();
    const ids = new Set(task.accountIds);
    const accounts = store.accounts.filter((account) => ids.has(account.id));
    task.totalAccounts = accounts.length;
    task.updatedAt = nowIso();

    const result = await collectMessages(accounts, task.protocol, task, {
      onAccountStart(account) {
        task.currentAccountEmail = account.email;
        task.updatedAt = nowIso();
      },
      onAccountSuccess(account, fetched) {
        task.messages.push(...fetched);
        task.updatedAt = nowIso();
      },
      onAccountError(account, classified) {
        task.errors.push(classified);
        task.updatedAt = nowIso();
      },
      onAccountFinish() {
        task.processedAccounts += 1;
        task.updatedAt = nowIso();
      },
    });

    task.messages = result.messages;
    task.errors = result.errors;
    task.status = taskStateFromResults(task);
    task.currentAccountEmail = '';
    task.updatedAt = nowIso();
  } catch (error) {
    task.status = 'failed';
    task.currentAccountEmail = '';
    task.errors.push({
      id: `task-fatal-${task.id}`,
      email: 'System',
      protocol: task.protocol,
      message: shortError(error),
      hint: '后台任务意外中断了。',
      code: 'TASK_FATAL',
    });
    task.updatedAt = nowIso();
  }
}

function startTask(task) {
  setImmediate(() => {
    runTask(task).catch(() => {});
  });
}

async function latestTaskSnapshot() {
  if (!latestTaskId) {
    return null;
  }

  const task = fetchTasks.get(latestTaskId);
  return task ? taskSnapshot(task) : null;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: nowIso(), packaged: isPackaged });
});

app.get('/api/accounts', async (req, res) => {
  const store = await readStore();
  res.json({ accounts: store.accounts.map(publicAccount) });
});

app.post('/api/accounts/import', async (req, res) => {
  const lines = String(req.body.text || '').split(/\r?\n/);
  const imported = [];
  const errors = [];

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = parseLine(line);
      const account = await upsertAccount(parsed);
      imported.push(publicAccount(account));
    } catch (error) {
      errors.push({ line: index + 1, message: shortError(error) });
    }
  }

  res.json({ imported, errors });
});

app.delete('/api/accounts', async (req, res) => {
  const ids = new Set(req.body.ids || []);
  const store = await readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((account) => !ids.has(account.id));
  await writeStore(store);
  res.json({ deleted: before - store.accounts.length });
});

app.post('/api/auth-url', async (req, res) => {
  const clientId = req.body.clientId || process.env.MS_CLIENT_ID;
  if (!clientId) {
    return res.status(400).json({ error: '缺少 client_id。' });
  }

  const tenant = req.body.tenant || process.env.MS_TENANT || 'consumers';
  const protocol = req.body.protocol === 'imap' ? 'imap' : 'graph';
  const redirectUri = req.body.redirectUri || process.env.MS_REDIRECT_URI || `http://127.0.0.1:${port}/auth/callback`;
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const scope = protocol === 'imap' ? IMAP_SCOPES : GRAPH_SCOPES;

  pendingAuth.set(state, {
    verifier,
    clientId,
    clientSecret: req.body.clientSecret || process.env.MS_CLIENT_SECRET || '',
    tenant,
    redirectUri,
    protocol,
    createdAt: Date.now(),
  });

  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  res.json({ url: url.toString(), redirectUri, scope });
});

app.get('/auth/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  const meta = pendingAuth.get(state);
  pendingAuth.delete(state);

  if (!meta || !code) {
    return res.status(400).send('<h2>授权失败</h2><p>state 或 code 无效，请重新生成授权链接后再试。</p>');
  }

  try {
    const params = new URLSearchParams();
    params.set('client_id', meta.clientId);
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', meta.redirectUri);
    params.set('code_verifier', meta.verifier);
    params.set('scope', meta.protocol === 'imap' ? IMAP_SCOPES : GRAPH_SCOPES);
    if (meta.clientSecret) params.set('client_secret', meta.clientSecret);

    const tokenResponse = await axios.post(tokenEndpoint(meta.tenant), params, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    const payload = decodeJwtPayload(tokenResponse.data.id_token || tokenResponse.data.access_token || '');
    const email = payload.preferred_username || payload.email || payload.upn;
    if (!email) {
      throw new Error('授权成功，但令牌中没有解析到邮箱地址。');
    }

    await upsertAccount({
      email,
      refreshToken: tokenResponse.data.refresh_token,
      accessToken: tokenResponse.data.access_token,
      clientId: meta.clientId,
      clientSecret: meta.clientSecret,
      tenant: meta.tenant,
    });

    res.send('<h2>授权完成</h2><p>账号已经保存，你可以回到程序里刷新列表。</p>');
  } catch (error) {
    const safe = shortError(error).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    res.status(500).send(`<h2>授权失败</h2><pre>${safe}</pre>`);
  }
});

app.post('/api/fetch', async (req, res) => {
  const store = await readStore();
  const ids = new Set(req.body.accountIds || []);
  const protocol = req.body.protocol === 'graph' ? 'graph' : 'imap';
  const selected = store.accounts.filter((account) => ids.has(account.id));
  const result = await collectMessages(selected, protocol, req.body);
  res.json(result);
});

app.post('/api/tasks/fetch', async (req, res) => {
  const task = createTask(req.body);
  startTask(task);
  res.json({ task: taskSnapshot(task) });
});

app.post('/api/message-detail', async (req, res) => {
  try {
    const accountId = String(req.body.accountId || '');
    const messageId = String(req.body.messageId || '');
    const protocol = String(req.body.protocol || '').toLowerCase() === 'graph' ? 'graph' : 'imap';

    if (!accountId || !messageId) {
      return res.status(400).json({ error: '缺少账号或邮件标识。' });
    }

    const cached = getCachedMessageDetail(protocol === 'graph' ? 'Graph' : 'IMAP', accountId, messageId);
    if (cached) {
      return res.json({ message: cached, cached: true });
    }

    const store = await readStore();
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存在。' });
    }

    const message = protocol === 'graph'
      ? await fetchGraphMessageDetail(account, messageId)
      : await fetchImapMessageDetail(account, messageId);

    res.json({ message, cached: false });
  } catch (error) {
    res.status(500).json({ error: shortError(error) });
  }
});

app.get('/api/tasks/latest', async (req, res) => {
  res.json({ task: await latestTaskSnapshot() });
});

app.get('/api/tasks/:id', async (req, res) => {
  const task = fetchTasks.get(String(req.params.id || ''));
  if (!task) {
    return res.status(404).json({ error: '任务不存在。' });
  }
  res.json({ task: taskSnapshot(task) });
});

app.post('/api/app/exit', async (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    if (httpServer) {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1200);
    } else {
      process.exit(0);
    }
  }, 250);
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

httpServer = app.listen(port, host, () => {
  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${browserHost}:${port}`;
  console.log(`API listening on ${host}:${port}`);
  console.log(`Data directory: ${dataDir}`);
  maybeOpenBrowser(url);
});
