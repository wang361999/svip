/**
 * 公众号行情分析文章生成模块
 *
 * 设计原则（与交易系统同源）：
 * 1. 数据与文案分离：点位用 AB9 线（分形选段 A→B 波段 9 等分线）、结构/分型复用服务端
 *    客观计算，AI 只写叙述文字（标题/导语/正文/观点），杜绝幻觉数字
 * 2. 产出内联样式 HTML：公众号编辑器不支持外部 CSS 与 markdown，
 *    直接粘贴富文本可完整保留排版（style 全部内联在标签上）
 * 3. 标题给 3 个候选：html 内埋 TITLE_SLOT 占位符，前端选标题后替换
 *
 * 注：本模块只用 AB9 线做文章价位框架；交易系统（AI 挂单信号）仍用江恩八分位，互不影响。
 */
import {
  fetchKlines,
  fetchPrice,
  type KlineData,
} from './market-data';
import {
  computeStructureTrend,
  computeFractalSignal,
  callChatCompletions,
  extractJson,
  type AiConfig,
  type FractalSignal,
  type StructureInfo,
} from './ai-analysis';
import { calcAB9Lines, type AB9Analysis } from './indicators';

// ==================== 类型 ====================

export interface ArticleData {
  symbol: string;
  label: string;
  /** 现价 */
  price: number;
  /** 24h 涨跌幅（%） */
  change24hPct: number;
  /** 24h 最高 / 最低 */
  high24h: number;
  low24h: number;
  /** AB9 线（文章价位框架） */
  ab9: AB9Analysis | null;
  structure: { m15: StructureInfo; h1: StructureInfo; h4: StructureInfo };
  fractal: FractalSignal | null;
  generatedAt: string;
}

export interface ArticleContent {
  /** 3 个候选标题 */
  titles: string[];
  /** 导语（一段） */
  lead: string;
  /** 核心观点一句话（重点高亮） */
  keyPoint: string;
  /** 正文 3-4 段 */
  body: string[];
  /** 操作参考（两三句） */
  operation: string;
  /** 风险提示（一句，文末自动拼接固定免责声明） */
  riskNote: string;
}

export interface ArticleResult {
  data: ArticleData;
  content: ArticleContent;
  /** 内联样式 HTML（含 TITLE_SLOT 占位符，前端选标题后替换） */
  html: string;
  /** 纯文本（备份复制用） */
  plainText: string;
  model: string;
}

// ==================== 数据准备 ====================

/** 拉取客观数据：价格 + 多周期 K 线 → AB9线/结构/分型（服务端客观计算） */
async function collectArticleData(
  symbol: string,
  okxId: string,
  label: string,
  currentPrice?: number,
): Promise<ArticleData> {
  const price =
    currentPrice && currentPrice > 0 ? currentPrice : await fetchPrice(symbol, okxId);
  if (!price || price <= 0) throw new Error('无法获取当前价格');

  const [k1h, k15m, k4h] = await Promise.all([
    fetchKlines(symbol, okxId, '1h', 200).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '15m', 120).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '4h', 60).catch(() => [] as KlineData[]),
  ]);
  if (k1h.length === 0) throw new Error('无法获取 K 线数据');

  const last24 = k1h.slice(-24);
  const priceNow = k1h[k1h.length - 1].close;
  const price24hAgo = last24[0].open;

  // AB9 线：分形选段（含当前价的最大波段）→ A→B 9 等分线（波段 <2% 或无有效分形时返回 null）
  const ab9 = calcAB9Lines(k1h);

  return {
    symbol,
    label,
    price,
    change24hPct: price24hAgo > 0 ? ((priceNow - price24hAgo) / price24hAgo) * 100 : 0,
    high24h: Math.max(...last24.map((k) => k.high)),
    low24h: Math.min(...last24.map((k) => k.low)),
    ab9,
    structure: {
      m15: computeStructureTrend(k15m, '15分钟'),
      h1: computeStructureTrend(k1h, '1小时'),
      h4: computeStructureTrend(k4h, '4小时'),
    },
    // 分型信号：文章场景不带八分位贴近标注（gann 传 null，仅展示分型状态）
    fractal: computeFractalSignal(k1h, null),
    generatedAt: new Date().toISOString(),
  };
}

// ==================== Prompt ====================

