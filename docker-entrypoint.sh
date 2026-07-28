#!/bin/sh
set -e

echo "============================================"
echo "  ETH Trading Tool - Docker 启动"
echo "============================================"

# 等待数据库就绪
echo "[1/4] 等待数据库就绪..."
MAX_RETRIES=30
RETRY=0
until npx prisma db push --accept-data-loss 2>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ $RETRY -ge $MAX_RETRIES ]; then
    echo "数据库连接超时，请检查 postgres 容器是否正常运行"
    exit 1
  fi
  echo "  数据库未就绪，重试 ($RETRY/$MAX_RETRIES)..."
  sleep 2
done
echo "[1/4] 数据库已连接"

# 创建表结构
echo "[2/4] 同步数据库表结构..."
npx prisma db push --accept-data-loss
echo "[2/4] 表结构同步完成"

# 自动创建管理员账号（如果不存在）
echo "[3/4] 创建管理员账号..."
npx tsx prisma/seed.ts || echo "  管理员账号已存在，跳过"
echo "[3/4] 管理员账号就绪"

# 启动应用
echo "[4/4] 启动应用..."
echo "============================================"
echo "  访问地址: http://localhost:3000"
echo "  管理员:   admin@ethtrading.com / admin"
echo "============================================"
exec npm start
