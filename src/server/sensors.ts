// Event Horizon Code - Sensors (S3): the camera, first of the suite.
//
// The camera is OFF until the user opens the camera window and starts it; the
// window captures, and this module only answers two questions: which vision
// lanes exist, and "what is in this frame?". A frame goes to a model on this
// machine by default. Sending one to a BYOK provider makes it leave the
// computer, and that needs the user's explicit consent - enforced here, not
// only in the UI. Frames are never written to disk and never logged; the audit
// entry records the lane, the byte count and the question's length.

import { audit } from "./audit";
import { engineEndpoint } from "./engine";
import { noteSourceState, sensorsHalted } from "./sensorBus";
import { chat as ollamaChat, chatOpenAI, listModels, modelCapabilities, type ChatMessage } from "./router";
import { readSecret, secretsStatus } from "./secrets";

export type CameraLanes = {
  engine: { baseUrl: string } | null;
  /** Ollama models that Ollama itself reports as vision-capable. */
  ollama: { models: string[] } | null;
  byok: Array<{ provider: string; baseUrl: string | null; model: string | null }>;
  /** The camera window is open with the camera on and checking in. */
  windowLive: boolean;
};

/**
 * Where a frame could go. Provider endpoints only - never a key. Ollama is a
 * local lane (frames stay on this machine), so it needs no consent; only its
 * vision-capable models are offered.
 */
export async function cameraLanes(): Promise<CameraLanes> {
  let byok: CameraLanes["byok"] = [];
  try {
    byok = secretsStatus().providers
      .filter((p) => p.hasKey && p.baseUrl)
      .map((p) => ({ provider: p.provider, baseUrl: p.baseUrl, model: p.model }));
  } catch { /* no secrets file: no BYOK lanes */ }
  let ollama: CameraLanes["ollama"] = null;
  try {
    const vision: string[] = [];
    for (const m of await listModels()) {
      try {
        if ((await modelCapabilities(m.id, { engineBase: null })).capabilities.includes("vision")) vision.push(m.id);
      } catch { /* a model that cannot be probed is not offered */ }
    }
    if (vision.length) ollama = { models: vision };
  } catch { /* Ollama not reachable */ }
  const base = engineEndpoint();
  return { engine: base ? { baseUrl: base } : null, ollama, byok, windowLive: cameraWindowLive() };
}
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// ---- one fresh frame, on request ----
// The agent cannot open the camera; only the camera window can, and only once
// the user has started it. When the agent asks to look, a request is lodged
// here; the open window polls for it, sends a single frame, and the frame is
// handed to the caller once. Nothing is kept: no request, no frame.
export const FRAME_TIMEOUT_MS = 8000;
let frameRequest: { resolve: (image: string | null) => void; timer: ReturnType<typeof setTimeout>; announced: boolean } | null = null;

/** Ask the open camera window for one frame. Resolves null if none arrives in time. */
export function requestFrame(timeoutMs = FRAME_TIMEOUT_MS): Promise<string | null> {
  // A newer request supersedes an older one.
  if (frameRequest) { clearTimeout(frameRequest.timer); frameRequest.resolve(null); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (frameRequest?.resolve === resolve) frameRequest = null; resolve(null); }, timeoutMs);
    frameRequest = { resolve, timer, announced: false };
  });
}

/** The camera window's poll: is a frame wanted? Answers yes once per request. */
export function takeFrameRequest(): boolean {
  if (!frameRequest || frameRequest.announced) return false;
  frameRequest.announced = true;
  return true;
}

let lastCameraPoll = 0;
export function cameraPoll(): { request: boolean } {
  // The first poll after a gap is the camera turning ON. The bus hears it at
  // once, so the status bar offers the stop the moment a camera is live
  // rather than on its next idle poll.
  if (!cameraWindowLive()) noteSourceState("camera");
  lastCameraPoll = Date.now();
  return { request: takeFrameRequest() };
}

/** True while the camera window is open with the camera on (it checks in about twice a second). */
export function cameraWindowLive(maxAgeMs = 3000): boolean {
  return Date.now() - lastCameraPoll < maxAgeMs;
}

/** The camera window says its capture ended: off at once, no heartbeat grace. */
export function markCameraStopped(): void {
  lastCameraPoll = 0;
  noteSourceState("camera");
}

/** The camera window's answer to a request. Anything else is dropped. */
export function deliverFrame(image: string): { ok: boolean; error?: string } {
  if (!frameFromDataUrl(image)) return { ok: false, error: "not a frame (JPEG, PNG or WebP data URL under 2 MB)" };
  const r = frameRequest;
  if (!r) return { ok: false, error: "no frame was requested" };
  clearTimeout(r.timer);
  frameRequest = null;
  r.resolve(image);
  return { ok: true };
}

