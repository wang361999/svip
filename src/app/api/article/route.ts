/**
 * 公众号文章生成 API
 *
 * POST /api/article  — 生成指定币种的行情分析文章 { symbol, okxId, label }
 *
 * 数据复用服务端客观计算（八分位/结构/分型，与交易面板同源），
 * AI 只写叙述文字，产出内联样式 HTML（公众号可直接粘贴）。
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { z } from 'zod';
import { settingsService } from '@/features/settings/api/settings.service';
import { parseAiConfig } from '@/shared/lib/ai-analysis';
import { generateArticle } from '@/shared/lib/article-writer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const generateSchema = z.object({
  symbol: z.string().min(1),
  okxId: z.string().min(1),
  label: z.string().min(1),
});

export const POST = createHandler(async ({ req }) => {
  requireUser();

  const input = generateSchema.parse(await req.json());

  // 读取 AI 配置
  const settings = await settingsService.getSettings();
  const config = parseAiConfig(settings as unknown as Record<string, string | null>);

  if (!config.enabled) {
    return apiError('AI_DISABLED', 'AI 分析功能未启用，请在后台设置中开启', 400);
  }
  if (!config.apiUrl || !config.apiKey || !config.model) {
    return apiError('AI_NOT_CONFIGURED', 'AI 模型配置不完整，请检查 API 地址、Key 和模型名称', 400);
  }

  // 生成文章（长文生成耗时 20-40s，不做并发去重 — 手动低频操作）
  try {
    const result = await generateArticle(config, input.symbol, input.okxId, input.label);
    return apiSuccess(result);
  } catch (err) {
    return apiError(
      'ARTICLE_FAILED',
      err instanceof Error ? err.message : '文章生成失败',
      500,
    );
  }
});
