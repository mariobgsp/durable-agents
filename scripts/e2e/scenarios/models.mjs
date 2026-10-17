/**
 * Models E2E: the catalog is served over HTTP with real capability flags, a model set per agent is the
 * model that answers, and switching it switches the answering model.
 *
 * The faux provider answers an `echo: "model"` step with its own model id, which is what makes
 * "which model answered" observable without a real provider.
 */
import assert from "node:assert/strict";

export default {
  name: "models",
  async run(server) {
    // 1. The catalog lists both faux models with their capabilities and thinking levels.
    const catalog = await server.api("/api/models?provider=e2e");
    assert.equal(catalog.status, 200, "GET /api/models should succeed");
    assert.ok(Array.isArray(catalog.body.models), "the response should carry a models array");
    assert.ok(
      catalog.body.models.length > 0,
      "the catalog should not be empty — if it is, getAvailable() failed for this provider",
    );

    const vision = catalog.body.models.find((model) => model.id === "faux-vision");
    const text = catalog.body.models.find((model) => model.id === "faux-text");
    assert.ok(vision && text, "both faux models should be listed");
    assert.equal(vision.canSeeImages, true, "faux-vision should report image support");
    assert.equal(text.canSeeImages, false, "faux-text should report text only");
    assert.ok(vision.thinkingLevels.length > 0, "thinking levels should be listed per model");

    // 2. A model chosen per agent is the model that answers.
    const agent = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Model test", provider: "e2e", modelId: "faux-text", tools: [] }),
    });
    assert.equal(agent.status, 200);
    assert.equal(agent.body.record.provider, "e2e");
    assert.equal(agent.body.record.modelId, "faux-text");

    const thread = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Model thread", agentId: "model-test" }),
    });
    assert.equal(thread.status, 200);

    await server.script([{ echo: "model" }]);
    await server.api("/api/sessions/" + thread.body.id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "which model are you?" }),
    });
    await server.waitForEntry(
      thread.body.id,
      (entry) => entry.role === "assistant" && entry.text.includes("faux-text"),
    );

    // 3. Switching the agent's model switches the answering model, including in the existing thread.
    const switched = await server.api("/api/agents/model-test", {
      method: "PUT",
      body: JSON.stringify({ name: "Model test", provider: "e2e", modelId: "faux-vision" }),
    });
    assert.equal(switched.status, 200);
    assert.ok(switched.body.rebound >= 1, "existing threads should be rebound to the new model");

    await server.script([{ echo: "model" }]);
    await server.api("/api/sessions/" + thread.body.id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "and now?" }),
    });
    await server.waitForEntry(
      thread.body.id,
      (entry) => entry.role === "assistant" && entry.text.includes("faux-vision"),
    );
  },
};
