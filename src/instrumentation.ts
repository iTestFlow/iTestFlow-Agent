export const runtime = "nodejs";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await import("./instrumentation-node");
}
