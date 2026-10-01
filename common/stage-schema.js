'use strict';
const { z } = require('zod');
const family = z.enum(['anthropic', 'google', 'openai', 'xai']);
const author = { family, model: z.string().min(1) };
const paths = z.union([z.string(), z.array(z.string())]);
const replaces = z.object({ who: z.enum(['codex', 'antigravity', 'fresh', 'claude']), reason: z.string().min(1), after_job: paths.optional(), after_file: paths.optional() });
const send = { role: z.enum(['текст', 'проверка', 'совет']).optional(), replaces: replaces.optional(), opora: z.boolean().optional() };
const stage = {
  id: z.string().optional(), level: z.enum(['мелочь', 'обычный', 'высокий']).optional(),
  author: z.union([z.object(author), z.array(z.object({ part: z.string().min(1), ...author }))]).optional(),
  source_jobs: z.array(z.string()).optional(), material: z.array(z.string()).optional(), reviews: z.array(z.string()).optional(),
  fresh_review_file: z.string().optional(),
  override: z.object({ by: z.enum(['claude', 'user']), reason: z.string().optional(), quote: z.string().optional(), criterion: z.boolean().optional() }).optional(),
  one_family: z.boolean().optional(), reason: z.string().optional(), criterion_met: z.object({ reason: z.string().min(1) }).optional(),
};
module.exports = { stage, send };
