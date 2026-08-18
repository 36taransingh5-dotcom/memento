import { getTeamById } from "@/lib/db/repositories/organization";
import {
  findExpiringAllocations,
  findReusableResources,
  getTeamResourceUsage,
} from "@/lib/db/repositories/resources";
import { getRequestHistory } from "@/lib/db/repositories/requests";
import type { ResourceWithContext, UserWithTeam } from "@/lib/db/types";
import type {
  ExpiringAllocation,
  PolicyContext,
  PriorRequestSummary,
  RequestFacts,
} from "@/lib/policy/types";

/**
 * Materialises everything the deterministic rules need, in one place.
 *
 * The rules themselves do no I/O, so this is the single boundary between "what
 * the organization currently looks like" and "what the organization permits".
 */
export async function buildPolicyContext(input: {
  request: RequestFacts;
  requester: UserWithTeam;
  now?: Date;
  lookbackDays?: number;
  expiringWithinDays?: number;
}): Promise<PolicyContext> {
  const now = input.now ?? new Date();
  const teamId = input.requester.team_id;

  const team = await getTeamById(teamId);
  if (!team) {
    throw new Error(
      `Team ${teamId} referenced by ${input.requester.email} does not exist`,
    );
  }

  const [teamUsage, expiring, priorRequests, reusableResources] =
    await Promise.all([
      getTeamResourceUsage(teamId),
      findExpiringAllocations(teamId, input.expiringWithinDays ?? 14),
      getRequestHistory({
        teamId,
        resourceKind: input.request.resourceKind,
        lookbackDays: input.lookbackDays ?? 60,
        limit: 15,
      }),
      resolveReusable(teamId, input.request),
    ]);

  return {
    request: input.request,
    requester: input.requester,
    team,
    teamUsage,
    reusableResources,
    expiringAllocations: expiring.map(
      (a): ExpiringAllocation => ({
        id: a.id,
        resource_id: a.resource_id,
        resource_name: a.resource_name,
        resource_key: a.resource_key,
        resource_kind: a.resource_kind,
        holder_name: a.holder_name,
        expires_at: a.expires_at,
        purpose: a.purpose,
      }),
    ),
    priorRequests: priorRequests.map(
      (r): PriorRequestSummary => ({
        id: r.id,
        reference: r.reference,
        title: r.title,
        status: r.status,
        decision: r.latest_decision,
        created_at: r.created_at,
        requester_name: r.requester_name,
      }),
    ),
    now,
  };
}

async function resolveReusable(
  teamId: string,
  request: RequestFacts,
): Promise<ResourceWithContext[]> {
  if (!request.resourceKind) return [];
  return findReusableResources(teamId, request.resourceKind);
}
