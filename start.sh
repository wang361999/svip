#!/bin/bash
#
# ETH Trading Tool - 一键启动脚本
# 只需要安装好 Docker，运行这个脚本就行
#
set -e

echo ""
echo "============================================"
echo "  ETH Trading Tool 一键部署"
echo "============================================"
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker："
  echo "  Windows/Mac: https://www.docker.com/products/docker-desktop"
  echo "  Linux:       https://docs.docker.com/engine/install/"
  echo ""
  echo "安装后重新运行本脚本即可。"
  exit 1
fi

# 检查 Docker Compose
if ! docker compose version &> /dev/null; then
  if ! command -v docker-compose &> /dev/null; then
    echo "[错误] 未检测到 Docker Compose，请安装完整版 Docker"
    exit 1
  fi
  COMPOSE_CMD="docker-compose"
else
  COMPOSE_CMD="docker compose"
fi

echo "[1/3] 构建应用镜像（首次约 2-3 分钟）..."
$COMPOSE_CMD build

echo ""
echo "[2/3] 启动服务..."
$COMPOSE_CMD up -d

echo ""
echo "[3/3] 等待应用就绪..."
sleep 5

# 检查应用是否启动
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -q "200\|307\|308"; then
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo "  等待中... ($WAITED/$MAX_WAIT 秒)"
done

echo ""
echo "============================================"
echo "  部署完成！"
echo "============================================"
echo ""
echo "  访问地址:  http://localhost:3000"
echo "  管理员:    admin@ethtrading.com"
echo "  密码:      admin"
echo ""
echo "  数据库已自动创建，管理员账号已自动配置"
echo "  直接打开浏览器访问即可使用"
echo ""
echo "  停止服务:  $COMPOSE_CMD down"
echo "  查看日志:  $COMPOSE_CMD logs -f"
echo "  重新启动:  $COMPOSE_CMD up -d"
echo ""
