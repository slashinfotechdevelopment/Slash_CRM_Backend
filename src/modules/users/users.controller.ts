import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UserQueryDto } from './dto/user-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AssignUserRolesDto } from './dto/assign-user-roles.dto';
import { AssignUserDepartmentsDto } from './dto/assign-user-departments.dto';
import { AssignUserPermissionsDto } from './dto/assign-user-permissions.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('users.create')
  @ApiOperation({
    summary: 'Create user',
    description:
      'Creates a user account (ADMIN, EMPLOYEE, or CLIENT) along with type-specific profile data atomically. Enforces delegation authority, generates user codes (A001, EMP001, CLI001), and dispatches an initial email verification OTP.',
  })
  @ApiResponse({
    status: 201,
    description: 'User created successfully and email verification dispatched.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Validation failed or incompatible profile data.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions, unauthorized user type, or delegation escalation attempt.',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflict - Email, phone, or employee number already exists.',
  })
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: any,
  ) {
    const user = await this.usersService.create(
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message:
        'User created successfully. A verification code has been sent to their email.',
      data: user,
    };
  }

  @Get()
  @RequirePermissions('users.view')
  @ApiOperation({
    summary: 'List users with search, filters, and pagination',
    description:
      'Retrieves a paginated list of non-deleted users. Supports search by name, email, or userCode, filtering by user type, role, department, status, email verification status, and creation date range. Automatically enforces the caller’s data scope in database queries.',
  })
  @ApiResponse({
    status: 200,
    description: 'Users retrieved successfully with pagination metadata.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Invalid query parameters or date range.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions.',
  })
  async findAll(
    @Query() query: UserQueryDto,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.findAll(
      query,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'Users retrieved successfully',
      data: result,
    };
  }

  @Get(':id')
  @RequirePermissions('users.view')
  @ApiOperation({
    summary: 'Get complete user details by ID',
    description:
      'Retrieves detailed user information, user type, type-specific profiles (employee or client), assigned roles, effective permissions, and primary/secondary departments. Enforces data scope isolation and hides Super Admin accounts from ordinary Admins.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User details retrieved successfully.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User does not exist, is soft-deleted, or out of scope.',
  })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    const user = await this.usersService.findOne(
      id,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User details retrieved successfully',
      data: user,
    };
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  @ApiOperation({
    summary: 'Update permitted user and profile fields',
    description:
      'Partially updates permitted common user fields (name, phone, profileMediaId) and type-specific profile fields. Strictly prevents modification of immutable identifiers (id, userCode, email, userTypeId, status, roles, departments). Enforces uniqueness and prevents circular reporting.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request - Validation error, self-reporting, or incompatible profile payload.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions or attempting to modify Super Admin accounts.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User does not exist or is soft-deleted.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Conflict - Phone number or employee number is already in use by another user.',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: any,
  ) {
    const user = await this.usersService.update(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User updated successfully',
      data: user,
    };
  }

  @Patch(':id/status')
  @RequirePermissions('users.update')
  @ApiOperation({
    summary: 'Change user account status (ACTIVE / INACTIVE)',
    description:
      'Activates or deactivates a user account. Deactivation immediately revokes all active sessions, invalidates refresh tokens, and blocks active access tokens. Protected against deactivating the last active Super Admin via transactional row locking.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User status updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request - Self-deactivation or attempt to deactivate the last active Super Admin.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions or Admin attempting to change Super Admin status.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User does not exist or is soft-deleted.',
  })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: any,
  ) {
    const user = await this.usersService.updateStatus(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: `User status changed to ${dto.status} successfully.`,
      data: user,
    };
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  @ApiOperation({
    summary: 'Soft-delete a user account',
    description:
      'Soft-deletes a user account by setting deletedAt and deletedBy. Immediately revokes all active sessions, invalidates refresh tokens, and excludes the record from normal queries. Protected against deleting the last active Super Admin.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User deleted successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request - Self-deletion, already deleted, or attempt to delete the last active Super Admin.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions or Admin attempting to delete Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User does not exist.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.usersService.remove(
      id,
      actor?.sub,
      actor?.userType,
    );
  }

  @Patch(':id/restore')
  @RequirePermissions('users.delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted user account',
    description:
      'Restores an eligible soft-deleted user account by clearing deletedAt and deletedBy. Validates that email, phone, and employee number uniqueness constraints remain valid against existing active accounts.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User restored successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - User is not deleted.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions or Admin attempting to restore Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User does not exist.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Conflict - Email, phone, or employee number is now used by another active account.',
  })
  async restore(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    const user = await this.usersService.restore(
      id,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User restored successfully',
      data: user,
    };
  }

  @Put(':id/roles')
  @RequirePermissions('roles.assign')
  @ApiOperation({
    summary: 'Replace user roles',
    description:
      'Replaces all role assignments for the specified user. Enforces delegation authority, rejects inactive/deleted roles and SUPER_ADMIN role assignment, and prevents Admin from modifying Super Admin accounts.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User roles replaced successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Validation failed or invalid roles.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions, unauthorized delegation, self-escalation, or modifying Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User not found.',
  })
  async replaceRoles(
    @Param('id') id: string,
    @Body() dto: AssignUserRolesDto,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.replaceRoles(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User roles updated successfully',
      data: result,
    };
  }

  @Post(':id/roles')
  @RequirePermissions('roles.assign')
  @ApiOperation({
    summary: 'Add roles to user',
    description:
      'Adds one or more roles to the specified user without removing existing assignments. Enforces delegation authority and prevents Admin from modifying Super Admin accounts.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'Roles added to user successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Validation failed or invalid roles.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions, unauthorized delegation, self-escalation, or modifying Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User not found.',
  })
  async addRoles(
    @Param('id') id: string,
    @Body() dto: AssignUserRolesDto,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.addRoles(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'Roles added to user successfully',
      data: result,
    };
  }

  @Delete(':id/roles/:roleId')
  @RequirePermissions('roles.assign')
  @ApiOperation({
    summary: 'Remove role from user',
    description:
      'Removes a specific role assignment (by role ID or role code) from the specified user. Prevents self-modification and Super Admin role removal by ordinary Admins.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiParam({ name: 'roleId', description: 'Role CUID or role code' })
  @ApiResponse({
    status: 200,
    description: 'Role removed from user successfully.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions, self-modification, or modifying Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User, role, or role assignment not found.',
  })
  async removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser() actor: any,
  ) {
    return this.usersService.removeRole(
      id,
      roleId,
      actor?.sub,
      actor?.userType,
    );
  }

  @Put(':id/departments')
  @RequirePermissions('departments.update')
  @ApiOperation({
    summary: 'Assign user departments',
    description:
      'Replaces department assignments for the specified user. Enforces that exactly one department must be primary (isPrimary: true) when departments are assigned, or clears departments if empty. Prevents modifying Super Admin departments.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User departments updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request - Invalid departments or not exactly one primary department.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions or modifying Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User not found.',
  })
  async replaceDepartments(
    @Param('id') id: string,
    @Body() dto: AssignUserDepartmentsDto,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.replaceDepartments(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User departments updated successfully',
      data: result,
    };
  }

  @Put(':id/permissions')
  @RequirePermissions('permissions.assign')
  @ApiOperation({
    summary: 'Set direct permission overrides',
    description:
      'Replaces direct individual permission overrides (ALLOW / DENY) for the specified user. Enforces delegation authority on ALLOW grants, validates dataScope, requires optional reason, and prevents self-escalation or modifying Super Admin permissions.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User permission overrides updated successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request - Invalid permissions or duplicate codes.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden - Insufficient permissions, granting unauthorized permissions, self-escalation, or modifying Super Admin.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User not found.',
  })
  async replacePermissions(
    @Param('id') id: string,
    @Body() dto: AssignUserPermissionsDto,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.replacePermissions(
      id,
      dto,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User permission overrides updated successfully',
      data: result,
    };
  }

  @Get(':id/permissions')
  @RequirePermissions('users.view')
  @ApiOperation({
    summary: 'Get user effective permissions',
    description:
      'Retrieves the effective permissions for the specified user, computed via the 5-tier precedence model (System Restrictions -> Direct DENY -> Direct ALLOW -> Role ALLOW with highest dataScope -> Default DENY). Inactive/deleted accounts return 0 permissions.',
  })
  @ApiParam({ name: 'id', description: 'User unique CUID' })
  @ApiResponse({
    status: 200,
    description: 'User effective permissions retrieved successfully.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Insufficient permissions.',
  })
  @ApiResponse({
    status: 404,
    description: 'Not Found - User not found or inaccessible.',
  })
  async getEffectivePermissions(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    const result = await this.usersService.getEffectivePermissions(
      id,
      actor?.sub,
      actor?.userType,
    );

    return {
      message: 'User effective permissions retrieved successfully',
      data: result,
    };
  }
}
