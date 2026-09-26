
import { ADMIN_ROLE_DEFAULTS } from '@/shared/lib/permissions';/**
 * Default Role Templates
 *
 * Used by the seed script to create initial roles.
 * Adapted from Claude_ai-master role templates.
 */

export interface RoleTemplate {
  name: string;
  description: string;
  isSystemRole: boolean;
  permissions: string[];
  allowedModels: string[];
  systemInstructions: string | null;
  customInstructionsEnabled: boolean;
  customInstructionsMaxLength: number;
  personalMcpEnabled: boolean;
  personalMcpMaxCount: number;
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
}

// Seed fallback only — the model_registry table is the platform's source of truth.
// Tiered by capability: FabOrchestrator 1 (lowest) … 4 (highest).
const ALL_MODELS = [
  'claude-sonnet-5',   // FabOrchestrator 1
  'claude-opus-5',     // FabOrchestrator 2
  'claude-fable-5',    // FabOrchestrator 3
  'claude-fable-5-1',  // FabOrchestrator 4
];

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: ADMIN_ROLE_DEFAULTS.name,
    description: ADMIN_ROLE_DEFAULTS.description,
    isSystemRole: true,
    permissions: [...ADMIN_ROLE_DEFAULTS.permissions],
    allowedModels: ALL_MODELS,
    systemInstructions: null,
    customInstructionsEnabled: ADMIN_ROLE_DEFAULTS.customInstructionsEnabled,
    customInstructionsMaxLength: ADMIN_ROLE_DEFAULTS.customInstructionsMaxLength,
    personalMcpEnabled: ADMIN_ROLE_DEFAULTS.personalMcpEnabled,
    personalMcpMaxCount: ADMIN_ROLE_DEFAULTS.personalMcpMaxCount,
    dailyRequestLimit: null,
    dailyTokenLimit: null,
  },
  {
    name: 'Business User',
    description: 'Business users with standard access',
    isSystemRole: true,
    permissions: ['chat', 'artifacts', 'file_upload'],
    allowedModels: ['claude-sonnet-5', 'claude-opus-5'],
    systemInstructions: null,
    customInstructionsEnabled: false,
    customInstructionsMaxLength: 0,
    personalMcpEnabled: false,
    personalMcpMaxCount: 0,
    dailyRequestLimit: null,
    dailyTokenLimit: null,
  },
  {
    name: 'Operator User',
    description: 'Operator users with rate-limited access',
    isSystemRole: true,
    permissions: ['chat', 'artifacts', 'file_upload'],
    allowedModels: ['claude-sonnet-5', 'claude-opus-5'],
    systemInstructions: null,
    customInstructionsEnabled: false,
    customInstructionsMaxLength: 0,
    personalMcpEnabled: false,
    personalMcpMaxCount: 0,
    dailyRequestLimit: 100,
    dailyTokenLimit: 200000,
  },
];
