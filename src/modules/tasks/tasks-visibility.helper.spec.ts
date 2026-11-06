import { buildTaskVisibilityWhere, TaskActorContext } from './tasks-visibility.helper';
import { DataScope } from '../../generated/prisma/enums';

describe('TasksVisibilityHelper - buildTaskVisibilityWhere', () => {
  describe('Default Deny & Client Boundary', () => {
    it('should return default deny when actor context is null or invalid', () => {
      const where = buildTaskVisibilityWhere(null as any);
      expect(where).toEqual({ id: 'FORBIDDEN_INVALID_CONTEXT' });
    });

    it('should deny client users from accessing internal tasks', () => {
      const clientActor: TaskActorContext = {
        userId: 'client_user_1',
        userType: 'CLIENT',
        departmentIds: [],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.OWN,
      };

      const where = buildTaskVisibilityWhere(clientActor);
      expect(where).toEqual({ id: 'FORBIDDEN_CLIENT_TASK_ACCESS_NOT_SUPPORTED' });
    });

    it('should deny unknown user types', () => {
      const unknownActor: TaskActorContext = {
        userId: 'unknown_1',
        userType: 'CONTRACTOR',
        departmentIds: [],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.ALL,
      };

      const where = buildTaskVisibilityWhere(unknownActor);
      expect(where).toEqual({ id: 'FORBIDDEN_UNKNOWN_USER_TYPE' });
    });
  });

  describe('SUPER_ADMIN Visibility', () => {
    it('should return unrestricted filter under ALL scope', () => {
      const saActor: TaskActorContext = {
        userId: 'sa_1',
        userType: 'SUPER_ADMIN',
        departmentIds: ['dept_1'],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.ALL,
      };

      const where = buildTaskVisibilityWhere(saActor);
      expect(where).toEqual({ deletedAt: null });
    });

    it('should filter by department under DEPARTMENT scope', () => {
      const saActor: TaskActorContext = {
        userId: 'sa_1',
        userType: 'SUPER_ADMIN',
        departmentIds: ['dept_1', 'dept_2'],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.DEPARTMENT,
      };

      const where = buildTaskVisibilityWhere(saActor);
      expect(where).toEqual({
        deletedAt: null,
        departmentId: { in: ['dept_1', 'dept_2'] },
      });
    });

    it('should return forbidden if DEPARTMENT scope has no departments', () => {
      const saActor: TaskActorContext = {
        userId: 'sa_1',
        userType: 'SUPER_ADMIN',
        departmentIds: [],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.DEPARTMENT,
      };

      const where = buildTaskVisibilityWhere(saActor);
      expect(where).toEqual({ id: 'FORBIDDEN_NO_DEPARTMENTS' });
    });

    it('should filter by own assigned or unassigned drafts under OWN scope', () => {
      const saActor: TaskActorContext = {
        userId: 'sa_1',
        userType: 'SUPER_ADMIN',
        departmentIds: [],
        subordinateUserIds: [],
        effectiveDataScope: DataScope.OWN,
      };

      const where = buildTaskVisibilityWhere(saActor);
      expect(where).toEqual({
        deletedAt: null,
        OR: [
          { assigneeId: 'sa_1' },
          { createdById: 'sa_1', assigneeId: null },
        ],
      });
    });
  });

  describe('ADMIN Visibility & Ceiling Enforcement', () => {
    const adminActor: TaskActorContext = {
      userId: 'admin_1',
      userType: 'ADMIN',
      departmentIds: ['dept_eng'],
      subordinateUserIds: ['emp_sub_1', 'emp_sub_2'],
      effectiveDataScope: DataScope.DEPARTMENT,
    };

    it('should enforce Admin ceiling: assignee must be EMPLOYEE or ADMIN, or unassigned', () => {
      const where = buildTaskVisibilityWhere(adminActor) as any;
      expect(where.AND).toBeDefined();

      const ceiling = where.AND[1];
      expect(ceiling).toEqual({
        OR: [
          {
            assignee: {
              userType: {
                code: { in: ['EMPLOYEE', 'ADMIN'] },
              },
            },
          },
          {
            assigneeId: null,
          },
        ],
      });
    });

    it('should filter strictly by department under DEPARTMENT scope without self bypass', () => {
      const where = buildTaskVisibilityWhere(adminActor) as any;
      const deptFilter = where.AND[2];

      expect(deptFilter).toEqual({
        departmentId: { in: ['dept_eng'] },
      });
      // Verify no assigneeId bypass in department filter
      expect(deptFilter.OR).toBeUndefined();
    });

    it('should support ALL scope under Admin ceiling', () => {
      const actorAll: TaskActorContext = {
        ...adminActor,
        effectiveDataScope: DataScope.ALL,
      };

      const where = buildTaskVisibilityWhere(actorAll) as any;
      expect(where.AND[0]).toEqual({ deletedAt: null });
      expect(where.AND[1].OR).toBeDefined(); // ceiling
      expect(where.AND[2]).toEqual({}); // all scope
    });

    it('should support ASSIGNED scope under Admin ceiling', () => {
      const actorAssigned: TaskActorContext = {
        ...adminActor,
        effectiveDataScope: DataScope.ASSIGNED,
      };

      const where = buildTaskVisibilityWhere(actorAssigned) as any;
      expect(where.AND[2]).toEqual({
        OR: [
          { assigneeId: 'admin_1' },
          { assigneeId: { in: ['emp_sub_1', 'emp_sub_2'] } },
          { createdById: 'admin_1', assigneeId: null },
        ],
      });
    });

    it('should support OWN scope under Admin ceiling', () => {
      const actorOwn: TaskActorContext = {
        ...adminActor,
        effectiveDataScope: DataScope.OWN,
      };

      const where = buildTaskVisibilityWhere(actorOwn) as any;
      expect(where.AND[2]).toEqual({
        OR: [
          { assigneeId: 'admin_1' },
          { createdById: 'admin_1', assigneeId: null },
        ],
      });
    });
  });

  describe('EMPLOYEE Visibility & Ceiling Enforcement', () => {
    const employeeActor: TaskActorContext = {
      userId: 'emp_1',
      userType: 'EMPLOYEE',
      departmentIds: ['dept_sales'],
      subordinateUserIds: [],
      effectiveDataScope: DataScope.OWN,
    };

    it('should enforce Employee ceiling: assignee must be EMPLOYEE or unassigned', () => {
      const where = buildTaskVisibilityWhere(employeeActor) as any;
      const ceiling = where.AND[1];

      expect(ceiling).toEqual({
        OR: [
          {
            assignee: {
              userType: {
                code: 'EMPLOYEE',
              },
            },
          },
          {
            assigneeId: null,
          },
        ],
      });
    });

    it('should filter strictly by own assigned and unassigned drafts under OWN scope', () => {
      const where = buildTaskVisibilityWhere(employeeActor) as any;
      const ownFilter = where.AND[2];

      expect(ownFilter).toEqual({
        OR: [
          { assigneeId: 'emp_1' },
          { createdById: 'emp_1', assigneeId: null },
        ],
      });
    });

    it('should enforce strict department boundary under DEPARTMENT scope for elevated employee', () => {
      const elevatedActor: TaskActorContext = {
        ...employeeActor,
        effectiveDataScope: DataScope.DEPARTMENT,
      };

      const where = buildTaskVisibilityWhere(elevatedActor) as any;
      const deptFilter = where.AND[2];

      expect(deptFilter).toEqual({
        departmentId: { in: ['dept_sales'] },
      });
    });
  });
});

