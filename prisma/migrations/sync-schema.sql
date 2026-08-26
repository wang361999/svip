-- ============================================================
-- ETH Trading Tool - Schema 同步迁移
-- ============================================================
-- 此脚本将数据库表结构与 prisma/schema.prisma 同步
-- 适用于已部署的 Neon 数据库（向后兼容，不删数据）
--
-- 执行方式：
--   npx prisma db push   （推荐，自动同步）
--   或在 Neon Dashboard 的 SQL Editor 执行本文件
-- ============================================================

-- 1. User 表：补齐缺失列（IF NOT EXISTS 兼容旧表）
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "membership" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "membershipExpires" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "strategyConfig" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "prefAB9" TEXT DEFAULT 'true';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "prefAB9Labels" TEXT DEFAULT 'true';
-- 清理已废弃的用户偏好列
ALTER TABLE "User" DROP COLUMN IF EXISTS "prefAutoFib";
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email");
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");

-- 2. TradeRecord 表：补齐缺失列
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "entryPrice" DOUBLE PRECISION;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "exitPrice" DOUBLE PRECISION;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "stopLoss" DOUBLE PRECISION;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "takeProfit1" DOUBLE PRECISION;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "takeProfit2" DOUBLE PRECISION;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS pnl DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "pnlPercent" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS strategy TEXT;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE "TradeRecord" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
-- 旧数据 price 改为可空（兼容旧 schema 用 price 而非 entryPrice）
ALTER TABLE "TradeRecord" ALTER COLUMN price DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "TradeRecord_userId_idx" ON "TradeRecord"("userId");
CREATE INDEX IF NOT EXISTS "TradeRecord_status_idx" ON "TradeRecord"("status");

-- 3. VerificationCode 表
CREATE TABLE IF NOT EXISTS "VerificationCode" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  expiry TIMESTAMP(3) NOT NULL,
  "lastSent" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "VerificationCode_email_idx" ON "VerificationCode"("email");
CREATE INDEX IF NOT EXISTS "VerificationCode_type_idx" ON "VerificationCode"("type");

-- 4. PriceAlert 表
CREATE TABLE IF NOT EXISTS "PriceAlert" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  symbol TEXT NOT NULL,
  condition TEXT NOT NULL,
  "targetPrice" DOUBLE PRECISION NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "triggeredAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "PriceAlert_userId_idx" ON "PriceAlert"("userId");
CREATE INDEX IF NOT EXISTS "PriceAlert_status_idx" ON "PriceAlert"("status");

-- 5. RedeemCode 表
CREATE TABLE IF NOT EXISTS "RedeemCode" (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  days INTEGER NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  "usedBy" TEXT,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RedeemCode_code_idx" ON "RedeemCode"("code");
CREATE INDEX IF NOT EXISTS "RedeemCode_used_idx" ON "RedeemCode"("used");

-- 6. SiteSetting 表：补齐全部缺失列
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "indicatorEMA" TEXT DEFAULT 'false';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "indicatorBOLL" TEXT DEFAULT 'true';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "indicatorMACD" TEXT DEFAULT 'true';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "indicatorRSI" TEXT DEFAULT 'false';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "emaPeriod" TEXT DEFAULT '20';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "bollPeriod" TEXT DEFAULT '20';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "rsiPeriod" TEXT DEFAULT '14';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "macdFast" TEXT DEFAULT '12';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "macdSlow" TEXT DEFAULT '26';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "macdSignal" TEXT DEFAULT '9';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "showPriceCard" TEXT DEFAULT 'true';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "enableRegistration" TEXT DEFAULT 'true';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpHost" TEXT DEFAULT 'smtp.qq.com';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpPort" TEXT DEFAULT '465';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpSecure" TEXT DEFAULT 'true';
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpUser" TEXT;
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpPass" TEXT;
ALTER TABLE "SiteSetting" ADD COLUMN IF NOT EXISTS "smtpFrom" TEXT;
-- 清理已废弃的指标列（FIB/TD/NAKED/ATR 等，已从代码中移除）
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "indicatorATR";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "atrPeriod";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "indicatorFIB";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "indicatorTDSequential";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "indicatorNAKED";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showFibPanel";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showMarketStructure";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showEntrySignal";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showExitSignal";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showGannAngle";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showNakedBullBear";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "showFibDraw";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "fibLabeled";
ALTER TABLE "SiteSetting" DROP COLUMN IF EXISTS "fibUnlabeled";

-- 11. AiAnalysis 表：AI 预测反馈闭环（复盘结果字段）
-- 若表不存在则创建（列清单与 schema.prisma 保持一致）
CREATE TABLE IF NOT EXISTS "AiAnalysis" (
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
    "meta" TEXT,
    "riskWarning" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "rawResponse" TEXT,
    "outcome" TEXT,
    "outcomePrice" DOUBLE PRECISION,
    "outcomeAt" TIMESTAMP(3),
    "outcomeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);
-- 旧表补列（IF NOT EXISTS 兼容）
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "meta" TEXT;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomePrice" DOUBLE PRECISION;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomeAt" TIMESTAMP(3);
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomeNote" TEXT;
ALTER TABLE "AiAnalysis" DROP COLUMN IF EXISTS "pullback";
CREATE INDEX IF NOT EXISTS "AiAnalysis_symbol_idx" ON "AiAnalysis"("symbol");
CREATE INDEX IF NOT EXISTS "AiAnalysis_createdAt_idx" ON "AiAnalysis"("createdAt");
CREATE INDEX IF NOT EXISTS "AiAnalysis_direction_idx" ON "AiAnalysis"("direction");
CREATE INDEX IF NOT EXISTS "AiAnalysis_outcome_idx" ON "AiAnalysis"("outcome");

-- 完成
SELECT 'Schema 同步完成' as result;
