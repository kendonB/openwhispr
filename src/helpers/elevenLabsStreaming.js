const WebSocket = require("ws");
const {
  providerError,
  providerHttpError,
  PROVIDER_ERROR_CODES: C,
} = require("./providerHttpErrors");

const MODEL = "scribe_v2_realtime";
const context = { provider: "ElevenLabs", surface: "transcription", model: MODEL };
const ERROR_CODES = {
  auth_error: C.AUTH_FAILED,
  quota_exceeded: C.QUOTA_EXHAUSTED,
  unaccepted_terms: C.ACCESS_DENIED,
  rate_limited: C.RATE_LIMITED,
  commit_throttled: C.RATE_LIMITED,
  queue_overflow: C.UNAVAILABLE,
  resource_exhausted: C.UNAVAILABLE,
  transcriber_error: C.UNAVAILABLE,
  session_time_limit_exceeded: C.UNAVAILABLE,
  insufficient_audio_activity: C.TIMEOUT,
  input_error: C.BAD_REQUEST,
  invalid_request: C.BAD_REQUEST,
  chunk_size_exceeded: C.PAYLOAD_TOO_LARGE,
  error: C.ERROR,
};

function buildElevenLabsUrl({ sampleRate = 16000, language } = {}) {
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate)) {
    throw providerError(C.BAD_REQUEST, context);
  }
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", MODEL);
  url.searchParams.set("audio_format", `pcm_${sampleRate}`);
  url.searchParams.set("commit_strategy", "manual");
  if (language && language !== "auto")
    url.searchParams.set("language_code", language.split("-")[0]);
  return url.toString();
}

// Dictation uses explicit commits. Send every 20s (before the server's ~36s
// automatic segmentation) and once at stop, then wait for ALL commit replies.
// There is no separate final_transcript event in Scribe's public protocol.
class ElevenLabsStreaming {
  constructor({ WebSocketImpl = WebSocket, connectTimeoutMs = 15000, finalTimeoutMs = 8000 } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.finalTimeoutMs = finalTimeoutMs;
    this.currentModel = MODEL;
    this.isConnected = false;
    this.isConnecting = false;
    this.ws = null;
    this.audioBytesSent = 0;
    this.text = "";
    this.completedSegments = [];
  }

