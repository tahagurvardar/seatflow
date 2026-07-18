import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { getNotificationDeliveryHealth } from "../src/server/notifications/dispatcher-service";
import { getTicketIssuanceBacklog } from "../src/server/tickets/issuance-service";

try {
  const database = getDatabase();
  const [issuance, notifications, ticketsByStatus, scanOutcomes] = await Promise.all([
    getTicketIssuanceBacklog(database),
    getNotificationDeliveryHealth(database),
    database.ticket.groupBy({ by: ["status"], _count: { _all: true }, orderBy: { status: "asc" } }),
    database.ticketRedemptionEvent.groupBy({ by: ["outcome"], _count: { _all: true }, orderBy: { outcome: "asc" } }),
  ]);
  console.info(JSON.stringify({
    issuance,
    notifications,
    ticketsByStatus: ticketsByStatus.map((entry) => ({ status: entry.status, count: entry._count._all })),
    scanOutcomes: scanOutcomes.map((entry) => ({ outcome: entry.outcome, count: entry._count._all })),
  }, null, 2));
} finally {
  await disconnectDatabase();
}
