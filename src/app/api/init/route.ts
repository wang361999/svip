import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { ForbiddenError } from '@/shared/api/errors';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** neon() 默认返回的 SQL 查询函数类型 */
type SqlFn = NeonQueryFunction<false, false>;

const INIT_KEY = process.env.INIT_KEY || 'eth-trading-init-2024';

/** 单条 SQL 执行结果 */
interface SqlResult {
  index: number;
  label: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** 单条数据写入结果 */
interface DataResult {
  step: string;
  ok: boolean;
  message: string;
  error?: string;
  durationMs: number;
}

/**
 * 建表 SQL — 逐条执行，每条单独检测
 * 使用 @neondatabase/serverless 走 HTTP 连接（Neon 官方推荐的 serverless 方式）
 */
const CREATE_TABLE_STATEMENTS: { label: string; sql: string }[] = [
  // ---------- User 表 ----------
  {
    label: 'CREATE TABLE User',
    sql: `CREATE TABLE IF NOT EXISTS "User" (
      "id" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "username" TEXT NOT NULL,
      "password" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'user',
      "membership" TEXT NOT NULL DEFAULT 'free',
      "membershipExpires" TEXT,
      "strategyConfig" TEXT,
      "prefAB9" TEXT NOT NULL DEFAULT 'true',
      "prefAutoFib" TEXT NOT NULL DEFAULT 'false',
      "prefAB9Labels" TEXT NOT NULL DEFAULT 'true',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "User_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX User_email_key', sql: `CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email")` },
  { label: 'CREATE INDEX User_username_key', sql: `CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username")` },
  { label: 'CREATE INDEX User_email_idx', sql: `CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email")` },
  { label: 'CREATE INDEX User_username_idx', sql: `CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username")` },

  // ---------- TradeRecord 表 ----------
  {
    label: 'CREATE TABLE TradeRecord',
    sql: `CREATE TABLE IF NOT EXISTS "TradeRecord" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "side" TEXT NOT NULL,
      "entryPrice" DOUBLE PRECISION NOT NULL,
      "exitPrice" DOUBLE PRECISION,
      "stopLoss" DOUBLE PRECISION,
      "takeProfit1" DOUBLE PRECISION,
      "takeProfit2" DOUBLE PRECISION,
      "volume" DOUBLE PRECISION NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'open',
      "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "pnlPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "strategy" TEXT,
      "note" TEXT,
      "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "closedAt" TIMESTAMP(3),
      CONSTRAINT "TradeRecord_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX TradeRecord_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "TradeRecord_userId_idx" ON "TradeRecord"("userId")` },
  { label: 'CREATE INDEX TradeRecord_status_idx', sql: `CREATE INDEX IF NOT EXISTS "TradeRecord_status_idx" ON "TradeRecord"("status")` },

  // ---------- VerificationCode 表 ----------
  {
    label: 'CREATE TABLE VerificationCode',
    sql: `CREATE TABLE IF NOT EXISTS "VerificationCode" (
      "id" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "expiry" TIMESTAMP(3) NOT NULL,
      "lastSent" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX VerificationCode_email_idx', sql: `CREATE INDEX IF NOT EXISTS "VerificationCode_email_idx" ON "VerificationCode"("email")` },
  { label: 'CREATE INDEX VerificationCode_type_idx', sql: `CREATE INDEX IF NOT EXISTS "VerificationCode_type_idx" ON "VerificationCode"("type")` },

  // ---------- PriceAlert 表 ----------
  {
    label: 'CREATE TABLE PriceAlert',
    sql: `CREATE TABLE IF NOT EXISTS "PriceAlert" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "condition" TEXT NOT NULL,
      "targetPrice" DOUBLE PRECISION NOT NULL,
      "note" TEXT,
      "status" TEXT NOT NULL DEFAULT 'active',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "triggeredAt" TIMESTAMP(3),
      CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX PriceAlert_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "PriceAlert_userId_idx" ON "PriceAlert"("userId")` },
  { label: 'CREATE INDEX PriceAlert_status_idx', sql: `CREATE INDEX IF NOT EXISTS "PriceAlert_status_idx" ON "PriceAlert"("status")` },

  // ---------- RedeemCode 表 ----------
  {
    label: 'CREATE TABLE RedeemCode',
    sql: `CREATE TABLE IF NOT EXISTS "RedeemCode" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "days" INTEGER NOT NULL,
      "used" BOOLEAN NOT NULL DEFAULT false,
      "usedBy" TEXT,
      "usedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "RedeemCode_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX RedeemCode_code_key', sql: `CREATE UNIQUE INDEX IF NOT EXISTS "RedeemCode_code_key" ON "RedeemCode"("code")` },
  { label: 'CREATE INDEX RedeemCode_code_idx', sql: `CREATE INDEX IF NOT EXISTS "RedeemCode_code_idx" ON "RedeemCode"("code")` },
  { label: 'CREATE INDEX RedeemCode_used_idx', sql: `CREATE INDEX IF NOT EXISTS "RedeemCode_used_idx" ON "RedeemCode"("used")` },

  // ---------- SiteSetting 表 ----------
  {
    label: 'CREATE TABLE SiteSetting',
    sql: `CREATE TABLE IF NOT EXISTS "SiteSetting" (
      "id" TEXT NOT NULL DEFAULT 'main',
      "siteTitle" TEXT NOT NULL DEFAULT 'ETH Trading Tool',
      "siteSubtitle" TEXT NOT NULL DEFAULT 'Real-time Ethereum Trading Platform',
      "siteLogo" TEXT NOT NULL DEFAULT '/logo.svg',
      "footerText" TEXT NOT NULL DEFAULT '© 2024 ETH Trading Tool. All rights reserved.',
      "primaryColor" TEXT NOT NULL DEFAULT '#3b82f6',
      "indicatorMA" TEXT NOT NULL DEFAULT 'true',
      "indicatorEMA" TEXT NOT NULL DEFAULT 'false',
      "indicatorBOLL" TEXT NOT NULL DEFAULT 'true',
      "indicatorMACD" TEXT NOT NULL DEFAULT 'true',
      "indicatorRSI" TEXT NOT NULL DEFAULT 'false',
      "indicatorATR" TEXT NOT NULL DEFAULT 'false',
      "indicatorFIB" TEXT NOT NULL DEFAULT 'false',
      "indicatorTDSequential" TEXT NOT NULL DEFAULT 'false',
      "indicatorNAKED" TEXT NOT NULL DEFAULT 'false',
      "maPeriod" TEXT NOT NULL DEFAULT '50',
      "emaPeriod" TEXT NOT NULL DEFAULT '20',
      "bollPeriod" TEXT NOT NULL DEFAULT '20',
      "rsiPeriod" TEXT NOT NULL DEFAULT '14',
      "atrPeriod" TEXT NOT NULL DEFAULT '14',
      "macdFast" TEXT NOT NULL DEFAULT '12',
      "macdSlow" TEXT NOT NULL DEFAULT '26',
      "macdSignal" TEXT NOT NULL DEFAULT '9',
      "showPriceCard" TEXT NOT NULL DEFAULT 'true',
      "showFibPanel" TEXT NOT NULL DEFAULT 'true',
      "showMarketStructure" TEXT NOT NULL DEFAULT 'true',
      "showEntrySignal" TEXT NOT NULL DEFAULT 'true',
      "showExitSignal" TEXT NOT NULL DEFAULT 'true',
      "showGannAngle" TEXT NOT NULL DEFAULT 'true',
      "showNakedBullBear" TEXT NOT NULL DEFAULT 'true',
      "showFibDraw" TEXT NOT NULL DEFAULT 'true',
      "fibLabeled" TEXT NOT NULL DEFAULT 'true',
      "fibUnlabeled" TEXT NOT NULL DEFAULT 'true',
      "enableRegistration" TEXT NOT NULL DEFAULT 'true',
      "smtpHost" TEXT DEFAULT 'smtp.qq.com',
      "smtpPort" TEXT DEFAULT '465',
      "smtpSecure" TEXT DEFAULT 'true',
      "smtpUser" TEXT,
      "smtpPass" TEXT,
      "smtpFrom" TEXT,
      "ab9Line1Color" TEXT NOT NULL DEFAULT 'rgba(100, 116, 139, 0.3)',
      "ab9Line2Color" TEXT NOT NULL DEFAULT 'rgba(100, 116, 139, 0.35)',
      "ab9Line3Color" TEXT NOT NULL DEFAULT 'rgba(239, 68, 68, 0.75)',
      "ab9Line4Color" TEXT NOT NULL DEFAULT 'rgba(148, 163, 184, 0.7)',
      "ab9Line5Color" TEXT NOT NULL DEFAULT 'rgba(34, 197, 94, 0.75)',
      "ab9Line6Color" TEXT NOT NULL DEFAULT 'rgba(100, 116, 139, 0.45)',
      "ab9Line7Color" TEXT NOT NULL DEFAULT 'rgba(100, 116, 139, 0.45)',
      "ab9Line8Color" TEXT NOT NULL DEFAULT 'rgba(148, 163, 184, 0.6)',
      "ab9Line9Color" TEXT NOT NULL DEFAULT 'rgba(168, 85, 247, 0.6)',
      "paperTradingEnabled" TEXT NOT NULL DEFAULT 'false',
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "SiteSetting_pkey" PRIMARY KEY ("id")
    )`,
  },
  // ---------- PaperAccount 表（模拟盘账户） ----------
  {
    label: 'CREATE TABLE PaperAccount',
    sql: `CREATE TABLE IF NOT EXISTS "PaperAccount" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "balance" DOUBLE PRECISION NOT NULL DEFAULT 100000,
      "available" DOUBLE PRECISION NOT NULL DEFAULT 100000,
      "marginUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "unrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "leverage" INTEGER NOT NULL DEFAULT 10,
      "positionPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
      "stopLossPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
      "takerFee" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
      "makerFee" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
      "slippage" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
      "autoTrade" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "PaperAccount_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX PaperAccount_userId_key', sql: `CREATE UNIQUE INDEX IF NOT EXISTS "PaperAccount_userId_key" ON "PaperAccount"("userId")` },
  { label: 'CREATE INDEX PaperAccount_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperAccount_userId_idx" ON "PaperAccount"("userId")` },
  // ---------- PaperPosition 表（模拟盘持仓） ----------
  {
    label: 'CREATE TABLE PaperPosition',
    sql: `CREATE TABLE IF NOT EXISTS "PaperPosition" (
      "id" TEXT NOT NULL,
      "accountId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "side" TEXT NOT NULL,
      "entryPrice" DOUBLE PRECISION NOT NULL,
      "quantity" DOUBLE PRECISION NOT NULL,
      "leverage" INTEGER NOT NULL,
      "margin" DOUBLE PRECISION NOT NULL,
      "stopLoss" DOUBLE PRECISION,
      "takeProfit1" DOUBLE PRECISION,
      "takeProfit2" DOUBLE PRECISION,
      "partialClosed" BOOLEAN NOT NULL DEFAULT false,
      "status" TEXT NOT NULL DEFAULT 'open',
      "strategyId" TEXT,
      "signalPrice" DOUBLE PRECISION,
      "entryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "entrySlippage" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "currentPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "unrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "unrealizedPnlPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "closedAt" TIMESTAMP(3),
      CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX PaperPosition_accountId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperPosition_accountId_idx" ON "PaperPosition"("accountId")` },
  { label: 'CREATE INDEX PaperPosition_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperPosition_userId_idx" ON "PaperPosition"("userId")` },
  { label: 'CREATE INDEX PaperPosition_status_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperPosition_status_idx" ON "PaperPosition"("status")` },
  { label: 'CREATE INDEX PaperPosition_symbol_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperPosition_symbol_idx" ON "PaperPosition"("symbol")` },
  // ---------- PaperTrade 表（模拟盘交易记录） ----------
  {
    label: 'CREATE TABLE PaperTrade',
    sql: `CREATE TABLE IF NOT EXISTS "PaperTrade" (
      "id" TEXT NOT NULL,
      "positionId" TEXT NOT NULL,
      "accountId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "side" TEXT NOT NULL,
      "entryPrice" DOUBLE PRECISION NOT NULL,
      "exitPrice" DOUBLE PRECISION NOT NULL,
      "quantity" DOUBLE PRECISION NOT NULL,
      "leverage" INTEGER NOT NULL,
      "margin" DOUBLE PRECISION NOT NULL,
      "pnl" DOUBLE PRECISION NOT NULL,
      "pnlPercent" DOUBLE PRECISION NOT NULL,
      "fee" DOUBLE PRECISION NOT NULL,
      "slippage" DOUBLE PRECISION NOT NULL,
      "totalCost" DOUBLE PRECISION NOT NULL,
      "duration" INTEGER NOT NULL DEFAULT 0,
      "closeReason" TEXT NOT NULL,
      "strategyId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX PaperTrade_positionId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTrade_positionId_idx" ON "PaperTrade"("positionId")` },
  { label: 'CREATE INDEX PaperTrade_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTrade_userId_idx" ON "PaperTrade"("userId")` },
  { label: 'CREATE INDEX PaperTrade_symbol_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTrade_symbol_idx" ON "PaperTrade"("symbol")` },
  // ---------- PaperTradeLog 表（模拟盘日志） ----------
  {
    label: 'CREATE TABLE PaperTradeLog',
    sql: `CREATE TABLE IF NOT EXISTS "PaperTradeLog" (
      "id" TEXT NOT NULL,
      "accountId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "symbol" TEXT,
      "detail" TEXT NOT NULL,
      "price" DOUBLE PRECISION,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaperTradeLog_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX PaperTradeLog_accountId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTradeLog_accountId_idx" ON "PaperTradeLog"("accountId")` },
  { label: 'CREATE INDEX PaperTradeLog_userId_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTradeLog_userId_idx" ON "PaperTradeLog"("userId")` },
  { label: 'CREATE INDEX PaperTradeLog_action_idx', sql: `CREATE INDEX IF NOT EXISTS "PaperTradeLog_action_idx" ON "PaperTradeLog"("action")` },
  // ---------- 补充列（兼容已有数据库） ----------
  { label: 'ALTER TABLE PaperAccount ADD currentSymbol', sql: `ALTER TABLE "PaperAccount" ADD COLUMN IF NOT EXISTS "currentSymbol" TEXT` },
  { label: 'ALTER TABLE PaperPosition ADD aiMeta', sql: `ALTER TABLE "PaperPosition" ADD COLUMN IF NOT EXISTS "aiMeta" TEXT` },
  { label: 'ALTER TABLE PaperTrade ADD aiMeta', sql: `ALTER TABLE "PaperTrade" ADD COLUMN IF NOT EXISTS "aiMeta" TEXT` },
  { label: 'ALTER TABLE PaperTrade ADD aiCorrect', sql: `ALTER TABLE "PaperTrade" ADD COLUMN IF NOT EXISTS "aiCorrect" BOOLEAN` },
  { label: 'ALTER TABLE AiAnalysis ADD meta', sql: `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "meta" TEXT` },
  { label: 'ALTER TABLE SiteSetting ADD paperTradingEnabled', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "paperTradingEnabled" TEXT NOT NULL DEFAULT 'false'` },
  { label: 'ALTER TABLE SiteSetting ADD cronLoops', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "cronLoops" TEXT DEFAULT '1'` },
  { label: 'ALTER TABLE SiteSetting ADD cronInterval', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "cronInterval" TEXT DEFAULT '0'` },
  { label: 'ALTER TABLE SiteSetting ADD cronLogTtl', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "cronLogTtl" TEXT DEFAULT '1'` },
  // ---------- AI 配置列（兼容已有数据库） ----------
  { label: 'ALTER TABLE SiteSetting ADD aiEnabled', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiEnabled" TEXT NOT NULL DEFAULT 'true'` },
  { label: 'ALTER TABLE SiteSetting ADD aiProvider', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiProvider" TEXT NOT NULL DEFAULT 'custom'` },
  { label: 'ALTER TABLE SiteSetting ADD aiApiUrl', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiApiUrl" TEXT` },
  { label: 'ALTER TABLE SiteSetting ADD aiApiKey', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiApiKey" TEXT` },
  { label: 'ALTER TABLE SiteSetting ADD aiModel', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiModel" TEXT` },
  { label: 'ALTER TABLE SiteSetting ADD aiTemperature', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiTemperature" TEXT NOT NULL DEFAULT '0.3'` },
  { label: 'ALTER TABLE SiteSetting ADD aiMaxTokens', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiMaxTokens" TEXT NOT NULL DEFAULT '4000'` },
  { label: 'ALTER TABLE SiteSetting ADD aiAnalysisInterval', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiAnalysisInterval" TEXT NOT NULL DEFAULT '30'` },
  { label: 'ALTER TABLE SiteSetting ADD aiAutoTrade', sql: `ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "aiAutoTrade" TEXT NOT NULL DEFAULT 'false'` },
  // ---------- TradingSymbol 表（币种管理） ----------
  {
    label: 'CREATE TABLE TradingSymbol',
    sql: `CREATE TABLE IF NOT EXISTS "TradingSymbol" (
      "id" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "okxId" TEXT NOT NULL,
      "label" TEXT NOT NULL,
      "baseAsset" TEXT NOT NULL,
      "quoteAsset" TEXT NOT NULL DEFAULT 'USDT',
      "pricePrecision" INTEGER NOT NULL DEFAULT 2,
      "qtyPrecision" INTEGER NOT NULL DEFAULT 4,
      "minQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "minNotional" DOUBLE PRECISION NOT NULL DEFAULT 5,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "autoTrade" BOOLEAN NOT NULL DEFAULT false,
      "isPopular" BOOLEAN NOT NULL DEFAULT false,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "iconUrl" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "TradingSymbol_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "TradingSymbol_symbol_key" UNIQUE ("symbol")
    )`,
  },
  // 兼容旧数据库：CREATE TABLE IF NOT EXISTS 不会给已有表补字段，所以这里逐列补齐
  { label: 'ALTER TABLE TradingSymbol ADD id', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "id" TEXT` },
  { label: 'ALTER TABLE TradingSymbol ADD symbol', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "symbol" TEXT` },
  { label: 'ALTER TABLE TradingSymbol ADD okxId', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "okxId" TEXT NOT NULL DEFAULT ''` },
  { label: 'ALTER TABLE TradingSymbol ADD label', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "label" TEXT NOT NULL DEFAULT ''` },
  { label: 'ALTER TABLE TradingSymbol ADD baseAsset', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "baseAsset" TEXT NOT NULL DEFAULT ''` },
  { label: 'ALTER TABLE TradingSymbol ADD quoteAsset', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "quoteAsset" TEXT NOT NULL DEFAULT 'USDT'` },
  { label: 'ALTER TABLE TradingSymbol ADD pricePrecision', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "pricePrecision" INTEGER NOT NULL DEFAULT 2` },
  { label: 'ALTER TABLE TradingSymbol ADD qtyPrecision', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "qtyPrecision" INTEGER NOT NULL DEFAULT 4` },
  { label: 'ALTER TABLE TradingSymbol ADD minQty', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "minQty" DOUBLE PRECISION NOT NULL DEFAULT 0` },
  { label: 'ALTER TABLE TradingSymbol ADD minNotional', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "minNotional" DOUBLE PRECISION NOT NULL DEFAULT 5` },
  { label: 'ALTER TABLE TradingSymbol ADD active', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true` },
  { label: 'ALTER TABLE TradingSymbol ADD autoTrade', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "autoTrade" BOOLEAN NOT NULL DEFAULT false` },
  { label: 'ALTER TABLE TradingSymbol ADD isPopular', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "isPopular" BOOLEAN NOT NULL DEFAULT false` },
  { label: 'ALTER TABLE TradingSymbol ADD sortOrder', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0` },
  { label: 'ALTER TABLE TradingSymbol ADD iconUrl', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "iconUrl" TEXT` },
  { label: 'ALTER TABLE TradingSymbol ADD createdAt', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` },
  { label: 'ALTER TABLE TradingSymbol ADD updatedAt', sql: `ALTER TABLE "TradingSymbol" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` },
  { label: 'UPDATE TradingSymbol fill missing id', sql: `UPDATE "TradingSymbol" SET "id" = md5(random()::text || clock_timestamp()::text) WHERE "id" IS NULL OR "id" = ''` },
  { label: 'UPDATE TradingSymbol fill display fields', sql: `UPDATE "TradingSymbol" SET "baseAsset" = REPLACE("symbol", 'USDT', ''), "okxId" = REPLACE("symbol", 'USDT', '-USDT'), "label" = REPLACE("symbol", 'USDT', '/USDT') WHERE "symbol" IS NOT NULL AND ("okxId" = '' OR "label" = '' OR "baseAsset" = '')` },
  { label: 'CREATE INDEX TradingSymbol_symbol_key', sql: `CREATE UNIQUE INDEX IF NOT EXISTS "TradingSymbol_symbol_key" ON "TradingSymbol"("symbol")` },
  { label: 'UPDATE TradingSymbol default autoTrade whitelist', sql: `UPDATE "TradingSymbol" SET "autoTrade" = true WHERE "symbol" IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT') AND "autoTrade" = false` },
  { label: 'CREATE INDEX TradingSymbol_active_idx', sql: `CREATE INDEX IF NOT EXISTS "TradingSymbol_active_idx" ON "TradingSymbol"("active")` },
  { label: 'CREATE INDEX TradingSymbol_autoTrade_idx', sql: `CREATE INDEX IF NOT EXISTS "TradingSymbol_autoTrade_idx" ON "TradingSymbol"("autoTrade")` },
  { label: 'CREATE INDEX TradingSymbol_isPopular_idx', sql: `CREATE INDEX IF NOT EXISTS "TradingSymbol_isPopular_idx" ON "TradingSymbol"("isPopular")` },
  { label: 'CREATE INDEX TradingSymbol_sortOrder_idx', sql: `CREATE INDEX IF NOT EXISTS "TradingSymbol_sortOrder_idx" ON "TradingSymbol"("sortOrder")` },
  // ---------- AiAnalysis 表（AI 行情分析记录） ----------
  {
    label: 'CREATE TABLE AiAnalysis',
    sql: `CREATE TABLE IF NOT EXISTS "AiAnalysis" (
      "id" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "direction" TEXT NOT NULL,
      "confidence" INTEGER NOT NULL,
      "summary" TEXT NOT NULL,
      "entryPrice" DOUBLE PRECISION,
      "stopLoss" DOUBLE PRECISION,
      "takeProfit1" DOUBLE PRECISION,
      "takeProfit2" DOUBLE PRECISION,
      "reasoning" TEXT NOT NULL,
      "keyLevels" TEXT,
      "riskWarning" TEXT,
      "provider" TEXT,
      "model" TEXT,
      "rawResponse" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
    )`,
  },
  { label: 'CREATE INDEX AiAnalysis_symbol_idx', sql: `CREATE INDEX IF NOT EXISTS "AiAnalysis_symbol_idx" ON "AiAnalysis"("symbol")` },
  { label: 'CREATE INDEX AiAnalysis_createdAt_idx', sql: `CREATE INDEX IF NOT EXISTS "AiAnalysis_createdAt_idx" ON "AiAnalysis"("createdAt")` },
  { label: 'CREATE INDEX AiAnalysis_direction_idx', sql: `CREATE INDEX IF NOT EXISTS "AiAnalysis_direction_idx" ON "AiAnalysis"("direction")` },
];

/**
 * 解析数据库连接串
 * 优先级：body.databaseUrl > query.databaseUrl > 环境变量 DATABASE_URL
 */
function resolveDatabaseUrl(
  queryDbUrl: string | null,
  bodyDbUrl?: string,
): { url: string | null; source: string } {
  if (bodyDbUrl && bodyDbUrl.trim()) {
    return { url: bodyDbUrl.trim(), source: 'request_body' };
  }
  if (queryDbUrl && queryDbUrl.trim()) {
    return { url: queryDbUrl.trim(), source: 'query_param' };
  }
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'env' };
  }
  return { url: null, source: 'none' };
}

/** 连接预检 — SELECT 1 测试连接是否可用（15s 超时） */
async function pingDatabase(sql: SqlFn): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  const t0 = Date.now();
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('数据库连接超时（15s）')), 15000),
      ),
    ]);
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

/** 检查初始化密钥 — 数据库为空时跳过 */
async function requireInitKeyOrEmpty(sql: SqlFn, key: string | null) {
  try {
    const rows = (await sql`SELECT COUNT(*)::int as count FROM "User"`) as Array<{ count: number }>;
    if (rows[0]?.count === 0) return;
  } catch {
    return;
  }
  if (key !== INIT_KEY) {
    throw new ForbiddenError('INIT_INVALID_KEY', '无效的初始化密钥');
  }
}

/** 逐条建表 — 每条单独执行并记录结果 */
async function ensureTables(sql: SqlFn): Promise<SqlResult[]> {
  const results: SqlResult[] = [];
  for (let i = 0; i < CREATE_TABLE_STATEMENTS.length; i++) {
    const { label, sql: sqlText } = CREATE_TABLE_STATEMENTS[i];
    const t0 = Date.now();
    try {
      // neon() 可以直接用普通函数调用方式执行查询字符串
      await sql(sqlText);
      results.push({ index: i, label, ok: true, durationMs: Date.now() - t0 });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      results.push({
        index: i,
        label,
        ok: false,
        error: msg.slice(0, 200),
        durationMs: Date.now() - t0,
      });
    }
  }
  return results;
}

/** 生成 UUID（不依赖扩展） */
function genId(): string {
  // crypto.randomUUID 在 Node 18+ / Vercel 环境可用
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 逐条写入管理员账户 */
async function ensureAdmin(sql: SqlFn): Promise<DataResult> {
  const t0 = Date.now();
  try {
    const existing = (await sql`SELECT id FROM "User" WHERE email = 'admin@ethtrading.com'`) as Array<{ id: string }>;
    if (existing.length > 0) {
      return { step: 'admin', ok: true, message: '管理员账户已存在，跳过创建', durationMs: Date.now() - t0 };
    }
    const password = await bcrypt.hash('admin', 12);
    const id = genId();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "User" ("id", "email", "username", "password", "role", "membership", "prefAB9", "prefAutoFib", "prefAB9Labels", "createdAt", "updatedAt")
      VALUES (${id}, 'admin@ethtrading.com', 'admin', ${password}, 'admin', 'vip', 'true', 'false', 'true', ${now}, ${now})
    `;
    return { step: 'admin', ok: true, message: '管理员账户创建成功 (admin@ethtrading.com / admin)', durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      step: 'admin',
      ok: false,
      message: '管理员账户创建失败',
      error: ((err as Error).message ?? String(err)).slice(0, 200),
      durationMs: Date.now() - t0,
    };
  }
}

/** 逐条写入默认网站设置 */
async function ensureSiteSettings(sql: SqlFn): Promise<DataResult> {
  const t0 = Date.now();
  try {
    const existing = (await sql`SELECT id FROM "SiteSetting" WHERE id = 'main'`) as Array<{ id: string }>;
    if (existing.length > 0) {
      return { step: 'siteSettings', ok: true, message: '网站设置已存在，跳过创建', durationMs: Date.now() - t0 };
    }
    const now = new Date().toISOString();
    await sql`INSERT INTO "SiteSetting" ("id", "updatedAt") VALUES ('main', ${now})`;
    return { step: 'siteSettings', ok: true, message: '默认网站设置创建成功', durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      step: 'siteSettings',
      ok: false,
      message: '网站设置创建失败',
      error: ((err as Error).message ?? String(err)).slice(0, 200),
      durationMs: Date.now() - t0,
    };
  }
}

/** 默认币种列表 */
const DEFAULT_SYMBOLS = [
  { symbol: 'BTCUSDT', okxId: 'BTC-USDT', label: 'BTC/USDT', baseAsset: 'BTC', isPopular: true, autoTrade: true, sortOrder: 1, pricePrecision: 2, qtyPrecision: 5, minQty: 0.00001 },
  { symbol: 'ETHUSDT', okxId: 'ETH-USDT', label: 'ETH/USDT', baseAsset: 'ETH', isPopular: true, autoTrade: true, sortOrder: 2, pricePrecision: 2, qtyPrecision: 4, minQty: 0.0001 },
  { symbol: 'SOLUSDT', okxId: 'SOL-USDT', label: 'SOL/USDT', baseAsset: 'SOL', isPopular: true, autoTrade: true, sortOrder: 3, pricePrecision: 3, qtyPrecision: 3, minQty: 0.01 },
  { symbol: 'BNBUSDT', okxId: 'BNB-USDT', label: 'BNB/USDT', baseAsset: 'BNB', isPopular: true, autoTrade: false, sortOrder: 4, pricePrecision: 2, qtyPrecision: 3, minQty: 0.001 },
  { symbol: 'XRPUSDT', okxId: 'XRP-USDT', label: 'XRP/USDT', baseAsset: 'XRP', isPopular: true, autoTrade: false, sortOrder: 5, pricePrecision: 4, qtyPrecision: 1, minQty: 0.1 },
  { symbol: 'DOGEUSDT', okxId: 'DOGE-USDT', label: 'DOGE/USDT', baseAsset: 'DOGE', isPopular: true, autoTrade: false, sortOrder: 6, pricePrecision: 5, qtyPrecision: 0, minQty: 1 },
  { symbol: 'ADAUSDT', okxId: 'ADA-USDT', label: 'ADA/USDT', baseAsset: 'ADA', isPopular: false, autoTrade: false, sortOrder: 7, pricePrecision: 4, qtyPrecision: 1, minQty: 0.1 },
  { symbol: 'AVAXUSDT', okxId: 'AVAX-USDT', label: 'AVAX/USDT', baseAsset: 'AVAX', isPopular: false, autoTrade: false, sortOrder: 8, pricePrecision: 3, qtyPrecision: 2, minQty: 0.01 },
  { symbol: 'LINKUSDT', okxId: 'LINK-USDT', label: 'LINK/USDT', baseAsset: 'LINK', isPopular: false, autoTrade: false, sortOrder: 9, pricePrecision: 3, qtyPrecision: 2, minQty: 0.01 },
  { symbol: 'LTCUSDT', okxId: 'LTC-USDT', label: 'LTC/USDT', baseAsset: 'LTC', isPopular: false, autoTrade: false, sortOrder: 10, pricePrecision: 2, qtyPrecision: 3, minQty: 0.001 },
];

/** 写入默认币种 */
async function ensureDefaultSymbols(sql: SqlFn): Promise<DataResult> {
  const t0 = Date.now();
  try {
    const existing = (await sql`SELECT COUNT(*)::int as count FROM "TradingSymbol"`) as Array<{ count: number }>;
    if (existing[0]?.count > 0) {
      return { step: 'defaultSymbols', ok: true, message: `已有 ${existing[0].count} 个币种，跳过创建`, durationMs: Date.now() - t0 };
    }
    const now = new Date().toISOString();
    let inserted = 0;
    for (const s of DEFAULT_SYMBOLS) {
      const id = genId();
      await sql`
        INSERT INTO "TradingSymbol" (
          "id", "symbol", "okxId", "label", "baseAsset", "quoteAsset",
          "pricePrecision", "qtyPrecision", "minQty", "minNotional",
          "active", "autoTrade", "isPopular", "sortOrder", "createdAt", "updatedAt"
        ) VALUES (
          ${id}, ${s.symbol}, ${s.okxId}, ${s.label}, ${s.baseAsset}, 'USDT',
          ${s.pricePrecision}, ${s.qtyPrecision}, ${s.minQty}, 5,
          true, ${s.autoTrade}, ${s.isPopular}, ${s.sortOrder}, ${now}, ${now}
        )
      `;
      inserted++;
    }
    return { step: 'defaultSymbols', ok: true, message: `默认币种创建成功，共 ${inserted} 个`, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      step: 'defaultSymbols',
      ok: false,
      message: '默认币种创建失败',
      error: ((err as Error).message ?? String(err)).slice(0, 200),
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * POST /api/init — 一键初始化数据库
 * 使用 @neondatabase/serverless 走 HTTP 连接（Neon 官方推荐方式）
 * databaseUrl 可通过 body / query 传入，也可直接走环境变量
 */
export const POST = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get('key');
  const queryDbUrl = searchParams.get('databaseUrl');

  // 尝试从 body 读取 databaseUrl
  let bodyDbUrl: string | undefined;
  try {
    const body = await req.json();
    bodyDbUrl = body?.databaseUrl;
  } catch {
    // body 不是 JSON 或为空
  }

  const { url: dbUrl, source } = resolveDatabaseUrl(queryDbUrl, bodyDbUrl);

  if (!dbUrl) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'DB_URL_MISSING',
          message: '未提供数据库连接串，请在页面上粘贴 Neon 连接串，或配置 DATABASE_URL 环境变量',
        },
        data: { stage: 'resolve_url' },
      },
      { status: 400 },
    );
  }

  // 用 @neondatabase/serverless 创建 HTTP 连接
  const sql = neon(dbUrl);

  // 1. 连接预检
  const ping = await pingDatabase(sql);
  if (!ping.ok) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'DB_CONNECT_FAILED',
          message: '数据库连接失败，请检查连接串是否正确、数据库是否已激活',
        },
        data: {
          stage: 'connection_check',
          ping,
          urlSource: source,
          hint: '请确认：1) 连接串格式正确 2) Neon 数据库已激活 3) IP 已加入白名单',
        },
      },
      { status: 503 },
    );
  }

  // 2. 密钥检查
  await requireInitKeyOrEmpty(sql, key);

  // 3. 逐条建表
  const sqlResults = await ensureTables(sql);
  const sqlOkCount = sqlResults.filter((r) => r.ok).length;
  const sqlFailCount = sqlResults.length - sqlOkCount;

  // 4. 逐条写入数据
  const adminResult = await ensureAdmin(sql);
  const settingsResult = await ensureSiteSettings(sql);
  const symbolsResult = await ensureDefaultSymbols(sql);

  // 5. 汇总
  const allDataOk = adminResult.ok && settingsResult.ok && symbolsResult.ok;
  const overallOk = ping.ok && sqlFailCount === 0 && allDataOk;

  return apiSuccess({
    message: overallOk
      ? '数据库初始化完成，所有步骤成功'
      : `初始化完成但有部分失败：SQL ${sqlOkCount}/${sqlResults.length} 成功，数据写入 ${allDataOk ? '成功' : '有失败'}`,
    overallOk,
    urlSource: source,
    stages: {
      connectionCheck: { ok: ping.ok, durationMs: ping.durationMs, error: ping.error },
      tableCreation: {
        total: sqlResults.length,
        success: sqlOkCount,
        failed: sqlFailCount,
        allOk: sqlFailCount === 0,
        details: sqlResults.map((r) => ({
          index: r.index,
          label: r.label,
          ok: r.ok,
          durationMs: r.durationMs,
          error: r.error,
        })),
      },
      dataSeed: {
        admin: adminResult,
        siteSettings: settingsResult,
        defaultSymbols: symbolsResult,
        allOk: allDataOk,
      },
    },
    summary: {
      totalSteps: sqlResults.length + 3,
      successSteps: sqlOkCount + (adminResult.ok ? 1 : 0) + (settingsResult.ok ? 1 : 0) + (symbolsResult.ok ? 1 : 0),
      failedSteps: sqlFailCount + (adminResult.ok ? 0 : 1) + (settingsResult.ok ? 0 : 1) + (symbolsResult.ok ? 0 : 1),
    },
  });
});

/**
 * GET /api/init — 检查数据库初始化状态
 */
export const GET = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get('key');
  const queryDbUrl = searchParams.get('databaseUrl');

  const { url: dbUrl, source } = resolveDatabaseUrl(queryDbUrl);

  if (!dbUrl) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'DB_URL_MISSING', message: '未提供数据库连接串' },
        data: { stage: 'resolve_url' },
      },
      { status: 400 },
    );
  }

  const sql = neon(dbUrl);

  // 连接预检
  const ping = await pingDatabase(sql);
  if (!ping.ok) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'DB_CONNECT_FAILED', message: '数据库连接失败，无法检查初始化状态' },
        data: { stage: 'connection_check', ping, urlSource: source },
      },
      { status: 503 },
    );
  }

  await requireInitKeyOrEmpty(sql, key);

  let userCount = 0;
  let settingsCount = 0;
  let userTableExists = true;
  let settingsTableExists = true;

  try {
    const rows = (await sql`SELECT COUNT(*)::int as count FROM "User"`) as Array<{ count: number }>;
    userCount = rows[0]?.count ?? 0;
  } catch {
    userTableExists = false;
  }
  try {
    const rows = (await sql`SELECT COUNT(*)::int as count FROM "SiteSetting"`) as Array<{ count: number }>;
    settingsCount = rows[0]?.count ?? 0;
  } catch {
    settingsTableExists = false;
  }

  return apiSuccess({
    initialized: userCount > 0 || settingsCount > 0,
    connectionOk: ping.ok,
    userTableExists,
    settingsTableExists,
    userCount,
    settingsCount,
    urlSource: source,
    message:
      userCount > 0
        ? '数据库已初始化，包含管理员账户'
        : '数据库尚未初始化，请执行初始化操作',
  });
});
