const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { mountByokStep } = require("../lib/byokStepHarness");

const dictation = {
  useLocalWhisper: "false",
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
};

for (const selfHostedRequested of [false, true]) {
  test(`blank ${selfHostedRequested ? "self-hosted" : "BYOK"} assistant can be skipped without committing its form`, async (t) => {
    const step = await mountByokStep(t, {
      stepId: "byok-assistant",
      selfHostedRequested,
      settings: dictation,
      secrets: { openaiApiKey: "saved-dictation-only-key" },
    });
    const before = step.state();
    assert.ok(step.skipButton());
    assert.equal(step.skipButton().props.disabled, undefined);
    await step.skip();
    assert.equal(step.skipped(), 1);
    assert.equal(step.proceeded(), 0);
    const after = step.state();
    for (const field of [
      "cloudTranscriptionProvider",
      "cloudTranscriptionModel",
      "cloudTranscriptionMode",
      "openaiApiKey",
      "chatAgentProvider",
      "chatAgentModel",
      "chatAgentCustomApiKey",
    ]) {
      assert.equal(after[field], before[field], field);
    }
  });
}

test("a rejected assistant key does not block Skip or replace the saved dictation key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: dictation,
    secrets: { openaiApiKey: "saved-dictation-only-key" },
    resumeState: {
      selectedProvider: "openai",
      selectedModel: "gpt-4o",
      baseUrl: "",
      customModel: "",
    },
  });
  await step.type("onboarding.rehaul.provider.apiKeyPlaceholder", "uncommitted-assistant-key");
  await step.wait(500);
  await step.answerConnection({ success: false, errorCode: "credentialsRejected", status: 401 });
  assert.equal(step.proceedDisabled(), true);
  await step.skip();
  assert.equal(step.skipped(), 1);
  assert.equal(step.state().openaiApiKey, "saved-dictation-only-key");
});

test("dictation setup never exposes an assistant skip even when a callback is supplied", async (t) => {
  const step = await mountByokStep(t, { settings: dictation });
  assert.equal(step.skipButton(), undefined);
  assert.equal(step.proceedDisabled(), true);
});

for (const mode of ["byok", "local"]) {
  test(`${mode} skip disables reasoning and completes the existing route without touching provider configuration`, async () => {
    const { skipOptionalAssistantSetup } =
      await import("../../src/components/onboarding/optionalAssistantSetup.ts");
    const events = [];
    const state = {
      provider: "my-transcription",
      model: "my-model",
      key: "saved",
      useCleanupModel: true,
      useDictationAgent: true,
    };
    const result = await skipOptionalAssistantSetup({
      stepId: `${mode}-assistant`,
      route: ["auth", `${mode}-dictation`, `${mode}-assistant`],
      disableReasoning: () => {
        state.useCleanupModel = false;
        state.useDictationAgent = false;
        events.push("disable");
      },
      complete: async (chosen) => {
        events.push(`complete:${chosen}`);
      },
    });
    assert.equal(result, true);
    assert.deepEqual(events, ["disable", `complete:${mode}`]);
    assert.deepEqual(state, {
      provider: "my-transcription",
      model: "my-model",
      key: "saved",
      useCleanupModel: false,
      useDictationAgent: false,
    });
  });
}

test("required models, dictation and off-route assistant steps cannot be skipped", async () => {
  const { skipOptionalAssistantSetup } =
    await import("../../src/components/onboarding/optionalAssistantSetup.ts");
  for (const [stepId, route] of [
    ["required-models", ["required-models"]],
    ["byok-assistant", ["required-models", "byok-dictation", "byok-assistant"]],
    ["byok-dictation", ["byok-dictation", "byok-assistant"]],
    ["local-dictation", ["local-dictation", "local-assistant"]],
    ["byok-assistant", ["byok-dictation"]],
  ]) {
    assert.equal(
      await skipOptionalAssistantSetup({
        stepId,
        route,
        disableReasoning: () => assert.fail("must not change settings"),
        complete: async () => assert.fail("must not complete onboarding"),
      }),
      false
    );
  }
});

