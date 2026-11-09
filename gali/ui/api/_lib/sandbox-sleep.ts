import type { User } from "./db/schema.js";
import { sandboxProvider } from "./sandbox-provider/index.js";
import { forgetCached } from "./sandbox-resolve.js";
import { markAsleep } from "./users.js";

/**
 * Puts a user's sandbox to sleep: compute is released and the home keeps the
 * disk. Safe to call on a user who is already asleep.
 */
export async function sleepUser(user: User): Promise<void> {
  if (user.sandboxHome) {
    await sandboxProvider(user.sandboxProvider).sleep(user.sandboxHome, user.sandboxId);
  }
  await markAsleep(user.id);
  forgetCached(user.id);
}