const ARTICLE_SYSTEM_PROMPT = `你是资深加密货币分析师，为微信公众号撰写行情分析文章。风格：专业、克制、重逻辑，面向有经验的投资者，绝不喊单、不煽动情绪。

写作铁律：
1. 只叙述、不报数：文章中禁止出现任何具体价格数字（价位表由系统自动插入，与你无关）。表达位置关系用「上方/下方」「上方一档/下方一档」「区间中轴附近」等相对表述
2. 立场必须有依据：观点必须锚定在数据提供的市场结构（HH/HL/LH/LL）、AB9波段位置（A→B 波段的 9 等分线，4线为波段中轴）、顶底分型状态上，不许凭空判断
3. 语气专业克制：用「偏强/偏弱/观望」「若有效站稳/若失守」等分析师措辞，禁止「暴涨」「梭哈」「必涨」等词
4. 承认不确定性：给出条件化推演（若A则B），不做单一断言
5. 全文不出现「投资建议」「必赚」等承诺性表述

结构要求（正文 body 共 3-4 段，全文约 1000-1300 字）：
- lead 导语：一段话（100-150字），概括当前行情状态与本文要回答的问题
- keyPoint 核心观点：一句话（30字内），本文最有信息量的判断
- body：第1段行情回顾与结构解读；第2段关键位置分析（用相对位置表述，围绕数据给的 AB9 线，如「4线中轴」「贴近5线」「上方一档」）；第3段多周期结构与情景推演（上行/下行两种条件）；第4段（可选）风险与变量
- operation 操作参考：两三句，只讲思路框架（关注哪类位置、什么条件倾向什么方向、风控原则），不给具体点位
- riskNote 风险提示：一句话点出当前最需要警惕的变量

你必须以严格的 JSON 格式返回，不要包含任何其他文字：
{
  "titles": ["候选标题1(20字内)", "候选标题2", "候选标题3"],
  "lead": "导语一段",
  "keyPoint": "核心观点一句话",
  "body": ["第1段", "第2段", "第3段", "第4段(可选)"],
  "operation": "操作参考两三句",
  "riskNote": "风险提示一句"
}`;

/** 构建文章用户 prompt：注入全部客观数据（AI 只依据这些写叙述） */
function buildArticleUserPrompt(d: ArticleData): string {
  const trendLabel = (s: StructureInfo) =>
    s.trend === 'up' ? '上升结构（HH+HL）' : s.trend === 'down' ? '下降结构（LH+LL）' : s.trend === 'range' ? '震荡结构（高低点矛盾）' : '结构不明';
  const fmt = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 2 : 4 });

  const ab9Text = d.ab9
    ? `AB9波段（分形选段 A→B，服务端客观计算）：
方向：${d.ab9.direction === 'up' ? '上升（A 为低点 → B 为高点）' : '下降（A 为高点 → B 为低点）'}
A点 ${fmt(d.ab9.pointA)} → B点 ${fmt(d.ab9.pointB)}，波段高度 ${((d.ab9.height / d.ab9.pointA) * 100).toFixed(2)}%
9条线（等分 AB 段，4线为波段中轴；系统会自动插入价位表，正文禁复述具体数字）：
${[...d.ab9.lines].sort((a, b) => b.price - a.price).map((l) => `- ${l.label} ${fmt(l.price)}`).join('\n')}
趋势强度评级：${d.ab9.strength}
当前位置：${d.ab9.betweenLines}${d.ab9.nearLine ? `，贴近${d.ab9.nearLine}线` : ''}`
    : '当前无有效 AB9 波段（波段高度不足或分形失效）— 文章应侧重观望与等待方向选择';

  const fractalText = d.fractal
    ? `最近顶分型：${d.fractal.lastTop ? `${fmt(d.fractal.lastTop.price)}（${d.fractal.lastTop.barsAgo}根前，${d.fractal.lastTop.strong ? '强分型' : '普通分型'}，${d.fractal.topBroken ? '已被突破失效' : '有效'}）` : '近端无'}
最近底分型：${d.fractal.lastBottom ? `${fmt(d.fractal.lastBottom.price)}（${d.fractal.lastBottom.barsAgo}根前，${d.fractal.lastBottom.strong ? '强分型' : '普通分型'}，${d.fractal.bottomBroken ? '已被跌破失效' : '有效'}）` : '近端无'}`
    : '近端无已确认分型';

  return `请为 ${d.label} 撰写今日行情分析公众号文章。

=== 客观数据（唯一依据，正文禁复述具体数字） ===
现价：${fmt(d.price)}
24小时：${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct.toFixed(2)}%，最高 ${fmt(d.high24h)} / 最低 ${fmt(d.low24h)}

${ab9Text}

多周期市场结构（道氏 HH/HL/LH/LL，服务端客观计算）：
- 15分钟：${trendLabel(d.structure.m15)}
- 1小时：${trendLabel(d.structure.h1)}
- 4小时：${trendLabel(d.structure.h4)}

顶底分型（1小时，服务端客观计算）：
${fractalText}

=== 要求 ===
标题 3 个候选：主标题风格（概括行情+核心判断），20 字内，专业媒体感，不用感叹号与「惊」「暴涨」等词
正文共约 1000-1300 字，严格按 JSON 结构返回。`;
}

