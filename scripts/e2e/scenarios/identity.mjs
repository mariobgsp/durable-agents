/**
 * Identity E2E: an agent's and a group's colour + emoji are stored, survive a restart, and — the point
 * of this scenario — survive a later patch that touches an unrelated field.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

export default {
  name: "identity",
  async run(server) {
    // 1. Agent identity.
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Identity test", color: "#7fb3d5", avatar: "🐙", tools: [] }),
    });
    assert.equal(created.status, 200, "creating an agent should succeed");
    assert.equal(created.body.record.color, "#7fb3d5", "the agent colour should be stored");
    assert.equal(created.body.record.avatar, "🐙", "the agent emoji should be stored");

    // 2. Group identity.
    const room = await server.api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ title: "Identity group", members: ["identity-test"] }),
    });
    assert.equal(room.status, 200, "creating a group should succeed");
    const roomId = room.body.id;

    const painted = await server.api("/api/rooms/" + roomId, {
      method: "PUT",
      body: JSON.stringify({ color: "#a2d5a2", avatar: "👥" }),
    });
    assert.equal(painted.status, 200);
    assert.equal(painted.body.room.color, "#a2d5a2", "the group colour should be stored");
    assert.equal(painted.body.room.avatar, "👥", "the group emoji should be stored");

    // The trap: roomOf() rebuilds the room field by field, so a field it does not carry is dropped and
    // the next unrelated patch wipes it.
    const patched = await server.api("/api/rooms/" + roomId, {
      method: "PUT",
      body: JSON.stringify({ mode: "silent" }),
    });
    assert.equal(patched.body.room.mode, "silent", "the mode should change");
    assert.equal(patched.body.room.color, "#a2d5a2", "a mode change must not wipe the group colour");
    assert.equal(patched.body.room.avatar, "👥", "a mode change must not wipe the group emoji");

    // 3. Both survive a restart on the same data directory.
    await server.stop({ keepData: true });
    const restarted = await startServer({ dataDir: server.dataDir });

    const agents = await restarted.api("/api/agents");
    const agent = agents.body.agents.find((entry) => entry.id === "identity-test");
    assert.ok(agent, "the agent should still exist");
    assert.equal(agent.color, "#7fb3d5", "the agent colour should survive a restart");
    assert.equal(agent.avatar, "🐙", "the agent emoji should survive a restart");

    const sessions = await restarted.api("/api/sessions");
    const group = sessions.body.sessions.find((session) => session.id === roomId);
    assert.ok(group, "the group should still exist");
    assert.equal(group.room.color, "#a2d5a2", "the group colour should survive a restart");
    assert.equal(group.room.avatar, "👥", "the group emoji should survive a restart");

    await restarted.stop();
  },
};
