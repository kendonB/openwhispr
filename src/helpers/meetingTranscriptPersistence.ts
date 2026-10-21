import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// The final transcript is persisted from the store's stop path, not from a
// notes-view effect: a recording can stop without the user driving it
// (auto-end, owner loss) while another view is open, and any persistence keyed
// to a mounted editor would silently drop the tail since the last periodic
// save. Delayed diarization results are handled by the store's #1495 listener.
//
// Write the current segments immediately for the editor, then reconcile finals
// delivered while main drains the provider. Manual-commit providers may retain
// several seconds of speech until stop; those finals must retain speaker metadata.
export async function persistFinalTranscriptAroundStop<T>({
  segments,
  serializeSegments,
  persist,
  stop,
  fallbackTranscript,
  finalizedSegments,
}: {
  segments: TranscriptSegment[];
  serializeSegments: (segments: TranscriptSegment[]) => string;
  persist: (transcript: string) => Promise<void>;
  stop: () => Promise<T>;
  fallbackTranscript: () => string;
  finalizedSegments?: () => TranscriptSegment[];
}): Promise<T> {
  const initialTranscript = segments.length > 0 ? serializeSegments(segments) : null;
  const segmentWrite = initialTranscript !== null ? persist(initialTranscript) : null;

  const result = await stop();

  if (segmentWrite) await segmentWrite;
  const finalSegments = finalizedSegments?.();
  if (finalSegments && (finalSegments.length > 0 || initialTranscript !== null)) {
    const finalTranscript = serializeSegments(finalSegments);
    if (finalTranscript !== initialTranscript) await persist(finalTranscript);
  } else if (!segmentWrite) {
    const fallback = fallbackTranscript();
    if (fallback) await persist(fallback);
  }
  return result;
}