// ==================== 内容解析与组装 ====================

/** 解析 AI 返回的文章 JSON（宽容清洗，任何字段缺失给兜底） */
function parseArticleContent(raw: string): ArticleContent {
  const p = extractJson(raw);
  const strArr = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).slice(0, max) : [];

  const titles = strArr(p.titles, 3).map((t) => t.trim().slice(0, 40));
  if (titles.length === 0) titles.push('行情分析：结构、位置与应对');

  const body = strArr(p.body, 5).map((s) => s.trim());
  if (body.length === 0) body.push('当前行情以区间运行为主，建议以关键位置的突破与失守作为方向确认依据。');

  return {
    titles,
    lead: String(p.lead || '').trim() || '本文基于市场结构与关键位置，梳理当前行情的运行状态与后续观察要点。',
    keyPoint: String(p.keyPoint || '').trim().slice(0, 60) || '结构未破坏前，按区间思路应对，破位再转向。',
    body,
    operation: String(p.operation || '').trim() || '关注关键位置的得失，站稳与否作为方向倾向依据；风控优先，仓位克制。',
    riskNote: String(p.riskNote || '').trim() || '注意区间边界假突破风险，重大数据与消息面可能改变节奏。',
  };
}

// ==================== 公众号 HTML 模板（全内联样式） ====================

/** 公众号排版基础样式常量（内联在标签上，编辑器粘贴后完整保留） */
const S = {
  section: 'margin:0 auto;padding:8px 4px;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  title: 'margin:24px 0 12px;font-size:20px;font-weight:600;color:#1a1a1a;line-height:1.5;text-align:center;letter-spacing:1px;',
  meta: 'margin:0 0 20px;font-size:13px;color:#999;text-align:center;',
  lead: 'margin:0 0 24px;padding:14px 16px;font-size:15px;color:#5a5a5a;line-height:1.9;background:#f7f7f7;border-left:3px solid #888;border-radius:0 8px 8px 0;letter-spacing:0.5px;',
  h2: 'margin:32px 0 14px;font-size:17px;font-weight:600;color:#1a1a1a;line-height:1.6;letter-spacing:0.5px;',
  h2Bar: 'display:inline-block;width:4px;height:16px;background:#2f6fed;margin-right:8px;vertical-align:-2px;border-radius:2px;',
  p: 'margin:0 0 20px;font-size:15px;color:#3f3f3f;line-height:1.9;letter-spacing:0.5px;text-align:justify;',
  keyPoint: 'margin:24px 0;padding:16px;font-size:15px;font-weight:600;color:#8a5a00;line-height:1.8;background:#fff8e6;border-radius:8px;letter-spacing:0.5px;',
  dataCard: 'margin:0 0 20px;padding:16px;background:#f7f9fc;border-radius:10px;border:1px solid #e8edf5;',
  dataRow: 'display:flex;justify-content:space-between;align-items:center;padding:7px 0;font-size:14px;line-height:1.6;',
  dataLabel: 'color:#8a94a6;',
  dataValue: 'color:#1a1a1a;font-weight:600;',
  badgeUp: 'display:inline-block;margin:0 6px 6px 0;padding:4px 12px;font-size:13px;color:#1a7f37;background:#e8f5e9;border-radius:12px;',
  badgeDown: 'display:inline-block;margin:0 6px 6px 0;padding:4px 12px;font-size:13px;color:#c62828;background:#fdecea;border-radius:12px;',
  badgeRange: 'display:inline-block;margin:0 6px 6px 0;padding:4px 12px;font-size:13px;color:#9a6700;background:#fff3cd;border-radius:12px;',
  badgeUnknown: 'display:inline-block;margin:0 6px 6px 0;padding:4px 12px;font-size:13px;color:#666;background:#f0f0f0;border-radius:12px;',
  levelRow: 'display:flex;align-items:center;padding:8px 10px;margin-bottom:6px;font-size:14px;background:#fff;border-radius:8px;border:1px solid #eceff4;',
  levelDiv: 'width:44px;font-weight:700;color:#2f6fed;flex-shrink:0;',
  levelAxis: 'width:44px;font-weight:700;color:#b8860b;flex-shrink:0;',
  levelPrice: 'flex:1;color:#1a1a1a;font-weight:600;text-align:center;',
  levelDist: 'width:64px;font-size:12px;color:#999;text-align:right;flex-shrink:0;',
  operation: 'margin:0 0 20px;padding:16px;font-size:15px;color:#1f3a5f;line-height:1.9;background:#eef4ff;border-radius:10px;letter-spacing:0.5px;',
  risk: 'margin:28px 0 8px;padding:12px 14px;font-size:13px;color:#999;line-height:1.8;background:#fafafa;border-radius:8px;',
  divider: 'margin:28px auto;width:36px;height:3px;background:#e0e0e0;border-radius:2px;',
  footer: 'margin:16px 0 4px;font-size:12px;color:#bbb;text-align:center;line-height:1.8;',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtNum = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 2 : 4 });

