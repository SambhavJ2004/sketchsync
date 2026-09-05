// Re-export Prisma's generated model types & enums (User, Room, Role, Prisma, ...),
// the shared PrismaClient singleton, and the shared authz helpers so consumers
// import everything DB-related from `@sketchsync/db`.
export * from "@prisma/client";
export * from "./client.js";
export * from "./authz.js";
