/**
 * 网络诊断接口（管理员）：测试各数据源从 Vercel 出口的连通性
 * 用于排查 FRED / Google News / alternative.me / Binance 的可达性
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';

export const dynamic = 'force-dynamic';

interface ProbeResult {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  bytes: number;
  snippet: string;
  error: string | null;
}

async function probe(url: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
      },
    });
    const text = await res.text();
    return {
      url,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      bytes: text.length,
      snippet: text.slice(0, 200).replace(/\n/g, '⏎'),
      error: null,
    };
  } catch (e) {
    return {
      url,
      ok: false,
      status: null,
      ms: Date.now() - t0,
      bytes: 0,
      snippet: '',
      error: (e as Error).message?.slice(0, 200) ?? String(e),
    };
  }
}

export const GET = createHandler(async () => {
  requireAdmin();

  const [fred, fredCosd, gnCrypto, gnMacro, alt, binance] = await Promise.all([
    probe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL'),
    probe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=PAYEMS&cosd=2024-01-01'),
    probe(`https://news.google.com/rss/search?q=${encodeURIComponent('比特币 OR 以太坊 OR 加密货币')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`),
    probe(`https://news.google.com/rss/search?q=${encodeURIComponent('美联储 OR 降息')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`),
    probe('https://api.alternative.me/fng/?limit=2'),
    probe('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
  ]);

  return apiSuccess({
    probes: { fred, fredCosd, gnCrypto, gnMacro, alt, binance },
  });
});
