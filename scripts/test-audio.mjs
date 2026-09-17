import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/audio.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { AudioCapture, visualAudioLevel } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("long silence and legacy VAD options never stop capture; explicit finish/cancel still clean up", async () => {
  const descriptors = new Map(["navigator", "AudioContext", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const realNow = Date.now;
  let now = 0;
  let stoppedTracks = 0;
  let automaticStops = 0;
  const frames = new Map();
  const processors = [];
  let frameId = 0;
  let amplitude = 0;
  const levels = [];
  const node = () => ({ connect() {}, disconnect() {} });
  class MockContext {
    sampleRate = 16000;
    state = "running";
    destination = node();
    createMediaStreamSource() { return node(); }
    createAnalyser() { return { ...node(), fftSize: 256, getFloatTimeDomainData(data) { data.fill(amplitude); } }; }
    createScriptProcessor() { const processor = node(); processors.push(processor); return processor; }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  try {
    Date.now = () => now;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { stoppedTracks++; } }] }; } },
    } });
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: MockContext });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    } });
    // Former options and callback must not revive auto-stop even for a legacy caller.
    const capture = new AudioCapture((level) => levels.push(level), { vadEnabled: true, autoStopSeconds: 1 }, () => automaticStops++);
    await capture.start();
    for (const elapsed of [2000, 60000, 3600000, 86400000]) {
      now = elapsed;
      processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1024) } });
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(now);
      assert.equal(stoppedTracks, 0, "Silence must not stop the microphone");
      assert.equal(automaticStops, 0, "Silence must not invoke an automatic finish");
    }
    amplitude = 0.02;
    for (let step = 0; step < 2; step++) {
      now += 16;
      const [id, callback] = frames.entries().next().value;
      frames.delete(id); callback(now);
    }
    assert.ok(levels.at(-2) > 0.2, "Weak speech must have a fast attack");
    assert.ok(levels.at(-1) > levels.at(-2), "Meter must refresh after 16 ms");
    const audio = await capture.stop();
    assert.equal(audio.samples.length, 4096);
    assert.equal(audio.samples[0], 0, "Visual gain must not alter captured samples");
    assert.equal(audio.sampleRate, 16000);
    assert.equal(stoppedTracks, 1);
    assert.equal(frames.size, 0);
    const cancelled = new AudioCapture();
    await cancelled.start();
    await cancelled.cancel();
    assert.equal(stoppedTracks, 2);
    assert.equal(frames.size, 0);
  } finally {
    Date.now = realNow;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("visual gain compresses weak speech without amplifying silence or NaN", () => {
  assert.equal(visualAudioLevel(0), 0);
  assert.equal(visualAudioLevel(0.001), 0);
  assert.equal(visualAudioLevel(NaN), 0);
  assert.ok(visualAudioLevel(0.02) > 0.3);
  assert.equal(visualAudioLevel(1), 1);
});
