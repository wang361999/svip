#!/usr/bin/env node
/**
 * 宏观数据更新脚本（GitHub Actions 定时运行）
 *
 * 写入 src/data/macro-live.json → 提交 → Vercel 自动部署 → 应用读取 bundled 数据
 *
 * 数据序列（与 src/shared/lib/macro-news.ts 的 FRED_IDS 保持一致）：
 *   payroll     PAYEMS     非农总就业（千人，月度）  = BLS CES0000000001
 *   unemployment UNRATE    失业率（%，月度）          = BLS LNS14000000
 *   cpi         CPIAUCSL   CPI 指数（月度）           = BLS CUSR0000SA0
 *   coreCpi     CPILFESL   核心 CPI 指数（月度）      = BLS CUSR0000SA0L1E
 *   claims      ICSA       初请失业金（周度）         = 仅 FRED（DOL 数据）
 *   corePce     PCEPILFE   核心 PCE 指数（月度）      = 仅 FRED（BEA 数据）
 *
 * 拉取策略（每序列独立降级）：
 * 1. BLS 公共 API v2（无需 key；一次 POST 取全部 BLS 序列，注意 25 次/天限额 → cron 已限频）
 *    ⚠ 2026-09 实测：fred.stlouisfed.org（Akamai）从 GitHub runner 出口全部超时
 *      （工作流 8/26 创建起 33/33 次运行失败），故月度序列改走 BLS 官方源
 * 2. FRED JSON API（需 FRED_API_KEY，可选注册）
 * 3. FRED CSV 端点（保留兜底；对 runner 大概率超时，仅沙箱/WebFetch 出口可达）
 * 4. 沿用旧数据 + 输出 ::warning:: 陈旧告警（月度 >45 天 / 周度 >16 天）
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

/** BLS API 序列映射（与 FRED 序列同源同值：FRED 的这四个序列本就转载自 BLS） */
const BLS_MAP = {
  payroll: 'CES0000000001',
  unemployment: 'LNS14000000',
  cpi: 'CUSR0000SA0',
  coreCpi: 'CUSR0000SA0L1E',
};

const OUT_PATH = 'src/data/macro-live.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** BLS 公共 API v2：一次 POST 取全部 BLS 月度序列（无 key 每日限额 25 次，一次调用算 1 次） */
async function fetchBlsBulk() {
  const ids = Object.values(BLS_MAP);
  const res = await fetch('https://api.bls.gov/v2/timeseries/data/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Akamai 会拦无 UA/非浏览器 UA 的请求（runner 实测裸 fetch 403）
      'User-Agent': UA,
    },
    body: JSON.stringify({ seriesid: ids, startyear: '2024', endyear: String(new Date().getFullYear()) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS ${j.status}: ${(j.message || []).join('; ')}`);
  const byId = new Map(); // seriesId -> {date,value}[] 升序
  for (const s of j.Results?.series || []) {
    const pts = [];
    for (const o of s.data || []) {
      // M01..M12 月度观测（LNS/CES/CU 序列均为月度）
      if (typeof o.period === 'string' && o.period.startsWith('M')) {
        const mm = String(Number(o.period.slice(1))).padStart(2, '0');
        const value = Number(o.value);
        if (Number.isFinite(value)) pts.push({ date: `${o.year}-${mm}-01`, value });
      }
    }
    pts.sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length > 0) byId.set(s.seriesID, pts);
  }
  if (byId.size === 0) throw new Error('BLS 返回空序列');
  return byId;
}

/** FRED CSV 端点（对 GitHub runner 大概率被 Akamai 丢弃，保留兜底） */
async function fetchCsv(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2024-01-01`, {
    headers: { 'User-Agent': UA, Accept: 'text/csv' },
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

/** FRED JSON API（需 API key） */
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

/** 单序列 FRED 兜底链：JSON API（有 key）→ CSV */
async function fetchFred(id) {
  if (FRED_API_KEY) {
    try {
      const pts = await fetchJson(id);
      console.log(`  └ FRED JSON API 成功`);
      return pts;
    } catch (e) {
      console.warn(`  └ FRED JSON API 失败（${e.message}），降级到 CSV`);
    }
  }
  return fetchCsv(id);
}

/** 月度序列最大容忍陈旧天数（正常每月一更，发布窗口±2周） */
const STALE_DAYS = { monthly: 45, weekly: 16 };

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(`${dateStr}T00:00:00Z`).getTime()) / 86_400_000);
}

async function main() {
  const out = { fetchedAt: new Date().toISOString(), series: {} };
  const failures = [];

  // 1) BLS 批量（payroll/unemployment/cpi/coreCpi）
  let bls = null;
  try {
    bls = await fetchBlsBulk();
    console.log(`✓ BLS API：${bls.size}/${Object.keys(BLS_MAP).length} 个序列`);
  } catch (e) {
    failures.push(`BLS: ${e.message}`);
    console.error(`✗ BLS API 批量失败：${e.message}`);
  }

  // 2) 逐序列：BLS → FRED；claims/corePce 只有 FRED
  await Promise.all(
    Object.entries(SERIES).map(async ([key, fredId]) => {
      const blsId = BLS_MAP[key];
      // 先试 BLS（仅 BLS 映射的序列）
      if (blsId && bls) {
        const pts = bls.get(blsId);
        if (pts && pts.length > 0) {
          out.series[key] = pts;
          console.log(`✓ ${key}（BLS ${blsId}）：${pts.length} 点，最新 ${pts.at(-1).date} = ${pts.at(-1).value}`);
          return;
        }
      }
      // FRED 兜底（claims/corePce 必走；BLS 序列 BLS 侧失败时也走）
      try {
        const pts = await fetchFred(fredId);
        out.series[key] = pts;
        console.log(`✓ ${key}（FRED ${fredId}）：${pts.length} 点，最新 ${pts.at(-1).date} = ${pts.at(-1).value}`);
      } catch (e) {
        failures.push(`${key}: ${e.message}`);
        console.error(`✗ ${key} (${fredId})：${e.message}`);
      }
    }),
  );

  // 3) 失败序列沿用旧数据
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

  // 4) 陈旧告警（GitHub Actions annotation，页面上 bundledAt 可见快照时间）
  let staleCount = 0;
  for (const [key, limit] of Object.entries({ payroll: STALE_DAYS.monthly, unemployment: STALE_DAYS.monthly, cpi: STALE_DAYS.monthly, coreCpi: STALE_DAYS.monthly, corePce: STALE_DAYS.monthly, claims: STALE_DAYS.weekly })) {
    const last = out.series[key]?.at(-1);
    if (!last) continue;
    const age = daysSince(last.date);
    if (age > limit) {
      staleCount++;
      console.log(`::warning::数据陈旧：${key} 最新数据点 ${last.date}（${age} 天前），超过 ${limit} 天容忍阈值 — 数据源拉取可能失败，请检查`);
    }
  }

  fs.mkdirSync('src/data', { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out) + '\n');
  console.log(`\n写入 ${OUT_PATH}：${ok}/${Object.keys(SERIES).length} 个序列，陈旧告警 ${staleCount} 条`);
  if (FRED_API_KEY) console.log('（FRED JSON API key 已配置，作为兜底源）');
  if (failures.length) console.log(`失败明细: ${failures.join('; ')}`);
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
