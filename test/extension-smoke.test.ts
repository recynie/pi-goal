import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("Pi loads the extension entrypoint and registers its command and tools", async () => {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [resolve("src/index.ts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension?.commands.has("goal"));
  assert.deepEqual(
    [...(extension?.tools.keys() ?? [])].sort(),
    ["goal_pause", "goal_propose", "goal_submit"],
  );
  assert.ok(extension?.entryRenderers?.has("goal-verification-ui-v1"));
});
