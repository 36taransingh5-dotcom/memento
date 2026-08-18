import { query, queryOne } from "@/lib/db/client";
import type { Team, User, UserWithTeam } from "@/lib/db/types";

export async function listTeams(): Promise<Team[]> {
  return query<Team>(`SELECT * FROM teams ORDER BY name`);
}

export async function getTeamById(id: string): Promise<Team | null> {
  return queryOne<Team>(`SELECT * FROM teams WHERE id = $1`, [id]);
}

export async function getTeamByKey(key: string): Promise<Team | null> {
  return queryOne<Team>(`SELECT * FROM teams WHERE key = $1`, [key]);
}

export async function listUsers(): Promise<UserWithTeam[]> {
  return query<UserWithTeam>(
    `SELECT u.*, t.name AS team_name, t.key AS team_key
       FROM users u
       JOIN teams t ON t.id = u.team_id
      ORDER BY u.name`,
  );
}

export async function getUserById(id: string): Promise<UserWithTeam | null> {
  return queryOne<UserWithTeam>(
    `SELECT u.*, t.name AS team_name, t.key AS team_key
       FROM users u
       JOIN teams t ON t.id = u.team_id
      WHERE u.id = $1`,
    [id],
  );
}

export async function getUserByEmail(email: string): Promise<UserWithTeam | null> {
  return queryOne<UserWithTeam>(
    `SELECT u.*, t.name AS team_name, t.key AS team_key
       FROM users u
       JOIN teams t ON t.id = u.team_id
      WHERE u.email = $1`,
    [email],
  );
}

/** Members of a team who can approve an escalation. */
export async function listApprovers(
  teamId: string,
  requiredRole: "lead" | "admin",
): Promise<User[]> {
  const roles = requiredRole === "admin" ? ["admin"] : ["lead", "admin"];
  return query<User>(
    `SELECT * FROM users
      WHERE role = ANY($1)
        AND (team_id = $2 OR role = 'admin')
      ORDER BY role DESC, name`,
    [roles, teamId],
  );
}
