#!/usr/bin/env node
/**
 * 宏观数据更新脚本（GitHub Actions 定时运行）
 *
 * 从美联储 FRED 数据库拉取官方 CSV/JSON 序列，写入 src/data/macro-live.json
 * 提交后 Vercel 自动部署 → 应用读取 bundled 数据（绕过 Akamai 对 Vercel IP 的封锁）
 *
 * 数据序列（与 src/shared/lib/macro-news.ts 的 FRED_IDS 保持一致）：
 *   payroll     PAYEMS     非农总就业（千人，月度）
 *   unemployment UNRATE    失业率（%，月度）
 *   cpi         CPIAUCSL   CPI 指数（月度）
 *   coreCpi     CPILFESL   核心 CPI 指数（月度）
 *   claims      ICSA       初请失业金（周度）
 *   corePce     PCEPILFE   核心 PCE 指数（月度）
 *
 * 同时从 CNBC 图表接口（ts-api harmony）拉取 WTI/布伦特近两年日K，
 * 取最近 30 个交易日收盘写入 src/data/oil-history.json
 * → /api/crude-oil 运行时优先直连同一接口，本文件作为兜底
 *   （防 Vercel 出口 IP 被 Akamai 封锁，与 macro-live.json 同模式）
 *
 * 拉取策略：有 FRED_API_KEY 时用 JSON API，否则用 CSV（两者都尝试，取先成功的）
 */
import fs from 'node:fs';

const FRED_API_KEY = process.env.FRED_API_KEY || '';

const SERIES = {
  payroll: 'PAYEMS',
  unemployment: 'UNRATE',
  cpi: 'CPIAUCSL',
  coreCpi: 'CPILFESL',
  claims: 'ICSA',
  corePce: 'PCEPILFE',
};

const OUT_PATH = 'src/data/macro-live.json';
const OIL_HISTORY_PATH = 'src/data/oil-history.json';
const OIL_HISTORY_MAX_DAYS = 30;

/** 通过 FRED CSV 端点拉取（GitHub Actions runner 可正常访问） */
async function fetchCsv(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2024-01-01`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/csv',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
  const csv = await res.text();
  if (csv.trim().startsWith('<')) throw new Error('non-CSV response');
  const lines = csv.trim().split('\n').slice(1); // 跳过表头
  const pts = [];
  for (const line of lines) {
    const [date, raw] = line.split(',');
    const value = Number(raw);
    if (!date || !raw || raw === '.' || !Number.isFinite(value)) continue;
    pts.push({ date, value });
  }
  if (pts.length === 0) throw new Error('empty CSV series');
  return pts;
}

/** 通过 FRED JSON API 拉取（需要 API key，不同端点可能不受 Akamai 封锁影响） */
async function fetchJson(id) {
  if (!FRED_API_KEY) throw new Error('no API key');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_API_KEY}&file_type=json&observation_start=2024-01-01`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`JSON HTTP ${res.status}`);
  const j = await res.json();
  const obs = j?.observations;
  if (!Array.isArray(obs)) throw new Error('no observations in JSON');
  const pts = [];
  for (const o of obs) {
    const value = Number(o.value);
    if (!o.date || o.value === '.' || !Number.isFinite(value)) continue;
    pts.push({ date: o.date, value });
  }
  if (pts.length === 0) throw new Error('empty JSON series');
  return pts;
}

/** 拉取单个序列：优先 JSON API（有 key 时），失败则降级到 CSV */
async function fetchSeries(id) {
  // 有 key 时先尝试 JSON API
  if (FRED_API_KEY) {
    try {
      const pts = await fetchJson(id);
      console.log(`  └ JSON API 成功`);
      return pts;
    } catch (e) {
      console.warn(`  └ JSON API 失败（${e.message}），降级到 CSV`);
    }
  }
  // CSV 端点（GitHub Actions runner 可正常访问）
  return fetchCsv(id);
}

// ---------- 原油日K历史（CNBC ts-api 图表接口，无需 key） ----------

