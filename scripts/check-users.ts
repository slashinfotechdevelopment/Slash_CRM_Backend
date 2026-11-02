import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'slash_infotech_crm',
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const users = await prisma.user.findMany({
    include: {
      userType: true,
      userRoles: {
        include: { role: true },
      },
    },
  });

  console.log('Current users count:', users.length);
  for (const u of users) {
    console.log(`- ${u.userCode} | ${u.email} | Type: ${u.userType.code} | Status: ${u.status} | Verified: ${u.emailVerifiedAt ? 'YES' : 'NO'}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

