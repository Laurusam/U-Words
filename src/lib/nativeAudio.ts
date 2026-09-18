import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AudioCapture, listAudioInputs } from "./audio";
import type { AudioCaptureOptions, CapturedAudio } from "./audio";

export type RecordedAudio = CapturedAudio & { recordingId?: string; sampleCount?: number; durationMs?: number };

export interface Capture {
  start(): Promise<void>;
  stop(): Promise<RecordedAudio>;
  cancel(): Promise<void>;
}

class NativeCapture implements Capture {
  private off?: () => void;
  private running = false;
  private cancelled = false;

  constructor(
    private level: ((value: number) => void) | undefined,
    private options: AudioCaptureOptions,
  ) {}

  async start() {
    this.off = await listen<number>("native-audio-level", (event) => this.level?.(event.payload));
    try {
      await invoke("recording_start", { deviceName: this.options.deviceId || null });
      this.running = true;
      if(this.cancelled){await this.cancel();throw new Error("录音已取消");}
    } catch (error) {
      this.off();
      this.off = undefined;
      throw error;
    }
  }

  async stop(): Promise<RecordedAudio> {
    try {
      const recording = await invoke<{ id: string; sampleRate: number; sampleCount: number; durationMs: number }>(
        "recording_stop",
        { cancel: false },
      );
      return {
        samples: [],
        sampleRate: recording.sampleRate,
        recordingId: recording.id,
        sampleCount: recording.sampleCount,
        durationMs: recording.durationMs,
      };
    } finally {
      this.running = false;
      this.off?.();
      this.level?.(0);
    }
  }

  async cancel() {
    this.cancelled = true;
    try {
      if (this.running) await invoke("recording_stop", { cancel: true }).catch(() => undefined);
    } finally {
      this.running = false;
      this.off?.();
      this.level?.(0);
    }
  }
}

export function createCapture(level?: (value: number) => void, options: AudioCaptureOptions = {}): Capture {
  return "__TAURI_INTERNALS__" in window ? new NativeCapture(level, options) : new AudioCapture(level, options);
}

export async function audioInputs(): Promise<MediaDeviceInfo[]> {
  if (!("__TAURI_INTERNALS__" in window)) return listAudioInputs();
  const names = await invoke<string[]>("recording_devices");
  return names.map(
    (name) =>
      ({ deviceId: name, label: name, kind: "audioinput", groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo,
  );
}
