import "dotenv/config";

import { z } from "zod";

import { disconnectDatabase, getDatabase } from "../src/lib/database";

const emailArgumentIndex = process.argv.indexOf("--email");
const emailArgument =
  emailArgumentIndex >= 0 ? process.argv[emailArgumentIndex + 1] : undefined;
const confirmed = process.argv.includes("--confirm");
const emailResult = z.email().safeParse(emailArgument?.trim().toLowerCase());

if (!emailResult.success || !confirmed) {
  console.error(
    "Usage: npm run admin:promote -- --email existing-user@example.com --confirm",
  );
  console.error(
    "This command only promotes an already registered account and requires explicit confirmation.",
  );
  process.exit(1);
}

const database = getDatabase();

try {
  const user = await database.user.findUnique({
    where: { email: emailResult.data },
    select: { id: true, email: true, platformRole: true },
  });

  if (!user) {
    console.error("No registered SeatFlow account exists for that email address.");
    process.exitCode = 1;
  } else if (user.platformRole === "ADMIN") {
    console.log(`${user.email} is already a platform administrator.`);
  } else {
    await database.user.update({
      where: { id: user.id },
      data: { platformRole: "ADMIN" },
    });
    console.log(`Promoted ${user.email} to platform administrator.`);
  }
} finally {
  await disconnectDatabase();
}
