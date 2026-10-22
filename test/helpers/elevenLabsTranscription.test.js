const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeWithElevenLabs } = require("../../src/helpers/elevenLabsTranscription");
const { testProviderConnection } = require("../../src/helpers/providerConnectionTest");
const input = { audioBuffer: Buffer.from("mock audio"), apiKey: "fake-test-key" };

test("batch sends multipart Scribe v2, preserves file format and returns final text", async () => {
  const result = await transcribeWithElevenLabs(
    { ...input, language: "fr-CA", fileName: "sample.wav", contentType: "audio/wav" },
    async (url, init) => {
      assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
      assert.equal(init.headers["xi-api-key"], "fake-test-key");
      assert.equal(init.headers["Content-Type"], undefined);
      assert.equal(init.redirect, "error");
      assert.equal(init.body.get("model_id"), "scribe_v2");
      assert.equal(
        init.body.has("no_verbatim"),
        false,
        "shared upload helper preserves its default"
      );
      assert.equal(init.body.get("language_code"), "fr");
      assert.equal(init.body.get("tag_audio_events"), "false");
      const file = init.body.get("file");
      assert.equal(file.name, "sample.wav");
      assert.equal(file.type, "audio/wav");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), input.audioBuffer);
      return Response.json({ text: "Bonjour." });
    }
  );
  assert.deepEqual(result, { text: "Bonjour.", model: "scribe_v2" });
});

test("batch automatic language, silence, malformed responses and network errors", async () => {
  assert.deepEqual(
    await transcribeWithElevenLabs({ ...input, language: "auto" }, async (_url, init) => {
      assert.equal(init.body.has("language_code"), false);
      return Response.json({ text: "" });
    }),
    { text: "", model: "scribe_v2" }
  );
  for (const data of [{}, { text: 3 }])
    await assert.rejects(
      transcribeWithElevenLabs(input, async () => Response.json(data)),
      { code: "PROVIDER_ERROR" }
    );
  await assert.rejects(
    transcribeWithElevenLabs(input, async () => {
      throw new Error("fake-test-key");
    }),
    (error) => error.code === "PROVIDER_UNREACHABLE" && !error.message.includes("fake-test-key")
  );
});
for (const [status, code] of [
  [401, "PROVIDER_AUTH_FAILED"],
  [403, "PROVIDER_ACCESS_DENIED"],
  [429, "PROVIDER_RATE_LIMITED"],
  [500, "PROVIDER_UNAVAILABLE"],
]) {
  test(`batch HTTP ${status} has a safe, actionable error`, async () => {
    await assert.rejects(
      transcribeWithElevenLabs(input, async () => new Response("fake-test-key", { status })),
      (e) => e.code === code && !JSON.stringify(e).includes("fake-test-key")
    );
  });
}
test("batch rejects missing credentials, empty and oversized audio before networking", async () => {
  const noFetch = () => assert.fail("unexpected network request");
  await assert.rejects(transcribeWithElevenLabs({ ...input, apiKey: "" }, noFetch), {
    code: "API_KEY_MISSING",
  });
  await assert.rejects(
    transcribeWithElevenLabs({ ...input, audioBuffer: Buffer.alloc(0) }, noFetch),
    { code: "PROVIDER_BAD_REQUEST" }
  );
  await assert.rejects(
    transcribeWithElevenLabs(
      { ...input, audioBuffer: Buffer.alloc(25 * 1024 * 1024 + 1) },
      noFetch
    ),
    { code: "PROVIDER_PAYLOAD_TOO_LARGE" }
  );
});

test("settings probe checks the selected STT token scope without returning the token", async () => {
  for (const model of ["scribe_v2", "scribe_v2_realtime"]) {
    const result = await testProviderConnection(
      { provider: "elevenlabs", apiKey: "fake", model },
      async (url, init) => {
        assert.equal(
          url,
          `https://api.elevenlabs.io/v1/single-use-token/${model === "scribe_v2" ? "batch_scribe" : "realtime_scribe"}`
        );
        assert.equal(init.method, "POST");
        assert.equal(init.headers["xi-api-key"], "fake");
        return Response.json({ token: "fake-discarded-token" });
      }
    );
    assert.deepEqual(result, { success: true });
  }
});

test("uploads, retries and dictation batch routes stay on ElevenLabs, even with stale models", async () => {
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  for (const model of ["scribe_v2", "scribe_v2_realtime", "gpt-4o-transcribe"]) {
    const route = resolveTranscriptionRoute({
      settings: {
        cloudTranscriptionProvider: "elevenlabs",
        cloudTranscriptionModel: model,
        preferredLanguage: "de-DE",
      },
    });
    assert.equal(route.transport, "proxied");
    assert.equal(route.provider, "elevenlabs");
    assert.equal(route.model, "scribe_v2");
    assert.equal(route.language, "de");
  }
});

test("batch identifies ElevenLabs quota exhaustion even when returned as HTTP 401", async () => {
  await assert.rejects(
    transcribeWithElevenLabs(input, async () =>
      Response.json(
        { detail: { status: "quota_exceeded", message: "sensitive detail" } },
        { status: 401 }
      )
    ),
    { code: "PROVIDER_QUOTA_EXHAUSTED" }
  );
});

test("batch classifies deadline expiry and rejects malformed JSON", async () => {
  await assert.rejects(
    transcribeWithElevenLabs(input, async () => {
      throw new DOMException("expired", "TimeoutError");
    }),
    { code: "PROVIDER_TIMEOUT" }
  );
  await assert.rejects(
    transcribeWithElevenLabs(input, async () => new Response("not json")),
    { code: "PROVIDER_ERROR" }
  );
});

test("batch non-verbatim opt-in serializes the provider field", async () => {
  await transcribeWithElevenLabs({ ...input, noVerbatim: true }, async (_url, init) => {
    assert.equal(init.body.get("no_verbatim"), "true");
    return Response.json({ text: "Clean dictation." });
  });
});
