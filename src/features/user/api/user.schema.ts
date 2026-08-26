import { z } from 'zod';

export const updatePreferencesSchema = z.object({
  prefAllDrawings: z.boolean().optional(),
});
