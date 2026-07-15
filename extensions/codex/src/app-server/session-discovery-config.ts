import { z } from "zod";

export const codexSessionCatalogConfigSchema = z
  .object({ enabled: z.boolean().optional() })
  .strict();
