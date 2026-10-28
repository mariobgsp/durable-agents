import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { withDaemon } from "../client.ts";

type Room = { id: string; title: string; mode?: string; members: string[]; speaker: string | null };

export async function runGroup(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const rooms = await withDaemon((client) => client.request<Room[]>("rooms.list"));
    if (has(parsed, "json")) {
      json(rooms);
      return;
    }
    if (rooms.length === 0) {
      print("no groups; create one with: dura group create --title <name> --members a,b");
      return;
    }
    table(
      ["id", "title", "mode", "members", "speaker"],
      rooms.map((room) => [room.id, room.title, room.mode ?? "-", room.members.join(", "), room.speaker ?? "-"]),
    );
    return;
  }

  if (action === "create") {
    const title = flag(parsed, "title") ?? fail("usage: dura group create --title <name> --members a,b", 2);
    const members = (flag(parsed, "members") ?? "").split(",").map((member) => member.trim()).filter(Boolean);
    if (members.length === 0) fail("--members is required", 2);
    const room = await withDaemon((client) => client.request<Room>("rooms.create", { title, members }));
    if (has(parsed, "json")) json(room);
    else {
      print(paint("green", "created") + " " + room.id + " · " + room.title);
      print(paint("dim", "bind it in Telegram with: /bind " + room.id));
    }
    return;
  }

  if (action === "mode") {
    const mode = parsed.positional[2];
    if (!target || (mode !== "nyahut" && mode !== "moderator" && mode !== "silent")) {
      fail("usage: dura group mode <id> nyahut|moderator|silent", 2);
    }
    const room = await withDaemon((client) => client.request<Room>("rooms.update", { id: target, patch: { mode } }));
    print(room ? room.title + " → " + mode : "no such group");
    return;
  }

  if (action === "show") {
    if (!target) fail("usage: dura group show <id>", 2);
    const rooms = await withDaemon((client) => client.request<Room[]>("rooms.list"));
    const room = rooms.find((entry) => entry.id === target);
    if (!room) fail("unknown group: " + target, 4);
    if (has(parsed, "json")) json(room);
    else {
      print(paint("bold", room.title + " (" + room.id + ")"));
      print("mode " + (room.mode ?? "-") + " · members " + room.members.join(", ") + " · speaker " + (room.speaker ?? "-"));
    }
    return;
  }

  fail("usage: dura group <list|create|show|mode>", 2);
}
