/**
 * 构建后处理：把外链 CSS 内联进所有预渲染 HTML
 *
 * 背景：国内访问 Vercel 不稳定（或国产浏览器省流模式剥外链样式），
 * HTML 能到但 /_next/static/css/xx.css 二次请求随机失败 → 用户看到裸 HTML。
 * 全站只有一个 Tailwind CSS 文件（~40KB），直接内联 <style> 后：
 * - 样式随 HTML 一次到达，零额外请求
 * - 省流/转码代理通常保留内联样式
 * - 正常网络下也省一次往返（LCP 略升但 FOUC 归零）
 *
 * 运行时机：next build 之后（package.json 的 build 命令串联）。
 * 客户端路由切换时 Next 会再动态插 <link>（CDN 上文件仍在），失败也无妨 —
 * 初始 HTML 的内联样式已覆盖全站（同一个 CSS 文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cssDir = path.join(root, '.next/static/css');

if (!fs.existsSync(cssDir)) {
  console.error('[inline-css] 找不到 .next/static/css —— 请在 next build 之后运行');
  process.exit(1);
}

const css = fs
  .readdirSync(cssDir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8'))
  .join('\n')
  // <style> 内不能出现 </style（CSS 字符串里实际不会有，防御性转义）
  .replace(/<\/style/gi, '<\\/style');

const appDir = path.join(root, '.next/server/app');
const htmlFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
};
walk(appDir);

// Next 输出形如：<link rel="stylesheet" href="/_next/static/css/x.css" data-precedence="next"/>
const linkRe = /<link[^>]*href="\/_next\/static\/css\/[^"]*\.css"[^>]*>/g;

let total = 0;
for (const f of htmlFiles) {
  let html = fs.readFileSync(f, 'utf8');
  if (!linkRe.test(html)) continue;
  linkRe.lastIndex = 0;
  const n = html.match(linkRe).length;
  // 全部外链替换为单个内联 <style>（多页面共用同一文件，去重后只留一份）
  html = html.replace(linkRe, `<style data-inline-css>${css}</style>`);
  fs.writeFileSync(f, html);
  total++;
  console.log(`[inline-css] ${path.relative(root, f)} 内联 ${n} 个样式表`);
}
console.log(`[inline-css] 完成：${total}/${htmlFiles.length} 个 HTML · 内联 ${css.length} 字节`);
