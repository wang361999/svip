/**
 * 结构分析 · 文案层
 *
 * 分工铁律：数字全部来自规则引擎（structure-analysis.ts），
 * LLM 只负责把数字组织成交易员口吻的文字。
 *
 * 三道防线：
 * 1. LLM 输出 JSON 解析失败 → 用模板
 * 2. LLM 输出里的价格数字与规则引擎不一致（容差 0.5%）→ 用模板（防幻觉数字）
 * 3. LLM 未配置 / 超时 → 用模板
 *
 * 输出结构 AnalysisNarrative 前后端共用，无论哪条防线触发，字段完全一致。
 */

import { StructureAnalysis, TradePlan } from './structure-analysis';
import { llmChat } from './llm-client';

export interface AnalysisNarrative {
  /** 一句话结论（≤20字） */
  headline: string;
  /** 偏向：偏多/偏空/中性（必须与规则引擎 bias 一致，不一致时以规则引擎为准） */
  biasText: string;
  /** 解读段落（2-4 段） */
  paragraphs: string[];
  /** 方案 A 点评 */
  planAComment: string;
  /** 方案 B 点评 */
  planBComment: string;
  /** 失效条件（数字必须与规则引擎一致） */
  invalidation: string;
  /** 风险提醒 */
  reminder: string;
  /** 文案来源 */
  source: 'ai' | 'template';
}

// ==================== 价格数字校验 ====================

/** 从文案里提取所有数字（含小数），用于校验 LLM 是否篡改了价格 */
function extractNumbers(text: string): number[] {
  const nums: number[] = [];
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    nums.push(parseFloat(m[0]));
  }
  return nums;
}

/**
 * 校验 AI 文案里的价格数字是否都是规则引擎产出的
 * 规则：文案中出现的每个"价格量级"的数字，必须能在结构数据的合法数字集合中找到（容差 0.5%）
 * 量级判断：数字 >= 当前价 30% 的才视为"价格"（排除百分比、盈亏比、次数等小数字）
 */
