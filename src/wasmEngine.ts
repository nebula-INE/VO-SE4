// src/wasmEngine.ts

import { bufferToWav } from './utils/audioEncoder';
import { parsePitchBend } from './utils/pitchCurve';

function allocateUTF8(Module: any, str: string): number {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str + '\0');
  const ptr = Module._malloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    Module.setValue(ptr + i, bytes[i], 'i8');
  }
  return ptr;
}

async function decodeWavTo44kPcm16(arrayBuf: ArrayBuffer): Promise<Int16Array> {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioContextClass();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));

    // If already 44100Hz mono/stereo
    if (audioBuffer.sampleRate === 44100) {
      const channelData = audioBuffer.getChannelData(0);
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return pcm16;
    }

    // Resample to 44100Hz
    const targetLength = Math.round(audioBuffer.duration * 44100);
    const offlineCtx = new OfflineAudioContext(1, Math.max(1, targetLength), 44100);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled = await offlineCtx.startRendering();
    const channelData = resampled.getChannelData(0);
    const pcm16 = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  } catch (err) {
    console.error("Failed to decode audio with AudioContext:", err);
    return new Int16Array(0);
  } finally {
    try { audioCtx.close(); } catch (e) {}
  }
}

export async function loadWasmEngine() {
  if ((window as any).VoseEngineReady) return (window as any).Module;

  return new Promise((resolve, reject) => {
    (window as any).Module = {
      onRuntimeInitialized: () => {
        (window as any).VoseEngineReady = true;
        resolve((window as any).Module);
      },
      print: (text: string) => console.log('[VOSE WASM]', text),
      printErr: (text: string) => console.error('[VOSE WASM ERR]', text)
    };

    const script = document.createElement('script');
    script.src = '/vose_core.js';
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

interface RenderEvent {
  isRest: boolean;
  wavPathStr?: string;
  noteNum: number;
  durationSec: number;
  intensity: number;
  lyric: string;
  pbs?: string;
  pbw?: string;
  pby?: string;
  tick: number;
  length: number;
}

/**
 * High-Precision Studio Offline Synthesizer
 * Seamlessly handles Oto.ini alignment, pitch shifting (C4 base), pitch bends, and crossfading
 *
 * NOTE: this is a *fallback* path (naive OfflineAudioContext.playbackRate resampling).
 * It does not preserve formants the way the WASM/WORLD engine does, so large pitch
 * shifts will sound thin/"chipmunked" here. Fixing why renderWasm() falls back to this
 * (see the silence check in renderWasm) is the real fix for perceived audio quality.
 */
async function renderStudioOffline(notes: any[], tempo: number, voicebank: string): Promise<string | null> {
  if (!notes || notes.length === 0) return null;

  const sampleRate = 44100;
  const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick);
  const maxTick = sortedNotes.reduce((max, n) => Math.max(max, (n.tick || 0) + (n.length || 480)), 0);
  const totalDurationSec = Math.max((maxTick / 480) * (60 / tempo) + 1.5, 1.0);
  const totalSamples = Math.ceil(sampleRate * totalDurationSec);

  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Fetch audio buffers and Oto parameters
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

  try {
    for (let idx = 0; idx < sortedNotes.length; idx++) {
      const n = sortedNotes[idx];
      const lyric = n.lyric || 'あ';
      const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
      const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
      const prevLyric = isContinuous ? prevNote.lyric : undefined;

      const pitchMidi = n.noteNum || 60;
      let url = `/api/py/voicebank-sample?name=${encodeURIComponent(voicebank)}&alias=${encodeURIComponent(lyric)}&noteNum=${encodeURIComponent(String(pitchMidi))}`;
      if (prevLyric) url += `&prevLyric=${encodeURIComponent(prevLyric)}`;

      let audioBuf: AudioBuffer | null = null;
      let left_blank = 15;
      let fixed_range = 100;
      let right_blank = -40;
      let preutterance = 25;
      let overlap = 10;
      let baseMidi = 60;

      try {
        const res = await fetch(url);
        if (res.ok) {
          left_blank = parseFloat(res.headers.get('X-Oto-Left-Blank') || '15');
          fixed_range = parseFloat(res.headers.get('X-Oto-Fixed-Range') || '100');
          right_blank = parseFloat(res.headers.get('X-Oto-Right-Blank') || '-40');
          preutterance = parseFloat(res.headers.get('X-Oto-Preutterance') || '25');
          overlap = parseFloat(res.headers.get('X-Oto-Overlap') || '10');
          baseMidi = parseFloat(res.headers.get('X-Sample-Base-Midi') || '60');

          const ab = await res.arrayBuffer();
          audioBuf = await audioContext.decodeAudioData(ab);
        } else {
          // [FIX] previously silent — you had no way to tell a note was being dropped.
          console.warn(
            `[VOSE Fallback] voicebank-sample fetch failed (HTTP ${res.status}) ` +
            `voicebank="${voicebank}" alias="${lyric}" note#${idx} — this note will be silent.`
          );
        }
      } catch (e) {
        // [FIX] previously silent — surface decode/network errors so bad aliases are debuggable.
        console.warn(
          `[VOSE Fallback] voicebank-sample fetch/decode error voicebank="${voicebank}" alias="${lyric}" note#${idx}:`,
          e
        );
      }

      const noteStartTime = (n.tick / 480) * (60 / tempo);
      const noteDurationSec = (n.length / 480) * (60 / tempo);

      if (audioBuf) {
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuf;

        // Base pitch shift relative to the sample's recorded MIDI pitch
        const semitoneShift = pitchMidi - baseMidi;
        const baseRate = Math.min(4.0, Math.max(0.25, Math.pow(2, semitoneShift / 12)));
        source.playbackRate.setValueAtTime(baseRate, noteStartTime);

        // Apply pitch bend curve if present
        if (n.pbs && n.pbw && n.pby) {
          try {
            const points = parsePitchBend(n.pbs, n.pbw, n.pby);
            for (const pt of points) {
              const ptTime = noteStartTime + pt.offsetMs / 1000;
              const ptRate = baseRate * Math.pow(2, pt.semitone / 12);
              if (ptTime >= 0 && ptTime < totalDurationSec) {
                source.playbackRate.linearRampToValueAtTime(ptRate, ptTime);
              }
            }
          } catch (e) {}
        }

        const offsetSec = Math.max(0, left_blank / 1000);
        const preuttSec = Math.max(0, preutterance / 1000);
        const effectivePreuttSec = preuttSec / baseRate;
        const wavDuration = audioBuf.duration;

        let maxSampleDur = Math.max(0.05, wavDuration - offsetSec);
        if (right_blank < 0) {
          maxSampleDur = Math.max(0.05, wavDuration - offsetSec - Math.abs(right_blank) / 1000);
        } else if (right_blank > 0) {
          maxSampleDur = Math.max(0.05, right_blank / 1000);
        }

        const actualStartTime = Math.max(0, noteStartTime - effectivePreuttSec);
        const timeDiff = actualStartTime - (noteStartTime - effectivePreuttSec);
        const startOffsetInWav = offsetSec + timeDiff * baseRate;
        const playLen = effectivePreuttSec + noteDurationSec;

        // Smooth vowel body looping if note exceeds sample duration
        const requiredSampleSec = (startOffsetInWav - offsetSec) + playLen * baseRate;
        if (requiredSampleSec > maxSampleDur + 0.05) {
          const loopStartSec = offsetSec + Math.max(0.01, (fixed_range || preutterance || 50) / 1000);
          const loopEndSec = Math.min(wavDuration - 0.02, offsetSec + maxSampleDur);
          if (loopEndSec > loopStartSec + 0.04) {
            source.loop = true;
            source.loopStart = loopStartSec;
            source.loopEnd = loopEndSec;
          }
        }

        const gainNode = offlineCtx.createGain();
        const volGain = Math.max(0.05, Math.min(1.5, (n.intensity || 120) / 120)) * 0.92;

        // Equal power envelope ramp with smooth micro-fade
        gainNode.gain.setValueAtTime(0.0001, actualStartTime);
        gainNode.gain.exponentialRampToValueAtTime(Math.max(0.01, volGain), Math.max(actualStartTime + 0.008, noteStartTime));
        gainNode.gain.setValueAtTime(volGain, Math.max(noteStartTime + 0.01, noteStartTime + noteDurationSec - 0.012));
        gainNode.gain.exponentialRampToValueAtTime(0.0001, noteStartTime + noteDurationSec + 0.025);

        // Studio high-pass filter (80Hz) to remove DC offset/mud and high-shelf (12kHz) for crystalline shimmer
        const hpf = offlineCtx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.setValueAtTime(80, actualStartTime);
        hpf.Q.setValueAtTime(0.707, actualStartTime);

        source.connect(hpf);
        hpf.connect(gainNode);
        gainNode.connect(offlineCtx.destination);

        source.start(actualStartTime, startOffsetInWav);
        source.stop(noteStartTime + noteDurationSec + 0.03);
      }
    }

    const renderedBuffer = await offlineCtx.startRendering();
    const wavBlob = bufferToWav(renderedBuffer);
    return URL.createObjectURL(wavBlob);
  } finally {
    try { audioContext.close(); } catch (e) {}
  }
}

export async function renderWasm(rawNotes: any[], tempo: number, voicebank: string): Promise<string | null> {
  if (!rawNotes || rawNotes.length === 0) return null;

  try {
    // Attempt WASM compilation & execute_render first
    const Module = await loadWasmEngine();
    const FRAME_PERIOD_MS = 5.0;
    const structSize = 44; // 32-bit WASM NoteEvent struct size
    const ptrsToFree: number[] = [];

    // Sort notes by tick
    const sortedNotes = [...rawNotes].sort((a, b) => a.tick - b.tick);

    // Build a continuous timeline including rest events
    const timelineEvents: RenderEvent[] = [];
    let currentTick = 0;

    for (let i = 0; i < sortedNotes.length; i++) {
      const note = sortedNotes[i];
      if (note.tick > currentTick) {
        // Gap detected: insert rest note
        const gapTicks = note.tick - currentTick;
        const gapSec = (gapTicks / 480) * (60 / tempo);
        if (gapSec > 0.001) {
          timelineEvents.push({
            isRest: true,
            noteNum: 60,
            durationSec: gapSec,
            intensity: 0,
            lyric: 'R',
            tick: currentTick,
            length: gapTicks
          });
        }
      }

      const noteSec = (note.length / 480) * (60 / tempo);
      if (noteSec > 0.001) {
        timelineEvents.push({
          isRest: false,
          wavPathStr: `/${encodeURIComponent(note.lyric || 'a')}_${note.id || i}.wav`,
          noteNum: note.noteNum || 60,
          durationSec: noteSec,
          intensity: note.intensity ?? 100,
          lyric: note.lyric || 'あ',
          pbs: note.pbs,
          pbw: note.pbw,
          pby: note.pby,
          tick: note.tick,
          length: note.length
        });
      }

      currentTick = Math.max(currentTick, note.tick + note.length);
    }

    const notesPtr = Module._malloc(structSize * timelineEvents.length);

    try {
      // 1. Download and register voice samples into WASM engine
      for (let i = 0; i < sortedNotes.length; i++) {
        const n = sortedNotes[i];
        const prevLyric = i > 0 ? sortedNotes[i - 1].lyric : '';
        const wavPathKey = `/${encodeURIComponent(n.lyric || 'a')}_${n.id || i}.wav`;

        const res = await fetch(
          `/api/py/voicebank-sample?name=${encodeURIComponent(voicebank)}&alias=${encodeURIComponent(n.lyric || '')}&prevLyric=${encodeURIComponent(prevLyric)}&noteNum=${encodeURIComponent(String(n.noteNum || 60))}`
        );

        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const pcm16 = await decodeWavTo44kPcm16(arrayBuf);

          if (pcm16.length > 0 && Module._load_embedded_resource) {
            const dataPtr = Module._malloc(pcm16.length * 2);
            ptrsToFree.push(dataPtr);
            if (Module.HEAP16) {
              Module.HEAP16.set(pcm16, dataPtr >> 1);
            } else {
              for (let j = 0; j < pcm16.length; j++) {
                Module.setValue(dataPtr + j * 2, pcm16[j], 'i16');
              }
            }
            const phonemePtr = allocateUTF8(Module, wavPathKey);
            ptrsToFree.push(phonemePtr);

            Module._load_embedded_resource(phonemePtr, dataPtr, pcm16.length);
          } else {
            // [FIX] previously silent — decode failure or missing engine export
            console.warn(
              `[VOSE WASM] Could not register sample for alias="${n.lyric}" note#${i} ` +
              `(decoded ${pcm16.length} samples, _load_embedded_resource=${!!Module._load_embedded_resource}).`
            );
          }
        } else {
          // [FIX] previously silent — surface the HTTP status so an alias mismatch is diagnosable
          console.warn(
            `[VOSE WASM] voicebank-sample fetch failed (HTTP ${res.status}) ` +
            `voicebank="${voicebank}" alias="${n.lyric}" note#${i} — this note will be silent.`
          );
        }
      }

      // Helper for allocating double arrays in WASM
      const allocateDoubleArray = (val: number | number[], length: number) => {
        const ptr = Module._malloc(length * 8);
        ptrsToFree.push(ptr);
        if (Array.isArray(val)) {
          if (Module.HEAPF64) {
            Module.HEAPF64.set(new Float64Array(val), ptr >> 3);
          } else {
            for (let j = 0; j < length; j++) {
              Module.setValue(ptr + j * 8, val[j] || 0.0, 'double');
            }
          }
        } else {
          if (Module.HEAPF64) {
            const arr = new Float64Array(length);
            arr.fill(val);
            Module.HEAPF64.set(arr, ptr >> 3);
          } else {
            for (let j = 0; j < length; j++) {
              Module.setValue(ptr + j * 8, val, 'double');
            }
          }
        }
        return ptr;
      };

      // 2. Populate C NoteEvent structs
      for (let i = 0; i < timelineEvents.length; i++) {
        const evt = timelineEvents[i];
        const offset = notesPtr + i * structSize;
        const pitchLength = Math.max(1, Math.ceil((evt.durationSec * 1000) / FRAME_PERIOD_MS));

        if (evt.isRest || !evt.wavPathStr) {
          // Rest Note
          Module.setValue(offset + 0, 0, 'i32');
          const pitchCurvePtr = allocateDoubleArray(0.0, pitchLength);
          Module.setValue(offset + 4, pitchCurvePtr, 'i32');
          Module.setValue(offset + 8, pitchLength, 'i32');

          Module.setValue(offset + 12, 0, 'i32');
          Module.setValue(offset + 16, 0, 'i32');
          Module.setValue(offset + 20, 0, 'i32');
          Module.setValue(offset + 24, 0, 'i32');
          Module.setValue(offset + 28, 0, 'i32');
          Module.setValue(offset + 32, 0, 'i32');
          Module.setValue(offset + 36, 0, 'i32');
          Module.setValue(offset + 40, 0, 'i32');
        } else {
          // Singing Note
          const wavPathPtr = allocateUTF8(Module, evt.wavPathStr);
          ptrsToFree.push(wavPathPtr);
          Module.setValue(offset + 0, wavPathPtr, 'i32');

          // Correct MIDI pitch conversion (A4 = 69 = 440Hz, C4 = 60 = 261.63Hz)
          const baseFreq = 440 * Math.pow(2, (evt.noteNum - 69) / 12);
          const pitchCurvePtr = allocateDoubleArray(baseFreq, pitchLength);
          Module.setValue(offset + 4, pitchCurvePtr, 'i32');
          Module.setValue(offset + 8, pitchLength, 'i32');

          const genderPtr = allocateDoubleArray(0.5, pitchLength);
          Module.setValue(offset + 12, genderPtr, 'i32');

          const tensionPtr = allocateDoubleArray(0.5, pitchLength);
          Module.setValue(offset + 16, tensionPtr, 'i32');

          const breathPtr = allocateDoubleArray(0.5, pitchLength);
          Module.setValue(offset + 20, breathPtr, 'i32');

          const vibDepthPtr = allocateDoubleArray(0.0, pitchLength);
          Module.setValue(offset + 24, vibDepthPtr, 'i32');

          const vibRatePtr = allocateDoubleArray(0.0, pitchLength);
          Module.setValue(offset + 28, vibRatePtr, 'i32');

          Module.setValue(offset + 32, 0, 'i32');

          const portPtr = allocateDoubleArray(0.0, pitchLength);
          Module.setValue(offset + 36, portPtr, 'i32');
          Module.setValue(offset + 40, 0, 'i32');
        }
      }

      const outputPathStr = "/vose_output.wav";
      const outputPathPtr = allocateUTF8(Module, outputPathStr);
      ptrsToFree.push(outputPathPtr);

      // Execute rendering in WASM engine
      Module._execute_render(notesPtr, timelineEvents.length, outputPathPtr, 0);

      let wavData: Uint8Array | null = null;
      try {
        wavData = Module.FS.readFile(outputPathStr);
      } catch (e) {}

      if (wavData && wavData.length > 500) {
        // [FIX] Validate that audio isn't silence.
        // The old check only scanned bytes 44..5000 (~57ms at 44.1kHz stereo). A UTAU
        // project that starts with a rest/pickup silence would be scanned as "all zero"
        // and wrongly discarded, forcing every render down to the lower-fidelity
        // renderStudioOffline() fallback — which is what actually caused the perceived
        // "poor audio quality". Now we sample across the *entire* buffer instead.
        let nonZero = 0;
        const dataStart = 44;
        const dataLen = wavData.length - dataStart;
        // sample at most ~20000 points spread across the whole file, so this stays cheap
        // even for long renders, but a leading silent region can no longer fool it.
        const step = Math.max(1, Math.floor(dataLen / 20000));
        for (let k = dataStart; k < wavData.length; k += step) {
          if (wavData[k] !== 0) {
            nonZero++;
            if (nonZero > 10) break;
          }
        }

        if (nonZero > 10) {
          const blob = new Blob([wavData.buffer], { type: 'audio/wav' });
          return URL.createObjectURL(blob);
        } else {
          console.warn(
            "[VOSE WASM] Rendered output is silent across the entire buffer " +
            "(not just the start) — falling back to renderStudioOffline()."
          );
        }
      } else {
        console.warn(
          `[VOSE WASM] execute_render produced no usable WAV data (length=${wavData ? wavData.length : 'null'}) — ` +
          "falling back to renderStudioOffline()."
        );
      }
    } finally {
      Module._free(notesPtr);
      for (const ptr of ptrsToFree) {
        try { Module._free(ptr); } catch (e) {}
      }
    }

    // Fallback renderer (lower fidelity — see renderStudioOffline() docstring)
    return await renderStudioOffline(rawNotes, tempo, voicebank);
  } catch (err) {
    console.warn("[VOSE WASM] WASM render fallback triggered:", err);
    return await renderStudioOffline(rawNotes, tempo, voicebank);
  }
}
