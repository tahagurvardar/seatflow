import type { PrismaClient } from "../../src/generated/prisma/client";

export async function resetIntegrationDatabase(database: PrismaClient) {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Verification",
      "Session",
      "Account",
      "Membership",
      "Seat",
      "SeatRow",
      "SeatSection",
      "SeatMap",
      "Space",
      "Venue",
      "Organization",
      "User"
    RESTART IDENTITY CASCADE
  `);
}
