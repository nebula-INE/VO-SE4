// ============================================================================
// PATCH: src/wasmEngine.ts 内の renderStudioOffline() をこの内容で丸ごと置き換えてください。
//
// 何を直したか:
// 1. [残響/二重再生の修正] CachedSample.overlap（oto.iniのオーバーラップ値）が
//    これまで一切使われていなかったため、隣接ノートが独立したgainエンベロープで
//    ほぼフルボリュームのまま重なって鳴っていました（＝「謎の残響」「二重に聴こえる音」の正体）。
//    → 前ノートの release と次ノートの attack を overlap 分だけ揃えてクロスフェードするよう修正。
// 2. [余計な音/クリップの修正] 上記の重なりによりピークがdBFSを超えてクリップノイズが乗ることが
//    あったため、マスターバスに軽いリミッター(DynamicsCompressor)を追加。
// 3. [音質を少し上げる] 高域プレゼンスシェルフ(+2.2dB @6.5kHz)を追加し、
//    こもりがちなUTAU音源に軽い明瞭感を付与（かけすぎない程度の控えめな量）。
// ============================================================================

async function renderStudioOffline(notes: any[], tempo: number, voicebank: string): Promise<string | null> {
  if (!notes || notes.length === 0) return null;

  const sampleRate = 44100;
  const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick);
  const maxTick = sortedNotes.reduce((max, n) => Math.max(max, (n.tick || 0) + (n.length || 480)), 0);
  const totalDurationSec = Math.max((maxTick / 480) * (60 / tempo) + 1.5, 1.0);
  const totalSamples = Math.ceil(sampleRate * totalDurationSec);

  // 1. 必要なサンプルの組み合わせを洗い出す（元コードと同じ）
  interface SampleRequest {
    voicebank: string;
    alias: string;
    prevLyric?: string;
    noteNum: number;
  }
  const sampleKeyMap = new Map<string, SampleRequest>();

  for (let idx = 0; idx < sortedNotes.length; idx++) {
    const n = sortedNotes[idx];
    if (isRest(n.lyric)) continue;
    const lyric = n.lyric || 'あ';
    const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
    const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
    const prevLyric = isContinuous ? prevNote.lyric : undefined;
    const pitchMidi = n.noteNum || 60;
    const key = `${voicebank}:${lyric}:${prevLyric || ''}:${pitchMidi}`;
    if (!sampleKeyMap.has(key)) {
      sampleKeyMap.set(key, { voicebank, alias: lyric, prevLyric, noteNum: pitchMidi });
    }
  }

  // 2. サンプルをバッチで先読み（元コードと同じ）
  const requests = Array.from(sampleKeyMap.values());
  const BATCH_SIZE = 8;
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(req => fetchSampleWithCache(req.voicebank, req.alias, req.prevLyric, req.noteNum))
    );
  }

  // 3. [変更点] 各ノートのタイミング情報を「先に1本のリストにまとめる」。
  //    こうすることで、隣り合うノート同士(前後)を参照してクロスフェード幅を決められる。
  interface VoicedNote {
    sample: CachedSample;
    actualStartTime: number;
    noteStartTime: number;
    noteDurationSec: number;
    startOffsetInWav: number;
    cutoffEndSec: number;
    baseRate: number;
    overlapSec: number; // oto.ini の overlap をレンダリング後の秒数に変換したもの
    n: any;
  }
  const voiced: VoicedNote[] = [];

  for (let idx = 0; idx < sortedNotes.length; idx++) {
    const n = sortedNotes[idx];
    if (isRest(n.lyric)) continue;
    const lyric = n.lyric || 'あ';
    const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
    const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
    const prevLyric = isContinuous ? prevNote.lyric : undefined;
    const pitchMidi = n.noteNum || 60;

    const sample = await fetchSampleWithCache(voicebank, lyric, prevLyric, pitchMidi);
    if (!sample || !sample.audioBuffer) continue;

    const { left_blank, right_blank, preutterance, overlap, baseMidi } = sample;
    const noteStartTime = (n.tick / 480) * (60 / tempo);
    const noteDurationSec = (n.length / 480) * (60 / tempo);

    const semitoneShift = pitchMidi - baseMidi;
    const baseRate = Math.min(4.0, Math.max(0.25, Math.pow(2, semitoneShift / 12)));

    const offsetSec = Math.max(0, left_blank / 1000);
    const preuttSec = Math.max(0, preutterance / 1000);
    const effectivePreuttSec = preuttSec / baseRate;
    const wavDuration = sample.audioBuffer.duration;

    let cutoffEndSec = wavDuration;
    if (right_blank > 0) {
      cutoffEndSec = Math.max(offsetSec + 0.05, wavDuration - (right_blank / 1000));
    } else if (right_blank < 0) {
      cutoffEndSec = Math.max(offsetSec + 0.05, Math.min(wavDuration, offsetSec + Math.abs(right_blank) / 1000));
    }

    const actualStartTime = Math.max(0, noteStartTime - effectivePreuttSec);
    const timeDiff = actualStartTime - (noteStartTime - effectivePreuttSec);
    const startOffsetInWav = Math.min(offsetSec + timeDiff * baseRate, cutoffEndSec - 0.02);

    // oto.ini の overlap(ms) を、このノートのピッチ変速後の実時間(秒)に変換。
    // 短すぎ/長すぎでクロスフェードが破綻しないよう 6ms〜150ms にクランプ。
    const overlapSec = Math.max(0.006, Math.min(0.15, (overlap || 10) / 1000 / baseRate));

    voiced.push({
      sample, actualStartTime, noteStartTime, noteDurationSec,
      startOffsetInWav, cutoffEndSec, baseRate, overlapSec, n,
    });
  }

  // 4. OfflineAudioContext とマスターバスを用意
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // [追加] マスターリミッター: ノート同士の重なりが残っても波形が突き抜けてクリップノイズに
  // ならないようにする安全弁。踏みすぎないよう控えめな設定。
  const masterCompressor = offlineCtx.createDynamicsCompressor();
  masterCompressor.threshold.setValueAtTime(-6, 0);
  masterCompressor.knee.setValueAtTime(12, 0);
  masterCompressor.ratio.setValueAtTime(4, 0);
  masterCompressor.attack.setValueAtTime(0.003, 0);
  masterCompressor.release.setValueAtTime(0.15, 0);
  const masterGain = offlineCtx.createGain();
  masterGain.gain.setValueAtTime(1.06, 0); // コンプで下がった分の軽いメイクアップゲイン
  masterCompressor.connect(masterGain);
  masterGain.connect(offlineCtx.destination);

  // 5. 各ノートをスケジューリング
  for (let i = 0; i < voiced.length; i++) {
    const v = voiced[i];
    const { sample, actualStartTime, noteStartTime, noteDurationSec, startOffsetInWav, cutoffEndSec, baseRate, overlapSec, n } = v;
    const { audioBuffer, fixed_range, preutterance, left_blank } = sample;
    const wavDuration = audioBuffer.duration;
    const offsetSec = Math.max(0, left_blank / 1000);
    const preuttSec = Math.max(0, preutterance / 1000);
    const fixedSec = Math.max(0, fixed_range / 1000);
    const playLen = (preuttSec / baseRate) + noteDurationSec;

    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.setValueAtTime(baseRate, actualStartTime);

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

    const maxSampleDur = Math.max(0.04, cutoffEndSec - offsetSec);
    const requiredSampleSec = (startOffsetInWav - offsetSec) + playLen * baseRate;
    if (requiredSampleSec > maxSampleDur + 0.02) {
      const loopStartSec = Math.min(cutoffEndSec - 0.06, offsetSec + Math.max(0.02, fixedSec || preuttSec || 0.05));
      const loopEndSec = Math.min(wavDuration - 0.01, Math.max(loopStartSec + 0.04, cutoffEndSec - 0.01));
      if (loopEndSec > loopStartSec + 0.03) {
        source.loop = true;
        source.loopStart = loopStartSec;
        source.loopEnd = loopEndSec;
      }
    }

    const gainNode = offlineCtx.createGain();
    const volGain = Math.max(0.05, Math.min(1.5, (n.intensity || 120) / 120)) * 0.92;

    // --- [変更点] アタック: overlap分だけかけてフェードイン
    //     （以前は actualStartTime でいきなり音量が上がり、前ノートの余韻の上に
    //      そのまま重ねて鳴っていた）
    const attackEnd = Math.max(actualStartTime + 0.008, actualStartTime + overlapSec);
    gainNode.gain.setValueAtTime(0.0001, actualStartTime);
    gainNode.gain.exponentialRampToValueAtTime(
      Math.max(0.01, volGain),
      Math.min(attackEnd, noteStartTime + noteDurationSec * 0.4)
    );

    // --- [変更点] リリース: 次ノートのアタック開始（overlap込み）より後ろにはみ出さない。
    //     これにより「前ノートの尻尾」と「次ノートの頭」が同時にフルボリュームで
    //     鳴ることがなくなる ＝ 残響/二重再生の解消。
    const nextNote = voiced[i + 1];
    const naturalReleaseStart = Math.max(noteStartTime + 0.01, noteStartTime + noteDurationSec - 0.012);
    const naturalReleaseEnd = noteStartTime + noteDurationSec + 0.025;
    const releaseStart = nextNote ? Math.min(naturalReleaseStart, nextNote.actualStartTime) : naturalReleaseStart;
    const releaseEnd = nextNote
      ? Math.max(releaseStart + 0.006, Math.min(naturalReleaseEnd, nextNote.actualStartTime + nextNote.overlapSec))
      : naturalReleaseEnd;

    gainNode.gain.setValueAtTime(volGain, Math.max(attackEnd, releaseStart));
    gainNode.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

    // スタジオ用ハイパスフィルタ（80Hz）: DCオフセット/低域の濁りを除去（元コードと同じ）
    const hpf = offlineCtx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.setValueAtTime(80, actualStartTime);
    hpf.Q.setValueAtTime(0.707, actualStartTime);

    // [追加] 軽いプレゼンスシェルフ: こもりがちなUTAU音源に控えめな明瞭感を追加
    const presence = offlineCtx.createBiquadFilter();
    presence.type = 'highshelf';
    presence.frequency.setValueAtTime(6500, actualStartTime);
    presence.gain.setValueAtTime(2.2, actualStartTime);

    source.connect(hpf);
    hpf.connect(presence);
    presence.connect(gainNode);
    gainNode.connect(masterCompressor); // destinationではなくマスターバスへ

    source.start(actualStartTime, startOffsetInWav);
    source.stop(releaseEnd + 0.03);
  }

  const renderedBuffer = await offlineCtx.startRendering();
  const wavBlob = bufferToWav(renderedBuffer);
  return URL.createObjectURL(wavBlob);
}
