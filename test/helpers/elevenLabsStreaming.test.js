const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  ElevenLabsStreaming,
  buildElevenLabsUrl,
} = require("../../src/helpers/elevenLabsStreaming");

class Socket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    Socket.instances.push(this);
  }
  send(message, callback) {
    this.sent.push(JSON.parse(message));
    callback?.();
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}
const audio = Buffer.alloc(3200, 4);
async function ready(t, options = {}) {
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket, ...options });
  t.after(() => client.cleanup());
  const connecting = client.connect({ apiKey: "fake-test-key", language: "en-US" });
  const socket = Socket.instances.at(-1);
  socket.receive({ message_type: "session_started" });
  await connecting;
  return { client, socket };
}

test("protocol uses fixed endpoint, model, PCM and header auth; readiness waits for session", async (t) => {
  const url = new URL(buildElevenLabsUrl({ language: "auto" }));
  assert.equal(url.origin, "wss://api.elevenlabs.io");
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(url.searchParams.get("commit_strategy"), "manual");
  assert.equal(url.searchParams.has("language_code"), false);
  assert.throws(() => buildElevenLabsUrl({ sampleRate: 1234 }));
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket });
  t.after(() => client.cleanup());
  const promise = client.connect({ apiKey: "fake-test-key" });
  const socket = Socket.instances.at(-1);
  assert.equal(socket.options.headers["xi-api-key"], "fake-test-key");
  assert.equal(socket.url.includes("fake-test-key"), false);
  assert.equal(client.isConnected, false);
  assert.equal(client.sendAudio(audio), true);
  assert.equal(socket.sent.length, 0);
  socket.receive({ message_type: "session_started" });
  await promise;
  assert.deepEqual(Buffer.from(socket.sent[0].audio_base_64, "base64"), audio);
  assert.equal(socket.sent[0].sample_rate, 16000);
});

test("stop waits for committed text, ignores supplemental timestamps and never returns a partial", async (t) => {
  const { client, socket } = await ready(t);
  const partials = [],
    finals = [];
  client.onPartialTranscript = (text) => partials.push(text);
  client.onFinalTranscript = (text) => finals.push(text);
  client.sendAudio(audio);
  socket.receive({ message_type: "partial_transcript", text: "unfinished" });
  client.finalize();
  client.finalize();
  assert.equal(socket.sent.filter((m) => m.commit).length, 1);
  let done = false;
  const stop = client.disconnect().then((result) => {
    done = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(done, false);
  socket.receive({ message_type: "committed_transcript_with_timestamps", text: "duplicate" });
  socket.receive({ message_type: "committed_transcript", text: "Finished." });
  assert.deepEqual(await stop, { text: "Finished." });
  assert.deepEqual(partials, ["unfinished"]);
  assert.deepEqual(finals, ["Finished."]);
  assert.equal(socket.readyState, 3);
});

test("long recordings wait for all periodic and final commits", async (t) => {
  const { client, socket } = await ready(t);
  client.sendAudio(Buffer.alloc(16000 * 2 * 21));
  assert.equal(socket.sent.filter((m) => m.commit).length, 1);
  assert.ok(socket.sent.every((m) => Buffer.from(m.audio_base_64, "base64").length <= 32000));
  const stop = client.disconnect();
  assert.equal(socket.sent.filter((m) => m.commit).length, 2);
  socket.receive({ message_type: "committed_transcript", text: "One." });
  assert.equal(client.isConnected, true);
  socket.receive({ message_type: "committed_transcript", text: "Two." });
  assert.deepEqual(await stop, { text: "One. Two." });
});

test("missing key, handshake timeout, early close and cancellation settle pending starts", async (t) => {
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket, connectTimeoutMs: 10 });
  t.after(() => client.cleanup());
  await assert.rejects(client.connect(), { code: "API_KEY_MISSING" });
  await assert.rejects(client.connect({ apiKey: "fake" }), { code: "PROVIDER_TIMEOUT" });
  let start = client.connect({ apiKey: "fake" });
  Socket.instances.at(-1).emit("close");
  await assert.rejects(start, { code: "PROVIDER_UNREACHABLE" });
  start = client.connect({ apiKey: "fake" });
  client.cleanup();
  await assert.rejects(start, { code: "PROVIDER_NO_RESPONSE" });
});

