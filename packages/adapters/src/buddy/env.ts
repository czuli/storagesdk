import { optionalEnv, requireEnv } from '../env-helpers.js';
import type { AdapterEnvVar } from '../registry.js';
import type { BuddyConfig } from './buddy.js';

export const BUDDY_ENV_VARS: readonly AdapterEnvVar[] = [
  { name: 'BUDDY_WORKSPACE', required: true },
  { name: 'BUDDY_ARTIFACT', required: true },
  { name: 'BUDDY_TOKEN', required: true, fallback: ['BUDDY_API_TOKEN'] },
  { name: 'BUDDY_PROJECT', required: false },
  { name: 'BUDDY_VERSION', required: false },
  { name: 'BUDDY_API_URL', required: false },
];

export function buddyConfigFromEnv(): BuddyConfig {
  const project = optionalEnv('BUDDY_PROJECT');
  const version = optionalEnv('BUDDY_VERSION');
  const apiUrl = optionalEnv('BUDDY_API_URL');
  return {
    workspace: requireEnv('BUDDY_WORKSPACE'),
    artifact: requireEnv('BUDDY_ARTIFACT'),
    token: requireEnv('BUDDY_TOKEN', ['BUDDY_API_TOKEN']),
    ...(project !== undefined ? { project } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
  };
}