  connect({ apiKey, sampleRate = 16000, language } = {}) {
    if (this.ws || this.isConnecting) return Promise.reject(providerError(C.BAD_REQUEST, context));
    if (!apiKey?.trim()) return Promise.reject(providerError(C.KEY_MISSING, context));
    const url = buildElevenLabsUrl({ sampleRate, language });
    this.sampleRate = sampleRate;
    this.isConnecting = true;
    this.failure = null;
    this.finalizing = false;
    this.pendingCommits = 0;
    this.commitOffsets = [];
    this.nextSegmentByteOffset = 0;
    this.sessionStartedAt = null;
    this.completedSegments = [];
    this.segmentBytes = 0;
    this.audioBytesSent = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.text = "";
    this.finalPromise = null;
    return new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      this.connectTimer = setTimeout(() => this.fail(C.TIMEOUT), this.connectTimeoutMs);
      let socket;
      try {
        socket = new this.WebSocketImpl(url, { headers: { "xi-api-key": apiKey.trim() } });
      } catch {
        this.fail(C.UNREACHABLE);
        return;
      }
      this.ws = socket;
      socket.on("message", (raw) => {
        if (this.ws !== socket) return;
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          this.fail(C.ERROR);
          return;
        }
        if (Object.hasOwn(ERROR_CODES, data.message_type)) {
          this.fail(ERROR_CODES[data.message_type]);
        } else if (data.message_type === "session_started" && this.isConnecting) {
          clearTimeout(this.connectTimer);
          this.rejectConnect = null;
          this.isConnecting = false;
          this.isConnected = true;
          const queued = this.queue;
          this.queue = [];
          this.queueBytes = 0;
          for (const chunk of queued) this.sendAudio(chunk);
          if (this.failure) reject(this.failure);
          else resolve();
        } else if (data.message_type === "partial_transcript") {
          if (typeof data.text === "string") this.onPartialTranscript?.(data.text);
        } else if (data.message_type === "committed_transcript") {
          if (typeof data.text !== "string") return this.fail(C.ERROR);
          const segmentByteOffset = this.commitOffsets.shift() ?? this.nextSegmentByteOffset;
          if (data.text.trim()) {
            this.completedSegments.push(data.text.trim());
            this.text = this.completedSegments.join(" ");
            const timestamp =
              this.sessionStartedAt == null
                ? Date.now()
                : this.sessionStartedAt + (segmentByteOffset / (this.sampleRate * 2)) * 1000;
            this.onFinalTranscript?.(this.text, timestamp);
          }
          if (this.pendingCommits > 0) this.pendingCommits--;
          if (this.finalizing && this.pendingCommits === 0) this.resolveFinal?.();
        }
        // Timestamp/entity events supplement the same commit; never append twice.
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        this.fail(providerHttpError({ ...context, status: response.statusCode }));
      });
      socket.on("error", () => {
        if (this.ws === socket) this.fail(C.UNREACHABLE);
      });
      socket.on("close", () => {
        if (this.ws === socket) this.fail(C.UNREACHABLE);
      });
    });
  }

  sendAudio(audio) {
    if (this.failure || this.finalizing) return false;
    const buffer = Buffer.from(audio);
    if (!buffer.length) return true;
    if (buffer.length % 2 !== 0) {
      this.fail(C.BAD_REQUEST);
      return false;
    }
    if (this.isConnecting) {
      // Bound memory; failing triggers the recorder's retained-audio batch fallback.
      if (this.queueBytes + buffer.length > this.sampleRate * 2 * 5) {
        this.fail(C.UNAVAILABLE);
        return false;
      }
      this.queue.push(buffer);
      this.queueBytes += buffer.length;
      return true;
    }
    if (!this.isConnected) return false;
    if (this.sessionStartedAt == null) this.sessionStartedAt = Date.now();
    // At most one second of PCM per message, including buffered cold-start audio.
    for (let offset = 0; offset < buffer.length; offset += this.sampleRate * 2) {
      const chunk = buffer.subarray(offset, offset + this.sampleRate * 2);
      this.segmentBytes += chunk.length;
      const commit = this.segmentBytes >= this.sampleRate * 2 * 20;
      if (!this.sendChunk(chunk, commit)) return false;
      this.audioBytesSent += chunk.length;
    }
    return true;
  }

  sendChunk(buffer, commit) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.fail(C.UNREACHABLE);
      return false;
    }
    if (this.ws.bufferedAmount > this.sampleRate * 2 * 5) {
      this.fail(C.UNAVAILABLE);
      return false;
    }
    if (commit) {
      this.pendingCommits++;
      this.commitOffsets.push(this.nextSegmentByteOffset);
      this.nextSegmentByteOffset = this.audioBytesSent + buffer.length;
      this.segmentBytes = 0;
    }
    const socket = this.ws;
    try {
      socket.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: buffer.toString("base64"),
          sample_rate: this.sampleRate,
          commit,
        }),
        (error) => {
          if (error && this.ws === socket) this.fail(C.UNREACHABLE);
        }
      );
      return true;
    } catch {
      this.fail(C.UNREACHABLE);
      return false;
    }
  }

  finalize() {
    if (this.finalizing || this.failure) return;
    if (!this.isConnected) return;
    this.finalizing = true;
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    // finalize is fire-and-forget over IPC; disconnect consumes the same promise.
    this.finalPromise.catch(() => {});
    this.finalTimer = setTimeout(() => this.fail(C.TIMEOUT), this.finalTimeoutMs);
    if (this.segmentBytes > 0) this.sendChunk(Buffer.alloc(0), true);
    if (this.pendingCommits === 0) this.resolveFinal();
  }

  async disconnect(waitForFinal = true) {
    try {
      if (waitForFinal) {
        if (this.failure) throw this.failure;
        if (this.isConnecting || (!this.isConnected && !this.finalPromise))
          throw providerError(C.NO_RESPONSE, context);
        this.finalize();
        if (this.finalPromise) await this.finalPromise;
        if (this.failure) throw this.failure;
      }
      return { text: this.text };
    } finally {
      this.cleanup();
    }
  }

  fail(code) {
    if (this.failure) return;
    const error = code instanceof Error ? code : providerError(code, context);
    const activeFailure = this.isConnected && !this.finalizing;
    const recoverable =
      activeFailure && [C.UNREACHABLE, C.UNAVAILABLE, C.TIMEOUT].includes(error.code);
    this.failure = error;
    this.rejectConnect?.(error);
    this.rejectFinal?.(error);
    this.cleanup();
    this.onError?.(error);
    if (recoverable) this.onConnectionLost?.(error);
    else if (activeFailure) this.onFatalError?.(error);
  }

  cleanup() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.finalTimer);
    this.rejectConnect?.(providerError(C.NO_RESPONSE, context));
    this.rejectFinal?.(providerError(C.NO_RESPONSE, context));
    this.rejectConnect = null;
    this.rejectFinal = null;
    this.resolveFinal = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.queue = [];
    this.queueBytes = 0;
    const socket = this.ws;
    this.ws = null;
    socket?.terminate();
  }

  getStatus() {
    return { isConnected: this.isConnected, isConnecting: this.isConnecting };
  }
}

module.exports = { ElevenLabsStreaming, buildElevenLabsUrl };
