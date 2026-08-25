'use client';

/**
 * 公众号文章写作页
 *
 * 流程：选币种（ETH/BTC 快捷 + 全部下拉）→ 生成文章 → 手机宽预览 →
 *      三选一标题 → 一键复制富文本（粘贴公众号编辑器保留排版）/ 复制纯文本
 *
 * 历史：localStorage 存最近 10 篇（本设备），刷新不丢
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiGet, apiPost } from '@/shared/api/client';
import useAuthStore from '@/store/authStore';

interface SymbolOption {
  symbol: string;
  okxId: string;
  label: string;
  isPopular?: boolean;
}

interface ArticleContent {
  titles: string[];
  lead: string;
  keyPoint: string;
  body: string[];
  operation: string;
  riskNote: string;
}

interface ArticleData {
  symbol: string;
  label: string;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  gann: unknown;
  structure: { m15: { trend: string }; h1: { trend: string }; h4: { trend: string } };
  fractal: unknown;
  generatedAt: string;
}

interface ArticleResult {
  data: ArticleData;
  content: ArticleContent;
  html: string;
  plainText: string;
  model: string;
}

interface HistoryEntry {
  key: string;
  symbol: string;
  label: string;
  title: string;
  createdAt: string;
  result: ArticleResult;
}

const HISTORY_KEY = 'article_history_v1';
const HISTORY_MAX = 10;

export default function WriterPage() {
  const router = useRouter();
  const { setUser } = useAuthStore();
  const [symbols, setSymbols] = useState<SymbolOption[]>([]);
  const [symbol, setSymbol] = useState('ETHUSDT');
  const [okxId, setOkxId] = useState('ETH-USDT');
  const [label, setLabel] = useState('ETH/USDT');
  const [article, setArticle] = useState<ArticleResult | null>(null);
  const [titleIdx, setTitleIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'' | 'html' | 'text'>('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // 登录守卫（未登录跳登录页）+ 加载币种列表与历史
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meData = await apiGet<{ user: Parameters<typeof setUser>[0] }>('/api/auth/me');
        if (!cancelled) setUser(meData.user);
      } catch {
        if (!cancelled) router.push('/login');
        return;
      }
      try {
        const list = await apiGet<SymbolOption[]>('/api/symbols');
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setSymbols(list);
          const eth = list.find((s) => s.symbol === 'ETHUSDT');
          if (eth) {
            setOkxId(eth.okxId);
            setLabel(eth.label);
          }
        }
      } catch {}
    })();
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
    return () => {
      cancelled = true;
    };
  }, [router, setUser]);

  const selectSymbol = (s: SymbolOption) => {
    setSymbol(s.symbol);
    setOkxId(s.okxId);
    setLabel(s.label);
  };

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await apiPost<ArticleResult>('/api/article', { symbol, okxId, label });
      setArticle(result);
      setTitleIdx(0);
      // 写入历史
      const entry: HistoryEntry = {
        key: `${Date.now()}`,
        symbol,
        label,
        title: result.content.titles[0],
        createdAt: new Date().toISOString(),
        result,
      };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, HISTORY_MAX);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setLoading(false);
    }
  };

  // 选中的标题 + 替换占位符后的 HTML
  const finalHtml = article
    ? article.html.replace('<!--TITLE_SLOT-->', article.content.titles[titleIdx] || '')
    : '';

  /** 复制富文本（text/html — 公众号编辑器粘贴后保留全部排版） */
  const copyRich = async () => {
    if (!finalHtml) return;
    const plain = article ? article.plainText : '';
    try {
      // ClipboardItem 同时写 html + 纯文本（编辑器不支持 html 时退化为纯文本）
      const item = new ClipboardItem({
        'text/html': new Blob([finalHtml], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      setCopied('html');
    } catch {
      // 兜底：execCommand 复制（隐藏节点承载样式 HTML）
      const holder = document.createElement('div');
      holder.setAttribute('contenteditable', 'true');
      holder.innerHTML = finalHtml;
      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      document.body.appendChild(holder);
      const range = document.createRange();
      range.selectNodeContents(holder);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand('copy');
      document.body.removeChild(holder);
      sel?.removeAllRanges();
      setCopied('html');
    }
    setTimeout(() => setCopied(''), 2000);
  };

  /** 复制纯文本 */
  const copyPlain = async () => {
    if (!article) return;
    try {
      await navigator.clipboard.writeText(article.plainText);
      setCopied('text');
      setTimeout(() => setCopied(''), 2000);
    } catch {}
  };

  const quickPicks = ['ETHUSDT', 'BTCUSDT']
    .map((s) => symbols.find((x) => x.symbol === s))
    .filter((x): x is SymbolOption => !!x);
  const otherSymbols = symbols.filter((s) => !['ETHUSDT', 'BTCUSDT'].includes(s.symbol));

  return (
    <main className="min-h-screen bg-dark-950 pt-16">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* 顶栏 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">公众号文章</h1>
            <p className="text-xs text-dark-500 mt-1">
              行情分析文章生成 · 点位与交易面板同源 · 复制后直接粘贴公众号编辑器
            </p>
          </div>
          <Link href="/trading" className="text-xs text-dark-400 hover:text-white transition-colors">
            ← 返回交易
          </Link>
        </div>

        {/* 生成控制条 */}
        <div className="glass-card p-4 mb-6">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-dark-500">币种：</span>
            {quickPicks.map((s) => (
              <button
                key={s.symbol}
                onClick={() => selectSymbol(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  symbol === s.symbol
                    ? 'bg-blue-600 text-white border-blue-500'
                    : 'text-dark-300 bg-dark-800 border-dark-700 hover:text-white'
                }`}
              >
                {s.label}
              </button>
            ))}
            {otherSymbols.length > 0 && (
              <select
                value={symbol}
                onChange={(e) => {
                  const s = symbols.find((x) => x.symbol === e.target.value);
                  if (s) selectSymbol(s);
                }}
                className="px-3 py-1.5 rounded-lg text-xs bg-dark-800 border border-dark-700 text-dark-300"
              >
                <option value={symbol}>{symbol === 'ETHUSDT' || symbol === 'BTCUSDT' ? '其他币种' : label}</option>
                {otherSymbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={generate}
              disabled={loading}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  AI 撰写中（约 30 秒）...
                </>
              ) : (
                <>✍️ 生成文章</>
              )}
            </button>
            {history.length > 0 && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="text-xs text-dark-400 hover:text-white transition-colors"
              >
                历史 ({history.length})
              </button>
            )}
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* 历史 */}
          {showHistory && history.length > 0 && (
            <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
              {history.map((h) => (
                <button
                  key={h.key}
                  onClick={() => {
                    setArticle(h.result);
                    setTitleIdx(0);
                    setShowHistory(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-900/60 border border-dark-800 text-xs text-left hover:border-dark-600 transition-colors"
                >
                  <span className="text-dark-500 flex-shrink-0">{h.label}</span>
                  <span className="text-dark-300 truncate flex-1">{h.title}</span>
                  <span className="text-dark-600 flex-shrink-0">
                    {new Date(h.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 文章预览 */}
        {!article && !loading && (
          <div className="text-center py-16 text-dark-400">
            <p className="text-4xl mb-4">📝</p>
            <p className="text-sm">选择币种，点击「生成文章」</p>
            <p className="text-xs text-dark-500 mt-2">
              标题 / 导语 / 走势解读由 AI 撰写 · 点位表 / 多周期结构 / 分型信号为系统客观计算
            </p>
          </div>
        )}

        {article && (
          <div className="space-y-4">
            {/* 标题三选一 */}
            <div className="glass-card p-4">
              <div className="text-xs text-dark-500 mb-2">候选标题（点击切换）</div>
              <div className="space-y-1.5">
                {article.content.titles.map((t, i) => (
                  <button
                    key={i}
                    onClick={() => setTitleIdx(i)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm border transition-colors ${
                      titleIdx === i
                        ? 'bg-blue-600/15 border-blue-500/40 text-white'
                        : 'bg-dark-900/40 border-dark-800 text-dark-300 hover:border-dark-600'
                    }`}
                  >
                    <span className={`mr-2 text-[10px] font-bold ${titleIdx === i ? 'text-blue-400' : 'text-dark-500'}`}>
                      {i + 1}
                    </span>
                    {t}
                  </button>
                ))}
              </div>
              {/* 复制按钮 */}
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={copyRich}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    copied === 'html'
                      ? 'text-green-400 border-green-500/40 bg-green-500/10'
                      : 'text-white bg-blue-600 border-blue-500 hover:bg-blue-700'
                  }`}
                >
                  {copied === 'html' ? '✓ 已复制，去公众号编辑器粘贴' : '📋 一键复制（公众号排版）'}
                </button>
                <button
                  onClick={copyPlain}
                  className={`px-4 py-2.5 rounded-lg text-sm border transition-colors ${
                    copied === 'text'
                      ? 'text-green-400 border-green-500/40 bg-green-500/10'
                      : 'text-dark-300 bg-dark-800 border-dark-700 hover:text-white'
                  }`}
                >
                  {copied === 'text' ? '✓ 已复制' : '纯文本'}
                </button>
              </div>
            </div>

            {/* 手机宽预览（模拟公众号阅读视图：白底黑字） */}
            <div className="flex justify-center">
              <div
                className="w-full max-w-[420px] bg-white rounded-xl overflow-hidden shadow-2xl"
                style={{ minHeight: 400 }}
              >
                <div
                  className="article-preview"
                  dangerouslySetInnerHTML={{ __html: finalHtml }}
                />
              </div>
            </div>

            <p className="text-center text-[11px] text-dark-600">
              预览即为粘贴到公众号后的实际排版 · 模型 {article.model} · 生成于{' '}
              {new Date(article.data.generatedAt).toLocaleString('zh-CN')}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
