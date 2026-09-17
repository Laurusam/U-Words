export type CapturedAudio = { samples: number[]; sampleRate: number };

export type AudioCaptureOptions = {
  deviceId?: string;
  noiseSuppression?: boolean;
  vadEnabled?: boolean;
  autoStopSeconds?: number;
};

export class AudioCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private analyser?: AnalyserNode;
  private meterFrame?: number;
  private chunks: number[] = [];
  private onLevel?: (level: number) => void;
  private onAutoStop?: () => void;
  private options: AudioCaptureOptions;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private autoStopTriggered = false;
  private displayedLevel = 0;
  private lastMeterFrameAt = Number.NEGATIVE_INFINITY;

  constructor(onLevel?: (level: number) => void, options: AudioCaptureOptions = {}, onAutoStop?: () => void) {
    this.onLevel = onLevel;
    this.options = options;
    this.onAutoStop = onAutoStop;
  }

  async start() {
    this.chunks = [];
    this.startedAt = Date.now();
    this.lastVoiceAt = this.startedAt;
    this.autoStopTriggered = false;
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
    this.analyser.smoothingTimeConstant = 0.72;
    this.processor = this.context.createScriptProcessor(1024, 1, 1);
    const silentGain = this.context.createGain();
    silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      for (const value of data) {
        this.chunks.push(Math.max(-1, Math.min(1, value)) * 32767);
      }
      const now = Date.now();
      if (this.rmsLevel(data) > 0.055) this.lastVoiceAt = now;
      if (
        this.options.vadEnabled &&
        !this.autoStopTriggered &&
        now - this.startedAt > 900 &&
        now - this.lastVoiceAt > (this.options.autoStopSeconds ?? 2) * 1000
      ) {
        this.autoStopTriggered = true;
        this.onAutoStop?.();
      }
    };
    source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.context.destination);
    await this.context.resume();
    const emitMeterFrame = (frameTime: number) => {
      if (!this.analyser) return;
      if (frameTime - this.lastMeterFrameAt >= 32) {
        const data = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(data);
        const level = Math.min(1, this.rmsLevel(data) * 5);
        const alpha = level > this.displayedLevel ? 0.42 : 0.18;
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

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}
