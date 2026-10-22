/**
 * Display customization E2E: an agent changes the global theme through customize_ui, the owner can read and
 * reset it, and the CSS layer rejects network/channel escapes.
 */
import assert from "node:assert/strict";

export default {
  name: "display",
  async run(server) {
    const defaults = await server.api("/api/display");
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.displayName, "dura-agents");
    assert.equal(defaults.body.customCss, "");

    const presence = server.presence();
    await presence.ready;
    const initialFrame = await presence.waitFor((frame) => frame.type === "display");
    assert.equal(initialFrame.display.displayName, "dura-agents");

    const agent = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Designer", tools: [] }),
    });
    assert.equal(agent.status, 200);
    const id = String(
      (
        await server.api("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ title: "Display work", agentId: agent.body.record.id }),
        })
      ).body.id,
    );

    await server.script([
      {
        toolCall: {
          name: "customize_ui",
          arguments: {
            displayName: "Night Shift",
            tagline: "quiet agent work",
            logo: "🌙",
            accent: "#7fb3d5",
            background: "#050608",
            panel: "#0d1014",
            text: "#e7edf3",
            muted: "#87919b",
            font: "mono",
            density: "compact",
            radius: 6,
            customCss: ".brand { letter-spacing: 0.12em; }",
          },
        },
      },
      { text: "display changed" },
    ]);
    await server.send(id, { text: "restyle the app", requestId: "display-one" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "display changed");

    const changed = await server.api("/api/display");
    assert.equal(changed.body.displayName, "Night Shift");
    assert.equal(changed.body.accent, "#7fb3d5");
    assert.equal(changed.body.font, "mono");
    assert.equal(changed.body.density, "compact");
    assert.equal(changed.body.radius, 6);
    assert.equal(changed.body.customCss, ".brand { letter-spacing: 0.12em; }");
    assert.equal(changed.body.updatedBy, "designer");
    const changedFrame = await presence.waitFor(
      (frame) => frame.type === "display" && frame.display.displayName === "Night Shift",
    );
    assert.equal(changedFrame.display.accent, "#7fb3d5");

    const unsafe = await server.api("/api/display", {
      method: "PUT",
      body: JSON.stringify({ customCss: "@import url(https://example.com/x.css);" }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal(unsafe.body.code, "unsafe_css");
    const still = await server.api("/api/display");
    assert.equal(still.body.displayName, "Night Shift", "a rejected CSS layer must not partially save");

    const badColor = await server.api("/api/display", {
      method: "PUT",
      body: JSON.stringify({ accent: "red; background: url(x)" }),
    });
    assert.equal(badColor.status, 400);

    const reset = await server.api("/api/display/reset", { method: "POST", body: "{}" });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.displayName, "dura-agents");
    assert.equal(reset.body.customCss, "");
    assert.equal(reset.body.radius, 10);
    const resetFrame = await presence.waitFor(
      (frame) => frame.type === "display" && frame.display.displayName === "dura-agents",
    );
    assert.equal(resetFrame.display.customCss, "");
    presence.close();
  },
};