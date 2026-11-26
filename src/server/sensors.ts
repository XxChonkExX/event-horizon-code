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
import { chatOpenAI } from "./router";
import { readSecret, secretsStatus } from "./secrets";

export type CameraLanes = {
  engine: { baseUrl: string } | null;
  byok: Array<{ provider: string; baseUrl: string | null; model: string | null }>;
  /** The camera window is open with the camera on and checking in. */
  windowLive: boolean;
};

/** Where a frame could go. Provider endpoints only - never a key. Only providers that could actually answer. */
export function cameraLanes(): CameraLanes {
  let byok: CameraLanes["byok"] = [];
  try {
    byok = secretsStatus().providers
      .filter((p) => p.hasKey && p.baseUrl)
      .map((p) => ({ provider: p.provider, baseUrl: p.baseUrl, model: p.model }));
  } catch { /* no secrets file: no BYOK lanes */ }
  const base = engineEndpoint();
  return { engine: base ? { baseUrl: base } : null, byok, windowLive: cameraWindowLive() };
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
  lastCameraPoll = Date.now();
  return { request: takeFrameRequest() };
}

/** True while the camera window is open with the camera on (it checks in about twice a second). */
export function cameraWindowLive(maxAgeMs = 3000): boolean {
  return Date.now() - lastCameraPoll < maxAgeMs;
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
  lane: "engine" | "byok";
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

  let baseUrl: string;
  let apiKey = "local";
  let model: string;
  let laneNote: string;
  if (args.lane === "engine") {
    const base = engineEndpoint();
    if (!base) return { ok: false, error: "the local engine is not running - start a vision model in the Models panel, or choose BYOK Vision" };
    baseUrl = base;
    model = "engine";
    laneNote = "engine (this machine)";
  } else {
    let secret: ReturnType<typeof readSecret> = null;
    try { secret = args.provider ? readSecret(args.provider) : null; } catch { /* unreadable: treated as absent */ }
    if (!secret?.apiKey || !secret.baseUrl) return { ok: false, error: "that BYOK provider has no key or endpoint saved" };
    // From here on the frame would leave the computer: only on an explicit yes.
    if (args.allowRemote !== true) {
      audit({ tool: "camera.look", note: `REFUSED byok ${String(args.provider ?? "").slice(0, 40)}: no consent given` });
      return { ok: false, needsConsent: true, error: "a BYOK Vision look sends this camera frame to your provider - it leaves this computer. Allow it first." };
    }
    baseUrl = secret.baseUrl;
    apiKey = secret.apiKey;
    model = secret.model ?? "";
    let host = secret.baseUrl;
    try { host = new URL(secret.baseUrl).host; } catch { /* keep the raw text */ }
    laneNote = `byok ${String(args.provider ?? "").slice(0, 40)} -> ${host}`;
  }
  audit({ tool: "camera.look", note: `${laneNote}, ${frame.bytes} bytes, ${question.length} chars${args.initiator ? ` [${args.initiator}]` : ""}` });
  const r = await chatOpenAI(model, [{ role: "user", content: question, images: [image] }], { baseUrl, apiKey, think: "low", numPredict: 180, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: String(r.error ?? "the vision model did not answer").slice(0, 300) };
  const text = (r.content ?? "").trim();
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
