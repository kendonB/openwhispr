const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const createMeetingTranscriptionLifecycle = require("../../src/helpers/meetingTranscriptionLifecycle");

class MeetingSocket extends EventEmitter {
  constructor(url, options) {
    super();
    assert.equal(
      new URL(url).searchParams.get("no_verbatim"),
      "true",
      "both meeting streams use non-verbatim"
    );
    this.options = options;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.frames = [];
    queueMicrotask(() => this.receive({ message_type: "session_started" }));
  }
  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  send(raw, callback) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    callback?.();
    if (frame.commit)
      queueMicrotask(() =>
        this.receive({ message_type: "committed_transcript", text: this.nextText })
      );
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
}

test("meeting lifecycle routes independent 24kHz mic/system streams and flushes both tails once", async () => {
  const { getMeetingStreamingClient } = require("../../src/helpers/meetingStreamingProviders");
  const { fetchRealtimeTokenForProvider } = require("../../src/helpers/realtimeTokenProviders");
  const { resolveMeetingTranscriptionOptions } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");
  const { getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");
  const options = resolveMeetingTranscriptionOptions({
    transcriptionMode: "providers",
    language: "en",
    selectedProvider: "elevenlabs",
    selectedModel: "scribe_v2_realtime",
    byokProviders: getMeetingStreamingTranscriptionProviders(),
  });
  const segments = [];
  const streams = [];
  let stops = 0;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async () => {
      const keys = await fetchRealtimeTokenForProvider(
        options.provider,
        { environmentManager: { getElevenLabsKey: () => "test-only-key" } },
        options,
        { streams: 2 }
      );
      const Client = getMeetingStreamingClient(options.provider);
      for (const [index, source] of ["mic", "system"].entries()) {
        const client = new Client({ WebSocketImpl: MeetingSocket });
        client.onFinalTranscript = (_text, timestamp) =>
          segments.push({ source, text: client.completedSegments.at(-1), timestamp });
        await client.connect({ ...options, apiKey: keys[index], sampleRate: 24000 });
        streams.push(client);
      }
      return { success: true };
    },
    stop: async () => {
      stops++;
      return Promise.all(streams.map((client) => client.disconnect()));
    },
  });
  await lifecycle.startSession({ sessionId: "fixture-meeting", options });
  assert.notEqual(streams[0].ws, streams[1].ws);
  for (const [index, client] of streams.entries()) {
    client.ws.nextText = index ? "Remote speaker." : "Local speaker.";
    client.sendAudio(Buffer.alloc(24000 * 2, index + 1));
    client.sessionStartedAt = 1000 + index * 1000;
    assert.equal(client.ws.frames[0].sample_rate, 24000);
  }
  const first = lifecycle.stopSession("fixture-meeting");
  const second = lifecycle.stopSession("fixture-meeting");
  assert.deepEqual(await first, [{ text: "Local speaker." }, { text: "Remote speaker." }]);
  await second;
  assert.equal(stops, 1);
  assert.deepEqual(segments, [
    { source: "mic", text: "Local speaker.", timestamp: 1000 },
    { source: "system", text: "Remote speaker.", timestamp: 2000 },
  ]);
  assert.ok(streams.every((client) => !client.isConnected && client.ws === null));
});

test("replacement meeting mic/system sockets preserve non-verbatim on recovery", async () => {
  const { getMeetingStreamingClient } = require("../../src/helpers/meetingStreamingProviders");
  const Client = getMeetingStreamingClient("elevenlabs-realtime");
  const originals = [];
  const replacements = [];
  try {
    for (const source of ["mic", "system"]) {
      const original = new Client({ WebSocketImpl: MeetingSocket });
      originals.push(original);
      await original.connect({ apiKey: "test-only-key", sampleRate: 24000 });
      const oldSocket = original.ws;
      original.cleanup();
      // Main-process recovery constructs fresh clients with the same options.
      const replacement = new Client({ WebSocketImpl: MeetingSocket });
      replacements.push(replacement);
      await replacement.connect({ apiKey: "test-only-key", sampleRate: 24000 });
      assert.notEqual(replacement.ws, oldSocket, source);
      replacement.ws.nextText = `${source} recovered.`;
      replacement.sendAudio(Buffer.alloc(4800));
      assert.deepEqual(await replacement.disconnect(), { text: `${source} recovered.` });
    }
  } finally {
    for (const client of [...originals, ...replacements]) client.cleanup();
  }
});
