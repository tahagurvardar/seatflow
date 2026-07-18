import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import {
  getPaymentOperationsHealth,
  listPaidUnfulfilledOrders,
  listStalePendingCheckoutOrders,
} from "../src/server/payments/operations-service";

try {
  const database = getDatabase();
  const [health, paidUnfulfilled, stale] = await Promise.all([
    getPaymentOperationsHealth(database),
    listPaidUnfulfilledOrders(database),
    listStalePendingCheckoutOrders(database),
  ]);
  console.info(JSON.stringify({ health, paidUnfulfilled, stale }, null, 2));
} finally {
  await disconnectDatabase();
}

