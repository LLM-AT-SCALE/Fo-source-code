/**
 * FabOrchestrator - Database Seed Script
 *
 * Creates the default roles and the bootstrap admin user. MCP servers, data
 * sources and everything else are created in the Admin Console, not seeded.
 *
 * Usage:
 *   # With env vars:
 *   ADMIN_EMAIL=admin@llmatscale.ai ADMIN_PASSWORD=secret ADMIN_NAME="Admin" npx tsx prisma/seed.ts
 *
 *   # Interactive:
 *   npx tsx prisma/seed.ts
 *
 *   # Via npm scripts:
 *   npm run db:seed
 */

import 'dotenv/config';
import { hashPassword } from '../shared/lib/encryption';
import { prisma } from '../shared/lib/db';
import { ROLE_TEMPLATES } from '../modules/admin/lib/constants/role-templates';
import { ensureAdminRole } from '../modules/admin/lib/services/role-service';
import * as readline from 'node:readline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing required input: "${question.trim()}" ` +
      'Set the corresponding environment variable (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME) ' +
      'or run in an interactive terminal.'
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Seed Roles
// ---------------------------------------------------------------------------

async function seedRoles(): Promise<string> {
  console.log('\n--- Role Setup ---\n');

  // The built-in Admin role: created or repaired to full access, never skipped.
  const admin = await ensureAdminRole();
  console.log(`  Role "Admin" ${admin.created ? 'created' : 'verified'} (full access).`);
  let adminRoleId = admin.id;

  for (const template of ROLE_TEMPLATES) {
    if (template.name === 'Admin') continue;
    const existing = await prisma.role.findUnique({
      where: { name: template.name },
    });

    if (existing) {
      console.log(`  Role "${template.name}" already exists. Skipping.`);
      if (template.name === 'Admin') adminRoleId = existing.id;
      continue;
    }

    const role = await prisma.role.create({
      data: {
        name: template.name,
        description: template.description,
        isSystemRole: template.isSystemRole,
        permissions: template.permissions,
        allowedModels: template.allowedModels,
        systemInstructions: template.systemInstructions,
        customInstructionsEnabled: template.customInstructionsEnabled,
        customInstructionsMaxLength: template.customInstructionsMaxLength,
        personalMcpEnabled: template.personalMcpEnabled,
        personalMcpMaxCount: template.personalMcpMaxCount,
        dailyRequestLimit: template.dailyRequestLimit,
        dailyTokenLimit: template.dailyTokenLimit,
      },
    });

    console.log(`  Role "${role.name}" created.`);
    if (template.name === 'Admin') adminRoleId = role.id;
  }

  console.log(`\n${ROLE_TEMPLATES.length} roles processed.`);
  return adminRoleId;
}

// ---------------------------------------------------------------------------
// Seed Admin User
// ---------------------------------------------------------------------------

async function seedAdminUser(adminRoleId: string): Promise<void> {
  console.log('\n--- Admin User Setup ---\n');

  const email = process.env.ADMIN_EMAIL || await prompt('Admin email: ');
  const password = process.env.ADMIN_PASSWORD || await prompt('Admin password: ');
  const name = process.env.ADMIN_NAME || await prompt('Admin name: ');

  if (!email || !password || !name) {
    throw new Error('Admin email, password, and name are all required.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    // Upgrade existing user to admin
    if (!existing.isAdmin) {
      await prisma.user.update({
        where: { email },
        data: {
          isAdmin: true,
          roleId: adminRoleId || undefined,
        },
      });
      console.log(`User "${email}" upgraded to Admin.`);
    } else {
      console.log(`Admin "${email}" already exists. Skipping.`);
    }
    return;
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      isAdmin: true,
      roleId: adminRoleId || undefined,
      status: 'ACTIVE',
      // The seed password is a bootstrap value: the first login must replace it.
      forcePasswordChange: true,
    },
  });
  console.log(`Admin "${email}" created successfully (password change required at first login).`);
}

// ---------------------------------------------------------------------------
// Seed MCP Registry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('FabOrchestrator - Database Seed Script');
  console.log('===================================');

  const adminRoleId = await seedRoles();
  await seedAdminUser(adminRoleId);

  console.log('\nSeed complete.');
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
