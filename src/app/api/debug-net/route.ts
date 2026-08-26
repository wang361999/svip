/**
 * 网络诊断接口（管理员）：测试各数据源从 Vercel 出口的连通性
 * 用于排查 FRED / Google News / alternative.me / Binance 的可达性
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import https from 'node:https';
import dns from 'node:dns/promises';

export const dynamic = 'force-dynamic';

interface ProbeResult {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  bytes: number;
  snippet: string;
  snippetFull?: string;
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
      snippetFull: text,
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

/** 用 node:https 强制指定 IP 族（4=IPv4, 6=IPv6）抓取，诊断 DNS 族问题 */
function probeWithFamily(url: string, family: 4 | 6): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        family,
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            url: `${url} [family=${family}]`,
            ok: (res.statusCode ?? 500) < 400,
            status: res.statusCode ?? null,
            ms: Date.now() - t0,
            bytes: text.length,
            snippet: text.slice(0, 200).replace(/\n/g, '⏎'),
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ url: `${url} [family=${family}]`, ok: false, status: null, ms: Date.now() - t0, bytes: 0, snippet: '', error: `timeout(family=${family})` });
    });
    req.on('error', (e: Error) => {
      resolve({ url: `${url} [family=${family}]`, ok: false, status: null, ms: Date.now() - t0, bytes: 0, snippet: '', error: e.message?.slice(0, 200) });
    });
  });
}

export const GET = createHandler(async () => {
  requireAdmin();

  // DNS 解析诊断
  let dnsInfo: Record<string, string> = {};
  try {
    const a = await dns.resolve4('fred.stlouisfed.org').catch(() => []);
    const aaaa = await dns.resolve6('fred.stlouisfed.org').catch(() => []);
    dnsInfo = { ipv4: (a as string[]).join(', ') || '无', ipv6: (aaaa as string[]).join(', ') || '无' };
  } catch (e) {
    dnsInfo = { error: (e as Error).message };
  }

  const [fred, fredCosd, gnCrypto, gnMacro, alt, binance, fredV4, fredV6] = await Promise.all([
    probe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL'),
    probe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=PAYEMS&cosd=2024-01-01'),
    probe(`https://news.google.com/rss/search?q=${encodeURIComponent('比特币 OR 以太坊 OR 加密货币')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`),
    probe(`https://news.google.com/rss/search?q=${encodeURIComponent('美联储 OR 降息')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`),
    probe('https://api.alternative.me/fng/?limit=2'),
    probe('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
    probeWithFamily('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL', 4),
    probeWithFamily('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL', 6),
  ]);

  // 解析 RSS：条数 + 前 5 条 pubDate（诊断 48h 过滤问题）
  const rssDiag = (r: ProbeResult) => {
    if (!r.ok || r.bytes === 0) return { items: 0, pubDates: [] as string[] };
    const full = r.snippetFull || '';
    const items = (full.match(/<item>/g) || []).length;
    const dates: string[] = [];
    const dateRe = /<pubDate>([\s\S]*?)<\/pubDate>/g;
    let dm: RegExpExecArray | null;
    while ((dm = dateRe.exec(full)) !== null && dates.length < 5) {
      dates.push(dm[1]);
    }
    return { items, pubDates: dates };
  };

  const strip = (r: ProbeResult) => {
    const { snippetFull: _full, ...rest } = r;
    return rest;
  };

  return apiSuccess({
    probes: {
      fred: strip(fred),
      fredCosd: strip(fredCosd),
      gnCrypto: strip(gnCrypto),
      gnMacro: strip(gnMacro),
      alt: strip(alt),
      binance: strip(binance),
      fredV4: strip(fredV4),
      fredV6: strip(fredV6),
    },
    dnsInfo,
    cryptoRss: rssDiag(gnCrypto),
    macroRss: rssDiag(gnMacro),
  });
});
