"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, signOut } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";

/** Ends the current session (revokes it server-side and clears the cookie) and goes to /login. */
export async function signOutAction(): Promise<void> {
  try {
    await signOut();
  } catch (error) {
    // Never trap the user in a session: drop the cookie even if server-side revocation failed.
    logger.error("action_failed", { action: "signOut", error });
    (await cookies()).delete(SESSION_COOKIE);
  }
  redirect("/login");
}
