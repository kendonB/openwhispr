const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerElevenLabsStreamingIpc } = require("../../src/helpers/elevenLabsStreamingIpc");
function setup() {
  const handlers = {},
    clients = [];
  let key = "fake-first-key";
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  registerElevenLabsStreamingIpc({
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
      on: (name, fn) => {
        handlers[name] = fn;
      },
    },
    getApiKey: () => key,
    startFailure: (error) => ({ success: false, error: error.message, code: error.code }),
    createStreaming: () => {
      const client = {
        isConnected: false,
        sent: [],
        connect: async function (options) {
          this.options = options;
          this.isConnected = true;
        },
        sendAudio: function (audio) {
          this.sent.push(audio);
        },
        finalize: function () {
          this.finalized = true;
        },
        disconnect: async function () {
          this.isConnected = false;
          return { text: "Final" };
        },
        cleanup: function () {
          this.isConnected = false;
          this.cleaned = true;
        },
        getStatus: function () {
          return { isConnected: this.isConnected };
        },
      };
      clients.push(client);
      return client;
    },
  });
  return {
    clients,
    sender,
    setKey: (value) => {
      key = value;
    },
    call: (name, options, from = sender) =>
      handlers[`elevenlabs-streaming-${name}`]({ sender: from }, options),
  };
}
test("warmup is free; start reads saved key, ignores injected credentials, and forwards finals", async () => {
  const { call, clients, sender } = setup();
  await call("warmup");
  assert.equal(clients.length, 0);
  await call("start", { apiKey: "injected", language: "fr" });
  assert.equal(clients[0].options.apiKey, "fake-first-key");
  const emitted = [];
  sender.send = (...args) => emitted.push(args);
  clients[0].onFinalTranscript("Final");
  assert.deepEqual(emitted, [["elevenlabs-final-transcript", "Final"]]);
  assert.equal((await call("stop")).text, "Final");
  assert.equal(sender.listenerCount("destroyed"), 0);
});
test("audio and stop are owned by their starting renderer; next recording reads rotated key", async () => {
  const { call, clients, sender, setKey } = setup();
  await call("start");
  assert.equal((await call("start")).success, false);
  call("send", Buffer.alloc(2), {});
  call("finalize", undefined, {});
  assert.equal((await call("stop", undefined, {})).success, false);
  assert.equal(clients[0].sent.length, 0);
  assert.equal(clients[0].finalized, undefined);
  call("send", Buffer.alloc(2));
  call("finalize");
  assert.equal(clients[0].sent.length, 1);
  assert.equal(clients[0].finalized, true);
  await call("stop");
  setKey("fake-rotated-key");
  await call("start");
  assert.equal(clients[1].options.apiKey, "fake-rotated-key");
  sender.emit("destroyed");
  assert.equal(clients[1].cleaned, true);
});

test("dictation IPC puts non-verbatim on the actual socket URL", async (t) => {
  const { ElevenLabsStreaming } = require("../../src/helpers/elevenLabsStreaming");
  let socket;
  class Socket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      socket = this;
      queueMicrotask(() =>
        this.emit("message", JSON.stringify({ message_type: "session_started" }))
      );
    }
    terminate() {
      this.readyState = 3;
    }
  }
  const handlers = {};
  const client = new ElevenLabsStreaming({ WebSocketImpl: Socket });
  t.after(() => client.cleanup());
  registerElevenLabsStreamingIpc({
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
      on() {},
    },
    createStreaming: () => client,
    getApiKey: () => "test-only-key",
    startFailure: (error) => {
      throw error;
    },
  });
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  const result = await handlers["elevenlabs-streaming-start"]({ sender }, {});
  assert.equal(result.success, true);
  assert.equal(new URL(socket.url).searchParams.get("no_verbatim"), "true");
});
