import type { RoomMode } from "./rooms.ts";

export type RoomTargets = { targets: string[]; mentioned: string[]; reason: string };

function mentionPattern(id: string): RegExp {
  return new RegExp("@" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9-])", "i");
}

/** Every member mentioned with @id in the text. */
export function mentionsIn(text: string, members: readonly string[]): string[] {
  return members.filter((member) => mentionPattern(member).test(text));
}

/**
 * Who answers one message. A pure function: no network, model or file access.
 *
 * - `@member` always wins, in any mode.
 * - `moderator`: one designated member (falls back to the first member).
 * - `nyahut`: phase 3 still means "every member answers in order"; phase 4 replaces it with
 *   per-agent responsibility judging (SOUL.md) plus an overseeing round.
 * - `silent`: nobody answers until called.
 */
export function planTargets(mode: RoomMode, moderator: string | undefined, text: string, members: readonly string[]): RoomTargets {
  const mentioned = mentionsIn(text, members);
  if (mentioned.length > 0) return { targets: mentioned, mentioned, reason: "called with @" };

  if (mode === "silent") return { targets: [], mentioned, reason: "mode silent" };

  if (mode === "moderator") {
    const chosen = moderator && members.includes(moderator) ? moderator : members[0];
    return { targets: chosen ? [chosen] : [], mentioned, reason: "group moderator" };
  }

  return { targets: [...members], mentioned, reason: "mode nyahut" };
}
