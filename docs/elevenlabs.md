# ElevenLabs speech to text (bring your own key)

In **Settings → Speech to Text**, choose **Providers → ElevenLabs**, enter your
ElevenLabs API key in the password field, and choose:

- **Scribe v2** (`scribe_v2`): batch dictation. Recorded audio is uploaded when you stop.
- **Scribe v2 Realtime** (`scribe_v2_realtime`): live dictation with partial text while
  recording and confirmed text after stopping.

File uploads and history retries use Scribe v2, including when Realtime is selected.
No OpenWhispr Cloud subscription or sign-in is required for this provider.
ElevenLabs bills transcription to the account associated with your key.

Use a key with Speech to Text access. The settings connection check requests and
immediately discards a temporary token for the selected STT mode; it sends no audio
and performs no transcription. A successful check verifies access, not transcription
quality or remaining quota. Keys can also be supplied through `ELEVENLABS_API_KEY`
in an existing development environment. Do not put keys in source files or logs.

Keys follow OpenWhispr's existing credential storage: Electron safeStorage and the
OS keyring when available, with the app's existing fallback when no keyring is
available. Replacing or clearing the key uses the same settings controls as other
providers. Each recording reads the saved key afresh; there are no billed idle
warmup sessions. Both upload and WebSocket authentication happen in Electron's
main process using the `xi-api-key` header, never URL parameters.

## Behavior and limits

- Realtime dictation sends mono signed 16-bit little-endian PCM at 16 kHz. It waits
  for `session_started` before sending queued audio, commits every 20 seconds and
  at stop, and waits up to eight seconds for outstanding committed transcripts.
  Partial or supplementary timestamp events cannot become a successful final
  result. Errors and finalization timeouts use the existing retained-audio batch
  recovery path where a recording is available.
- Batch requests use multipart uploads, preserve the recorded/file MIME type,
  disable audio-event tags, and return the API's `text`. The app retains its existing
  **25 MiB** BYOK file limit and applies a two-minute request timeout.
- Dictation honors the selected language; Auto omits the hint. File uploads use
  automatic language detection, consistent with other upload providers.
- Live **Note Recording/meeting transcription** is not offered for ElevenLabs in
  this change. The existing meeting-provider allowlist remains authoritative.
  Audio file uploads are supported. Native ElevenLabs diarization, timestamps,
  keyterm prompting, transcript editing, and regional endpoints are not exposed.
- No actual account credentials or audio were used during development. Tests mock
  the WebSocket, HTTP API, and IPC lifecycle. A credentialed microphone/desktop
  smoke test and cross-platform packaged application testing remain outstanding.

## Protocol references

Implementation checked against ElevenLabs' official documentation on 2026-10-21:

- [Batch transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [Realtime WebSocket API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
- [Commit strategies and audio formats](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)
- [Realtime events and errors](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)
- [Temporary token API used for the settings check](https://elevenlabs.io/docs/api-reference/tokens/create)
