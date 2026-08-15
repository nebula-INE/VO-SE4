// pitchCurve.ts
//
// UST形式のピッチベンド (PBS / PBW / PBY) をパースし、タイムライン上の
// 「その時点でのノート基準音高からの半音オフセット」に変換するユーティリティ。
//
// UST(UTAU)の慣習:
//   PBS = "開始オフセットms" または "開始オフセットms;開始半音"
//         (ノート開始位置からの相対時間。マイナス可＝ノートより前から始まる)
//   PBW = "幅ms,幅ms,..."（各制御点間の時間幅、カンマ区切り）
//   PBY = "半音,半音,..."（各制御点でのノート基準音高からのオフセット、カンマ区切り。
//          末尾に "s" 等の補間種別サフィックスが付くことがあるため数値だけ取り出す）
//
// 注意: 各UTAU系ツールで細部の解釈に差異があるため、これは一般的な慣習に沿った
// 「表示用の近似」です。実際の合成エンジン側の解釈と完全に一致する保証はありません。

export interface PitchPoint {
  /** ノート開始位置からの相対時間 (ms)。負の値=ノートより前 */
  offsetMs: number;
  /** ノート基準音高からの半音オフセット */
  semitone: number;
}

function parseNumeric(raw: string): number {
  const cleaned = raw.trim().replace(/[^0-9+\-.]/g, '');
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : 0;
}

/** PBS/PBW/PBY文字列から制御点の配列を作る */
export function parsePitchBend(pbs: string, pbw: string, pby: string): PitchPoint[] {
  const pbsParts = (pbs || '').split(';').map((s) => s.trim());
  const startOffsetMs = pbsParts[0] ? parseNumeric(pbsParts[0]) : 0;
  const startSemitone = pbsParts[1] ? parseNumeric(pbsParts[1]) : 0;

  const widths = (pbw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseNumeric);

  const heights = (pby || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseNumeric);

  const points: PitchPoint[] = [{ offsetMs: startOffsetMs, semitone: startSemitone }];

  let cursorMs = startOffsetMs;
  for (let i = 0; i < heights.length; i++) {
    cursorMs += widths[i] ?? (widths[widths.length - 1] ?? 100);
    points.push({ offsetMs: cursorMs, semitone: heights[i] });
  }

  return points;
}

/** 制御点の配列からPBS/PBW/PBY文字列を再構築する */
export function serializePitchBend(points: PitchPoint[]): { pbs: string; pbw: string; pby: string } {
  if (points.length === 0) {
    return { pbs: '0;0', pbw: '', pby: '' };
  }
  const [first, ...rest] = points;
  const pbs = `${Math.round(first.offsetMs)};${roundTo(first.semitone, 2)}`;

  const widths: number[] = [];
  const heights: number[] = [];
  let prevMs = first.offsetMs;
  for (const p of rest) {
    widths.push(Math.max(1, Math.round(p.offsetMs - prevMs)));
    heights.push(roundTo(p.semitone, 2));
    prevMs = p.offsetMs;
  }

  return {
    pbs,
    pbw: widths.join(','),
    pby: heights.join(','),
  };
}

function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/** tempo(BPM)を使ってms ⇔ tickを変換する */
export function msToTicks(ms: number, tempoBpm: number): number {
  // 480 ticks = 1拍。1拍の長さ(ms) = 60000 / tempo
  const msPerTick = 60000 / tempoBpm / 480;
  return ms / msPerTick;
}

export function ticksToMs(ticks: number, tempoBpm: number): number {
  const msPerTick = 60000 / tempoBpm / 480;
  return ticks * msPerTick;
}

/**
 * 制御点列を、指定した時刻(ノート開始からの相対ms)での半音オフセットに
 * 線形補間でサンプリングする。points は offsetMs 昇順であること。
 */
export function sampleSemitoneAt(points: PitchPoint[], offsetMs: number): number {
  if (points.length === 0) return 0;
  if (offsetMs <= points[0].offsetMs) return points[0].semitone;
  const last = points[points.length - 1];
  if (offsetMs >= last.offsetMs) return last.semitone;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (offsetMs >= a.offsetMs && offsetMs <= b.offsetMs) {
      const span = b.offsetMs - a.offsetMs;
      const t = span <= 0 ? 0 : (offsetMs - a.offsetMs) / span;
      return a.semitone + (b.semitone - a.semitone) * t;
    }
  }
  return last.semitone;
}