function numbersMatchAnalysis(text: string, analysis: StructureAnalysis): boolean {
  const legal: number[] = [];
  const add = (p: number) => {
    if (Number.isFinite(p) && p > 0 && legal.indexOf(p) < 0) legal.push(Math.round(p * 100) / 100);
  };

  add(analysis.currentPrice);
  for (const tf of ['4h', '1h', '15m'] as const) {
    add(analysis.periods[tf].ema20);
    add(analysis.periods[tf].ema60);
  }
  if (analysis.leg) {
    add(analysis.leg.startPrice);
    add(analysis.leg.endPrice);
    for (const f of analysis.leg.fibRetracements) add(f.price);
    for (const e of analysis.leg.fibExtensions) add(e.price);
  }
  for (const p of analysis.plans) {
    add(p.entry);
    add(p.stop);
    add(p.tp1);
    add(p.tp2);
  }
  if (analysis.invalidation) add(analysis.invalidation.price);
  for (const k of analysis.keyLevels) add(k.price);
  for (const v of analysis.volumeNodes) add(v.price);
  for (const t of analysis.profitTargets || []) add(t.price);
  if (analysis.confluence) {
    add(analysis.confluence.low);
    add(analysis.confluence.high);
    add(analysis.confluence.mid);
  }
  if (analysis.extendedTarget) add(analysis.extendedTarget.price);

  const priceThreshold = analysis.currentPrice * 0.3;
  for (const n of extractNumbers(text)) {
    if (n < priceThreshold) continue; // 小数字（百分比/盈亏比）不校验
    let ok = false;
    for (const l of legal) {
      if (Math.abs(n - l) / l < 0.005) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

// ==================== Prompt ====================

/** 把规则引擎数据压缩成 LLM 输入（去掉冗余序列，只留决策相关数字） */
function buildLlmInput(a: StructureAnalysis): Record<string, unknown> {
  const zh = {
    bull: '多头', bear: '空头', ranging: '震荡',
    long: '多头排列', short: '空头排列', mixed: '缠绕/粘合',
  };
  const planBrief = (p: TradePlan) => ({
    名称: p.name,
    方向: p.side === 'long' ? '做多' : '做空',
    触发: p.trigger,
    入场: p.entry,
    止损: p.stop,
    目标1: p.tp1,
    目标2: p.tp2,
    目标2依据: p.tp2Source || null,
    盈亏比TP1: p.rrTp1,
    盈亏比TP2: p.rrTp2,
    加权盈亏比: p.rrBlended,
    触及概率TP1: p.tp1ProbabilityPct != null ? `${p.tp1ProbabilityPct}%（条件概率：触发条件确认入场后，自入场价30根4h内触及；按入场情境校准的历史回测值，非理论推导）` : null,
    触及概率TP2: p.tp2ProbabilityPct != null ? `${p.tp2ProbabilityPct}%（条件概率：触发条件确认入场后，自入场价30根4h内触及；按入场情境校准的历史回测值，非理论推导）` : null,
    先到止盈概率: p.tp1FirstPct != null ? `${p.tp1FirstPct}%（实测竞速口径：入场确认后30根4h内，TP1先于止损被触及；同根双触按先止损保守计，最贴近挂单实绩）` : null,
    先到止损概率: p.slFirstPct != null ? `${p.slFirstPct}%（实测竞速口径，含义同上；A方案专属，B方案因止损率随行情机制漂移无法稳定校准故不提供）` : null,
  });

  const trendBrief = (tf: '4h' | '1h' | '15m') => {
    const p = a.periods[tf];
    const out: Record<string, unknown> = {
      方向: zh[p.dir],
      均线: zh[p.maState],
      MACD: zh[p.macdState],
      结构: zh[p.structure],
    };
    if (tf !== '15m') {
      out['EMA20'] = round2(p.ema20);
      out['EMA60'] = round2(p.ema60);
    }
    return out;
  };

  return {
    交易对: a.symbol,
    当前价: a.currentPrice,
    分析时间: new Date(a.generatedAt).toISOString(),
    三周期趋势: { '4h': trendBrief('4h'), '1h': trendBrief('1h'), '15m': trendBrief('15m') },
    共振计数: a.resonanceText,
    规则引擎定性: a.biasText,
    当前推动腿: a.leg
      ? {
          术语定义: '推动腿（Impulse Leg）＝最近一段单方向显著推动行情，由 ZigZag(4%) 识别的摆动端点界定；是全部回撤/扩展测算的锚定结构',
          方向: a.leg.direction === 'up' ? '上行推动（摆动低点→摆动高点）' : '下行推动（摆动高点→摆动低点）',
          起点价: round2(a.leg.startPrice),
          端点价: round2(a.leg.endPrice),
          推动幅度百分比: a.leg.rangePct,
          当前回撤比例: Math.round(a.leg.retracement * 1000) / 10,
          斐波那契回撤位: a.leg.fibRetracements.map((f) => ({ [Math.round(f.ratio * 100) + '%']: round2(f.price) })),
          斐波那契扩展位: a.leg.fibExtensions.map((e) => ({ [String(e.ratio)]: round2(e.price) })),
        }
      : null,
    预案: a.plans.map(planBrief),
    利润测算: {
      目标位: (a.profitTargets || []).map((t) => ({
        方法: t.label,
        价格: t.price,
        触及概率: `${t.probabilityPct}%（自现价，30根4h内，历史回测校准值）`,
      })),
      汇流止盈区: a.confluence
        ? {
            区间: `${a.confluence.low}–${a.confluence.high}`,
            中值: a.confluence.mid,
            叠加方法: a.confluence.methods,
            触及概率: `${a.confluence.probabilityPct}%（自现价触及近侧边缘）`,
          }
        : null,
      延伸目标: a.extendedTarget ? { 方法: a.extendedTarget.label, 价格: a.extendedTarget.price } : null,
      时间窗: a.eta ? a.eta.text : null,
      波动率基准: a.atr ? `4h ATR(14) = ${a.atr}` : null,
    },
    失效条件: a.invalidation ? a.invalidation.note : null,
    关键位: a.keyLevels.map((k) => ({ 价格: k.price, 说明: k.label, 距当前价百分比: k.distancePct })),
    成交密集区: a.volumeNodes.map((v) => v.price),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const SYSTEM_PROMPT = `你是"结构共振交易法"的资深交易分析师，为一个 ETH 交易网站撰写结构分析。

铁律（违反即废稿）：
1. 所有价格、百分比、盈亏比数字必须与输入 JSON 完全一致，禁止自行计算、换算、四舍五入或编造任何数字
2. 偏向结论（偏多/偏空/中性）必须与"规则引擎定性"一致
3. 只用简体中文，专业克制的交易员复盘口吻，不喊单、不绝对化
4. 严格输出 JSON，不要 markdown 代码块，不要多余文字
5. 若存在"汇流止盈区"，解读中须点出它由哪些方法叠加、为什么可信度更高；仅当预案的"目标2依据"含"汇流"时才把 TP2 与汇流区价格绑定，否则汇流区应描述为现价附近的第一目标带（减仓参考），不要与 TP2 混淆
6. 术语规范：使用"推动腿"（Impulse Leg）指代最近一段单方向显著推动行情，首次出现须自然带出定义（如"最近一段自摆动低点 X 推升至摆动高点 Y 的上行推动（推动腿）"），不使用"腿"单字；回撤比例指现价沿该推动自端点向起点折返的深度
7. 概率口径：方案A若提供"先到止盈/先到止损概率"，点评时优先引用这两个数（竞速口径最贴近挂单实绩），并明确这是条件概率、以止损纪律执行为前提；不要把"触及概率"说成胜率——触及口径包含先扫损后又到目标的路径，数值必然高于先到口径；B方案无先到概率，不要编造

输出 JSON 结构：
{
  "headline": "一句话结论，20字内，包含方向判断",
  "paragraphs": ["结构解读段落，2-4段，每段60-120字：为什么是这个方向、当前处于什么位置、为什么现在不能直接追"],
  "planAComment": "对方案A的一句话点评，说明它为什么是首选",
  "planBComment": "对方案B的一句话点评，说明它适合什么情况",
  "invalidation": "失效条件一句话，必须包含失效价格数字",
  "reminder": "风险提醒一句话，结合当前波动特点"
}`;

// ==================== 主入口 ====================

export async function generateNarrative(analysis: StructureAnalysis): Promise<AnalysisNarrative> {
  const template = buildTemplateNarrative(analysis);

  const userPrompt = `以下是规则引擎算出的结构数据（JSON），所有数字已锁定，你的任务只是组织语言：\n\n${JSON.stringify(buildLlmInput(analysis), null, 1)}`;

  const result = await llmChat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { jsonMode: true, temperature: 0.6, timeoutMs: 28_000 },
  );

  if (!result) return template;

  // 解析 + 校验
  try {
    const raw = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(raw);
    const narrative: AnalysisNarrative = {
      headline: String(parsed.headline || '').slice(0, 40),
      biasText: analysis.biasText, // 永远以规则引擎为准
      paragraphs: Array.isArray(parsed.paragraphs)
        ? parsed.paragraphs.map((p: unknown) => String(p)).filter((p: string) => p.length > 10).slice(0, 4)
        : [],
      planAComment: String(parsed.planAComment || ''),
      planBComment: String(parsed.planBComment || ''),
      invalidation: String(parsed.invalidation || template.invalidation),
      reminder: String(parsed.reminder || template.reminder),
      source: 'ai',
    };

    if (!narrative.headline || narrative.paragraphs.length === 0) return template;

    // 数字校验：LLM 文案里出现的价格必须全部来自规则引擎
    const fullText = [narrative.headline, ...narrative.paragraphs, narrative.planAComment, narrative.planBComment, narrative.invalidation, narrative.reminder].join(' ');
    if (!numbersMatchAnalysis(fullText, analysis)) {
      console.error('[AnalysisWriter] AI 文案数字与规则引擎不一致，降级模板');
      return template;
    }

    return narrative;
  } catch (err) {
    console.error('[AnalysisWriter] AI 输出解析失败，降级模板:', err);
    return template;
  }
}

// ==================== 模板兜底 ====================

function dirText(dir: string): string {
  return dir === 'bull' ? '多头' : dir === 'bear' ? '空头' : '震荡';
}

/** 纯模板文案：数字照填，话术固定。LLM 不可用时的保底 */
export function buildTemplateNarrative(a: StructureAnalysis): AnalysisNarrative {
  const p = a.periods;
  const trendLine = `4h ${dirText(p['4h'].dir)}（得分 ${p['4h'].score > 0 ? '+' : ''}${p['4h'].score}/3）、1h ${dirText(p['1h'].dir)}（${p['1h'].score > 0 ? '+' : ''}${p['1h'].score}/3）、15m ${dirText(p['15m'].dir)}（${p['15m'].score > 0 ? '+' : ''}${p['15m'].score}/3），共振计数 ${a.resonanceText}。`;

  const paragraphs: string[] = [];

  if (a.leg) {
    const isUpLeg = a.leg.direction === 'up';
    const legDir = isUpLeg ? '上行' : '下行';
    const startPt = isUpLeg ? '摆动低点' : '摆动高点';
    const endPt = isUpLeg ? '摆动高点' : '摆动低点';
    const retPct = Math.round(a.leg.retracement * 100);
    paragraphs.push(
      `结构锚定最近一段${legDir}推动腿（Impulse Leg，即自${startPt} ${round2(a.leg.startPrice)} 推动至${endPt} ${round2(a.leg.endPrice)} 的单边行情，幅度 ${a.leg.rangePct}%）：现价 ${a.currentPrice} 已自端点回撤 ${retPct}%，处于该推动的回撤消化阶段。${trendLine}`,
    );
    paragraphs.push(
      a.plans.length > 0 && a.plans[0]
        ? `按结构共振法的纪律，现价不在入场区：三周期未形成同向共振，直接追的止损无处安放。方案A 等回踩 ${a.plans[0].entry} 需求区（推动腿 61.8% 回撤结构位），方案B 等突破 ${round2(a.leg.endPrice)} 后回踩确认，两者都挂条件单等触发，都不触发就空仓等待。`
        : trendLine,
    );
    if (a.confluence) {
      const extText = a.extendedTarget ? `；更远的 ${a.extendedTarget.label} ${a.extendedTarget.price} 作延伸档` : '';
      // 汇流区是否真的绑定了某档 TP2（措辞与预案保持一致，防止"主止盈"与 TP2 矛盾）
      const boundToTp2 = a.plans.some((pl) => (pl.tp2Source || '').includes('汇流'));
      const isUp = a.leg.direction === 'up';
      paragraphs.push(
        boundToTp2
          ? `多方法利润测算显示：${a.confluence.methods.join('、')} 在 ${a.confluence.low}–${a.confluence.high} 重叠形成汇流止盈区，自现价触及概率约 ${a.confluence.probabilityPct}%，主止盈锚定区间中值 ${a.confluence.mid}${extText}。${a.eta ? a.eta.text + '。' : ''}`
          : `多方法利润测算显示：${a.confluence.methods.join('、')} 在 ${a.confluence.low}–${a.confluence.high} 重叠（自现价触及概率约 ${a.confluence.probabilityPct}%），是现价${isUp ? '上方第一目标带，价格到达后预计反复，适合首批减仓' : '下方第一目标带，价格到达后预计反复，适合首批减仓'}；主止盈仍看结构位${extText}。${a.eta ? a.eta.text + '。' : ''}`,
      );
    }
  } else {
    paragraphs.push(`最近 30 根 4h 内没有振幅超过 3% 的显著推动腿，结构压缩，方向未选。${trendLine} 此时任何方向的盈亏比都不够，等待突破或回撤出结构后再评估。`);
  }

  const planA = a.plans.find((x) => x.id === 'A');
  const planB = a.plans.find((x) => x.id === 'B');

  return {
    headline: a.plans.length === 0 ? '结构压缩，观望等方向' : `${a.biasText}，等回踩或突破再进`,
    biasText: a.biasText,
    paragraphs,
    planAComment: planA
      ? `首选回调单：入场 ${planA.entry}，止损 ${planA.stop}（风险 ${planA.riskPct}%），TP2 盈亏比 ${planA.rrTp2}${
          planA.tp1FirstPct != null && planA.slFirstPct != null
            ? `。历史回测同类入场先到 TP1 概率约 ${planA.tp1FirstPct}%、先到止损约 ${planA.slFirstPct}%（条件概率，触发确认入场后 30 根 4h 内；以止损纪律执行为前提）`
            : ''
        }。`
      : '结构不明，暂无回调预案。',
    planBComment: planB
      ? `备选突破单：触发位 ${round2(planB.entry)}，止损 ${planB.stop}，TP2 盈亏比 ${planB.rrTp2}，需放量确认。`
      : '结构不明，暂无突破预案。',
    invalidation: a.invalidation ? a.invalidation.note : '暂无明确失效位（结构压缩期）。',
    reminder: '数据仅供参考，不构成投资建议。条件单进场，止损必带，破位不扛。',
    source: 'template',
  };
}