/**
 * 拉取 CNBC 图表日K（ts-api harmony 端点，返回近两年日线 bar）
 * bar 结构：{ open, high, low, close, volume, tradeTime, tradeTimeinMills }
 * 按时间升序返回 [{date, price}]，取最近 maxDays 个交易日
 */
async function fetchOilDailyCloses(symbol, maxDays) {
  const url =
    'https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol=' + encodeURIComponent(symbol);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`ts-api HTTP ${res.status}`);
  const bars = (await res.json())?.barData?.priceBars;
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('ts-api 响应结构异常');

  const pts = [];
  for (const b of bars) {
    const price = parseFloat(b?.close);
    const ms = Number(b?.tradeTimeinMills);
    if (!(price > 0) || !Number.isFinite(ms) || ms <= 0) continue;
    pts.push({ date: new Date(ms).toISOString().slice(0, 10), price });
  }
  if (pts.length === 0) throw new Error('无有效日线');
  return pts.slice(-maxDays);
}

/**
 * 更新原油日K历史文件（失败时保留旧数据，不中断宏观数据更新）
 * /api/crude-oil 运行时优先直连 ts-api，此文件仅作 Vercel IP 被封时的兜底
 */
async function updateOilHistory() {
  let old = { fetchedAt: '', wti: [], brent: [] };
  try {
    old = JSON.parse(fs.readFileSync(OIL_HISTORY_PATH, 'utf8'));
  } catch {
    // 无旧文件（首次运行）
  }

  const out = { fetchedAt: new Date().toISOString(), wti: old.wti || [], brent: old.brent || [] };
  await Promise.all(
    [
      ['wti', '@CL.1'], // WTI 前月合约
      ['brent', '@LCO.1'], // 布伦特前月合约
    ].map(async ([key, symbol]) => {
      try {
        out[key] = await fetchOilDailyCloses(symbol, OIL_HISTORY_MAX_DAYS);
        const last = out[key].at(-1);
        console.log(`✓ oil-history ${key}: ${out[key].length} 天，最新 ${last.date} = ${last.price}`);
      } catch (e) {
        console.warn(`✗ oil-history ${key}（${symbol}）: ${e.message}，保留旧数据`);
      }
    }),
  );

  fs.mkdirSync('src/data', { recursive: true });
  fs.writeFileSync(OIL_HISTORY_PATH, JSON.stringify(out) + '\n');
}

async function main() {
  const out = { fetchedAt: new Date().toISOString(), series: {} };
  const failures = [];

  await Promise.all(
    Object.entries(SERIES).map(async ([key, id]) => {
      try {
        out.series[key] = await fetchSeries(id);
        console.log(`✓ ${key} (${id}): ${out.series[key].length} 点，最新 ${out.series[key].at(-1).date} = ${out.series[key].at(-1).value}`);
      } catch (e) {
        failures.push(`${key}: ${e.message}`);
        console.error(`✗ ${key} (${id}): ${e.message}`);
      }
    }),
  );

  // 部分失败时保留旧文件中对应序列（宏观数据月更，旧值仍有效）
  try {
    const old = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    for (const key of Object.keys(SERIES)) {
      if (!out.series[key] && old.series?.[key]) {
        out.series[key] = old.series[key];
        console.log(`↻ ${key}: 沿用旧数据（本次拉取失败）`);
      }
    }
  } catch {
    // 无旧文件
  }

  const ok = Object.keys(out.series).length;

  // 原油结算价累积（失败自吞，不影响宏观数据更新与退出码）
  await updateOilHistory();

  if (ok === 0) {
    console.error('全部序列拉取失败，退出');
    process.exit(1);
  }

  fs.mkdirSync('src/data', { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out) + '\n');
  console.log(`\n写入 ${OUT_PATH}：${ok}/${Object.keys(SERIES).length} 个序列，失败: ${failures.length ? failures.join('; ') : '无'}`);
  if (FRED_API_KEY) console.log('（使用 FRED JSON API）');
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
