import { NextResponse } from "next/server";
import { z } from "zod";
import { DatabaseUnavailableError } from "@/lib/db/client";
import { runAgent } from "@/lib/agent/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The only way into the agent from the browser.
 *
 * Input is validated before it reaches the runtime — the request body is
 * untrusted, and everything downstream (SQL, tool arguments, the model prompt)
 * assumes it has been checked here.
 */

const bodySchema = z.object({
  userId: z.string().uuid("userId must be a UUID"),
  message: z
    .string()
    .trim()
    .min(3, "Say a little more about what you need.")
    .max(4000, "Message is too long — keep it under 4000 characters."),
  requestId: z.string().uuid().nullish(),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid request.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const result = await runAgent({
      userId: parsed.data.userId,
      message: parsed.data.message,
      requestId: parsed.data.requestId ?? null,
      channel: "web",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/agent] run failed:", message);
    return NextResponse.json(
      {
        error:
          "The agent could not complete this request. The failure is recorded " +
          `in the audit log. Detail: ${message}`,
      },
      { status: 500 },
    );
  }
}
