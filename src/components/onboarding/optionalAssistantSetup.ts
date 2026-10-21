import type { OnboardingStepId } from "./flow";

/** Finish only an optional, currently reachable assistant step. The provider
 * form is deliberately not committed: draft keys/models must not replace the
 * working dictation setup, and no unconfigured LLM should process dictation. */
export async function skipOptionalAssistantSetup({
  stepId,
  route,
  disableReasoning,
  complete,
}: {
  stepId: OnboardingStepId;
  route: OnboardingStepId[];
  disableReasoning: () => void;
  complete: (mode: "byok" | "local") => Promise<void>;
}): Promise<boolean> {
  if (!route.includes(stepId) || route.includes("required-models")) return false;
  const mode = stepId === "byok-assistant" ? "byok" : stepId === "local-assistant" ? "local" : null;
  if (!mode) return false;
  disableReasoning();
  await complete(mode);
  return true;
}
