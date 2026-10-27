import type { AgentRecord, Session } from "../types.ts";

/**
 * One place that turns an agent or a group into the identity the UI draws: a colour, an optional emoji
 * face, and a label. Everything (sidebar, chat header, bubbles, cards, editor preview) reads this, so
 * the sidebar and the conversation can never disagree about who is who.
 */
export type IdentityKind = "agent" | "group" | "member" | "plain" | "you";

export type Identity = {
  id: string;
  label: string;
  color: string;
  emoji?: string;
  kind: IdentityKind;
};

/** Twelve desaturated swatches (saturation stays low so accents sit with the neutrals, not on top). */
export const PALETTE = [
  "#e0a35c",
  "#7fb3d5",
  "#a2d5a2",
  "#d59ab8",
  "#c9a2d5",
  "#d5c69a",
  "#8fc7c0",
  "#d59a8f",
  "#a8b4d5",
  "#c0d58f",
  "#d5b88f",
  "#b0a8d5",
];

/** A stable colour for anything the user has not painted yet. */
export function paletteColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]!;
}

export function initialsOf(label: string): string {
  const parts = label
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const first = parts[0];
  if (first === undefined) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The minimal identity fields. A full AgentRecord satisfies this, and so does a FleetAgent; the board reads
 * fleet rows, and forcing them through a fake record would be a second shape to keep in sync.
 */
export type AgentIdentitySource = Pick<AgentRecord, "id" | "name"> &
  Partial<Pick<AgentRecord, "color" | "avatar">>;

export function identityOfAgent(agent: AgentIdentitySource): Identity {
  return {
    id: agent.id,
    label: agent.name || agent.id,
    color: agent.color ?? paletteColor(agent.id),
    emoji: agent.avatar,
    kind: "agent",
  };
}

/** A member inside a group: the same identity, rendered smaller and stacked. */
export function identityOfMember(id: string, agents: readonly AgentRecord[]): Identity {
  const agent = agents.find((entry) => entry.id === id);
  if (agent) return { ...identityOfAgent(agent), kind: "member" };
  return { id, label: id, color: paletteColor(id), kind: "member" };
}

/** A group: its own colour and emoji when set; the caller stacks member avatars when it has none. */
export function identityOfGroup(session: Session): Identity {
  return {
    id: session.id,
    label: session.title || "Group",
    color: session.room?.color ?? paletteColor("group:" + session.id),
    emoji: session.room?.avatar,
    kind: "group",
  };
}

export function identityOfAuthor(
  author: string | null | undefined,
  agents: readonly AgentRecord[],
): Identity {
  if (!author) return { id: "you", label: "You", color: "#8b9096", kind: "you" };
  const agent = agents.find((entry) => entry.id === author);
  if (agent) return identityOfAgent(agent);
  return { id: author, label: author, color: paletteColor(author), kind: "member" };
}

/** Readable ink for text sitting on a colour. */
export function inkOn(color: string): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return "#f2f3f5";
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#14161a" : "#f2f3f5";
}

/** A small curated grid for the emoji picker: faces, animals, objects and tools that suit agents. */
export const EMOJI_CHOICES = [
  "🧑‍💻", "🧠", "🤖", "👾", "🧭", "🔭", "🛠️", "🧪",
  "📚", "📝", "🗂️", "📊", "🔍", "🔒", "⚙️", "🧰",
  "🚀", "🛰️", "🪄", "🧩", "🎯", "🎨", "🎼", "🧵",
  "🐙", "🦊", "🐺", "🐝", "🦉", "🐳", "🦅", "🐢",
  "🏴‍☠️", "🧑‍🍳", "🧑‍🔬", "🧑‍🚀", "🧑‍🏫", "🧑‍🌾", "🧑‍⚖️", "🧑‍🎤",
  "👥", "🌱", "🔥", "💧", "🌙", "☀️", "🧊", "⚡",
];
