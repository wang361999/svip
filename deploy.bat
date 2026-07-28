@echo off
chcp 65001 >nul
REM ============================================================
REM ETH Trading Tool 一键部署脚本 (Windows)
REM 使用方法: deploy.bat YOUR_VERCEL_TOKEN
REM ============================================================

if "%~1"=="" (
    echo.
    echo 错误：请传入 Vercel Token
    echo 用法: deploy.bat YOUR_VERCEL_TOKEN
    echo Token 获取: https://vercel.com/account/tokens -^> Create Token -^> Full Account
    echo.
    exit /b 1
)

set TOKEN=%~1
cd /d "%~dp0"

echo ============================================================
echo   ETH Trading Tool 一键部署
echo ============================================================
echo.

REM 检查环境
echo [1/5] 检查环境...
where node >nul 2>&1 || (echo 请先安装 Node.js & exit /b 1)
where vercel >nul 2>&1 || (echo 安装 Vercel CLI... & npm i -g vercel)
echo   环境就绪
echo.

REM 安装依赖
echo [2/5] 安装依赖...
call npm install --legacy-peer-deps
echo   依赖安装完成
echo.

REM 部署
echo [3/5] 部署到 Vercel...
call vercel link --yes --token %TOKEN% 2>nul
echo.

REM 逐条写入环境变量
echo [4/5] 写入环境变量（逐条）...

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require^&sslmode=require | vercel env add DATABASE_URL production preview development --token %TOKEN% 2>nul && echo   [ 1/17] DATABASE_URL = OK || echo   [ 1/17] DATABASE_URL = skip

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require | vercel env add DATABASE_URL_UNPOOLED production preview development --token %TOKEN% 2>nul && echo   [ 2/17] DATABASE_URL_UNPOOLED = OK || echo   [ 2/17] DATABASE_URL_UNPOOLED = skip

echo ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech | vercel env add PGHOST production preview development --token %TOKEN% 2>nul && echo   [ 3/17] PGHOST = OK || echo   [ 3/17] PGHOST = skip

echo ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech | vercel env add PGHOST_UNPOOLED production preview development --token %TOKEN% 2>nul && echo   [ 4/17] PGHOST_UNPOOLED = OK || echo   [ 4/17] PGHOST_UNPOOLED = skip

echo neondb_owner | vercel env add PGUSER production preview development --token %TOKEN% 2>nul && echo   [ 5/17] PGUSER = OK || echo   [ 5/17] PGUSER = skip

echo neondb | vercel env add PGDATABASE production preview development --token %TOKEN% 2>nul && echo   [ 6/17] PGDATABASE = OK || echo   [ 6/17] PGDATABASE = skip

echo npg_93uJZaQediCT | vercel env add PGPASSWORD production preview development --token %TOKEN% 2>nul && echo   [ 7/17] PGPASSWORD = OK || echo   [ 7/17] PGPASSWORD = skip

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require^&sslmode=require | vercel env add POSTGRES_URL production preview development --token %TOKEN% 2>nul && echo   [ 8/17] POSTGRES_URL = OK || echo   [ 8/17] POSTGRES_URL = skip

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require^&sslmode=require | vercel env add POSTGRES_URL_NON_POOLING production preview development --token %TOKEN% 2>nul && echo   [ 9/17] POSTGRES_URL_NON_POOLING = OK || echo   [ 9/17] POSTGRES_URL_NON_POOLING = skip

echo neondb_owner | vercel env add POSTGRES_USER production preview development --token %TOKEN% 2>nul && echo   [10/17] POSTGRES_USER = OK || echo   [10/17] POSTGRES_USER = skip

echo ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech | vercel env add POSTGRES_HOST production preview development --token %TOKEN% 2>nul && echo   [11/17] POSTGRES_HOST = OK || echo   [11/17] POSTGRES_HOST = skip

echo npg_93uJZaQediCT | vercel env add POSTGRES_PASSWORD production preview development --token %TOKEN% 2>nul && echo   [12/17] POSTGRES_PASSWORD = OK || echo   [12/17] POSTGRES_PASSWORD = skip

echo neondb | vercel env add POSTGRES_DATABASE production preview development --token %TOKEN% 2>nul && echo   [13/17] POSTGRES_DATABASE = OK || echo   [13/17] POSTGRES_DATABASE = skip

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb | vercel env add POSTGRES_URL_NO_SSL production preview development --token %TOKEN% 2>nul && echo   [14/17] POSTGRES_URL_NO_SSL = OK || echo   [14/17] POSTGRES_URL_NO_SSL = skip

echo postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require^&connect_timeout=15^&sslmode=require | vercel env add POSTGRES_PRISMA_URL production preview development --token %TOKEN% 2>nul && echo   [15/17] POSTGRES_PRISMA_URL = OK || echo   [15/17] POSTGRES_PRISMA_URL = skip

echo eth-trading-super-secret-key-2024-vercel-deploy | vercel env add JWT_SECRET production preview development --token %TOKEN% 2>nul && echo   [16/17] JWT_SECRET = OK || echo   [16/17] JWT_SECRET = skip

echo eth-trading-init-2024 | vercel env add INIT_KEY production preview development --token %TOKEN% 2>nul && echo   [17/17] INIT_KEY = OK || echo   [17/17] INIT_KEY = skip

echo.

REM 正式部署
echo [5/5] 正式部署到 Vercel...
call vercel --yes --token %TOKEN% --prod
echo.

echo ============================================================
echo   部署完成！
echo ============================================================
echo.
echo   下一步：打开上面的网址，访问 /init 页面
echo   输入密钥: eth-trading-init-2024
echo   点击初始化即可自动创建所有数据表
echo.
echo ============================================================
pause
