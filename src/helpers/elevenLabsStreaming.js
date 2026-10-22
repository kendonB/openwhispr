const WebSocket = require("ws");
const modelRegistryData = require("../models/modelRegistryData.json");
const {
  providerError,
  providerHttpError,
  PROVIDER_ERROR_CODES: C,
} = require("./providerHttpErrors");

const MODEL = modelRegistryData.transcriptionProviders
  .find((provider) => provider.id === "elevenlabs")
  .models.find((model) => model.streaming).id;
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
// Refusals a new session would meet again. Anything else mid-session is worth a reconnect.
const PERMANENT_CODES = new Set([
  C.AUTH_FAILED,
  C.QUOTA_EXHAUSTED,
  C.ACCESS_DENIED,
  C.BAD_REQUEST,
  C.PAYLOAD_TOO_LARGE,
]);
// The server commits by itself after ~36 s of uncommitted audio.
const MANUAL_COMMIT_SECONDS = 20;
const MEETING_SILENCE_SECONDS = 1.5;
const SPEECH_RMS_THRESHOLD = 0.003;

// Fillers are removed in dictation and meetings alike.
function buildElevenLabsUrl({ sampleRate = 16000, language } = {}) {
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate)) {
    throw providerError(C.BAD_REQUEST, context);
  }
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", MODEL);
  url.searchParams.set("audio_format", `pcm_${sampleRate}`);
  url.searchParams.set("commit_strategy", "manual");
  url.searchParams.set("no_verbatim", "true");
  if (language && language !== "auto")
    url.searchParams.set("language_code", language.split("-")[0]);
  return url.toString();
}

// Manual commits let stop count every outstanding reply. Meetings also commit
// after a pause; server VAD replies have no IDs to distinguish them from a stop
// reply. The 20 s limit avoids the server's automatic ~36 s commit.
class ElevenLabsStreaming {
  constructor({
    WebSocketImpl = WebSocket,
    connectTimeoutMs = 15000,
    finalTimeoutMs = 8000,
    commitOnSilence = true,
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.finalTimeoutMs = finalTimeoutMs;
    this.commitOnSilence = commitOnSilence;
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
    this.finalPromise = null;
    this.segmentBytes = 0;
    this.silenceBytes = 0;
    this.segmentHasSpeech = false;
    this.commitOffsets = [];
    this.nextSegmentByteOffset = 0;
    this.sessionStartedAt = null;
    this.completedSegments = [];
    this.audioBytesSent = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.text = "";
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
          if (typeof data.text !== "string") return;
          this.onPartialTranscript?.(data.text);
        } else if (data.message_type === "committed_transcript") {
          if (typeof data.text !== "string") return this.fail(C.ERROR);
          const text = data.text.trim();
          const startBytes = this.commitOffsets.shift();
          if (startBytes === undefined) return this.fail(C.ERROR);
          if (text) {
            this.completedSegments.push(text);
            this.text = this.completedSegments.join(" ");
            const timestamp = this.sessionStartedAt + (startBytes / (this.sampleRate * 2)) * 1000;
            this.onFinalTranscript?.(this.text, timestamp);
          } else {
            // A commit of only fillers or silence still settles its partial.
            this.onPartialTranscript?.("");
          }
          if (this.finalizing && this.commitOffsets.length === 0) this.resolveFinal?.();
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
    const bytesPerSecond = this.sampleRate * 2;
    if (this.isConnecting) {
      // Bound memory while the handshake is pending.
      if (this.queueBytes + buffer.length > bytesPerSecond * 5) {
        this.fail(C.UNAVAILABLE);
        return false;
      }
      this.queue.push(buffer);
      this.queueBytes += buffer.length;
      return true;
    }
    if (!this.isConnected) return false;
    if (this.sessionStartedAt == null) this.sessionStartedAt = Date.now();
    // Analyze 50 ms windows even when replaying buffered audio in larger blocks.
    const chunkBytes = this.commitOnSilence ? Math.floor(this.sampleRate / 20) * 2 : bytesPerSecond;
    for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
      const chunk = buffer.subarray(offset, offset + chunkBytes);
      this.segmentBytes += chunk.length;
      if (this.commitOnSilence) {
        let energy = 0;
        for (let i = 0; i < chunk.length; i += 2) {
          const sample = chunk.readInt16LE(i) / 32768;
          energy += sample * sample;
        }
        const speech = Math.sqrt(energy / (chunk.length / 2)) >= SPEECH_RMS_THRESHOLD;
        this.segmentHasSpeech ||= speech;
        this.silenceBytes = speech ? 0 : this.silenceBytes + chunk.length;
      }
      const commit =
        this.segmentBytes >= bytesPerSecond * MANUAL_COMMIT_SECONDS ||
        (this.commitOnSilence &&
          this.segmentHasSpeech &&
          this.segmentBytes >= bytesPerSecond * 2 &&
          this.silenceBytes >= bytesPerSecond * MEETING_SILENCE_SECONDS);
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
      this.commitOffsets.push(this.nextSegmentByteOffset);
      this.nextSegmentByteOffset = this.audioBytesSent + buffer.length;
      this.segmentBytes = 0;
      this.silenceBytes = 0;
      this.segmentHasSpeech = false;
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

  // Commits the tail; settles once every commit has its committed transcript.
  finalize() {
    if (this.finalPromise) return this.finalPromise;
    if (this.failure) return Promise.reject(this.failure);
    if (!this.isConnected) return Promise.reject(providerError(C.NO_RESPONSE, context));
    this.finalizing = true;
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = () => {
        clearTimeout(this.finalTimer);
        this.resolveFinal = null;
        this.rejectFinal = null;
        resolve();
      };
      this.rejectFinal = reject;
    });
    this.finalTimer = setTimeout(() => this.fail(C.TIMEOUT), this.finalTimeoutMs);
    if (this.segmentBytes > 0) this.sendChunk(Buffer.alloc(0), true);
    // A failed tail commit has already rejected the promise and cleared resolveFinal.
    if (this.commitOffsets.length === 0) this.resolveFinal?.();
    return this.finalPromise;
  }

  async disconnect() {
    try {
      if (this.failure) throw this.failure;
      if (!this.isConnected) throw providerError(C.NO_RESPONSE, context);
      await this.finalize();
      return { text: this.text };
    } finally {
      this.cleanup();
    }
  }

  fail(code) {
    if (this.failure) return;
    const error = code instanceof Error ? code : providerError(code, context);
    // Outside an active session, connect() or disconnect() rejects with the error instead.
    const active = this.isConnected && !this.finalizing;
    this.failure = error;
    this.rejectConnect?.(error);
    this.rejectFinal?.(error);
    this.cleanup();
    if (!active) return;
    const handler = PERMANENT_CODES.has(error.code) ? this.onFatalError : this.onConnectionLost;
    (handler || this.onError)?.(error);
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
}

module.exports = { ElevenLabsStreaming, buildElevenLabsUrl };