test("Skip shares ordinary completion and local optional setup, leaving later Settings setup intact", () => {
  const source = readFileSync("src/components/OnboardingFlow.tsx", "utf8");
  const skip = source.slice(
    source.indexOf("const skipAssistantSetup"),
    source.indexOf("const canContinue")
  );
  assert.match(skip, /updateCleanupSettings\(\{ useCleanupModel: false \}\)/);
  assert.match(skip, /setUseDictationAgent\(false\)/);
  assert.match(skip, /complete: finalizeOnboarding/);
  assert.match(skip, /await skipAssistantSetup\(\)/);
  assert.doesNotMatch(
    skip,
    /setChatAgent|setCloudTranscription|applyReasoningSelectionToAllScopes|set.*Key/
  );
  const completion = source.slice(
    source.indexOf("const finalizeOnboarding"),
    source.indexOf("const applyReasoningSelectionToAllScopes")
  );
  assert.match(completion, /clearSession\(\)/);
  assert.match(completion, /localStorage.setItem\("onboardingCompleted", "true"\)/);
  assert.match(completion, /registerHotkey\(/);
  assert.match(source, /onSkip=\{\s*currentStepId === "byok-assistant"/);
  const english = JSON.parse(readFileSync("src/locales/en/translation.json", "utf8"));
  assert.equal(english.onboarding.rehaul.provider.skipAssistantSetup, "Skip assistant setup");
});

test("returning to a saved assistant step restores the draft but can still skip without saving its key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: dictation,
    secrets: { openaiApiKey: "saved-dictation-only-key" },
  });
  await step.chooseProvider("openai");
  await step.type("onboarding.rehaul.provider.apiKeyPlaceholder", "unsaved-assistant-key");
  const drafts = await step.unmountForDrafts();
  const saved = JSON.parse(JSON.stringify(drafts.at(-1)));
  assert.equal(saved.selectedProvider, "openai");
  assert.equal(JSON.stringify(saved).includes("unsaved-assistant-key"), false);
  await step.remountWithDraft(saved);
  assert.equal(step.selectValues()[0], "openai");
  assert.ok(step.skipButton());
  await step.skip();
  assert.equal(step.skipped(), 1);
  assert.equal(step.proceeded(), 0);
  assert.equal(step.state().openaiApiKey, "saved-dictation-only-key");
  assert.equal(step.state().cloudTranscriptionModel, dictation.cloudTranscriptionModel);
});

test("skipping persists both reasoning switches off without changing saved transcription settings", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: { ...dictation, useCleanupModel: "true", useDictationAgent: "true" },
    secrets: { openaiApiKey: "saved-dictation-only-key" },
  });
  const { skipOptionalAssistantSetup } =
    await import("../../src/components/onboarding/optionalAssistantSetup.ts");
  await require("react").act(async () =>
    skipOptionalAssistantSetup({
      stepId: "byok-assistant",
      route: ["byok-dictation", "byok-assistant"],
      disableReasoning: () => {
        step.state().updateCleanupSettings({ useCleanupModel: false });
        step.state().setUseDictationAgent(false);
      },
      complete: async (mode) => assert.equal(mode, "byok"),
    })
  );
  assert.equal(step.state().useCleanupModel, false);
  assert.equal(step.state().useDictationAgent, false);
  assert.equal(localStorage.getItem("useCleanupModel"), "false");
  assert.equal(localStorage.getItem("useDictationAgent"), "false");
  assert.equal(step.state().cloudTranscriptionProvider, "openai");
  assert.equal(step.state().cloudTranscriptionModel, "gpt-4o-mini-transcribe");
  assert.equal(step.state().openaiApiKey, "saved-dictation-only-key");
});
