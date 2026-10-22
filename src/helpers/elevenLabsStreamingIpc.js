// A fresh socket per dictation avoids billing idle warmups and stale credentials.
// Only the renderer that starts the session may feed, finalize or stop it.
function registerElevenLabsStreamingIpc({ ipcMain, createStreaming, getApiKey, startFailure }) {
  let streaming = null;
  let owner = null;
  let starting = false;
  let detachOwner = null;
  const release = () => {
    detachOwner?.();
    detachOwner = null;
    owner = null;
  };
  ipcMain.handle("elevenlabs-streaming-warmup", async () => ({ success: true }));
  ipcMain.handle("elevenlabs-streaming-start", async (event, options = {}) => {
    if (starting || streaming?.isConnected)
      return { success: false, error: "Operation in progress" };
    starting = true;
    const client = createStreaming();
    streaming = client;
    release();
    owner = event.sender;
    const sender = owner;
    const emit = (channel, data) => {
      if (streaming === client && !sender.isDestroyed()) sender.send(channel, data);
    };
    client.onPartialTranscript = (text) => emit("elevenlabs-partial-transcript", text);
    client.onFinalTranscript = (text) => emit("elevenlabs-final-transcript", text);
    client.onError = (error) => emit("elevenlabs-error", error.message);
    const destroyed = () => {
      client.cleanup();
      release();
    };
    sender.once("destroyed", destroyed);
    detachOwner = () => sender.removeListener("destroyed", destroyed);
    try {
      await client.connect({
        apiKey: getApiKey(),
        sampleRate: options.sampleRate,
        language: options.language,
        noVerbatim: true, // Dictation removes fillers; shared meeting clients keep their default.
      });
      return { success: true, usedWarmConnection: false };
    } catch (error) {
      client.cleanup();
      release();
      return startFailure(error);
    } finally {
      starting = false;
    }
  });
  ipcMain.on("elevenlabs-streaming-send", (event, audio) => {
    if (event.sender === owner) streaming?.sendAudio(Buffer.from(audio));
  });
  ipcMain.on("elevenlabs-streaming-finalize", (event) => {
    if (event.sender === owner) streaming?.finalize();
  });
  ipcMain.handle("elevenlabs-streaming-stop", async (event) => {
    if (owner && event.sender !== owner)
      return { success: false, error: "Session belongs to another window" };
    const client = streaming;
    try {
      const result = await client?.disconnect(true);
      return {
        success: true,
        text: result?.text || "",
        model: "scribe_v2_realtime",
        audioBytesSent: client?.audioBytesSent || 0,
      };
    } catch (error) {
      return startFailure(error);
    } finally {
      if (streaming === client) {
        streaming = null;
        release();
      }
    }
  });
  ipcMain.handle(
    "elevenlabs-streaming-status",
    async () => streaming?.getStatus() || { isConnected: false, isConnecting: false }
  );
}
module.exports = { registerElevenLabsStreamingIpc };
