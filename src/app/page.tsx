import { redirect } from "next/navigation";

/** "/" has no content of its own: the dashboard page authenticates and authorizes. */
export default function Home() {
  redirect("/dashboard");
}
