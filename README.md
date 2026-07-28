# ETH Trading Tool

基于 Next.js + TypeScript + Tailwind CSS + Prisma + Neon PostgreSQL 的以太坊实时交易工具。

## 快速部署步骤（3步搞定）

### 1. 在 Vercel 创建项目
- 将本项目推送到 GitHub 仓库
- 在 [Vercel Dashboard](https://vercel.com/dashboard) 导入该仓库

### 2. 连接 Neon 数据库
- 在 Vercel 项目的 **Integrations** 里安装 [Neon](https://vercel.com/marketplace/neon)
- 创建数据库后，Vercel 会自动注入 `DATABASE_URL` 环境变量
- 手动添加以下环境变量：
  - `JWT_SECRET`：任意随机字符串（如 `your-secret-key-123456`）

### 3. 初始化数据库（无需命令行！）
部署成功后，直接在浏览器访问：
```
https://你的域名/init
```
点击 **"开始初始化数据库"** 按钮，自动完成：
- 创建数据表
- 创建默认管理员账户（admin@ethtrading.com / admin）
- 创建默认网站设置

初始化完成后即可正常使用！

## 管理员后台

- 地址：`https://你的域名/admin`
- 账号：`admin@ethtrading.com`
- 密码：`admin`

后台可以修改网站标题、副标题、Logo、页脚版权等，修改后实时生效。

## 功能清单

- 实时 ETH/USDT 价格推送（Binance WebSocket）
- 专业 K 线图（Lightweight-Charts，支持多周期 + MA 指标）
- 用户注册/登录（JWT + bcrypt）
- 后台管理（网站标题、Logo、页脚、用户列表）
- 响应式暗色主题 UI
