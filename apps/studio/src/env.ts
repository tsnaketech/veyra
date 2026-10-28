import { defineEnvVars } from '@sveltejs/kit/env';
import { z } from 'zod';

export const variables = defineEnvVars({
  DATABASE_URL: { description: 'The database connection string.' },
  ANTHROPIC_API_KEY: {
    description: 'Key for the anthropic-api provider only. Never logged or displayed.',
    schema: z.string().optional()
  },
  VEYRA_AI_PROVIDER: {
    description:
      'Locks the AI provider (fake = labelled test-only simulator). Unset: chosen in /settings.',
    schema: z.enum(['fake', 'anthropic-api', 'claude-subscribe']).optional()
  }
});
