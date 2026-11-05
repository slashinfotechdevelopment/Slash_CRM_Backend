import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../../database/prisma.service';
import { UserCodeService } from '../../common/services/user-code.service';
import { AuditService } from '../../common/audit/audit.service';
import { OtpService } from '../auth/services/otp.service';
import { RolesService } from '../roles/roles.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UserQueryDto } from './dto/user-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AssignUserRolesDto } from './dto/assign-user-roles.dto';
import { AssignUserDepartmentsDto } from './dto/assign-user-departments.dto';
import { AssignUserPermissionsDto } from './dto/assign-user-permissions.dto';
import { UpdateEmployeeProfileDto } from './dto/update-employee-profile.dto';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import {
  AuditAction,
  DataScope,
  MediaStatus,
  OtpPurpose,
  PermissionEffect,
  RecordStatus,
  SessionStatus,
} from '../../generated/prisma/enums';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userCodeService: UserCodeService,
    private readonly auditService: AuditService,
    private readonly otpService: OtpService,
    private readonly rolesService: RolesService,
  ) { }

  /**
   * Resolves the effective DataScope for an actor for a specific permission code.
   * Super Admin => ALL
   * Client => OWN
   * Other => Check user_permissions (direct ALLOW override) then user_roles.
   */
  async resolveActorDataScope(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string = 'users.view',
  ): Promise<DataScope> {
    if (actorUserType === 'SUPER_ADMIN') {
      return DataScope.ALL;
    }
    if (actorUserType === 'CLIENT') {
      return DataScope.OWN;
    }

    // 1. Direct permission override
    const directPerm = await this.prisma.userPermission.findFirst({
      where: {
        userId: actorUserId,
        permission: { code: permissionCode, status: RecordStatus.ACTIVE },
      },
    });

    if (
      directPerm &&
      directPerm.effect === PermissionEffect.ALLOW &&
      directPerm.dataScope
    ) {
      return directPerm.dataScope;
    }

    // 2. Role permissions
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId: actorUserId,
        role: { status: RecordStatus.ACTIVE, deletedAt: null },
      },
      include: {
        role: {
          include: {
            permissions: {
              where: {
                permission: { code: permissionCode, status: RecordStatus.ACTIVE },
              },
            },
          },
        },
      },
    });

    const rank: Record<DataScope, number> = {
      OWN: 0,
      ASSIGNED: 1,
      DEPARTMENT: 2,
      ALL: 3,
    };

    let highestScope: DataScope | null = null;
    for (const ur of userRoles) {
      for (const rp of ur.role.permissions) {
        if (!highestScope || rank[rp.dataScope] > rank[highestScope]) {
          highestScope = rp.dataScope;
        }
      }
    }

    if (highestScope) {
      return highestScope;
    }

    // Default fallback if no specific role-permission dataScope is mapped
    return actorUserType === 'ADMIN' ? DataScope.ALL : DataScope.OWN;
  }

  /**
   * Builds an authorization-aware Prisma WHERE filter based on the actor's userType
   * and resolved data scope.
   */
  async buildDataScopeWhere(
    actorUserId?: string,
    actorUserType?: string,
    permissionCode: string = 'users.view',
  ): Promise<any> {
    // 1. Super Admin: full visibility of non-deleted records
    if (actorUserType === 'SUPER_ADMIN') {
      return { deletedAt: null };
    }

    // 2. Client: only their own user record
    if (actorUserType === 'CLIENT') {
      return { id: actorUserId, deletedAt: null };
    }

    // 3. Fallback if actorUserId is missing
    if (!actorUserId) {
      return { id: '__UNAUTHORIZED__', deletedAt: null };
    }

    const scope = await this.resolveActorDataScope(
      actorUserId,
      actorUserType || '',
      permissionCode,
    );

    // Common restriction: Non-Super-Admins can NEVER see SUPER_ADMIN accounts
    const baseCondition: any = {
      deletedAt: null,
      userType: { code: { not: 'SUPER_ADMIN' } },
    };

    if (scope === DataScope.ALL) {
      if (actorUserType === 'EMPLOYEE') {
        baseCondition.userType = { code: { notIn: ['SUPER_ADMIN', 'ADMIN'] } };
      }
      return baseCondition;
    }

    if (scope === DataScope.DEPARTMENT) {
      const userDepts = await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      });
      const deptIds = userDepts.map((d) => d.departmentId);

      const deptCondition: any = {
        ...baseCondition,
        departments: {
          some: {
            departmentId: { in: deptIds },
          },
        },
      };
      if (actorUserType === 'EMPLOYEE') {
        deptCondition.userType = { code: { notIn: ['SUPER_ADMIN', 'ADMIN'] } };
      }
      return deptCondition;
    }

    if (scope === DataScope.ASSIGNED) {
      return {
        ...baseCondition,
        OR: [
          { id: actorUserId },
          { employeeProfile: { reportingToId: actorUserId } },
        ],
      };
    }

    // Scope === OWN: only own account
    return {
      id: actorUserId,
      deletedAt: null,
    };
  }

  /**
   * Atomically creates a new user, user-type-specific profile, role assignments,
   * and department assignments in a single transaction.
   * Generates atomic user codes (A001, EMP001, CLI001) and initiates email verification.
   */
  async create(
    dto: CreateUserDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    // 1. Authorization checks based on user types
    if (dto.userType === ('SUPER_ADMIN' as any)) {
      throw new BadRequestException(
        'Super Admin creation is not allowed via ordinary user creation. Use dedicated bootstrap/recovery procedures.',
      );
    }

    if (actorUserType === 'ADMIN') {
      if (dto.userType === 'ADMIN') {
        throw new ForbiddenException(
          'Admins are not permitted to create Admin accounts.',
        );
      }
      if (dto.userType !== 'EMPLOYEE' && dto.userType !== 'CLIENT') {
        throw new ForbiddenException(
          'Admins can only create EMPLOYEE and CLIENT accounts.',
        );
      }
    } else if (actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Only administrators are permitted to create user accounts.',
      );
    }

    // 2. Validate user type exists and is active
    const userTypeRecord = await this.prisma.userType.findFirst({
      where: { code: dto.userType, status: RecordStatus.ACTIVE },
    });

    if (!userTypeRecord) {
      throw new BadRequestException(
        `User type '${dto.userType}' is not active or recognized.`,
      );
    }

    // 3. Unique email check
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingEmail) {
      throw new ConflictException(
        `User with email '${dto.email}' already exists.`,
      );
    }

    // 4. Unique phone check (if supplied)
    if (dto.phone) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
      });

      if (existingPhone) {
        throw new ConflictException(
          `User with phone number '${dto.phone}' already exists.`,
        );
      }
    }

    // 5. Dynamic profile validation
    if (dto.userType === 'EMPLOYEE') {
      if (!dto.profile) {
        throw new BadRequestException(
          'profile object is required for EMPLOYEE user type.',
        );
      }

      if (dto.profile.employeeNumber) {
        const existingEmpNum = await this.prisma.employeeProfile.findUnique({
          where: { employeeNumber: dto.profile.employeeNumber },
        });

        if (existingEmpNum) {
          throw new ConflictException(
            `Employee number '${dto.profile.employeeNumber}' is already in use.`,
          );
        }
      }

      if (dto.profile.reportingToId) {
        const manager = await this.prisma.user.findFirst({
          where: {
            id: dto.profile.reportingToId,
            deletedAt: null,
            status: RecordStatus.ACTIVE,
          },
        });

        if (!manager) {
          throw new BadRequestException(
            'Specified reporting manager (reportingToId) does not exist or is inactive.',
          );
        }
      }
    } else if (dto.userType === 'CLIENT') {
      if (!dto.profile) {
        throw new BadRequestException(
          'profile object is required for CLIENT user type.',
        );
      }

      if (!dto.profile.companyName || typeof dto.profile.companyName !== 'string') {
        throw new BadRequestException(
          'companyName is required for client profiles.',
        );
      }

      if (dto.profile.logoMediaId) {
        const media = await this.prisma.media.findFirst({
          where: {
            id: dto.profile.logoMediaId,
            status: MediaStatus.ACTIVE,
            deletedAt: null,
          },
        });

        if (!media) {
          throw new BadRequestException(
            'Specified logoMediaId does not exist or is inactive.',
          );
        }
      }
    } else if (dto.userType === 'ADMIN') {
      if (dto.profile) {
        throw new BadRequestException(
          'Profile data is not permitted for ADMIN user type.',
        );
      }
    }

    // 6. Role validation & delegation authority
    let resolvedRoles: Array<{ id: string; code: string }> = [];
    if (dto.roles && dto.roles.length > 0) {
      if (dto.roles.includes('SUPER_ADMIN')) {
        throw new ForbiddenException(
          'Assignment of the Super Admin role is strictly restricted.',
        );
      }

      const roles = await this.prisma.role.findMany({
        where: {
          OR: [{ id: { in: dto.roles } }, { code: { in: dto.roles } }],
          status: RecordStatus.ACTIVE,
          deletedAt: null,
        },
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      });

      if (roles.length !== dto.roles.length) {
        throw new BadRequestException(
          'One or more specified roles are invalid, inactive, or do not exist.',
        );
      }

      if (roles.some((r) => r.code === 'SUPER_ADMIN')) {
        throw new ForbiddenException(
          'Assignment of the Super Admin role is strictly restricted.',
        );
      }

      // If actor is not Super Admin, check delegation authority over roles
      if (actorUserType !== 'SUPER_ADMIN' && actorUserId) {
        const actorPermissions =
          await this.rolesService.getActorEffectivePermissions(actorUserId);

        const unauthorizedPermissions: string[] = [];
        for (const role of roles) {
          for (const rp of role.permissions) {
            if (
              rp.permission.status === RecordStatus.ACTIVE &&
              !actorPermissions.has(rp.permission.code)
            ) {
              unauthorizedPermissions.push(rp.permission.code);
            }
          }
        }

        if (unauthorizedPermissions.length > 0) {
          const uniqueMissing = [...new Set(unauthorizedPermissions)];
          throw new ForbiddenException(
            `Cannot assign roles containing permissions you do not possess: [${uniqueMissing.join(', ')}]`,
          );
        }
      }

      resolvedRoles = roles.map((r) => ({ id: r.id, code: r.code }));
    }

    // 7. Department validation
    let resolvedDepartments: Array<{ id: string; code: string }> = [];
    if (dto.departments && dto.departments.length > 0) {
      const departments = await this.prisma.department.findMany({
        where: {
          OR: [
            { id: { in: dto.departments } },
            { code: { in: dto.departments } },
          ],
          status: RecordStatus.ACTIVE,
          deletedAt: null,
        },
      });

      if (departments.length !== dto.departments.length) {
        throw new BadRequestException(
          'One or more specified departments are invalid, inactive, or do not exist.',
        );
      }

      resolvedDepartments = departments.map((d) => ({
        id: d.id,
        code: d.code,
      }));
    }

    // 8. Atomic transaction: generate user code, create user, profile, roles, departments
    const createdUser = await this.prisma.$transaction(async (tx) => {
      const userCode = await this.userCodeService.generateNextCode(
        dto.userType,
        tx as any,
      );

      const user = await tx.user.create({
        data: {
          userCode,
          userTypeId: userTypeRecord.id,
          name: dto.name,
          email: dto.email,
          phone: dto.phone || null,
          createdBy: actorUserId || null,
          status: RecordStatus.ACTIVE,
        },
      });

      if (dto.userType === 'EMPLOYEE' && dto.profile) {
        await tx.employeeProfile.create({
          data: {
            userId: user.id,
            employeeNumber: dto.profile.employeeNumber || null,
            designation: dto.profile.designation || null,
            dateOfJoining: dto.profile.dateOfJoining
              ? new Date(dto.profile.dateOfJoining)
              : null,
            employmentType: dto.profile.employmentType || null,
            reportingToId: dto.profile.reportingToId || null,
            notes: dto.profile.notes || null,
          },
        });
      } else if (dto.userType === 'CLIENT' && dto.profile) {
        await tx.clientProfile.create({
          data: {
            userId: user.id,
            companyName: dto.profile.companyName,
            website: dto.profile.website || null,
            taxNumber: dto.profile.taxNumber || null,
            addressLine1: dto.profile.addressLine1 || null,
            addressLine2: dto.profile.addressLine2 || null,
            city: dto.profile.city || null,
            state: dto.profile.state || null,
            postalCode: dto.profile.postalCode || null,
            country: dto.profile.country || null,
            logoMediaId: dto.profile.logoMediaId || null,
          },
        });
      }

      for (const role of resolvedRoles) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
            assignedBy: actorUserId || null,
          },
        });
      }

      for (let i = 0; i < resolvedDepartments.length; i++) {
        await tx.userDepartment.create({
          data: {
            userId: user.id,
            departmentId: resolvedDepartments[i].id,
            isPrimary: i === 0,
            assignedBy: actorUserId || null,
          },
        });
      }

      return user;
    });

    // 9. Dispatch initial email verification OTP
    try {
      await this.otpService.requestOtp({
        email: createdUser.email,
        purpose: OtpPurpose.EMAIL_VERIFICATION,
        userId: createdUser.id,
      });
    } catch (otpErr: any) {
      this.logger.warn(
        `Failed to send email verification OTP to ${createdUser.email}: ${otpErr?.message || otpErr}`,
      );
    }

    // 10. Audit logging
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'users',
      entityType: 'User',
      entityId: createdUser.id,
      newValues: {
        id: createdUser.id,
        userCode: createdUser.userCode,
        userType: dto.userType,
        name: createdUser.name,
        email: createdUser.email,
        phone: createdUser.phone,
        roles: resolvedRoles.map((r) => r.code),
        departments: resolvedDepartments.map((d) => d.code),
      },
    });

    // 11. Retrieve fully populated user record for return
    return this.findCreatedUserDetails(createdUser.id);
  }

  /**
   * Retrieves a paginated list of users with search, multi-field filters, sorting,
   * and authorization data scope applied directly at the database query level.
   */
  async findAll(
    query: UserQueryDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    if (query.createdFrom && query.createdTo) {
      if (new Date(query.createdFrom) > new Date(query.createdTo)) {
        throw new BadRequestException(
          'createdFrom date cannot be later than createdTo date.',
        );
      }
    }

    const scopeWhere = await this.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'users.view',
    );

    const andConditions: any[] = [scopeWhere];

    if (query.search) {
      andConditions.push({
        OR: [
          { name: { contains: query.search } },
          { email: { contains: query.search } },
          { userCode: { contains: query.search } },
        ],
      });
    }

    if (query.userType) {
      andConditions.push({
        userType: { code: query.userType },
      });
    }

    if (query.role) {
      andConditions.push({
        userRoles: {
          some: {
            OR: [{ roleId: query.role }, { role: { code: query.role } }],
          },
        },
      });
    }

    if (query.department) {
      andConditions.push({
        departments: {
          some: {
            OR: [
              { departmentId: query.department },
              { department: { code: query.department } },
            ],
          },
        },
      });
    }

    if (query.status) {
      andConditions.push({ status: query.status });
    }

    if (query.emailVerified !== undefined) {
      if (query.emailVerified) {
        andConditions.push({ emailVerifiedAt: { not: null } });
      } else {
        andConditions.push({ emailVerifiedAt: null });
      }
    }

    if (query.createdFrom || query.createdTo) {
      const createdAtFilter: any = {};
      if (query.createdFrom) {
        createdAtFilter.gte = new Date(query.createdFrom);
      }
      if (query.createdTo) {
        createdAtFilter.lte = new Date(query.createdTo);
      }
      andConditions.push({ createdAt: createdAtFilter });
    }

    const where = { AND: andConditions };

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as
      | 'asc'
      | 'desc';

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          [sortBy]: sortOrder,
        },
        include: {
          userType: { select: { code: true, name: true } },
          profileMedia: {
            select: {
              id: true,
              fileUrl: true,
              originalName: true,
              mimeType: true,
            },
          },
          userRoles: {
            include: {
              role: { select: { id: true, code: true, name: true } },
            },
          },
          departments: {
            include: {
              department: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
    ]);

    const items = users.map((u) => ({
      id: u.id,
      userCode: u.userCode,
      name: u.name,
      email: u.email,
      phone: u.phone,
      userType: u.userType,
      status: u.status,
      emailVerified: u.emailVerifiedAt !== null,
      profileMedia: u.profileMedia || null,
      roles: u.userRoles.map((ur) => ur.role),
      departments: u.departments.map((ud) => ({
        id: ud.department.id,
        code: ud.department.code,
        name: ud.department.name,
        isPrimary: ud.isPrimary,
      })),
      createdAt: u.createdAt,
    }));

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    };
  }

  /**
   * Retrieves complete user details with type-specific profiles, role permissions,
   * and department assignments, enforcing data scope and security rules.
   */
  async findOne(id: string, actorUserId?: string, actorUserType?: string) {
    const scopeWhere = await this.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'users.view',
    );

    const user = await this.prisma.user.findFirst({
      where: {
        id,
        AND: [scopeWhere],
      },
      include: {
        userType: {
          select: { id: true, code: true, name: true, description: true },
        },
        profileMedia: {
          select: {
            id: true,
            fileUrl: true,
            originalName: true,
            mimeType: true,
          },
        },
        employeeProfile: true,
        clientProfile: {
          include: {
            logoMedia: {
              select: {
                id: true,
                fileUrl: true,
                originalName: true,
                mimeType: true,
              },
            },
          },
        },
        userRoles: {
          include: {
            role: {
              select: {
                id: true,
                code: true,
                name: true,
                description: true,
                isSystem: true,
              },
            },
          },
        },
        departments: {
          include: {
            department: {
              select: {
                id: true,
                code: true,
                name: true,
                description: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    if (actorUserType === 'ADMIN' && user.userType.code === 'SUPER_ADMIN') {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    let reportingTo: any = null;
    if (user.employeeProfile?.reportingToId) {
      reportingTo = await this.prisma.user.findUnique({
        where: { id: user.employeeProfile.reportingToId },
        select: {
          id: true,
          userCode: true,
          name: true,
          email: true,
        },
      });
    }

    let effectivePermissions: string[] = [];
    if (
      actorUserType === 'SUPER_ADMIN' ||
      actorUserType === 'ADMIN' ||
      actorUserId === user.id
    ) {
      const perms = await this.rolesService.getActorEffectivePermissions(
        user.id,
      );
      effectivePermissions = Array.from(perms);
    }

    return {
      id: user.id,
      userCode: user.userCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      emailVerifiedAt: user.emailVerifiedAt,
      profileMedia: user.profileMedia || null,
      userType: user.userType,
      roles: (user.userRoles || []).map((ur) => ur.role),
      departments: (user.departments || []).map((ud) => ({
        ...ud.department,
        isPrimary: ud.isPrimary,
      })),
      profile:
        user.userType.code === 'EMPLOYEE'
          ? user.employeeProfile
            ? { ...user.employeeProfile, reportingTo }
            : null
          : user.userType.code === 'CLIENT'
            ? user.clientProfile
            : null,
      effectivePermissions,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Partially updates permitted user common fields and nested type-specific profiles.
   * Protects immutable fields (id, userCode, email, userTypeId, status, roles, departments).
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        userType: true,
        employeeProfile: true,
        clientProfile: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin accounts.',
      );
    }

    if (actorUserType === 'CLIENT' && targetUser.id !== actorUserId) {
      throw new ForbiddenException(
        'Clients are not permitted to modify other accounts.',
      );
    }

    // Phone uniqueness check
    if (dto.phone && dto.phone !== targetUser.phone) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
      });

      if (existingPhone && existingPhone.id !== id) {
        throw new ConflictException(
          `Phone number '${dto.phone}' is already in use by another user.`,
        );
      }
    }

    // Media validation
    if (dto.profileMediaId) {
      const media = await this.prisma.media.findFirst({
        where: {
          id: dto.profileMediaId,
          status: MediaStatus.ACTIVE,
          deletedAt: null,
        },
      });

      if (!media) {
        throw new BadRequestException(
          'Specified profileMediaId does not exist or is inactive.',
        );
      }
    }

    // Dynamic profile validations
    if (dto.profile) {
      if (targetUser.userType.code === 'ADMIN') {
        throw new BadRequestException(
          'Profile data is not applicable for ADMIN users.',
        );
      }

      if (targetUser.userType.code === 'EMPLOYEE') {
        const instance = plainToInstance(UpdateEmployeeProfileDto, dto.profile);
        const errors = validateSync(instance, {
          whitelist: true,
          forbidNonWhitelisted: true,
        });

        if (errors.length > 0) {
          const firstErr =
            errors[0].constraints && Object.values(errors[0].constraints)[0]
              ? Object.values(errors[0].constraints)[0]
              : 'Invalid employee profile update.';
          throw new BadRequestException(
            `Employee profile update failed: ${firstErr}`,
          );
        }

        if (
          dto.profile.employeeNumber &&
          dto.profile.employeeNumber !==
          targetUser.employeeProfile?.employeeNumber
        ) {
          const existingEmpNo = await this.prisma.employeeProfile.findFirst({
            where: {
              employeeNumber: dto.profile.employeeNumber,
              userId: { not: id },
            },
          });

          if (existingEmpNo) {
            throw new ConflictException(
              `Employee number '${dto.profile.employeeNumber}' is already in use by another employee.`,
            );
          }
        }

        if (dto.profile.reportingToId) {
          if (dto.profile.reportingToId === id) {
            throw new BadRequestException(
              'An employee cannot report to themselves.',
            );
          }

          const manager = await this.prisma.user.findFirst({
            where: {
              id: dto.profile.reportingToId,
              deletedAt: null,
              status: RecordStatus.ACTIVE,
            },
          });

          if (!manager) {
            throw new BadRequestException(
              'Specified reporting manager (reportingToId) does not exist or is inactive.',
            );
          }
        }
      } else if (targetUser.userType.code === 'CLIENT') {
        const instance = plainToInstance(UpdateClientProfileDto, dto.profile);
        const errors = validateSync(instance, {
          whitelist: true,
          forbidNonWhitelisted: true,
        });

        if (errors.length > 0) {
          const firstErr =
            errors[0].constraints && Object.values(errors[0].constraints)[0]
              ? Object.values(errors[0].constraints)[0]
              : 'Invalid client profile update.';
          throw new BadRequestException(
            `Client profile update failed: ${firstErr}`,
          );
        }

        if (dto.profile.logoMediaId) {
          const logo = await this.prisma.media.findFirst({
            where: {
              id: dto.profile.logoMediaId,
              status: MediaStatus.ACTIVE,
              deletedAt: null,
            },
          });

          if (!logo) {
            throw new BadRequestException(
              'Specified logoMediaId does not exist or is inactive.',
            );
          }
        }
      }
    }

    // Execute atomic update
    await this.prisma.$transaction(async (tx) => {
      const userUpdate: any = {
        updatedBy: actorUserId || null,
      };

      if (dto.name !== undefined) userUpdate.name = dto.name;
      if (dto.phone !== undefined) userUpdate.phone = dto.phone;
      if (dto.profileMediaId !== undefined)
        userUpdate.profileMediaId = dto.profileMediaId;

      await tx.user.update({
        where: { id },
        data: userUpdate,
      });

      if (dto.profile) {
        if (targetUser.userType.code === 'EMPLOYEE') {
          const empData: any = {};
          if (dto.profile.employeeNumber !== undefined)
            empData.employeeNumber = dto.profile.employeeNumber;
          if (dto.profile.designation !== undefined)
            empData.designation = dto.profile.designation;
          if (dto.profile.dateOfJoining !== undefined)
            empData.dateOfJoining = new Date(dto.profile.dateOfJoining);
          if (dto.profile.employmentType !== undefined)
            empData.employmentType = dto.profile.employmentType;
          if (dto.profile.reportingToId !== undefined)
            empData.reportingToId = dto.profile.reportingToId;
          if (dto.profile.notes !== undefined)
            empData.notes = dto.profile.notes;

          await tx.employeeProfile.upsert({
            where: { userId: id },
            update: empData,
            create: { userId: id, ...empData },
          });
        } else if (targetUser.userType.code === 'CLIENT') {
          const cliData: any = {};
          if (dto.profile.companyName !== undefined)
            cliData.companyName = dto.profile.companyName;
          if (dto.profile.website !== undefined)
            cliData.website = dto.profile.website;
          if (dto.profile.taxNumber !== undefined)
            cliData.taxNumber = dto.profile.taxNumber;
          if (dto.profile.addressLine1 !== undefined)
            cliData.addressLine1 = dto.profile.addressLine1;
          if (dto.profile.addressLine2 !== undefined)
            cliData.addressLine2 = dto.profile.addressLine2;
          if (dto.profile.city !== undefined)
            cliData.city = dto.profile.city;
          if (dto.profile.state !== undefined)
            cliData.state = dto.profile.state;
          if (dto.profile.postalCode !== undefined)
            cliData.postalCode = dto.profile.postalCode;
          if (dto.profile.country !== undefined)
            cliData.country = dto.profile.country;
          if (dto.profile.logoMediaId !== undefined)
            cliData.logoMediaId = dto.profile.logoMediaId;

          await tx.clientProfile.upsert({
            where: { userId: id },
            update: cliData,
            create: { userId: id, ...cliData },
          });
        }
      }
    });

    // Audit log
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValues: {
        name: targetUser.name,
        phone: targetUser.phone,
        profileMediaId: targetUser.profileMediaId,
        profile:
          targetUser.employeeProfile || targetUser.clientProfile || null,
      },
      newValues: {
        name: dto.name ?? targetUser.name,
        phone: dto.phone ?? targetUser.phone,
        profileMediaId: dto.profileMediaId ?? targetUser.profileMediaId,
        profile:
          dto.profile ??
          (targetUser.employeeProfile || targetUser.clientProfile || null),
      },
    });

    return this.findOne(id, actorUserId, actorUserType);
  }

  /**
   * Concurrency-safe check to prevent deleting or deactivating the last active Super Admin.
   * Acquires an exclusive row lock on the SUPER_ADMIN user type record within the active transaction
   * to serialize concurrent modification requests.
   */
  private async assertNotLastActiveSuperAdmin(
    tx: any,
    targetUserId: string,
    actionName: string,
  ): Promise<void> {
    // 1. Lock the SUPER_ADMIN user_types row to serialize concurrent checks
    await tx.userType.update({
      where: { code: 'SUPER_ADMIN' },
      data: { updatedAt: new Date() },
    });

    // 2. Count active, non-deleted Super Admins within the locked transaction
    // In MySQL InnoDB, a locking read (FOR UPDATE) is required to bypass REPEATABLE READ snapshot isolation
    // and acquire exclusive locks on all active Super Admin rows.
    let activeSuperAdminCount: number;
    if (typeof tx.$queryRawUnsafe === 'function') {
      const activeSuperAdmins = await tx.$queryRawUnsafe(
        `SELECT u.id 
         FROM users u 
         JOIN user_types ut ON u.user_type_id = ut.id 
         WHERE ut.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL 
         FOR UPDATE`,
      );
      activeSuperAdminCount = Array.isArray(activeSuperAdmins)
        ? activeSuperAdmins.length
        : 0;
    } else {
      activeSuperAdminCount = await tx.user.count({
        where: {
          userType: { code: 'SUPER_ADMIN' },
          status: RecordStatus.ACTIVE,
          deletedAt: null,
        },
      });
    }

    if (activeSuperAdminCount <= 1) {
      throw new BadRequestException(
        `Cannot ${actionName} the last active Super Admin account. System must retain at least one operational Super Administrator.`,
      );
    }
  }

  /**
   * Updates a user's operational status (ACTIVE / INACTIVE).
   * Automatically revokes all active sessions and refresh tokens upon deactivation.
   */
  async updateStatus(
    id: string,
    dto: UpdateUserStatusDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to change Super Admin account status.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException(
        'Only administrators can change user status.',
      );
    }

    if (actorUserId === targetUser.id && dto.status === RecordStatus.INACTIVE) {
      throw new BadRequestException('Self-deactivation is not permitted.');
    }

    if (targetUser.status === dto.status) {
      throw new BadRequestException(`User account is already ${dto.status}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      // If deactivating a Super Admin, enforce concurrency-safe protection
      if (
        targetUser.userType.code === 'SUPER_ADMIN' &&
        dto.status === RecordStatus.INACTIVE
      ) {
        await this.assertNotLastActiveSuperAdmin(
          tx,
          targetUser.id,
          'deactivate',
        );
      }

      // Update user status
      await tx.user.update({
        where: { id },
        data: {
          status: dto.status,
          updatedBy: actorUserId || null,
        },
      });

      // If deactivating, immediately revoke all active sessions
      if (dto.status === RecordStatus.INACTIVE) {
        await tx.userSession.updateMany({
          where: {
            userId: targetUser.id,
            status: SessionStatus.ACTIVE,
          },
          data: {
            status: SessionStatus.REVOKED,
            revokedAt: new Date(),
          },
        });
      }
    });

    // Audit logging
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValues: { status: targetUser.status },
      newValues: { status: dto.status, reason: dto.reason || null },
    });

    await this.auditService.logActivity({
      actorUserId,
      action:
        dto.status === RecordStatus.ACTIVE
          ? 'USER_ACTIVATED'
          : 'USER_DEACTIVATED',
      module: 'users',
      entityType: 'User',
      entityId: id,
      description: `User '${targetUser.name}' (${targetUser.userCode}) status changed to ${dto.status}.${dto.reason ? ` Reason: ${dto.reason}` : ''}`,
    });

    return this.findOne(id, actorUserId, actorUserType);
  }

  /**
   * Soft-deletes a user account.
   * Excludes the record from normal queries and immediately revokes all active sessions.
   */
  async remove(id: string, actorUserId?: string, actorUserType?: string) {
    const targetUser = await this.prisma.user.findUnique({
      where: { id },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    if (targetUser.deletedAt !== null) {
      throw new BadRequestException('User account is already deleted.');
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to delete Super Admin accounts.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException(
        'Only administrators can delete user accounts.',
      );
    }

    if (actorUserId === targetUser.id) {
      throw new BadRequestException('Self-deletion is not permitted.');
    }

    await this.prisma.$transaction(async (tx) => {
      // If deleting a Super Admin, enforce concurrency-safe protection
      if (targetUser.userType.code === 'SUPER_ADMIN') {
        await this.assertNotLastActiveSuperAdmin(tx, targetUser.id, 'delete');
      }

      // Soft delete user record and deactivate
      await tx.user.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          deletedBy: actorUserId || null,
          status: RecordStatus.INACTIVE,
        },
      });

      // Revoke all active sessions
      await tx.userSession.updateMany({
        where: {
          userId: targetUser.id,
          status: SessionStatus.ACTIVE,
        },
        data: {
          status: SessionStatus.REVOKED,
          revokedAt: new Date(),
        },
      });
    });

    // Audit log
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValues: {
        status: targetUser.status,
        deletedAt: null,
      },
      newValues: {
        status: RecordStatus.INACTIVE,
        deletedAt: new Date(),
        deletedBy: actorUserId || null,
      },
    });

    await this.auditService.logActivity({
      actorUserId,
      action: 'USER_DELETED',
      module: 'users',
      entityType: 'User',
      entityId: id,
      description: `User '${targetUser.name}' (${targetUser.userCode}) was soft-deleted.`,
    });

    return {
      message: 'User deleted successfully.',
    };
  }

  /**
   * Restores a previously soft-deleted user account.
   * Verifies email, phone, and employee number uniqueness before restoring.
   */
  async restore(id: string, actorUserId?: string, actorUserType?: string) {
    const targetUser = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userType: true,
        employeeProfile: true,
        clientProfile: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    if (targetUser.deletedAt === null) {
      throw new BadRequestException('User account is not deleted.');
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to restore Super Admin accounts.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException(
        'Only administrators can restore user accounts.',
      );
    }

    // Verify email uniqueness against other active non-deleted users
    const existingEmail = await this.prisma.user.findFirst({
      where: {
        email: targetUser.email,
        deletedAt: null,
        id: { not: id },
      },
    });

    if (existingEmail) {
      throw new ConflictException(
        `Cannot restore user: email '${targetUser.email}' is currently in use by an active account.`,
      );
    }

    // Verify phone uniqueness (if phone is set)
    if (targetUser.phone) {
      const existingPhone = await this.prisma.user.findFirst({
        where: {
          phone: targetUser.phone,
          deletedAt: null,
          id: { not: id },
        },
      });

      if (existingPhone) {
        throw new ConflictException(
          `Cannot restore user: phone number '${targetUser.phone}' is currently in use by an active account.`,
        );
      }
    }

    // Verify employee number uniqueness (if employee)
    if (targetUser.employeeProfile?.employeeNumber) {
      const existingEmpNum = await this.prisma.employeeProfile.findFirst({
        where: {
          employeeNumber: targetUser.employeeProfile.employeeNumber,
          userId: { not: id },
          user: { deletedAt: null },
        },
      });

      if (existingEmpNum) {
        throw new ConflictException(
          `Cannot restore user: employee number '${targetUser.employeeProfile.employeeNumber}' is currently in use by an active employee.`,
        );
      }
    }

    // Restore user atomically
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          deletedAt: null,
          deletedBy: null,
          updatedBy: actorUserId || null,
          status: RecordStatus.ACTIVE,
        },
      });
    });

    // Audit log
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.RESTORE,
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValues: {
        deletedAt: targetUser.deletedAt,
        deletedBy: targetUser.deletedBy,
        status: targetUser.status,
      },
      newValues: {
        deletedAt: null,
        deletedBy: null,
        status: RecordStatus.ACTIVE,
      },
    });

    await this.auditService.logActivity({
      actorUserId,
      action: 'USER_RESTORED',
      module: 'users',
      entityType: 'User',
      entityId: id,
      description: `User '${targetUser.name}' (${targetUser.userCode}) was restored.`,
    });

    return this.findOne(id, actorUserId, actorUserType);
  }

  /**
   * Replaces all role assignments for a user.
   * Atomically validates existence, delegation authority, and Super Admin restrictions.
   */
  async replaceRoles(
    userId: string,
    dto: AssignUserRolesDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin roles.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException('Only administrators can assign roles.');
    }

    if (actorUserId === targetUser.id && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Users cannot modify their own roles.');
    }

    // Resolve roles
    const roles = await this.prisma.role.findMany({
      where: {
        OR: [{ id: { in: dto.roles } }, { code: { in: dto.roles } }],
        status: RecordStatus.ACTIVE,
        deletedAt: null,
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (roles.length !== dto.roles.length) {
      throw new BadRequestException(
        'One or more specified roles are invalid, inactive, or do not exist.',
      );
    }

    if (roles.some((r) => r.code === 'SUPER_ADMIN')) {
      throw new ForbiddenException(
        'Assignment of the Super Admin role is strictly restricted.',
      );
    }

    // Delegation authority check
    if (actorUserType !== 'SUPER_ADMIN' && actorUserId) {
      const actorPermissions =
        await this.rolesService.getActorEffectivePermissions(actorUserId);
      const unauthorizedPermissions: string[] = [];

      for (const role of roles) {
        for (const rp of role.permissions) {
          if (
            rp.permission.status === RecordStatus.ACTIVE &&
            !actorPermissions.has(rp.permission.code)
          ) {
            unauthorizedPermissions.push(rp.permission.code);
          }
        }
      }

      if (unauthorizedPermissions.length > 0) {
        throw new ForbiddenException(
          `Cannot assign roles containing permissions you do not possess: [${[...new Set(unauthorizedPermissions)].join(', ')}]`,
        );
      }
    }

    const previousRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { select: { code: true } } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({
        where: { userId },
      });

      for (const role of roles) {
        await tx.userRole.create({
          data: {
            userId,
            roleId: role.id,
            assignedBy: actorUserId || null,
          },
        });
      }
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.ROLE_ASSIGNMENT,
      module: 'users',
      entityType: 'UserRole',
      entityId: userId,
      oldValues: { roles: previousRoles.map((pr) => pr.role.code) },
      newValues: { roles: roles.map((r) => r.code) },
    });

    return {
      userId,
      roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
    };
  }

  /**
   * Adds one or more roles to a user without removing existing assignments.
   */
  async addRoles(
    userId: string,
    dto: AssignUserRolesDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin roles.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException('Only administrators can assign roles.');
    }

    if (actorUserId === targetUser.id && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Users cannot modify their own roles.');
    }

    const roles = await this.prisma.role.findMany({
      where: {
        OR: [{ id: { in: dto.roles } }, { code: { in: dto.roles } }],
        status: RecordStatus.ACTIVE,
        deletedAt: null,
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (roles.length !== dto.roles.length) {
      throw new BadRequestException(
        'One or more specified roles are invalid, inactive, or do not exist.',
      );
    }

    if (roles.some((r) => r.code === 'SUPER_ADMIN')) {
      throw new ForbiddenException(
        'Assignment of the Super Admin role is strictly restricted.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserId) {
      const actorPermissions =
        await this.rolesService.getActorEffectivePermissions(actorUserId);
      const unauthorizedPermissions: string[] = [];

      for (const role of roles) {
        for (const rp of role.permissions) {
          if (
            rp.permission.status === RecordStatus.ACTIVE &&
            !actorPermissions.has(rp.permission.code)
          ) {
            unauthorizedPermissions.push(rp.permission.code);
          }
        }
      }

      if (unauthorizedPermissions.length > 0) {
        throw new ForbiddenException(
          `Cannot assign roles containing permissions you do not possess: [${[...new Set(unauthorizedPermissions)].join(', ')}]`,
        );
      }
    }

    const existingAssignments = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });
    const existingRoleIds = new Set(existingAssignments.map((a) => a.roleId));

    await this.prisma.$transaction(async (tx) => {
      for (const role of roles) {
        if (!existingRoleIds.has(role.id)) {
          await tx.userRole.create({
            data: {
              userId,
              roleId: role.id,
              assignedBy: actorUserId || null,
            },
          });
        }
      }
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.ROLE_ASSIGNMENT,
      module: 'users',
      entityType: 'UserRole',
      entityId: userId,
      newValues: { addedRoles: roles.map((r) => r.code) },
    });

    const updatedUserRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { select: { id: true, code: true, name: true } } },
    });

    return {
      userId,
      roles: updatedUserRoles.map((ur) => ur.role),
    };
  }

  /**
   * Removes a specific role assignment from a user.
   */
  async removeRole(
    userId: string,
    roleIdentifier: string,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin roles.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException('Only administrators can remove roles.');
    }

    if (actorUserId === targetUser.id && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Users cannot modify their own roles.');
    }

    const role = await this.prisma.role.findFirst({
      where: {
        OR: [{ id: roleIdentifier }, { code: roleIdentifier }],
        deletedAt: null,
      },
    });

    if (!role) {
      throw new NotFoundException(`Role '${roleIdentifier}' not found.`);
    }

    const assignment = await this.prisma.userRole.findUnique({
      where: {
        userId_roleId: {
          userId,
          roleId: role.id,
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException(
        `Role '${role.name}' is not currently assigned to this user.`,
      );
    }

    await this.prisma.userRole.delete({
      where: {
        userId_roleId: {
          userId,
          roleId: role.id,
        },
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.ROLE_ASSIGNMENT,
      module: 'users',
      entityType: 'UserRole',
      entityId: userId,
      oldValues: { removedRole: role.code },
    });

    return {
      message: `Role '${role.name}' removed from user successfully.`,
    };
  }

  /**
   * Atomically replaces department assignments for a user.
   * Enforces that exactly one department must be primary when departments are provided.
   */
  async replaceDepartments(
    userId: string,
    dto: AssignUserDepartmentsDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin departments.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException(
        'Only administrators can assign departments.',
      );
    }

    let resolvedDepartments: Array<{
      id: string;
      code: string;
      name: string;
      isPrimary: boolean;
    }> = [];

    if (dto.departments && dto.departments.length > 0) {
      const primaryCount = dto.departments.filter((d) => d.isPrimary).length;
      if (primaryCount !== 1) {
        throw new BadRequestException(
          'Exactly one department must be designated as primary (isPrimary: true).',
        );
      }

      const codes = dto.departments.map((d) => d.code);
      const departments = await this.prisma.department.findMany({
        where: {
          OR: [{ id: { in: codes } }, { code: { in: codes } }],
          status: RecordStatus.ACTIVE,
          deletedAt: null,
        },
      });

      if (departments.length !== dto.departments.length) {
        throw new BadRequestException(
          'One or more specified departments are invalid, inactive, or do not exist.',
        );
      }

      resolvedDepartments = dto.departments.map((item) => {
        const match = departments.find(
          (d) =>
            d.id === item.code ||
            d.code.toLowerCase() === item.code.toLowerCase(),
        )!;
        return {
          id: match.id,
          code: match.code,
          name: match.name,
          isPrimary: !!item.isPrimary,
        };
      });
    }

    const previousAssignments = await this.prisma.userDepartment.findMany({
      where: { userId },
      include: { department: { select: { code: true } } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.userDepartment.deleteMany({
        where: { userId },
      });

      for (const item of resolvedDepartments) {
        await tx.userDepartment.create({
          data: {
            userId,
            departmentId: item.id,
            isPrimary: item.isPrimary,
            assignedBy: actorUserId || null,
          },
        });
      }
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'users',
      entityType: 'UserDepartment',
      entityId: userId,
      oldValues: {
        departments: previousAssignments.map((pa) => ({
          code: pa.department.code,
          isPrimary: pa.isPrimary,
        })),
      },
      newValues: {
        departments: resolvedDepartments.map((rd) => ({
          code: rd.code,
          isPrimary: rd.isPrimary,
        })),
      },
    });

    return {
      userId,
      departments: resolvedDepartments,
    };
  }

  /**
   * Atomically replaces individual permission overrides (ALLOW / DENY) for a user.
   * Enforces delegation authority for ALLOW grants.
   */
  async replacePermissions(
    userId: string,
    dto: AssignUserPermissionsDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { userType: true },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Admins are not permitted to modify Super Admin permissions.',
      );
    }

    if (actorUserId === userId && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Users cannot modify their own permissions.',
      );
    }

    if (actorUserType !== 'SUPER_ADMIN' && actorUserType !== 'ADMIN') {
      throw new ForbiddenException(
        'Only administrators can manage permission overrides.',
      );
    }

    let resolvedOverrides: Array<{
      permissionId: string;
      code: string;
      effect: PermissionEffect;
      dataScope: DataScope | null;
      reason: string | null;
    }> = [];

    if (dto.permissions && dto.permissions.length > 0) {
      const codes = dto.permissions.map((p) => p.code);
      const permissions = await this.prisma.permission.findMany({
        where: {
          OR: [{ id: { in: codes } }, { code: { in: codes } }],
          status: RecordStatus.ACTIVE,
        },
      });

      if (permissions.length !== dto.permissions.length) {
        throw new BadRequestException(
          'One or more specified permissions are invalid, inactive, or do not exist.',
        );
      }

      // Delegation check for ALLOW
      if (actorUserType !== 'SUPER_ADMIN' && actorUserId) {
        const actorPermissions =
          await this.rolesService.getActorEffectivePermissions(actorUserId);
        const unauthorized: string[] = [];

        for (const item of dto.permissions) {
          if (item.effect === PermissionEffect.ALLOW) {
            const perm = permissions.find(
              (p) =>
                p.id === item.code ||
                p.code.toLowerCase() === item.code.toLowerCase(),
            )!;
            if (!actorPermissions.has(perm.code)) {
              unauthorized.push(perm.code);
            }
          }
        }

        if (unauthorized.length > 0) {
          throw new ForbiddenException(
            `Cannot grant permissions you do not possess: [${[...new Set(unauthorized)].join(', ')}]`,
          );
        }
      }

      resolvedOverrides = dto.permissions.map((item) => {
        const perm = permissions.find(
          (p) =>
            p.id === item.code ||
            p.code.toLowerCase() === item.code.toLowerCase(),
        )!;
        return {
          permissionId: perm.id,
          code: perm.code,
          effect: item.effect,
          dataScope:
            item.effect === PermissionEffect.ALLOW
              ? item.dataScope || DataScope.ALL
              : null,
          reason: item.reason || null,
        };
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userPermission.deleteMany({
        where: { userId },
      });

      for (const item of resolvedOverrides) {
        await tx.userPermission.create({
          data: {
            userId,
            permissionId: item.permissionId,
            effect: item.effect,
            dataScope: item.dataScope,
            reason: item.reason,
            assignedBy: actorUserId || null,
          },
        });
      }
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.PERMISSION_CHANGE,
      module: 'users',
      entityType: 'UserPermission',
      entityId: userId,
      newValues: {
        overrides: resolvedOverrides.map((ro) => ({
          code: ro.code,
          effect: ro.effect,
          dataScope: ro.dataScope,
          reason: ro.reason,
        })),
      },
    });

    return {
      userId,
      permissions: resolvedOverrides,
    };
  }

  /**
   * Retrieves effective permissions for a user, resolving role grants and direct
   * ALLOW / DENY overrides using the documented 5-tier precedence model.
   */
  async getEffectivePermissions(
    userId: string,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const scopeWhere = await this.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'users.view',
    );

    const targetUser = await this.prisma.user.findFirst({
      where: {
        id: userId,
        AND: [scopeWhere],
      },
      include: {
        userType: true,
        userRoles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
        userPermissions: {
          include: { permission: true },
        },
      },
    });

    if (!targetUser) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    if (
      actorUserType === 'ADMIN' &&
      targetUser.userType.code === 'SUPER_ADMIN'
    ) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    // 1. System level restrictions: Inactive or deleted users receive 0 permissions
    if (
      targetUser.status !== RecordStatus.ACTIVE ||
      targetUser.deletedAt !== null
    ) {
      return {
        userId: targetUser.id,
        userCode: targetUser.userCode,
        roles: [],
        permissions: [],
      };
    }

    // If Super Admin account: granted ALL active permissions at system level
    if (targetUser.userType.code === 'SUPER_ADMIN') {
      const allActivePerms = await this.prisma.permission.findMany({
        where: { status: RecordStatus.ACTIVE },
      });
      return {
        userId: targetUser.id,
        userCode: targetUser.userCode,
        roles: ['SUPER_ADMIN'],
        permissions: allActivePerms.map((p) => ({
          code: p.code,
          name: p.name,
          module: p.module,
          action: p.action,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.ALL,
          source: 'SYSTEM',
        })),
      };
    }

    const rank: Record<DataScope, number> = {
      OWN: 0,
      ASSIGNED: 1,
      DEPARTMENT: 2,
      ALL: 3,
    };

    const effectiveMap = new Map<
      string,
      {
        code: string;
        name: string;
        module: string;
        action: string;
        effect: PermissionEffect;
        dataScope: DataScope | null;
        source: 'ROLE' | 'USER_OVERRIDE';
        reason?: string | null;
      }
    >();

    // 2. Direct user overrides take highest precedence (DENY overrides role ALLOW)
    for (const dp of targetUser.userPermissions) {
      if (dp.permission.status === RecordStatus.ACTIVE) {
        effectiveMap.set(dp.permission.code, {
          code: dp.permission.code,
          name: dp.permission.name,
          module: dp.permission.module,
          action: dp.permission.action,
          effect: dp.effect,
          dataScope:
            dp.effect === PermissionEffect.ALLOW
              ? dp.dataScope || DataScope.ALL
              : null,
          source: 'USER_OVERRIDE',
          reason: dp.reason,
        });
      }
    }

    // 3. Role-based permissions (only if not overridden directly by user)
    const activeRoles = targetUser.userRoles.filter(
      (ur) => ur.role.status === RecordStatus.ACTIVE && !ur.role.deletedAt,
    );

    for (const ur of activeRoles) {
      for (const rp of ur.role.permissions) {
        if (rp.permission.status === RecordStatus.ACTIVE) {
          const permCode = rp.permission.code;

          // If already defined by direct user override, user override wins!
          if (
            effectiveMap.has(permCode) &&
            effectiveMap.get(permCode)!.source === 'USER_OVERRIDE'
          ) {
            continue;
          }

          if (!effectiveMap.has(permCode)) {
            effectiveMap.set(permCode, {
              code: rp.permission.code,
              name: rp.permission.name,
              module: rp.permission.module,
              action: rp.permission.action,
              effect: PermissionEffect.ALLOW,
              dataScope: rp.dataScope,
              source: 'ROLE',
            });
          } else {
            const existing = effectiveMap.get(permCode)!;
            if (
              existing.dataScope &&
              rank[rp.dataScope] > rank[existing.dataScope]
            ) {
              existing.dataScope = rp.dataScope;
            }
          }
        }
      }
    }

    return {
      userId: targetUser.id,
      userCode: targetUser.userCode,
      roles: activeRoles.map((ur) => ur.role.code),
      permissions: Array.from(effectiveMap.values()),
    };
  }

  /**
   * Helper to retrieve complete populated user details after creation.
   */
  private async findCreatedUserDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userType: {
          select: { id: true, code: true, name: true },
        },
        employeeProfile: true,
        clientProfile: true,
        userRoles: {
          include: {
            role: {
              select: { id: true, code: true, name: true },
            },
          },
        },
        departments: {
          include: {
            department: {
              select: { id: true, code: true, name: true },
            },
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      userCode: user.userCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      userType: user.userType,
      roles: user.userRoles.map((ur) => ur.role),
      departments: user.departments.map((ud) => ({
        ...ud.department,
        isPrimary: ud.isPrimary,
      })),
      profile:
        user.userType.code === 'EMPLOYEE'
          ? user.employeeProfile
          : user.userType.code === 'CLIENT'
            ? user.clientProfile
            : null,
      createdAt: user.createdAt,
    };
  }
}