/** 组装公众号 HTML（标题处埋 TITLE_SLOT 占位符，前端选标题后替换） */
export function assembleArticleHtml(d: ArticleData, c: ArticleContent): string {
  const dateStr = new Date(d.generatedAt).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const changeStr = `${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct.toFixed(2)}%`;
  const changeColor = d.change24hPct >= 0 ? '#1a7f37' : '#c62828';

  // 多周期结构徽章
  const badge = (label: string, s: StructureInfo) => {
    const cls =
      s.trend === 'up' ? S.badgeUp : s.trend === 'down' ? S.badgeDown : s.trend === 'range' ? S.badgeRange : S.badgeUnknown;
    const txt = s.trend === 'up' ? '上升 HH+HL' : s.trend === 'down' ? '下降 LH+LL' : s.trend === 'range' ? '震荡' : '不明';
    return `<span style="${cls}">${label} · ${txt}</span>`;
  };

  // AB9 线行（按价格倒序：上方阻力在前，4线为波段中轴）
  const levelRows = d.ab9
    ? [...d.ab9.lines]
        .sort((a, b) => b.price - a.price)
        .map((l) => {
          const isAxis = l.lineNo === 4;
          const distPct = ((l.price - d.price) / d.price) * 100;
          const dist = `${distPct > 0 ? '+' : ''}${distPct.toFixed(2)}%`;
          const distColor = distPct > 0.05 ? '#c62828' : distPct < -0.05 ? '#1a7f37' : '#2f6fed';
          return `<div style="${S.levelRow}">
<span style="${isAxis ? S.levelAxis : S.levelDiv}">${l.label}</span>
<span style="${S.levelPrice}">${fmtNum(l.price)}${isAxis ? '（中轴）' : ''}</span>
<span style="${S.levelDist};color:${distColor};font-weight:600;">${dist}</span>
</div>`;
        })
        .join('')
    : '';

  // 分型状态
  const fractalLine = d.fractal
    ? [
        d.fractal.lastTop
          ? `顶分型 ${fmtNum(d.fractal.lastTop.price)}（${d.fractal.lastTop.strong ? '强' : '普通'}，${d.fractal.topBroken ? '已失效' : '有效'}）`
          : null,
        d.fractal.lastBottom
          ? `底分型 ${fmtNum(d.fractal.lastBottom.price)}（${d.fractal.lastBottom.strong ? '强' : '普通'}，${d.fractal.bottomBroken ? '已失效' : '有效'}）`
          : null,
      ]
        .filter(Boolean)
        .join('<br/>')
    : '近端无已确认分型';

  const bodyParas = c.body.map((t) => `<p style="${S.p}">${esc(t)}</p>`).join('');

  return `<section style="${S.section}">
<h1 style="${S.title}"><!--TITLE_SLOT--></h1>
<p style="${S.meta}">${esc(d.label)} · ${dateStr}</p>

<p style="${S.lead}">${esc(c.lead)}</p>

<p style="${S.keyPoint}">▎核心观点：${esc(c.keyPoint)}</p>

<div style="${S.dataCard}">
<div style="${S.dataRow}"><span style="${S.dataLabel}">现价</span><span style="${S.dataValue}">${fmtNum(d.price)}</span></div>
<div style="${S.dataRow}"><span style="${S.dataLabel}">24小时</span><span style="${S.dataValue};color:${changeColor};">${changeStr}</span></div>
<div style="${S.dataRow}"><span style="${S.dataLabel}">24小时最高 / 最低</span><span style="${S.dataValue}">${fmtNum(d.high24h)} / ${fmtNum(d.low24h)}</span></div>
${d.ab9 ? `<div style="${S.dataRow}"><span style="${S.dataLabel}">AB波段（${d.ab9.direction === 'up' ? '上升' : '下降'}）</span><span style="${S.dataValue}">${fmtNum(d.ab9.pointA)} → ${fmtNum(d.ab9.pointB)}</span></div>
<div style="${S.dataRow}"><span style="${S.dataLabel}">趋势强度</span><span style="${S.dataValue}">${esc(d.ab9.strength)}</span></div>
<div style="${S.dataRow}"><span style="${S.dataLabel}">当前位置</span><span style="${S.dataValue}">${esc(d.ab9.betweenLines)}${d.ab9.nearLine ? ` · 贴近${d.ab9.nearLine}线` : ''}</span></div>` : ''}
</div>

<h2 style="${S.h2}"><span style="${S.h2Bar}"></span>多周期结构</h2>
<p style="${S.p}">
${badge('15分钟', d.structure.m15)}
${badge('1小时', d.structure.h1)}
${badge('4小时', d.structure.h4)}
</p>

${d.ab9 ? `<h2 style="${S.h2}"><span style="${S.h2Bar}"></span>关键点位（AB9线）</h2>
<p style="${S.p}">${levelRows}</p>` : ''}

<h2 style="${S.h2}"><span style="${S.h2Bar}"></span>分型信号</h2>
<p style="${S.p};font-size:14px;color:#5a5a5a;">${fractalLine}</p>

<h2 style="${S.h2}"><span style="${S.h2Bar}"></span>走势解读</h2>
${bodyParas}

<div style="${S.operation}"><strong style="color:#1f3a5f;">▎操作参考</strong><br/><br/>${esc(c.operation)}</div>

<div style="${S.divider}"></div>

<p style="${S.risk}">风险提示：${esc(c.riskNote)}</p>
<p style="${S.footer}">本文基于公开市场数据与量化规则生成，仅代表技术面视角，不构成任何投资建议。数字资产波动剧烈，入市需谨慎，据此操作风险自负。</p>
</section>`;
}

