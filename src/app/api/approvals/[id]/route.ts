import { NextResponse } from "next/server";
import { z } from "zod";
import { DatabaseUnavailableError } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { resolveApproval } from "@/lib/db/repositories/decisions";
import { getUserById } from "@/lib/db/repositories/organization";
import {
  addRequestEvent,
  updateRequestStatus,
} from "@/lib/db/repositories/requests";
import { remember } from "@/lib/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Human escalation, closed out.
 *
 * The agent can only ever *request* approval; a person resolves it here. The
 * outcome becomes a memory, so the next comparable request retrieves not just
 * "this was escalated" but "and here is what the human decided".
 */

const bodySchema = z.object({
  approverId: z.string().uuid(),
  status: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Invalid approval id." }, { status: 400 });
  }

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
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  try {
    const approver = await getUserById(parsed.data.approverId);
    if (!approver) {
      return NextResponse.json({ error: "Unknown approver." }, { status: 404 });
    }
    if (approver.role !== "lead" && approver.role !== "admin") {
      return NextResponse.json(
        { error: `${approver.name} does not hold approval authority.` },
        { status: 403 },
      );
    }

    const approval = await resolveApproval({
      approvalId: id,
      approverId: approver.id,
      status: parsed.data.status,
      note: parsed.data.note,
    });

    if (!approval) {
      return NextResponse.json(
        { error: "That approval has already been resolved." },
        { status: 409 },
      );
    }

    await updateRequestStatus(
      approval.request_id,
      parsed.data.status === "approved" ? "approved" : "rejected",
    );

    await addRequestEvent({
      requestId: approval.request_id,
      eventType:
        parsed.data.status === "approved" ? "human_approval" : "human_rejection",
      actorType: "user",
      actorId: approver.id,
      summary: `${approver.name} ${parsed.data.status} the escalation${
        parsed.data.note ? `: ${parsed.data.note}` : "."
      }`,
      payload: { approval_id: approval.id },
    });

    await recordAuditEvent({
      requestId: approval.request_id,
      actorType: "user",
      actorId: approver.id,
      action: "approval.resolved",
      parameters: { approval_id: approval.id, status: parsed.data.status },
      resultSummary: `${approver.name} ${parsed.data.status} the escalation`,
    });

    await remember({
      content:
        `${approver.name} (${approver.title || approver.role}, ${approver.team_name}) ` +
        `${parsed.data.status} an escalated request that Memento had routed for human decision. ` +
        `Reason given for the escalation: ${approval.reason}.` +
        (parsed.data.note ? ` Approver's note: ${parsed.data.note}` : ""),
      summary: `${approver.name} ${parsed.data.status} an escalated request`,
      memoryType: "decision",
      importance: 4,
      sourceKind: "decision",
      sourceRequestId: approval.request_id,
      sourceDecisionId: approval.decision_id,
      subjectUserId: approver.id,
      subjectTeamId: approver.team_id,
      metadata: { approval_id: approval.id, status: parsed.data.status },
    });

    return NextResponse.json({ approval });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/approvals] resolve failed:", message);
    return NextResponse.json(
      { error: `Could not resolve the approval: ${message}` },
      { status: 500 },
    );
  }
}
