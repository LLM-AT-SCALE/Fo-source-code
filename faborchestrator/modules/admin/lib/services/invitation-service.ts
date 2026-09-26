/**
 * Invitation Service - Create, validate, accept invitations.
 */

import prisma from '@/shared/lib/db';
import { generateToken, hashPassword } from '@/shared/lib/encryption';
import { sendSmtpEmail } from '@/modules/admin/lib/email/smtp';
import { buildInvitationEmailHtml } from '@/modules/admin/lib/email/invitation-template';
import { recordAuditLog } from './audit-service';

const INVITATION_EXPIRY_DAYS = 7;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function buildAcceptUrl(token: string): string {
  return `${APP_URL}/register?token=${token}`;
}

/**
 * Create an invitation and send email.
 */
export async function createInvitation(data: {
  email: string;
  roleId: string;
  adminUserId: string;
  ipAddress: string | null;
}) {
  const { email, roleId, adminUserId, ipAddress } = data;
  const emailLower = email.toLowerCase().trim();

  // Validate role exists
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new Error('Role not found');

  // Check for existing active user (allow re-invite of soft-deleted users)
  const existingUser = await prisma.user.findUnique({ where: { email: emailLower } });
  if (existingUser && existingUser.status === 'ACTIVE') {
    throw new Error('An active user with this email already exists');
  }

  // Check for existing pending invitation
  const existingInvite = await prisma.invitation.findFirst({
    where: { email: emailLower, status: 'PENDING' },
  });
  if (existingInvite) throw new Error('An invitation is already pending for this email');

  // Create invitation
  const token = generateToken();
  const invitation = await prisma.$transaction(async (tx) => {
    const inv = await tx.invitation.create({
      data: {
        email: emailLower,
        roleId,
        invitedById: adminUserId,
        token,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
      include: { role: true },
    });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'invitation.created',
      targetType: 'Invitation',
      targetId: inv.id,
      metadata: { email: emailLower, roleName: role.name },
      ipAddress,
    });

    return inv;
  });

  // Send email
  const inviter = await prisma.user.findUnique({
    where: { id: adminUserId },
    select: { name: true },
  });

  const acceptUrl = buildAcceptUrl(token);
  const emailHtml = buildInvitationEmailHtml({
    inviterName: inviter?.name || 'An administrator',
    roleName: role.name,
    acceptUrl,
    expiresInDays: INVITATION_EXPIRY_DAYS,
  });

  try {
    const sent = await sendSmtpEmail({
      to: emailLower,
      subject: `You're invited to join LLMatscale.ai`,
      html: emailHtml,
    });

    if (!sent) {
      // Dev fallback
      console.log('[DEV] Invitation email for:', emailLower);
      console.log('[DEV] Accept URL:', acceptUrl);
    }
  } catch (err) {
    console.error('Failed to send invitation email:', err);
    // Don't fail the invitation creation if email fails
  }

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role.name,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    acceptUrl, // Return for dev convenience
  };
}

/**
 * Validate an invitation token (public endpoint).
 */
export async function validateInvitationToken(token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { role: true },
  });

  if (!invitation) {
    return { valid: false, error: 'Invitation not found' };
  }

  if (invitation.status === 'ACCEPTED') {
    return { valid: false, error: 'Invitation already accepted' };
  }

  if (invitation.status === 'REVOKED') {
    return { valid: false, error: 'Invitation has been revoked' };
  }

  if (invitation.expiresAt < new Date()) {
    // Auto-expire
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'EXPIRED' },
    });
    return { valid: false, error: 'Invitation has expired' };
  }

  if (invitation.status !== 'PENDING') {
    return { valid: false, error: 'Invitation is no longer valid' };
  }

  return {
    valid: true,
    email: invitation.email,
    roleName: invitation.role.name,
  };
}

/**
 * Accept invitation - create user account with password.
 */
