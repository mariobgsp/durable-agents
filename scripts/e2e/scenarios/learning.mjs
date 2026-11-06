import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { startHarness } from "../harness.mjs";

/**
 * The learning layer, end to end: a thread with a correction in it is distilled into the three stores.
 *
 * The faux provider answers the distillation call with the JSON this scenario expects, so what is under test
 * is the plumbing — transcript in, redacted notes out, the right file for each kind of note.
 */
export default {
  name: "learning",
  async run() {
    const h = await startHarness({
      script: [
        { text: "Understood, I will answer in Indonesian." },
        { text: "Status jaringan: terhubung." },
        {
          text: JSON.stringify({
            preferences: ["Answer in Indonesian whenever the owner writes in Indonesian."],
            memory: ["The home hotspot is a 4G MiFi at 192.168.100.1 with a factory admin login."],
            lessons: ["Probe the LAN with an ARP sweep before asking the owner which device is which."],
          }),
        },
        { text: "Okay, noted." },
        // The sweep calls the model again for the thread, which changed since the first pass.
        {
          text: JSON.stringify({
            preferences: [],
            memory: [],
            lessons: ["Confirm the interface name before trusting a command copied from another machine."],
          }),
        },
        // Consolidation: the rewritten list must replace, not append to, the file.
        {
          text: JSON.stringify({
            lessons: ["Probe the LAN before asking which device is which.", "Verify the change before reporting it."],
          }),
        },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      const session = await h.client.request("sessions.create", { title: "Learning", agent: "helper" });
      await h.client.request("sessions.send", { id: session.id, text: "please answer me in Indonesian from now on" });
      await waitForEntries(h.client, session.id, 2);
      await h.client.request("sessions.send", { id: session.id, text: "check the network now" });
      await waitForEntries(h.client, session.id, 4);

      const result = await h.client.request("learning.distill", { id: session.id, forced: true });
      assert.equal(result.skipped, undefined, "the pass ran instead of skipping: " + JSON.stringify(result));
      assert.deepEqual(result.preferences, ["Answer in Indonesian whenever the owner writes in Indonesian."]);
      assert.equal(result.lessons.length, 1, "one lesson learned");
      assert.equal(result.memory.length, 1, "one memory note saved");

      const preferences = await readFile(resolve(h.home, "preferences.md"), "utf8");
      assert.ok(preferences.includes("Answer in Indonesian"), "the preference is in the fleet file");
      const memory = await readFile(resolve(h.home, "agents", "helper", "MEMORY.md"), "utf8");
      assert.ok(memory.includes("4G MiFi"), "the fact is in the agent's memory");
      const lessons = await readFile(resolve(h.home, "agents", "helper", "LESSONS.md"), "utf8");
      assert.ok(lessons.includes("ARP sweep"), "the lesson is in the agent's lessons");

      // A second pass over an unchanged thread must not spend another model call.
      const again = await h.client.request("learning.distill", { id: session.id });
      assert.equal(again.skipped, "unchanged", "an unchanged thread is not distilled twice");

      // The three stores reach the prompt: preferences and lessons are rendered into the instructions.
      const status = await h.client.request("preferences.list");
      assert.ok(status.some((line) => includesIgnoresPath(line, "Answer in Indonesian")), "preferences.list returns the notes");

      // The autonomous pass: a sweep over live threads learns from this one without being told which.
      await h.client.request("sessions.send", { id: session.id, text: "and one more thing" });
      await waitForEntries(h.client, session.id, 6);
      const swept = await h.client.request("learning.sweep");
      assert.ok(swept.threads >= 1, "the sweep examines live threads");
      assert.equal(swept.distilled, 1, "the sweep distilled the one changed thread");
      assert.equal(swept.lessons, 1, "the sweep learned one more lesson");

      // Forgetting: a file that outgrew the render limit is compressed instead of growing forever.
      for (let index = 0; index < 14; index += 1) {
        await h.client.request("agents.learn-lesson", { id: "helper", note: "Filler lesson number " + index + "." });
      }
      const kept = await h.client.request("learning.consolidate", { agent: "helper" });
      assert.equal(kept.length, 2, "consolidation keeps the model's short list");
      const afterConsolidation = await readFile(resolve(h.home, "agents", "helper", "LESSONS.md"), "utf8");
      assert.ok(!afterConsolidation.includes("Filler lesson"), "the rewrite replaced the old lessons");
      assert.ok(afterConsolidation.includes("Verify the change before reporting it."), "the kept lessons are written");

      const files = await h.client.request("agents.show", { id: "helper" });
      assert.ok(files.lessonsMd.trim().length > 0, "readAgent exposes the lessons file");
      assert.ok(basename(h.home).startsWith("dura-e2e-"), "the harness ran against its own home");
    } finally {
      await h.stop();
    }
  },
};

function includesIgnoresPath(line, text) {
  return line.includes(text);
}

/** A send returns before the run finishes; wait for the transcript to reach `count` messages. */
async function waitForEntries(client, sessionId, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    entries = await client.request("sessions.transcript", { id: sessionId });
    if (entries.length >= count) return entries;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(
    "expected " + count + " entries, saw " + entries.length + ": " +
      entries.map((entry) => entry.role + ":" + String(entry.text).slice(0, 40)).join(" | "),
  );
}
