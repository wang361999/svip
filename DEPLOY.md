# ETH Trading Tool - Vercel 部署指南

## 环境变量（已配置在 .env 中，部署时需粘贴到 Vercel Dashboard）

进入 Vercel Dashboard → 你的项目 → Settings → Environment Variables，添加以下变量：

```
DATABASE_URL=postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require
JWT_SECRET=eth-trading-super-secret-key-2024-vercel-deploy
INIT_KEY=eth-trading-init-2024
```

## 部署步骤

### 方式一：Vercel CLI（推荐）

```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 登录
vercel login

# 3. 部署
vercel --prod
```

### 方式二：GitHub 导入

1. 将本项目推送到 GitHub 仓库
2. 在 Vercel Dashboard 点击 "Add New Project"
3. 导入 GitHub 仓库
4. 在 Environment Variables 中添加上述变量
5. 点击 Deploy

### 方式三：Vercel Deploy Button

使用 `vercel.json` 中已配置好的构建设置，直接部署即可。

## 数据库初始化

部署完成后，访问 `https://你的域名/init` 页面：
- 输入初始化密钥：`eth-trading-init-2024`
- 点击初始化，自动创建数据库表

## 项目更新内容

### 新增 4 套交易策略（共 12 套）
1. **超级趋势追踪** - ATR动态跟踪，趋势不死不回撤
2. **Z-Score量化回归** - 统计套利，极端偏差必回归
3. **一目均衡云图** - 日本经典，云内观望云上做多
4. **海龟交易法则** - 经典20日突破系统，趋势捕手

### 技术改进
- Prisma Schema 验证通过
- TypeScript 编译零错误
- 所有策略配备实时信号计算引擎
