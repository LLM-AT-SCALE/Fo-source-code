/**
 * Change Password API (for logged-in users)
 * POST /api/auth/change-password - Change password while authenticated
 */

import { updateUser } from '@/shared/lib/storage';
import { hashPassword, verifyPassword } from '@/shared/lib/encryption';
import { requireAuth } from '@/shared/lib/auth-middleware';
import {
  ChangePasswordSchema,
  validate,
  formatValidationErrors,
} from '@/shared/lib/validation';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireAuth(req);
    if (authResult instanceof NextResponse) {
      return authResult;
    }

    const { user } = authResult;
    const body = await req.json();

    // Validate request body
    const validation = validate(ChangePasswordSchema, body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatValidationErrors(validation.errors!) },
        { status: 400 }
      );
    }

    const { currentPassword, newPassword } = validation.data!;

    // Verify current password
    const isCurrentPasswordValid = await verifyPassword(
      currentPassword,
      user.passwordHash
    );

    if (!isCurrentPasswordValid) {
      return NextResponse.json(
        { error: 'Current password is incorrect' },
        { status: 400 }
      );
    }

    // Check if new password is same as current
    const isSamePassword = await verifyPassword(newPassword, user.passwordHash);
    if (isSamePassword) {
      return NextResponse.json(
        { error: 'New password must be different from current password' },
        { status: 400 }
      );
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update the password and release the forced-change gate: this is the
    // endpoint /force-password-change posts to, and without clearing the flag
    // the user was sent straight back to that page after every change.
    await updateUser(user.id, { passwordHash, forcePasswordChange: false, passwordChangedAt: new Date() });

    return NextResponse.json({
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json(
      { error: 'Failed to change password' },
      { status: 500 }
    );
  }
}