/** 组装纯文本版（备份复制用） */
export function assembleArticlePlainText(d: ArticleData, c: ArticleContent, title: string): string {
  const parts = [
    title,
    `${d.label} · ${new Date(d.generatedAt).toLocaleDateString('zh-CN')}`,
    '',
    `【导语】${c.lead}`,
    `【核心观点】${c.keyPoint}`,
    `现价 ${fmtNum(d.price)}（24h ${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct.toFixed(2)}%，${fmtNum(d.low24h)}~${fmtNum(d.high24h)}）`,
    '',
    ...c.body.map((t, i) => `${t}\n`),
    `【操作参考】${c.operation}`,
    `风险提示：${c.riskNote}`,
    '本文不构成任何投资建议，据此操作风险自负。',
  ];
  if (d.ab9) {
    const lines = [...d.ab9.lines].sort((a, b) => b.price - a.price).map((l) => `${l.label} ${fmtNum(l.price)}`).join('  ');
    parts.splice(5, 0, `AB波段（${d.ab9.direction === 'up' ? '上升' : '下降'}）：${fmtNum(d.ab9.pointA)} → ${fmtNum(d.ab9.pointB)} · ${d.ab9.strength} · ${d.ab9.betweenLines}`);
    parts.splice(6, 0, `关键点位（AB9线）：${lines}`);
  }
  return parts.join('\n');
}

// ==================== 主入口 ====================

/** 生成公众号文章：客观数据（与交易面板同源）+ AI 叙述 + 内联样式 HTML */
export async function generateArticle(
  config: AiConfig,
  symbol: string,
  okxId: string,
  label: string,
  currentPrice?: number,
): Promise<ArticleResult> {
  if (!config.enabled) throw new Error('AI 分析功能未启用');
  if (!config.apiUrl || !config.apiKey || !config.model) throw new Error('AI 模型配置不完整');

  // 1. 客观数据（AB9线/多周期结构/分型，全部服务端客观计算）
  const data = await collectArticleData(symbol, okxId, label, currentPrice);

  // 2. AI 写叙述（标题/导语/正文/观点，不含数字）
  const raw = await callChatCompletions(config, ARTICLE_SYSTEM_PROMPT, buildArticleUserPrompt(data));
  const content = parseArticleContent(raw);

  // 3. 组装公众号 HTML + 纯文本
  const html = assembleArticleHtml(data, content);
  const plainText = assembleArticlePlainText(data, content, content.titles[0]);

  return { data, content, html, plainText, model: config.model };
}
