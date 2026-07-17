import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth/minimal";

import type { ApplicationEnvironment } from "@/env/schema";
import type { PrismaClient } from "@/generated/prisma/client";

export function createSeatFlowAuth(
  environment: ApplicationEnvironment,
  database: PrismaClient,
) {
  return betterAuth({
    appName: "SeatFlow",
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [environment.BETTER_AUTH_URL],
    database: prismaAdapter(database, {
      provider: "postgresql",
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        platformRole: {
          type: ["USER", "ADMIN"],
          required: false,
          defaultValue: "USER",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: "seatflow",
      useSecureCookies: process.env.NODE_ENV === "production",
    },
  });
}
