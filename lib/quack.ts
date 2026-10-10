/**
 * "Wak wak": two short synthesized duck quacks for the logo easter egg. Built
 * with the Web Audio API, so there is no audio file to load. A nasal sawtooth
 * with a quick pitch drop, shaped by two filters, reads as a cartoon quack.
 */
let context: AudioContext | null = null;

function quackAt(audio: AudioContext, output: AudioNode, start: number, pitch: number) {
  const voice = audio.createOscillator();
  voice.type = "sawtooth";
  voice.frequency.setValueAtTime(pitch * 1.3, start);
  voice.frequency.exponentialRampToValueAtTime(pitch, start + 0.04);
  voice.frequency.exponentialRampToValueAtTime(pitch * 0.68, start + 0.17);

  const nasal = audio.createBiquadFilter();
  nasal.type = "bandpass";
  nasal.Q.value = 3.2;
  nasal.frequency.setValueAtTime(1250, start);
  nasal.frequency.linearRampToValueAtTime(820, start + 0.17);

  const bite = audio.createBiquadFilter();
  bite.type = "peaking";
  bite.frequency.value = 2700;
  bite.Q.value = 2;
  bite.gain.value = 9;

  const envelope = audio.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(1, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.45, start + 0.08);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);

  voice.connect(nasal).connect(bite).connect(envelope).connect(output);
  voice.start(start);
  voice.stop(start + 0.21);
}

export function quack() {
  try {
    const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    context ??= new AudioContextClass();
    void context.resume();
    const volume = context.createGain();
    volume.gain.value = 0.32;
    volume.connect(context.destination);
    const start = context.currentTime + 0.01;
    quackAt(context, volume, start, 470);
    quackAt(context, volume, start + 0.23, 430);
  } catch {
    // Sound is a bonus; a browser without audio just skips it.
  }
}
