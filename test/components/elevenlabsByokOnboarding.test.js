const test = require("node:test");
const assert = require("node:assert/strict");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
const { mountByokStep } = require("../lib/byokStepHarness");

const API_KEY_PLACEHOLDER = "onboarding.rehaul.provider.apiKeyPlaceholder";

for (const model of ["scribe_v2", "scribe_v2_realtime"]) {
  test(`ElevenLabs ${model} onboarding saves its verified key and restores it from main`, async (t) => {
    const step = await mountByokStep(t);
    const key = "test-only-elevenlabs-key";
    let mainStoredKey = "";
    global.window.electronAPI.saveElevenLabsKey = async (value) => {
      mainStoredKey = value;
    };
    global.window.electronAPI.getElevenLabsKey = async () => mainStoredKey;
    global.window.electronAPI.getDictionary = async () => ["OpenWhispr"];

    await step.chooseProvider("elevenlabs");
    await step.chooseModel(model);
    await step.type(API_KEY_PLACEHOLDER, key);
    await step.passConnectionTest();
    assert.equal(step.connectionRequests().at(-1).apiKey, key);
    assert.equal(step.proceedDisabled(), false);
    await step.proceed();

    assert.equal(step.proceeded(), 1);
    assert.equal(step.state().cloudTranscriptionProvider, "elevenlabs");
    assert.equal(step.state().cloudTranscriptionModel, model);
    assert.equal(step.state().elevenlabsApiKey, key);
    await step.wait(250);
    assert.equal(mainStoredKey, key, "the key is persisted through the main-process bridge");
    assert.equal(
      localStorage.getItem("elevenlabsApiKey"),
      null,
      "secrets stay out of localStorage"
    );

    await step.unmountForDrafts();
    // Match OnboardingFlow.continueFromCurrentStep after this form calls onProceed.
    step.state().setCloudTranscriptionForAllScopes({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
    });
    await step.setStore({ elevenlabsApiKey: "" });
    const { initializeSettings } = await step.vite.ssrLoadModule("/stores/settingsStore.ts");
    await initializeSettings();
    assert.equal(step.state().elevenlabsApiKey, key, "restart hydration reads the saved main key");
    await step.remountFromSavedSettings();
    assert.deepEqual(step.selectValues(), ["elevenlabs", model]);
    assert.equal(step.value(API_KEY_PLACEHOLDER), key, "re-entry uses the saved credential");
  });
}

// Exercise the selectable registry, not a hand-maintained list of provider IDs:
// newly added providers must have working onboarding read/write credential wiring.
test("every hosted dictation provider saves its verified credential", async (t) => {
  const step = await mountByokStep(t);
  const { getTranscriptionProviders } = await step.vite.ssrLoadModule("/models/ModelRegistry.ts");
  const providers = getTranscriptionProviders().filter(
    ({ id }) => id !== "custom" && id !== "corti"
  );
  assert.ok(providers.some(({ id }) => id === "elevenlabs"));
  for (const { id } of providers) {
    const secret = BYOK_API_KEYS.find(({ base }) => base === id);
    assert.ok(secret, `${id} has secure credential metadata`);
    const key = `test-only-${id}-key`;
    let savedKey;
    global.window.electronAPI[secret.save] = async (value) => {
      savedKey = value;
    };
    await step.chooseProvider(id);
    await step.type(API_KEY_PLACEHOLDER, key);
    await step.passConnectionTest();
    await step.proceed();
    assert.equal(step.state()[secret.storeKey], key, `${id} commits its verified credential`);
    await step.wait(250);
    assert.equal(savedKey, key, `${id} persists through its main-process bridge`);
    // Switching away and back must read the same saved credential.
    await step.chooseProvider(id === "openai" ? "elevenlabs" : "openai");
    await step.chooseProvider(id);
    assert.equal(step.value(API_KEY_PLACEHOLDER), key, `${id} restores its credential`);
  }
});
