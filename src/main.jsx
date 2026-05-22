import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle,
  ArchiveX,
  Check,
  Download,
  Inbox,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  User,
  X,
} from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const LOCAL_STORAGE_KEY = 'outlook-fast-mail.local-state.v2';
let errorSeq = 0;

function createDefaultSummary() {
  return { state: 'idle', messagesCount: 0, errorsCount: 0 };
}

function createDefaultTask() {
  return {
    id: '',
    status: 'idle',
    protocol: 'imap',
    totalAccounts: 0,
    processedAccounts: 0,
    currentAccountEmail: '',
    messages: [],
    errors: [],
    totalMessages: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function createDefaultLocalState() {
  return {
    accounts: [],
    selectedIds: [],
    messages: [],
    errors: [],
    runSummary: createDefaultSummary(),
    query: '',
    sender: '',
    limit: 5,
    protocol: 'imap',
    codeMode: true,
    recentMinutes: 30,
    updatedAt: '',
    activeTaskId: '',
    taskSnapshot: createDefaultTask(),
  };
}

function readLocalState() {
  if (typeof window === 'undefined') return createDefaultLocalState();

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return createDefaultLocalState();
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultLocalState(),
      ...parsed,
      selectedIds: Array.isArray(parsed?.selectedIds) ? parsed.selectedIds : [],
      accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
      messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
      errors: Array.isArray(parsed?.errors) ? parsed.errors : [],
      runSummary: parsed?.runSummary || createDefaultSummary(),
      taskSnapshot: parsed?.taskSnapshot || createDefaultTask(),
    };
  } catch {
    return createDefaultLocalState();
  }
}