/** Accepts a JPEG / PNG / WebP data URL up to 2 MB. Anything else is not a frame. */
export function frameFromDataUrl(dataUrl: string): { mime: string; bytes: number } | null {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bytes = Math.floor((m[2] ?? "").length * 3 / 4) - ((m[2] ?? "").endsWith("==") ? 2 : (m[2] ?? "").endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES ? { mime: `image/${m[1]}`, bytes } : null;
}

export async function look(args: {
  image: string;
  question: string;
  lane: "engine" | "ollama" | "byok";
  provider?: string;
  /** The user's explicit yes to the frame leaving this computer. */
  allowRemote?: boolean;
  /** Who asked - "user" from the camera window's button, "agent" from the camera_look tool. */
  initiator?: string;
}): Promise<{ ok: boolean; text?: string; error?: string; needsConsent?: boolean }> {
  const image = String(args?.image ?? "");
  const question = String(args?.question ?? "").trim().slice(0, 1000) || "Describe what you see, briefly.";
  const frame = frameFromDataUrl(image);
  if (!frame) return { ok: false, error: "the frame must be a JPEG, PNG or WebP data URL under 2 MB" };

  const messages: ChatMessage[] = [{ role: "user", content: question, images: [image] }];
  let laneNote = "";
  let answer: { ok: boolean; content?: string; error?: string };

  if (args.lane === "engine") {
    const base = engineEndpoint();
    if (!base) return { ok: false, error: "the local engine is not running - start a vision model in the Models panel, or choose Ollama / BYOK Vision" };
    laneNote = "engine (this machine)";
    answer = await chatOpenAI("engine", messages, { baseUrl: base, apiKey: "local", think: "low", numPredict: 180, timeoutMs: 60_000 });
  } else if (args.lane === "ollama") {
    // Local like the engine: the frame stays on this machine, so no consent gate.
    const model = String(args.provider ?? "");
    const installed = await listModels();
    if (!installed.some((m) => m.id === model)) {
      return { ok: false, error: `that Ollama model is not installed - pick a vision-capable model in the camera window (EHC never downloads models)` };
    }
    laneNote = `ollama ${model.slice(0, 60)} (this machine)`;
    answer = await ollamaChat(model, messages, { think: "low", numPredict: 180, timeoutMs: 120_000, numCtx: 8192 });
  } else {
    let secret: ReturnType<typeof readSecret> = null;
    try { secret = args.provider ? readSecret(args.provider) : null; } catch { /* unreadable: treated as absent */ }
    if (!secret?.apiKey || !secret.baseUrl) return { ok: false, error: "that BYOK provider has no key or endpoint saved" };
    // From here on the frame would leave the computer: only on an explicit yes.
    if (args.allowRemote !== true) {
      audit({ tool: "camera.look", note: `REFUSED byok ${String(args.provider ?? "").slice(0, 40)}: no consent given` });
      return { ok: false, needsConsent: true, error: "a BYOK Vision look sends this camera frame to your provider - it leaves this computer. Allow it first." };
    }
    let host = secret.baseUrl;
    try { host = new URL(secret.baseUrl).host; } catch { /* keep the raw text */ }
    laneNote = `byok ${String(args.provider ?? "").slice(0, 40)} -> ${host}`;
    answer = await chatOpenAI(secret.model ?? "", messages, { baseUrl: secret.baseUrl, apiKey: secret.apiKey, think: "low", numPredict: 180, timeoutMs: 60_000 });
  }
  audit({ tool: "camera.look", note: `${laneNote}, ${frame.bytes} bytes, ${question.length} chars${args.initiator ? ` [${args.initiator}]` : ""}` });
  if (!answer.ok) return { ok: false, error: String(answer.error ?? "the vision model did not answer").slice(0, 300) };
  const text = (answer.content ?? "").trim();
  return text ? { ok: true, text } : { ok: false, error: "the model returned no text - it may not support images" };
}
/**
 * The agent's look (`camera_look` tool). Two rules make it safe to hand to a
 * model: it can only happen while the USER has the camera on (the window is
 * open and started - otherwise no frame arrives), and it only ever uses the
 * engine on this machine, so nothing the agent does can send a frame off the
 * computer. The engine is checked before a frame is requested, so the camera
 * is never touched when nothing could answer.
 */
export async function lookFromCamera(args: { question: string; initiator: string }): Promise<{ ok: boolean; text?: string; error?: string }> {
  // The one switch outranks every approval: after the user stopped the
  // sensors, no frame is even requested until they resume.
  if (sensorsHalted()) {
    audit({ tool: "camera.look", note: "REFUSED: sensors are halted by the user" });
    return { ok: false, error: "sensors are stopped by the user - nothing looks through the camera until they resume (Sensors panel or the status bar)" };
  }
  if (!engineEndpoint()) {
    return { ok: false, error: "no local vision model is running - start one in the Models panel. (An agent look only ever uses the engine on this machine.)" };
  }
  const image = await requestFrame();
  if (!image) {
    // Say which half is missing: the window, or the camera inside it.
    return { ok: false, error: cameraWindowLive()
      ? "the camera window is open but no frame arrived - is the camera started there? Press Start camera in that window."
      : "the camera window is not open or the camera is off. Open it from the Sensory panel and press Start camera - the agent can only look while the user keeps the camera on." };
  }
  return look({ image, question: args.question, lane: "engine", initiator: args.initiator });
}
