import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discordUsersPath } from "../../core/src/paths.ts";

/** The allowlist. One owner, any number of members, and a bounded pending list. */
export type DiscordUserRole = "owner" | "user";

export type DiscordUserRecord = {
  id: string;
  username?: string;
  role: DiscordUserRole;
  addedAt: number;
  addedBy?: string;
};

export type DiscordPendingUser = {
  id: string;
  username?: string;
  firstSeenAt: number;
  lastText?: string;
};

export type DiscordUsers = {
  owner: string | null;
  users: DiscordUserRecord[];
  pending: DiscordPendingUser[];
};

const PENDING_LIMIT = 50;

export async function loadDiscordUsers(): Promise<DiscordUsers> {
  try {
    const parsed = JSON.parse(await readFile(discordUsersPath, "utf8")) as Partial<DiscordUsers>;
    return {
      owner: typeof parsed.owner === "string" ? parsed.owner : null,
      users: Array.isArray(parsed.users)
        ? parsed.users.filter(
            (user): user is DiscordUserRecord =>
              Boolean(user) && typeof user.id === "string" && (user.role === "owner" || user.role === "user"),
          )
        : [],
      pending: Array.isArray(parsed.pending)
        ? parsed.pending.filter((user): user is DiscordPendingUser => Boolean(user) && typeof user.id === "string")
        : [],
    };
  } catch {
    return { owner: null, users: [], pending: [] };
  }
}

export async function saveDiscordUsers(users: DiscordUsers): Promise<void> {
  await mkdir(dirname(discordUsersPath), { recursive: true, mode: 0o700 });
  const tmp = discordUsersPath + ".tmp";
  await writeFile(tmp, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, discordUsersPath);
}

export function discordRoleOf(users: DiscordUsers, id: string): DiscordUserRole | undefined {
  if (users.owner === id) return "owner";
  return users.users.find((user) => user.id === id)?.role;
}

export function isDiscordAllowed(users: DiscordUsers, id: string): boolean {
  return discordRoleOf(users, id) !== undefined;
}

export async function setDiscordOwner(users: DiscordUsers, id: string, username?: string): Promise<DiscordUsers> {
  const next: DiscordUsers = {
    ...users,
    owner: id,
    pending: users.pending.filter((user) => user.id !== id),
    users: users.users.filter((user) => user.id !== id),
  };
  next.users.unshift({ id, ...(username ? { username } : {}), role: "owner", addedAt: Date.now() });
  await saveDiscordUsers(next);
  return next;
}

export async function addDiscordUser(users: DiscordUsers, id: string, username?: string, addedBy?: string): Promise<DiscordUsers> {
  if (isDiscordAllowed(users, id)) return users;
  const next: DiscordUsers = {
    ...users,
    pending: users.pending.filter((user) => user.id !== id),
    users: users.users.filter((user) => user.id !== id),
  };
  next.users.push({ id, ...(username ? { username } : {}), role: "user", addedAt: Date.now(), ...(addedBy ? { addedBy } : {}) });
  await saveDiscordUsers(next);
  return next;
}

export async function removeDiscordUser(users: DiscordUsers, id: string): Promise<DiscordUsers> {
  if (users.owner === id) throw new Error("the owner cannot be removed; transfer ownership first");
  const next: DiscordUsers = { ...users, users: users.users.filter((user) => user.id !== id) };
  await saveDiscordUsers(next);
  return next;
}

export async function noteDiscordPending(users: DiscordUsers, id: string, username?: string, lastText?: string): Promise<DiscordUsers> {
  if (isDiscordAllowed(users, id)) return users;
  const existing = users.pending.find((user) => user.id === id);
  const pending = existing
    ? users.pending.map((user) =>
        user.id === id ? { ...user, ...(username ? { username } : {}), ...(lastText ? { lastText } : {}) } : user,
      )
    : [...users.pending, { id, ...(username ? { username } : {}), firstSeenAt: Date.now(), ...(lastText ? { lastText } : {}) }];
  const next: DiscordUsers = { ...users, pending: pending.slice(-PENDING_LIMIT) };
  await saveDiscordUsers(next);
  return next;
}

export async function approveDiscordPending(users: DiscordUsers, id: string, addedBy?: string): Promise<DiscordUsers> {
  const entry = users.pending.find((user) => user.id === id);
  return addDiscordUser(users, id, entry?.username, addedBy);
}

export async function denyDiscordPending(users: DiscordUsers, id: string): Promise<DiscordUsers> {
  const next: DiscordUsers = { ...users, pending: users.pending.filter((user) => user.id !== id) };
  await saveDiscordUsers(next);
  return next;
}
