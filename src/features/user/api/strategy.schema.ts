/**
 * 策略配置 Schema
 * 结构：{ strategyId: { enabled: boolean, params: Record<string, number|string> } }
 * 由于策略 ID 和参数 key 都是动态的，这里用宽松校验，由 normalizeStrategyConfig 做严格清洗
 */
import { z } from 'zod';

export const updateStrategyConfigSchema = z.record(
  z.string(),
  z.any(),
);
