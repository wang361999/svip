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
