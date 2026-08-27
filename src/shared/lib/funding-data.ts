/**
 * 资金费率历史（USDT-M 永续，Binance）
 *
 * 用途：费率背离指标（价格新高/新低 vs 费率 z-score 不配合）
 * 数据源（按序 fallback）：
 *   1. fapi.binance.com/fapi/v1/fundingRate —— 与回测同源（每 8h 结算，limit≤1000≈333 天）
 *   2. data.binance.vision 月包 zip —— 公共 CDN 不受地域封锁（月末才发布当月，当月缺失→数据滞后）
 *
 * 沙箱内 fapi/CDN-外主机不可达属预期；线上（Vercel）fapi 为主。全部失败时返回 []，
 * 上层指标显示"数据不可用"，绝不编造数字。
 */
import zlib from 'node:zlib';

export interface FundingPoint {
  /** 结算时间（秒） */
  t: number;
  /** 费率（小数，如 0.0001 = 0.01%/8h） */
  r: number;
}

// ==================== 模块级缓存（10 分钟） ====================

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { points: FundingPoint[]; at: number }>();

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://fapi1.binance.com', 'https://fapi2.binance.com'];
const VISION = 'https://data.binance.vision';

/** fapi 返回的最近 N 条（含当月，实时） */
async function fetchFromFapi(symbol: string): Promise<FundingPoint[]> {
  for (const host of FAPI_HOSTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${host}/fapi/v1/fundingRate?symbol=${symbol}&limit=1000`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 200) continue;
      return data
        .map((x: { fundingTime?: number; fundingRate?: string; calcTime?: number; lastFundingRate?: string }) => {
          const t = Math.floor((x.fundingTime ?? x.calcTime ?? 0) / 1000);
          const r = parseFloat(x.fundingRate ?? x.lastFundingRate ?? 'NaN');
          return { t, r };
        })
        .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.r))
        .sort((a, b) => a.t - b.t);
    } catch {
      continue;
    }
  }
  return [];
}

// ==================== 零依赖 zip 单文件解压（data.binance.vision 月包） ====================

/** 从 zip Buffer 中解出第一个文件内容（支持 deflate/store；月包为单 CSV deflate） */
function unzipFirstEntry(buf: Buffer): string {
  // 1) 从尾部找 EOCD（PK\x05\x06）
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) throw new Error('zip: EOCD not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // 2) 中央目录第一条（PK\x01\x02）
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip: bad central dir');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  // 3) 本地头：跳过 30 字节固定段 + 文件名 + extra
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return raw.toString('utf8'); // stored
  if (method === 8) return zlib.inflateRawSync(raw).toString('utf8'); // deflate
  throw new Error(`zip: unsupported method ${method}`);
}

function parseFundingCsv(csv: string): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const [t, , r] = line.split(',');
    if (!t || !r) continue;
    const tt = Math.floor(+t / 1000), rr = +r;
    if (Number.isFinite(tt) && Number.isFinite(rr)) out.push({ t: tt, r: rr });
  }
  return out;
}

/** 取最近 3 个"已发布"月份的月包（当月月包未发布会 404，逐月回退） */
async function fetchFromVision(symbol: string): Promise<FundingPoint[]> {
  const points: FundingPoint[] = [];
  const now = new Date();
  for (let back = 1; back <= 3 && points.length < 400; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${VISION}/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${ym}.zip`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 2).toString() !== 'PK') continue;
      points.push(...parseFundingCsv(unzipFirstEntry(buf)));
    } catch {
      continue;
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

// ==================== 主入口 ====================

export async function fetchFundingHistory(symbol: string): Promise<FundingPoint[]> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.points;

  let points = await fetchFromFapi(symbol);
  if (points.length < 200) {
    const fromVision = await fetchFromVision(symbol);
    if (fromVision.length > points.length) points = fromVision;
  }
  if (points.length > 0) cache.set(symbol, { points, at: Date.now() });
  return points;
}