for (const [message_type, code] of [
  ["auth_error", "PROVIDER_AUTH_FAILED"],
  ["quota_exceeded", "PROVIDER_QUOTA_EXHAUSTED"],
  ["rate_limited", "PROVIDER_RATE_LIMITED"],
  ["input_error", "PROVIDER_BAD_REQUEST"],
  ["unaccepted_terms", "PROVIDER_ACCESS_DENIED"],
  ["error", "PROVIDER_ERROR"],
]) {
  test(`server ${message_type} is classified without exposing raw details`, async (t) => {
    const { client, socket } = await ready(t);
    let error;
    client.onError = (e) => {
      error = e;
    };
    socket.receive({ message_type, error: "fake-test-key sensitive server body" });
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes("fake-test-key"), false);
    await assert.rejects(client.disconnect(), { code });
  });
}

test("timeout after partial/final segment fails instead of returning truncated text", async (t) => {
  const { client, socket } = await ready(t, { finalTimeoutMs: 10 });
  client.sendAudio(audio);
  socket.receive({ message_type: "partial_transcript", text: "Partial" });
  await assert.rejects(client.disconnect(), { code: "PROVIDER_TIMEOUT" });
  assert.equal(client.isConnected, false);
});

test("empty recording stops immediately without sending an invalid empty commit", async (t) => {
  const { client, socket } = await ready(t);
  assert.deepEqual(await client.disconnect(), { text: "" });
  assert.equal(socket.sent.length, 0);
});

test("bounded buffering and malformed events fail closed", async (t) => {
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket });
  t.after(() => client.cleanup());
  const start = client.connect({ apiKey: "fake" });
  assert.equal(client.sendAudio(Buffer.alloc(160001)), false);
  await assert.rejects(start, { code: "PROVIDER_BAD_REQUEST" });
  const { client: other, socket } = await ready(t);
  socket.emit("message", Buffer.from("not json"));
  await assert.rejects(other.disconnect(), { code: "PROVIDER_ERROR" });
});

test("handshake rejection is classified without retaining request or response secrets", async (t) => {
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket });
  t.after(() => client.cleanup());
  const start = client.connect({ apiKey: "fake-test-key" });
  let drained = false;
  Socket.instances.at(-1).emit(
    "unexpected-response",
    { sensitive: "fake-test-key" },
    {
      statusCode: 401,
      resume() {
        drained = true;
      },
    }
  );
  await assert.rejects(
    start,
    (error) =>
      error.code === "PROVIDER_AUTH_FAILED" && !JSON.stringify(error).includes("fake-test-key")
  );
  assert.equal(drained, true);
});

test("cold-start queue overflow and socket backpressure fail instead of dropping audio", async (t) => {
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket });
  t.after(() => client.cleanup());
  const start = client.connect({ apiKey: "fake" });
  assert.equal(client.sendAudio(Buffer.alloc(160002)), false);
  await assert.rejects(start, { code: "PROVIDER_UNAVAILABLE" });
  const { client: connected, socket } = await ready(t);
  socket.bufferedAmount = 160001;
  assert.equal(connected.sendAudio(audio), false);
  await assert.rejects(connected.disconnect(), { code: "PROVIDER_UNAVAILABLE" });
});

test("multiple committed segments publish accumulated text to the existing renderer contract", async (t) => {
  const { client, socket } = await ready(t);
  const finals = [];
  client.onFinalTranscript = (text) => finals.push(text);
  client.sendAudio(Buffer.alloc(640000));
  socket.receive({ message_type: "committed_transcript", text: "First." });
  client.sendAudio(audio);
  const stop = client.disconnect();
  socket.receive({ message_type: "committed_transcript", text: "Second." });
  assert.deepEqual(finals, ["First.", "First. Second."]);
  assert.equal((await stop).text, "First. Second.");
});

test("a closing socket cannot silently discard the last audio and return earlier text", async (t) => {
  const { client, socket } = await ready(t);
  client.sendAudio(audio);
  socket.receive({ message_type: "committed_transcript", text: "Earlier." });
  socket.readyState = 2;
  assert.equal(client.sendAudio(audio), false);
  await assert.rejects(client.disconnect(), { code: "PROVIDER_UNREACHABLE" });
});
