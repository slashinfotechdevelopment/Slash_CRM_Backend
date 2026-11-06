import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const REQUIRE_ANY_PERMISSIONS_KEY = 'require_any_permissions';
export const RequireAnyPermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRE_ANY_PERMISSIONS_KEY, permissions);


