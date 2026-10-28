import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { telegramUsersPath } from "../../core/src/paths.ts";

/**
 * The allowlist. One owner, any number of members, and a bounded pending list for people who wrote
 * to a bot before the owner approved them. The owner is global across bots; a member is recognised
 * by Telegram id, because usernames change.
 */
export type UserRole = "owner" | "user";

export type UserRecord = {
  id: string;
  username?: string;
  role: UserRole;
  addedAt: number;
  addedBy?: string;
};

export type PendingUser = {
  id: string;
  username?: string;
  firstSeenAt: number;
  lastText?: string;
};

export type Users = {
  owner: string | null;
  users: UserRecord[];
  pending: PendingUser[];
};

const PENDING_LIMIT = 50;

export async function loadUsers(): Promise<Users> {
  try {
    const parsed = JSON.parse(await readFile(telegramUsersPath, "utf8")) as Partial<Users>;
    return {
      owner: typeof parsed.owner === "string" ? parsed.owner : null,
      users: Array.isArray(parsed.users)
        ? parsed.users.filter((user): user is UserRecord => Boolean(user) && typeof user.id === "string" && (user.role === "owner" || user.role === "user"))
        : [],
      pending: Array.isArray(parsed.pending)
        ? parsed.pending.filter((user): user is PendingUser => Boolean(user) && typeof user.id === "string")
        : [],
    };
  } catch {
    return { owner: null, users: [], pending: [] };
  }
}

export async function saveUsers(users: Users): Promise<void> {
  await mkdir(dirname(telegramUsersPath), { recursive: true, mode: 0o700 });
  const tmp = telegramUsersPath + ".tmp";
  await writeFile(tmp, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, telegramUsersPath);
}

export function roleOf(users: Users, id: string): UserRole | undefined {
  if (users.owner === id) return "owner";
  return users.users.find((user) => user.id === id)?.role;
}

export function isAllowed(users: Users, id: string): boolean {
  return roleOf(users, id) !== undefined;
}

export async function setOwner(
  users: Users,
  id: string,
  username?: string,
): Promise<Users> {
  const next: Users = {
    ...users,
    owner: id,
    pending: users.pending.filter((user) => user.id !== id),
    users: users.users.filter((user) => user.id !== id),
  };
  next.users.unshift({ id, ...(username ? { username } : {}), role: "owner", addedAt: Date.now() });
  await saveUsers(next);
  return next;
}

export async function addUser(users: Users, id: string, username?: string, addedBy?: string): Promise<Users> {
  if (isAllowed(users, id)) return users;
  const next: Users = {
    ...users,
    pending: users.pending.filter((user) => user.id !== id),
    users: users.users.filter((user) => user.id !== id),
  };
  next.users.push({ id, ...(username ? { username } : {}), role: "user", addedAt: Date.now(), ...(addedBy ? { addedBy } : {}) });
  await saveUsers(next);
  return next;
}

export async function removeUser(users: Users, id: string): Promise<Users> {
  if (users.owner === id) throw new Error("the owner cannot be removed; transfer ownership first");
  const next: Users = { ...users, users: users.users.filter((user) => user.id !== id) };
  await saveUsers(next);
  return next;
}

export async function notePending(users: Users, id: string, username?: string, lastText?: string): Promise<Users> {
  if (isAllowed(users, id)) return users;
  const existing = users.pending.find((user) => user.id === id);
  const pending = existing
    ? users.pending.map((user) =>
        user.id === id ? { ...user, ...(username ? { username } : {}), ...(lastText ? { lastText } : {}) } : user,
      )
    : [...users.pending, { id, ...(username ? { username } : {}), firstSeenAt: Date.now(), ...(lastText ? { lastText } : {}) }];
  const next: Users = { ...users, pending: pending.slice(-PENDING_LIMIT) };
  await saveUsers(next);
  return next;
}

export async function approvePending(users: Users, id: string, addedBy?: string): Promise<Users> {
  const entry = users.pending.find((user) => user.id === id);
  return addUser(users, id, entry?.username, addedBy);
}

export async function denyPending(users: Users, id: string): Promise<Users> {
  const next: Users = { ...users, pending: users.pending.filter((user) => user.id !== id) };
  await saveUsers(next);
  return next;
}
