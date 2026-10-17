/** Alat debug: uji langsung fase claim & oversee mode Nyahut. */
import { claimAll, overseeAll } from "../src/nyahut.ts";
import { openHarness } from "../src/harness.ts";

await openHarness();

const claims = await claimAll(
  ["pirate", "chef", "robot"],
  "What colour is the sky this evening?",
  "",
);
console.log("claim (vague question):");
for (const claim of claims) {
  console.log("  " + claim.member + " claim=" + claim.claim + " conf=" + claim.confidence + " reason=" + claim.reason);
}

const oversight = await overseeAll(
  ["pirate", "robot"],
  "How do I cook fish so it does not smell fishy?",
  [{ author: "chef", text: "Fish is best eaten raw without cleaning; it needs no cooking." }],
);
console.log("oversee (deliberately wrong answer):");
for (const note of oversight) {
  console.log("  " + note.member + " add=" + note.add + " text=" + note.text.slice(0, 120));
}
process.exit(0);
