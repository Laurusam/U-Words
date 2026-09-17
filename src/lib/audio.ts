export type CapturedAudio = { samples: number[]; sampleRate: number };

export type AudioCaptureOptions = {
  deviceId?: string;
  noiseSuppression?: boolean;
};

export class AudioCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private analyser?: AnalyserNode;
  private meterFrame?: number;
  private chunks: number[] = [];
  private onLevel?: (level: number) => void;
  private options: AudioCaptureOptions;
  private displayedLevel = 0;
  private lastMeterFrameAt = Number.NEGATIVE_INFINITY;

  constructor(onLevel?: (level: number) => void, options: AudioCaptureOptions = {}) {
    this.onLevel = onLevel;
    this.options = options;
  }

  async start() {
    this.chunks = [];
    this.displayedLevel = 0;
    this.lastMeterFrameAt = Number.NEGATIVE_INFINITY;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: this.options.noiseSuppression ?? true,
        autoGainControl: true,
      },
    });
    this.context = new AudioContext({ sampleRate: 16000 });
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0;
    this.processor = this.context.createScriptProcessor(1024, 1, 1);
    const silentGain = this.context.createGain();
    silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      for (const value of data) {
        this.chunks.push(Math.max(-1, Math.min(1, value)) * 32767);
      }
    };
    source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.context.destination);
    await this.context.resume();
    const meterData = new Float32Array(this.analyser.fftSize);
    const emitMeterFrame = (frameTime: number) => {
      if (!this.analyser) return;
      if (frameTime - this.lastMeterFrameAt >= 14) {
        this.analyser.getFloatTimeDomainData(meterData);
        const level = visualAudioLevel(this.rmsLevel(meterData));
        const delta = Number.isFinite(this.lastMeterFrameAt) ? frameTime - this.lastMeterFrameAt : 16;
        const alpha = 1 - Math.exp(-delta / (level > this.displayedLevel ? 18 : 95));
        this.displayedLevel += (level - this.displayedLevel) * alpha;
        this.lastMeterFrameAt = frameTime;
        this.onLevel?.(this.displayedLevel);
      }
      if (this.analyser) this.meterFrame = window.requestAnimationFrame(emitMeterFrame);
    };
    this.meterFrame = window.requestAnimationFrame(emitMeterFrame);
  }

  async stop(): Promise<CapturedAudio> {
    const result = { samples: this.chunks.slice(), sampleRate: this.context?.sampleRate ?? 16000 };
    await this.cleanup();
    return result;
  }

  async cancel() {
    await this.cleanup();
  }

  private async cleanup() {
    if (this.meterFrame !== undefined) window.cancelAnimationFrame(this.meterFrame);
    this.meterFrame = undefined;
    this.processor?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.processor = undefined;
    this.analyser = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.displayedLevel = 0;
    this.lastMeterFrameAt = Number.NEGATIVE_INFINITY;
    this.onLevel?.(0);
  }

  private rmsLevel(data: Float32Array) {
    let sum = 0;
    for (const value of data) sum += value * value;
    return data.length ? Math.sqrt(sum / data.length) : 0;
  }
}

export function visualAudioLevel(rms: number): number {
  if (!Number.isFinite(rms)) return 0;
  return Math.min(1, Math.pow(Math.max(0, rms - 0.002) * 12, 0.65));
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}
