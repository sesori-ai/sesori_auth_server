import { z } from "zod";

export const projectKeySchema = z.string().regex(/^prj_v1_[A-Za-z0-9_-]{43}$/);

export type ProjectKey = z.infer<typeof projectKeySchema>;
