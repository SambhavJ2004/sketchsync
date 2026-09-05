import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot-reloads in dev (avoids exhausting the
// connection pool when modules are re-evaluated).
const globalForPrisma = globalThis as unknown as {
  prismaClient: PrismaClient | undefined;
};

export const prismaClient: PrismaClient =
  globalForPrisma.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaClient = prismaClient;
}
