import { defineEnvVars } from '@sveltejs/kit/env';
import { z } from 'zod';

export const variables = defineEnvVars({
  DATABASE_URL: { description: 'The database connection string.' },
  ANTHROPIC_API_KEY: {
    description: 'Key for the anthropic-api provider only. Never logged or displayed.',
    schema: z.string().optional()
  },
  OPENAI_API_KEY: {
    description: 'Key for the openai-api provider only. Never logged, displayed or given to Codex.',
    schema: z.string().optional()
  },
  VEYRA_ALLOW_LAN: {
    description:
      'Set to 1 to accept non-loopback clients (with VEYRA_ACCESS_TOKEN). Unset: local machine only.',
    schema: z.enum(['0', '1']).optional()
  },
  VEYRA_ACCESS_TOKEN: {
    description:
      'Access token required from LAN clients (32+ URL-safe characters). Never logged or displayed.',
    schema: z.string().optional()
  },
  VEYRA_CODEX_COMMAND: {
    description:
      'Absolute path of the user-installed codex binary (codex-chatgpt); overrides codexChatgpt.command.',
    schema: z.string().regex(/^\//, 'absolute path expected').optional()
  },
  VEYRA_CODEX_HOME: {
    description:
      'Absolute path of the dedicated CODEX_HOME (never ~/.codex); overrides codexChatgpt.codexHome.',
    schema: z.string().regex(/^\//, 'absolute path expected').optional()
  },
  VEYRA_AI_PROVIDER: {
    description:
      'Locks the AI provider (fake = labelled test-only simulator). Unset: chosen in /settings.',
    schema: z
      .enum(['fake', 'anthropic-api', 'claude-subscribe', 'openai-api', 'codex-chatgpt'])
      .optional()
  }
});
