import { z } from 'zod';

export const updatePreferencesSchema = z.object({
  prefAB9: z.boolean().optional(),
  prefAB9Labels: z.boolean().optional(),
});
