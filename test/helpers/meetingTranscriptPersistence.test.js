const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });
const serialize = (segments) => segments.map((s) => s.text).join("|");

// The note editor swaps from live segments to the stored transcript the moment
// isRecording flips, while the main-side stop can take seconds — so the
// captured segments must be written before that stop is awaited, or the tail
// since the last periodic save visibly disappears until the stop returns.
test("captured segments are written before the stop is awaited", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];

  const result = await persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello"), segment("b", "world")],
    serializeSegments: serialize,
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      events.push("stop");
      return { diarizationSessionId: "diar-1" };
    },
    fallbackTranscript: () => {
      throw new Error("main's transcript must not be consulted when segments exist");
    },
  });

  assert.deepEqual(events, ["persist:hello|world", "stop"]);
  assert.deepEqual(result, { diarizationSessionId: "diar-1" });
});

test("a segment-less recording writes main's final transcript after the stop", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];
  let stopped = false;

  await persistFinalTranscriptAroundStop({
    segments: [],
    serializeSegments: () => {
      throw new Error("must not serialize an empty segment list");
    },
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      stopped = true;
      events.push("stop");
      return null;
    },
    // Only available once main has flushed its final text.
    fallbackTranscript: () => (stopped ? "main text" : ""),
  });

  assert.deepEqual(events, ["stop", "persist:main text"]);
});

test("nothing is written when there are neither segments nor a fallback transcript", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let persisted = 0;

  await persistFinalTranscriptAroundStop({
    segments: [],
    serializeSegments: serialize,
    persist: async () => {
      persisted += 1;
    },
    stop: async () => null,
    fallbackTranscript: () => "",
  });

  assert.equal(persisted, 0);
});

test("the stop result is only returned once the early write has settled", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let releaseWrite;
  const write = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let settled = false;

  const pending = persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello")],
    serializeSegments: serialize,
    persist: () => write,
    stop: async () => "stopped",
    fallbackTranscript: () => "",
  }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the caller must not proceed while the transcript write is in flight"
  );

  releaseWrite();
  assert.equal(await pending, "stopped");
});

test("stop-flushed dual-stream finals are persisted without losing speaker metadata", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const first = {
    ...segment("a", "Earlier"),
    timestamp: 100,
    speakerName: "Alice",
    speakerLocked: true,
  };
  const tail = {
    ...segment("b", "Final commit"),
    source: "mic",
    timestamp: 200,
    speakerName: "Me",
  };
  let live = [first];
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments: live,
    serializeSegments: JSON.stringify,
    persist: async (text) => writes.push(JSON.parse(text)),
    stop: async () => {
      live = [...live, tail];
    },
    finalizedSegments: () => live,
    fallbackTranscript: () => "Earlier Final commit",
  });
  assert.deepEqual(writes, [[first], [first, tail]]);
});

test("final retractions replace the early snapshot, including an empty final list", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments: [segment("a", "echo")],
    serializeSegments: JSON.stringify,
    persist: async (text) => writes.push(text),
    stop: async () => {},
    finalizedSegments: () => [],
    fallbackTranscript: () => "stale echo",
  });
  assert.equal(writes.at(-1), "[]");
});

test("first final arriving at stop is saved as structured segments rather than plain fallback", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const tail = { ...segment("a", "Short meeting"), timestamp: 100, speakerName: "Alice" };
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments: [],
    serializeSegments: JSON.stringify,
    persist: async (text) => writes.push(JSON.parse(text)),
    stop: async () => {},
    finalizedSegments: () => [tail],
    fallbackTranscript: () => "Short meeting",
  });
  assert.deepEqual(writes, [[tail]]);
});

test("unchanged finalized segments do not cause a redundant write", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const segments = [segment("a", "hello")];
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments,
    serializeSegments: JSON.stringify,
    persist: async (text) => writes.push(text),
    stop: async () => {},
    finalizedSegments: () => [...segments],
    fallbackTranscript: () => "unused",
  });
  assert.equal(writes.length, 1);
});

test("renderer keeps final listeners and session identity until main stop settles", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require("node:path").join(__dirname, "../../src/stores/meetingRecordingStore.ts"),
    "utf8"
  );
  const stop = source.slice(
    source.indexOf("export async function stopRecording("),
    source.indexOf("export function lockSpeaker(")
  );
  const mainStop = stop.indexOf("await window.electronAPI?.meetingTranscriptionStop");
  assert.ok(mainStop > 0);
  assert.doesNotMatch(stop.slice(0, mainStop), /activeRecordingSessionId = null/);
  assert.match(stop.slice(0, mainStop), /cleanup\(\{ preserveIpcListeners: true \}\)/);
  assert.match(
    stop.slice(mainStop),
    /finally \{\s*detachMeetingIpcListeners\(\);\s*if \(activeRecordingSessionId === sessionId\) activeRecordingSessionId = null;/
  );
  assert.match(stop, /finalizedSegments: \(\) => useMeetingRecordingStore.getState\(\).segments/);
  assert.match(source, /if \(!preserveIpcListeners\) detachMeetingIpcListeners\(\);/);
});

test("delayed diarization waits for final structured stop persistence before merging", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    require("node:path").join(__dirname, "../../src/stores/meetingRecordingStore.ts"),
    "utf8"
  );
  const handler = source.slice(source.indexOf("enqueueDiarizationCompletion(async () => {"));
  const barrier = handler.indexOf("await meetingRecordingStopBarrier.waitForPendingStop()");
  assert.ok(barrier >= 0);
  assert.ok(barrier < handler.indexOf("useMeetingRecordingStore.getState()"));
  assert.ok(barrier < handler.indexOf("getNote?."));
});