export async function acceptInvitation(data: {
  token: string;
  name: string;
  password: string;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const { token, name, password, ipAddress, userAgent } = data;

  // Validate token
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { role: true },
  });

  if (!invitation) throw new Error('Invitation not found');
  if (invitation.status !== 'PENDING') throw new Error('Invitation is no longer valid');
  if (invitation.expiresAt < new Date()) throw new Error('Invitation has expired');

  // Check if email belongs to an existing user
  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
  });

  // If user exists and is ACTIVE, reject
  if (existingUser && existingUser.status === 'ACTIVE') {
    throw new Error('An active account with this email already exists');
  }

  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const passwordHash = await hashPassword(password);
  const sessionToken = generateToken();
  const sessionExpiry = new Date();
  sessionExpiry.setDate(sessionExpiry.getDate() + 30);

  // Create or reactivate user + accept invitation + create session atomically
  const result = await prisma.$transaction(async (tx) => {
    let user;

    if (existingUser && existingUser.status === 'DELETED') {
      // Reactivate soft-deleted user — preserves old data (conversations, usage)
      user = await tx.user.update({
        where: { id: existingUser.id },
        data: {
          name,
          passwordHash,
          roleId: invitation.roleId,
          status: 'ACTIVE',
          forcePasswordChange: false,
        },
      });
    } else {
      // Create new user
      user = await tx.user.create({
        data: {
          email: invitation.email,
          name,
          passwordHash,
          roleId: invitation.roleId,
          status: 'ACTIVE',
        },
      });
    }

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    const session = await tx.session.create({
      data: {
        userId: user.id,
        token: sessionToken,
        expiresAt: sessionExpiry,
        userAgent: userAgent || undefined,
        ipAddress: ipAddress || undefined,
      },
    });

    await recordAuditLog(tx, {
      userId: user.id,
      action: 'user.registered_via_invitation',
      targetType: 'User',
      targetId: user.id,
      metadata: { email: invitation.email, roleName: invitation.role.name },
      ipAddress,
    });

    return { user, session };
  });

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
    },
    token: sessionToken,
    expiresAt: sessionExpiry.toISOString(),
    roleName: invitation.role.name,
  };
}

/**
 * List all invitations.
 */
export async function listInvitations() {
  // Lazy expire overdue ones
  await prisma.invitation.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });

  return prisma.invitation.findMany({
    include: {
      role: { select: { id: true, name: true } },
      invitedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
}

/**
 * Revoke a pending invitation.
 */
export async function revokeInvitation(
  invitationId: string,
  adminUserId: string,
  ipAddress: string | null
) {
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation) throw new Error('Invitation not found');
  if (invitation.status !== 'PENDING') throw new Error('Only pending invitations can be revoked');

  return prisma.$transaction(async (tx) => {
    const inv = await tx.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'invitation.revoked',
      targetType: 'Invitation',
      targetId: invitationId,
      metadata: { email: inv.email },
      ipAddress,
    });

    return inv;
  });
}

/**
 * Resend an invitation — generates new token, resets expiry, sends email.
 */
export async function resendInvitation(
  invitationId: string,
  adminUserId: string,
  ipAddress: string | null
) {
  const INVITATION_EXPIRY_DAYS = 7;

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { role: true },
  });
  if (!invitation) throw new Error('Invitation not found');
  if (invitation.status === 'ACCEPTED') throw new Error('Cannot resend accepted invitations');
  if (invitation.status === 'REVOKED') throw new Error('Cannot resend revoked invitations');

  const newToken = generateToken();

  const updated = await prisma.$transaction(async (tx) => {
    const inv = await tx.invitation.update({
      where: { id: invitationId },
      data: {
        token: newToken,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
      include: { role: true },
    });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'invitation.resent',
      targetType: 'Invitation',
      targetId: invitationId,
      metadata: { email: inv.email, roleName: inv.role.name },
      ipAddress,
    });

    return inv;
  });

  // Re-send email
  const inviter = await prisma.user.findUnique({
    where: { id: adminUserId },
    select: { name: true },
  });

  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const acceptUrl = `${APP_URL}/register?token=${newToken}`;

  try {
    const emailHtml = buildInvitationEmailHtml({
      inviterName: inviter?.name || 'An administrator',
      roleName: updated.role.name,
      acceptUrl,
      expiresInDays: INVITATION_EXPIRY_DAYS,
    });

    const sent = await sendSmtpEmail({
      to: updated.email,
      subject: `You're invited to join LLMatscale.ai`,
      html: emailHtml,
    });

    if (!sent) {
      console.log('[DEV] Resent invitation for:', updated.email);
      console.log('[DEV] Accept URL:', acceptUrl);
    }
  } catch (err) {
    console.error('Failed to resend invitation email:', err);
  }

  return updated;
}
