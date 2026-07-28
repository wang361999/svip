#!/bin/bash
# ============================================================
# ETH Trading Tool 一键部署脚本
# 使用方法：chmod +x deploy.sh && ./deploy.sh <YOUR_VERCEL_TOKEN>
# ============================================================

set -e

# ======== 检查 Token ========
if [ -z "$1" ]; then
  echo ""
  echo "错误：请传入 Vercel Token"
  echo "用法: ./deploy.sh <YOUR_VERCEL_TOKEN>"
  echo "Token 获取: https://vercel.com/account/tokens → Create Token → Full Account"
  echo ""
  exit 1
fi

TOKEN="$1"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "============================================================"
echo "  ETH Trading Tool 一键部署"
echo "============================================================"
echo ""

# ======== 第一步：检查 npm 和 vercel ========
echo "[1/6] 检查环境..."
command -v node >/dev/null 2>&1 || { echo "请先安装 Node.js"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "请先安装 npm"; exit 1; }
command -v vercel >/dev/null 2>&1 || { echo "安装 Vercel CLI..."; npm i -g vercel; }
echo "  Node $(node -v)"
echo "  Vercel CLI $(vercel --version 2>/dev/null | head -1)"
echo ""

# ======== 第二步：安装依赖 ========
echo "[2/6] 安装依赖..."
npm install --legacy-peer-deps
echo "  依赖安装完成"
echo ""

# ======== 第三步：创建项目（如果不存在）并获取项目 ID ========
echo "[3/6] 部署到 Vercel..."

# 先 link/创建项目
vercel link --yes --token "$TOKEN" 2>/dev/null || true

# 获取项目信息
PROJECT_INFO=$(vercel project ls --token "$TOKEN" 2>/dev/null || echo "")
PROJECT_NAME=$(node -p "const p=require('./package.json'); p.name")

# 提取项目ID（从 .vercel 目录）
if [ -f .vercel/project.json ]; then
  PROJECT_ID=$(node -p "const f=require('./.vercel/project.json'); f.id")
  ORG_ID=$(node -p "const f=require('./.vercel/project.json'); f.orgId")
  echo "  项目 ID: $PROJECT_ID"
  echo "  组织 ID: $ORG_ID"
fi

# ======== 第四步：逐条写入环境变量 ========
echo ""
echo "[4/6] 写入环境变量（逐条）..."

# 如果没有项目ID，先部署一次获取
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "undefined" ]; then
  echo "  首次部署，创建项目..."
  vercel --yes --token "$TOKEN" --prod 2>/dev/null || vercel --yes --token "$TOKEN" 2>/dev/null || true
  if [ -f .vercel/project.json ]; then
    PROJECT_ID=$(node -p "const f=require('./.vercel/project.json'); f.id")
    ORG_ID=$(node -p "const f=require('./.vercel/project.json'); f.orgId")
  fi
fi

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "undefined" ]; then
  echo "  警告：无法获取项目ID，跳过环境变量设置，请手动添加"
else
  # 定义所有环境变量
  declare -A ENVS
  ENVS[DATABASE_URL]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
  ENVS[DATABASE_URL_UNPOOLED]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require"
  ENVS[PGHOST]="ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech"
  ENVS[PGHOST_UNPOOLED]="ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech"
  ENVS[PGUSER]="neondb_owner"
  ENVS[PGDATABASE]="neondb"
  ENVS[PGPASSWORD]="npg_93uJZaQediCT"
  ENVS[POSTGRES_URL]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
  ENVS[POSTGRES_URL_NON_POOLING]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
  ENVS[POSTGRES_USER]="neondb_owner"
  ENVS[POSTGRES_HOST]="ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech"
  ENVS[POSTGRES_PASSWORD]="npg_93uJZaQediCT"
  ENVS[POSTGRES_DATABASE]="neondb"
  ENVS[POSTGRES_URL_NO_SSL]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb"
  ENVS[POSTGRES_PRISMA_URL]="postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&connect_timeout=15&sslmode=require"
  ENVS[JWT_SECRET]="eth-trading-super-secret-key-2024-vercel-deploy"
  ENVS[INIT_KEY]="eth-trading-init-2024"
  ENVS[ENGINE_API_KEY]="eth-engine-secret-2024"

  COUNT=0
  TOTAL=${#ENVS[@]}
  for KEY in "${!ENVS[@]}"; do
    COUNT=$((COUNT + 1))
    VALUE="${ENVS[$KEY]}"
    # 使用 vercel env add 通过管道输入
    echo "$VALUE" | vercel env add "$KEY" production preview development --token "$TOKEN" 2>/dev/null && \
      echo "  [$COUNT/$TOTAL] $KEY = 写入成功" || \
      echo "  [$COUNT/$TOTAL] $KEY = 已存在或写入失败"
  done
fi

echo ""

# ======== 第五步：正式部署 ========
echo "[5/6] 正式部署到 Vercel..."
DEPLOY_OUTPUT=$(vercel --yes --token "$TOKEN" --prod 2>&1)
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9-]+\.vercel\.app' | head -1)

echo ""

# ======== 第六步：部署后预热 + 触发缓存刷新 ========
echo "[6/6] 预热部署 & 触发缓存刷新..."

if [ -n "$DEPLOY_URL" ]; then
  # 等待部署生效
  echo "  等待部署生效（10秒）..."
  sleep 10

  # 触发首页访问 — 让 Vercel CDN 预热 + 前端 CacheBuster 版本号生效
  echo "  预热首页..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOY_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" = "200" ]; then
    echo "  首页预热成功 (HTTP $HTTP_STATUS)"
  else
    echo "  首页预热返回 $HTTP_STATUS（可能仍在启动中，稍后访问即可）"
  fi

  # 触发 init 页面预热（让数据库连接建立）
  echo "  预热数据库连接..."
  curl -s -o /dev/null "$DEPLOY_URL/api/init?status=check" 2>/dev/null || true
  echo "  数据库连接预热完成"
fi

echo ""
echo "============================================================"
echo "  部署完成！"
echo "============================================================"
echo ""
if [ -n "$DEPLOY_URL" ]; then
  echo "  访问地址: $DEPLOY_URL"
  echo ""
  echo "  ✓ 缓存已自动刷新"
  echo "    - HTML 页面：no-cache（每次请求获取最新版本）"
  echo "    - API 响应：no-store（永不缓存）"
  echo "    - 前端 CacheBuster：构建版本号自动变化"
  echo "    - 用户首次访问：自动清除旧缓存并刷新"
  echo ""
  echo "  下一步：初始化数据库"
  echo "  打开 ${DEPLOY_URL}/init"
  echo "  输入密钥: eth-trading-init-2024"
  echo "  点击初始化即可自动创建所有数据表"
  echo ""
else
  echo "  部署完成，请到 Vercel Dashboard 查看访问地址"
  echo "  然后访问 /init 页面初始化数据库"
  echo "  密钥: eth-trading-init-2024"
  echo ""
fi

echo "============================================================"