function writeLocalState(state) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString(),
  }));
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed ${response.status}`);
  }
  return data;
}

function shortEmail(email) {
  if (!email) return '';
  return email.length > 30 ? `${email.slice(0, 27)}...` : email;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatLocalTime(value) {
  if (!value) return '未保存';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未保存';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function toUiErrors(items = []) {
  return items.map((item) => ({
    ...item,
    id: item.id || `error-${Date.now()}-${errorSeq += 1}`,
  }));
}

function summarizeRun(messagesCount, errorsCount) {
  if (errorsCount && messagesCount) {
    return { state: 'partial', messagesCount, errorsCount };
  }
  if (errorsCount) {
    return { state: 'error', messagesCount, errorsCount };
  }
  if (messagesCount) {
    return { state: 'ok', messagesCount, errorsCount };
  }
  return { state: 'empty', messagesCount: 0, errorsCount: 0 };
}

function summarizeTask(task) {
  return summarizeRun((task?.messages || []).length, (task?.errors || []).length);
}

function accountStatusTitle(account) {
  if (!account?.lastStatus) return account.email;
  if (account.lastStatus.ok) {
    return `${account.email}\n上次成功: ${String(account.lastStatus.protocol || '').toUpperCase()} / ${account.lastStatus.count || 0}`;
  }
  return `${account.email}\n上次失败: ${String(account.lastStatus.protocol || '').toUpperCase()} / ${account.lastStatus.message || '未知错误'}`;
}

function ImportModal({ onClose, onImported }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  async function submit() {
    setBusy(true);
    setErrors([]);
    try {
      const result = await api('/api/accounts/import', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      setErrors(result.errors || []);
      if (result.imported?.length) {
        await onImported();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2>批量导入</h2>
            <p>支持常见 Outlook 文本格式和 JSON 行格式。</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={'alva@example.com----password----client-id----M.Cxxx...\nme@outlook.com|0.AAA...|client-id||common\n{"email":"me@outlook.com","refreshToken":"0.AAA...","clientId":"...","tenant":"common"}'}
        />
        {errors.length > 0 && (
          <div className="import-errors">
            {errors.map((error) => (
              <p key={`${error.line}-${error.message}`}>第 {error.line} 行: {error.message}</p>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
            导入
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthModal({ onClose }) {
  const [form, setForm] = useState({
    clientId: '',
    clientSecret: '',
    tenant: 'consumers',
    protocol: 'graph',
  });
  const [authInfo, setAuthInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  async function createUrl() {
    setBusy(true);
    try {
      const result = await api('/api/auth-url', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setAuthInfo(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal auth-modal">
        <div className="modal-head">
          <div>
            <h2>OAuth 授权链接</h2>
            <p>用于单账号授权。授权成功后会自动保存刷新令牌。</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="field-grid">
          <label>
            Client ID
            <input value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} />
          </label>
          <label>
            Client Secret
            <input value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} />
          </label>
          <label>
            租户
            <input value={form.tenant} onChange={(event) => setForm({ ...form, tenant: event.target.value || 'consumers' })} />
          </label>
          <label>
            协议
            <select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
              <option value="graph">Graph</option>
              <option value="imap">IMAP</option>
            </select>
          </label>
        </div>
        {authInfo && (
          <div className="auth-result">
            <p>回调地址: {authInfo.redirectUri}</p>
            <a href={authInfo.url} target="_blank" rel="noreferrer">打开微软授权页面</a>
          </div>
        )}
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>关闭</button>
          <button className="primary-btn" onClick={createUrl} disabled={busy || !form.clientId.trim()}>
            {busy ? <Loader2 className="spin" size={18} /> : <User size={18} />}
            生成链接
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageDetailModal({ message, loading, onClose }) {
  if (!message) return null;

  const bodyText = message.bodyText || message.preview || '暂无正文内容';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal message-detail-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{message.subject || '无主题'}</h2>
            <p>点开即可阅读完整邮件正文。</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="message-detail-meta">
          <div>
            <strong>发件人</strong>
            <span>{message.fromName || message.from || '未知发件人'}</span>
          </div>
          <div>
            <strong>邮箱账号</strong>
            <span>{message.accountEmail || '-'}</span>
          </div>
          <div>
            <strong>协议</strong>
            <span>{message.protocol || '-'}</span>
          </div>
          <div>
            <strong>时间</strong>
            <span>{formatDate(message.receivedAt) || '-'}</span>
          </div>
        </div>

        <div className="message-detail-body">
          {loading && !message.bodyText && (
            <div className="detail-loading">
              <Loader2 className="spin" size={20} />
              <span>正在加载正文...</span>
            </div>
          )}
          {loading && message.bodyText && (
            <div className="detail-inline-note">
              <Loader2 className="spin" size={16} />
              <span>正在补充更完整的正文...</span>
            </div>
          )}
          <pre>{bodyText}</pre>
        </div>
      </div>
    </div>
  );
}

function App() {
  const initialLocalState = useMemo(() => readLocalState(), []);
  const [accounts, setAccounts] = useState(initialLocalState.accounts);
  const [selected, setSelected] = useState(new Set(initialLocalState.selectedIds));
  const [messages, setMessages] = useState(initialLocalState.messages);
  const [errors, setErrors] = useState(toUiErrors(initialLocalState.errors));
  const [runSummary, setRunSummary] = useState(initialLocalState.runSummary || createDefaultSummary());
  const [query, setQuery] = useState(initialLocalState.query || '');
  const [sender, setSender] = useState(initialLocalState.sender || '');
  const [limit, setLimit] = useState(Number(initialLocalState.limit) || 5);
  const [protocol, setProtocol] = useState(initialLocalState.protocol === 'graph' ? 'graph' : 'imap');
  const [codeMode, setCodeMode] = useState(initialLocalState.codeMode !== false);
  const [recentMinutes, setRecentMinutes] = useState(Number(initialLocalState.recentMinutes) || 30);
  const [importOpen, setImportOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [localUpdatedAt, setLocalUpdatedAt] = useState(initialLocalState.updatedAt || '');
  const [activeTaskId, setActiveTaskId] = useState(initialLocalState.activeTaskId || '');
  const [taskSnapshot, setTaskSnapshot] = useState(initialLocalState.taskSnapshot || createDefaultTask());
  const [shuttingDown, setShuttingDown] = useState(false);
  const [activeMessage, setActiveMessage] = useState(null);
  const [messageDetailLoading, setMessageDetailLoading] = useState(false);
  const pollTimeoutRef = useRef(null);
  const messageDetailRequestRef = useRef(0);

  const busy = Boolean(activeTaskId && ['queued', 'running'].includes(taskSnapshot.status));

  function persistSnapshot(next) {
    writeLocalState(next);
    setLocalUpdatedAt(new Date().toISOString());
  }

  useEffect(() => {
    const snapshot = {
      accounts,
      selectedIds: [...selected],
      messages,
      errors,
      runSummary,
      query,
      sender,
      limit,
      protocol,
      codeMode,
      recentMinutes,
      activeTaskId,
      taskSnapshot,
    };
    persistSnapshot(snapshot);
  }, [accounts, selected, messages, errors, runSummary, query, sender, limit, protocol, codeMode, recentMinutes, activeTaskId, taskSnapshot]);

  async function loadAccounts() {
    const result = await api('/api/accounts');
    setAccounts(result.accounts || []);
    setSelected((current) => {
      const valid = new Set((result.accounts || []).map((account) => account.id));
      return new Set([...current].filter((id) => valid.has(id)));
    });
  }

  function applyTaskSnapshot(task) {
    const normalizedTask = task || createDefaultTask();
    const nextMessages = normalizedTask.messages || [];
    const nextErrors = toUiErrors(normalizedTask.errors || []);
    setTaskSnapshot(normalizedTask);
    setMessages(nextMessages);
    setErrors(nextErrors);
    setRunSummary(summarizeTask(normalizedTask));

    if (!['queued', 'running'].includes(normalizedTask.status)) {
      setActiveTaskId('');
    } else {
      setActiveTaskId(normalizedTask.id || '');
    }
  }

  async function resumeLatestTask() {
    try {
      const result = await api('/api/tasks/latest');
      if (result.task && ['queued', 'running'].includes(result.task.status)) {
        applyTaskSnapshot(result.task);
      }
    } catch {
      // Keep local snapshot if the latest task cannot be fetched.
    }
  }

  useEffect(() => {
    loadAccounts().catch((error) => {
      setErrors((current) => toUiErrors([
        ...current,
        { email: '系统', protocol: 'api', message: error.message, hint: '浏览器本地记录仍然可用。' },
      ]));
      setRunSummary((current) => current.state === 'idle' ? { state: 'error', messagesCount: 0, errorsCount: 1 } : current);
    });

    if (!initialLocalState.activeTaskId) {
      resumeLatestTask();
    }
  }, []);

  useEffect(() => {
    if (!activeTaskId) {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      return undefined;
    }

    let cancelled = false;

    async function pollTask() {
      try {
        const result = await api(`/api/tasks/${activeTaskId}`);
        if (cancelled) return;
        applyTaskSnapshot(result.task);
        if (['queued', 'running'].includes(result.task.status)) {
          pollTimeoutRef.current = window.setTimeout(pollTask, 1200);
        } else {
          await loadAccounts().catch(() => {});
        }
      } catch (error) {
        if (cancelled) return;
        setErrors((current) => toUiErrors([
          ...current,
          { email: '任务', protocol, message: error.message, hint: '任务轮询已停止，你可以刷新页面重新连接。' },
        ]));
        setActiveTaskId('');
      }
    }

    pollTask();

    return () => {
      cancelled = true;
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [activeTaskId]);

  const selectedCount = selected.size;
  const allSelected = accounts.length > 0 && selected.size === accounts.length;
  const protocolCounts = useMemo(() => {
    return messages.reduce((acc, message) => {
      acc[message.protocol] = (acc[message.protocol] || 0) + 1;
      return acc;
    }, {});
  }, [messages]);

  const statusTone = busy
    ? ''
    : runSummary.state === 'error'
      ? 'danger'
      : runSummary.state === 'partial'
        ? 'warning'
        : runSummary.state === 'ok'
          ? 'ok'
          : '';

  const statusText = busy
    ? `抓取中 ${taskSnapshot.processedAccounts || 0}/${taskSnapshot.totalAccounts || 0}`
    : runSummary.state === 'partial'
      ? `部分成功（邮件 ${runSummary.messagesCount} / 错误 ${runSummary.errorsCount}）`
      : runSummary.state === 'error'
        ? `失败（错误 ${runSummary.errorsCount}）`
        : runSummary.state === 'ok'
          ? `完成（邮件 ${runSummary.messagesCount}）`
          : runSummary.state === 'empty'
            ? '暂无结果'
            : '空闲中';

  const taskDetail = busy
    ? (taskSnapshot.currentAccountEmail
      ? `当前账号: ${taskSnapshot.currentAccountEmail}`
      : '正在准备任务...')
    : '';

  function toggleAccount(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(accounts.map((account) => account.id)));
  }

  function dismissError(id) {
    setErrors((current) => current.filter((error) => error.id !== id));
  }

  async function openMessageDetail(message) {
    const requestId = messageDetailRequestRef.current + 1;
    messageDetailRequestRef.current = requestId;
    setActiveMessage(message);
    setMessageDetailLoading(!message.bodyText);

    try {
      const result = await api('/api/message-detail', {
        method: 'POST',
        body: JSON.stringify({
          accountId: message.accountId,
          messageId: message.id,
          protocol: String(message.protocol || '').toLowerCase(),
        }),
      });
      if (result.message && messageDetailRequestRef.current === requestId) {
        setActiveMessage((current) => {
          if (!current) return result.message;
          if (
            current.accountId !== message.accountId
            || current.id !== message.id
            || current.protocol !== message.protocol
          ) {
            return current;
          }
          return result.message;
        });
      }
    } catch (error) {
      setErrors((current) => toUiErrors([
        ...current,
        { email: '邮件详情', protocol: message.protocol, message: error.message, hint: '这封邮件的正文加载失败了。' },
      ]));
    } finally {
      if (messageDetailRequestRef.current === requestId) {
        setMessageDetailLoading(false);
      }
    }
  }

  function closeMessageDetail() {
    messageDetailRequestRef.current += 1;
    setActiveMessage(null);
    setMessageDetailLoading(false);
  }

  function clearLocalRecords() {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
    setSelected(new Set());
    setMessages([]);
    setErrors([]);
    setRunSummary(createDefaultSummary());
    setQuery('');
    setSender('');
    setLimit(5);
    setProtocol('imap');
    setCodeMode(true);
    setRecentMinutes(30);
    setLocalUpdatedAt('');
    setActiveTaskId('');
    setTaskSnapshot(createDefaultTask());
  }

  async function removeSelected() {
    if (!selected.size) return;
    await api('/api/accounts', {
      method: 'DELETE',
      body: JSON.stringify({ ids: [...selected] }),
    });
    setSelected(new Set());
    await loadAccounts();
  }

  async function clearAllAccounts() {
    if (!accounts.length) return;
    await api('/api/accounts', {
      method: 'DELETE',
      body: JSON.stringify({ ids: accounts.map((account) => account.id) }),
    });
    setAccounts([]);
    setSelected(new Set());
    setMessages([]);
    setErrors([]);
    setRunSummary(createDefaultSummary());
    await loadAccounts();
  }

  async function createFetchTask(ids = [...selected]) {
    if (!ids.length) return;
    setErrors([]);
    setMessages([]);
    setRunSummary({ state: 'busy', messagesCount: 0, errorsCount: 0 });
    setTaskSnapshot({
      ...createDefaultTask(),
      status: 'queued',
      protocol,
      totalAccounts: ids.length,
    });

    try {
      const result = await api('/api/tasks/fetch', {
        method: 'POST',
        body: JSON.stringify({
          accountIds: ids,
          protocol,
          query,
          sender,
          limit,
          codeMode,
          recentMinutes,
        }),
      });
      applyTaskSnapshot(result.task);
    } catch (error) {
      setErrors(toUiErrors([{ email: '系统', protocol, message: error.message }]));
      setRunSummary({ state: 'error', messagesCount: 0, errorsCount: 1 });
      setActiveTaskId('');
      setTaskSnapshot(createDefaultTask());
    }
  }

  async function exitApp() {
    const confirmed = window.confirm('确定要退出本地程序吗？关闭后当前网页将无法继续访问。');
    if (!confirmed) return;

    setShuttingDown(true);
    try {
      await api('/api/app/exit', { method: 'POST' });
    } catch {
      // ignore because shutdown may cut the response
    }

    window.setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.close();
        window.location.href = 'about:blank';
      }
    }, 700);
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand-icon">
          <Mail size={34} />
        </div>
        <div>
          <h1>Outlook Fast Mail</h1>
          <p>验证码优先的 Outlook 快速收件工具</p>
          {taskDetail && <small className="topbar-note">{taskDetail}</small>}
        </div>
        <div className={statusTone ? `status-pill ${statusTone}` : 'status-pill'}>
          <span />
          {statusText}
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="side-title">
            <User size={22} />
            <strong>邮箱账号</strong>
            <span>{accounts.length}</span>
          </div>
          <button className="wide-primary" onClick={() => setImportOpen(true)}>
            <Plus size={18} />
            批量导入
          </button>
          <button className="wide-secondary" onClick={() => setAuthOpen(true)}>
            <User size={18} />
            OAuth 授权
          </button>
          <button className="wide-danger" onClick={exitApp} disabled={shuttingDown}>
            {shuttingDown ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
            退出程序
          </button>

          <div className="local-box">
            <div className="local-box-head">
              <strong>浏览器本地记录</strong>
              <span>已开启</span>
            </div>
            <p>会保存账号缓存、筛选条件、协议选择、最近结果和当前任务 ID。</p>
            <small>最近更新时间: {formatLocalTime(localUpdatedAt)}</small>
            <button className="wide-muted" onClick={clearLocalRecords}>
              <RotateCcw size={16} />
              清空浏览器记录
            </button>
          </div>

          <div className="select-row">
            <label className="checkline">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span>全选</span>
            </label>
            <button className="delete-btn" onClick={removeSelected} disabled={!selected.size}>
              <Trash2 size={15} />
              删除（{selectedCount}）
            </button>
          </div>

          <div className="account-list">
            {accounts.map((account) => (
              <button
                className={`account-item ${selected.has(account.id) ? 'selected' : ''}`}
                key={account.id}
                onClick={() => toggleAccount(account.id)}
                title={accountStatusTitle(account)}
              >
                <span className="fake-check">{selected.has(account.id) && <Check size={14} />}</span>
                <span>{shortEmail(account.email)}</span>
              </button>
            ))}
            {!accounts.length && (
              <div className="empty-small">
                <ArchiveX size={28} />
                <p>还没有导入任何账号</p>
              </div>
            )}
          </div>

          <button className="clear-btn" onClick={clearAllAccounts}>
            <Trash2 size={15} />
            删除全部账号
          </button>
        </aside>

        <div className="main-panel">
          <section className="controls">
            <div className="search-wrap">
              <Search size={22} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="关键词，例如 OpenAI / GitHub（可选）" />
            </div>
            <div className="sender-wrap">
              <User size={20} />
              <input value={sender} onChange={(event) => setSender(event.target.value)} placeholder="发件人筛选（可选）" />
            </div>
            <select className="limit-select" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[3, 5, 10, 20].map((item) => <option key={item} value={item}>{item} 封</option>)}
            </select>
            <select className="limit-select" value={recentMinutes} onChange={(event) => setRecentMinutes(Number(event.target.value))}>
              {[5, 10, 30, 60, 120].map((item) => <option key={item} value={item}>近 {item} 分钟</option>)}
            </select>
            <label className="code-toggle">
              <input type="checkbox" checked={codeMode} onChange={(event) => setCodeMode(event.target.checked)} />
              <span>只看验证码</span>
            </label>
            <div className="protocol-tabs">
              <button className={protocol === 'imap' ? 'active' : ''} onClick={() => setProtocol('imap')}>IMAP</button>
              <button className={protocol === 'graph' ? 'active' : ''} onClick={() => setProtocol('graph')}>Graph</button>
            </div>
            <div className="action-row">
              <button className="primary-btn" disabled={busy || !selected.size} onClick={() => createFetchTask()}>
                {busy ? <Loader2 className="spin" size={19} /> : <Download size={19} />}
                抓取所选
              </button>
              <button className="cyan-btn" disabled={busy || !accounts.length} onClick={() => createFetchTask(accounts.map((account) => account.id))}>
                {busy ? <Loader2 className="spin" size={19} /> : <Download size={19} />}
                抓取全部
              </button>
            </div>
          </section>

          <section className="results-head">
            <div>
              <Inbox size={24} />
              <strong>结果列表</strong>
            </div>
            <div className="result-pills">
              {Object.entries(protocolCounts).map(([key, value]) => (
                <span key={key} className={key === 'IMAP' ? 'pink' : 'blue'}>{key}: {value}</span>
              ))}
              <span className="blue">总计 {messages.length}</span>
            </div>
          </section>

          <section className="message-list">
            {messages.map((message) => (
              <article
                className="message-card"
                key={`${message.accountId}-${message.protocol}-${message.id}`}
                onClick={() => openMessageDetail(message)}
                title="点击查看邮件正文"
              >
                <div>
                  <div className="mail-meta">
                    <strong>{message.fromName || message.from || '未知发件人'}</strong>
                    <span className={message.protocol === 'IMAP' ? 'tag imap' : 'tag graph'}>{message.protocol}</span>
                  </div>
                  <h3>{message.subject}</h3>
                  {message.verificationCode && (
                    <div className="code-badge">
                      <KeyRound size={16} />
                      <span>{message.verificationCode}</span>
                    </div>
                  )}
                  <p>{message.preview || '暂无预览内容'}</p>
                  <small>{message.from} | {message.accountEmail}</small>
                </div>
                <time>{formatDate(message.receivedAt)}</time>
              </article>
            ))}
            {!messages.length && (
              <div className="empty-state">
                <Mail size={42} />
                <p>{busy ? '后台任务正在运行中...' : '暂时还没有邮件结果'}</p>
              </div>
            )}
          </section>
        </div>
      </section>

      <div className="toast-stack">
        {errors.map((error) => (
          <div className="toast" key={error.id}>
            <AlertCircle size={18} />
            <div className="toast-body">
              <div className="toast-head">
                <strong>{error.email}</strong>
                <button className="toast-close" onClick={() => dismissError(error.id)} title="关闭错误提示">
                  <X size={16} />
                </button>
              </div>
              <p>[{String(error.protocol || '').toUpperCase()}] {error.message}</p>
              {error.hint && <small>{error.hint}</small>}
            </div>
          </div>
        ))}
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImported={loadAccounts} />}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {activeMessage && <MessageDetailModal message={activeMessage} loading={messageDetailLoading} onClose={closeMessageDetail} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
