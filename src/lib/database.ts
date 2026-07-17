import { PrismaPg } from "@prisma/adapter-pg";

import { readRuntimeDatabaseUrl } from "@/env/schema";
import { PrismaClient } from "@/generated/prisma/client";

const globalDatabase = globalThis as typeof globalThis & {
  seatflowDatabase?: PrismaClient;
};

export function createDatabaseClient(databaseUrl = readRuntimeDatabaseUrl()) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

export function getDatabase() {
  if (!globalDatabase.seatflowDatabase) {
    globalDatabase.seatflowDatabase = createDatabaseClient();
  }

  return globalDatabase.seatflowDatabase;
}

export async function disconnectDatabase() {
  if (globalDatabase.seatflowDatabase) {
    await globalDatabase.seatflowDatabase.$disconnect();
    globalDatabase.seatflowDatabase = undefined;
  }
}
