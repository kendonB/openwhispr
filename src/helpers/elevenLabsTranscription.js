const { net } = require("electron");
const {
  providerError,
  providerHttpError,
  PROVIDER_ERROR_CODES: C,
} = require("./providerHttpErrors");

const ELEVENLABS_BATCH_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const context = { provider: "ElevenLabs", surface: "transcription", model: "scribe_v2" };

async function transcribeWithElevenLabs(
  { audioBuffer, apiKey, language, contentType = "audio/webm", fileName = "audio.webm" },
  fetchImpl = (url, init) => net.fetch(url, init)
) {
  if (!apiKey?.trim()) throw providerError(C.KEY_MISSING, context);
  const audio = Buffer.from(audioBuffer);
  if (!audio.length) throw providerError(C.BAD_REQUEST, context);
  if (audio.length > MAX_AUDIO_BYTES) throw providerError(C.PAYLOAD_TOO_LARGE, context);
  const body = new FormData();
  body.append("file", new Blob([audio], { type: contentType }), fileName);
  body.append("model_id", "scribe_v2");
  body.append("tag_audio_events", "false");
  body.append("timestamps_granularity", "none");
  if (language && language !== "auto") body.append("language_code", language.split("-")[0]);
  let response;
  try {
    response = await fetchImpl(ELEVENLABS_BATCH_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey.trim() },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    // Never propagate network errors that may carry request headers or URLs.
    throw providerError(error.name === "TimeoutError" ? C.TIMEOUT : C.UNREACHABLE, context);
  }
  if (!response.ok) {
    // ElevenLabs may report quota exhaustion under HTTP 401. Read only its
    // machine status; never retain or log arbitrary provider text.
    const body = await response.json().catch(() => null);
    const status = body?.detail?.status;
    const codes = {
      quota_exceeded: C.QUOTA_EXHAUSTED,
      invalid_api_key: C.AUTH_FAILED,
      missing_permissions: C.ACCESS_DENIED,
      too_many_concurrent_requests: C.RATE_LIMITED,
      system_busy: C.UNAVAILABLE,
    };
    if (Object.hasOwn(codes, status)) throw providerError(codes[status], context);
    throw providerHttpError({ ...context, status: response.status });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw providerError(C.ERROR, context);
  }
  if (typeof data?.text !== "string") throw providerError(C.ERROR, context);
  return { text: data.text, model: "scribe_v2" };
}

module.exports = { transcribeWithElevenLabs, ELEVENLABS_BATCH_URL };
