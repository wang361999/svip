@echo off
chcp 65001 >nul
echo.
echo ============================================
echo   ETH Trading Tool 一键部署
echo ============================================
echo.

:: 检查 Docker
where docker >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 未检测到 Docker，请先安装 Docker Desktop：
  echo   https://www.docker.com/products/docker-desktop
  echo.
  echo 安装后启动 Docker Desktop，再双击运行本脚本。
  pause
  exit /b 1
)

echo [1/3] 构建应用镜像（首次约 2-3 分钟）...
docker compose build
if %errorlevel% neq 0 (
  echo 构建失败，请检查 Docker 是否正常运行
  pause
  exit /b 1
)

echo.
echo [2/3] 启动服务...
docker compose up -d
if %errorlevel% neq 0 (
  echo 启动失败
  pause
  exit /b 1
)

echo.
echo [3/3] 等待应用就绪...
timeout /t 10 /nobreak >nul

echo.
echo ============================================
echo   部署完成！
echo ============================================
echo.
echo   访问地址:  http://localhost:3000
echo   管理员:    admin@ethtrading.com
echo   密码:      admin
echo.
echo   数据库已自动创建，管理员账号已自动配置
echo   直接打开浏览器访问即可使用
echo.
echo   停止服务:  docker compose down
echo   查看日志:  docker compose logs -f
echo.
pause
