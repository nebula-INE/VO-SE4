// PitchCurveMiniEditor.tsx
//
// 右パネルのインスペクターに置く、選択中ノート専用のピッチベンド編集UI。
// これまで生のPBS/PBW文字列を直接テキスト入力させていた部分を、
// ドラッグで制御点を動かせる小さなカーブエディタに置き換える(+生の値も下に残す)。
//
// 操作:
//   ・点をドラッグ  : 時間(横)と半音オフセット(縦)を変更
//   ・キャンバスをダブルクリック: その位置に新しい点を追加
//   ・点を右クリック: その点を削除(先頭の点は削除不可＝PBS基準点のため)

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PitchPoint, parsePitchBend, serializePitchBend } from '../utils/pitchCurve';

interface PitchCurveMiniEditorProps {
  pbs: string;
  pbw: string;
  pby: string;
  /** ノートの長さ(ticks)。横軸の表示範囲を決めるのに使う */
  noteLengthTicks: number;
  tempo: number;
  onChange: (next: { pbs: string; pbw: string; pby: string }) => void;
}

const WIDTH = 256;
const HEIGHT = 104;
const SEMITONE_RANGE = 6; // 上下±6半音を表示範囲とする
const PAD_X = 16;

export default function PitchCurveMiniEditor({
  pbs,
  pbw,
  pby,
  noteLengthTicks,
  tempo,
  onChange,
}: PitchCurveMiniEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const points = useMemo(() => parsePitchBend(pbs, pbw, pby), [pbs, pbw, pby]);

  const noteLengthMs = useMemo(() => {
    const msPerTick = 60000 / (tempo || 120) / 480;
    return Math.max(200, noteLengthTicks * msPerTick);
  }, [noteLengthTicks, tempo]);

  // 表示範囲: ノート開始の少し前 〜 ノート終端の少し後
  const viewMinMs = -noteLengthMs * 0.15;
  const viewMaxMs = noteLengthMs * 1.15;

  const msToX = useCallback(
    (ms: number) => PAD_X + ((ms - viewMinMs) / (viewMaxMs - viewMinMs)) * (WIDTH - PAD_X * 2),
    [viewMinMs, viewMaxMs]
  );
  const xToMs = useCallback(
    (x: number) => viewMinMs + ((x - PAD_X) / (WIDTH - PAD_X * 2)) * (viewMaxMs - viewMinMs),
    [viewMinMs, viewMaxMs]
  );
  const semitoneToY = useCallback((s: number) => HEIGHT / 2 - (s / SEMITONE_RANGE) * (HEIGHT / 2 - 8), []);
  const yToSemitone = useCallback(
    (y: number) => (-(y - HEIGHT / 2) / (HEIGHT / 2 - 8)) * SEMITONE_RANGE,
    []
  );

  const commit = (next: PitchPoint[]) => {
    const sorted = [...next].sort((a, b) => a.offsetMs - b.offsetMs);
    onChange(serializePitchBend(sorted));
  };

  const handlePointerDown = (index: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button === 2) return; // 右クリックは削除ハンドラ側で処理
    setDraggingIndex(index);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (draggingIndex === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((e.clientY - rect.top) / rect.height) * HEIGHT;

    const next = points.map((p, i) => {
      if (i !== draggingIndex) return p;
      const newMs = xToMs(Math.max(PAD_X, Math.min(WIDTH - PAD_X, x)));
      const newSemitone = Math.max(
        -SEMITONE_RANGE,
        Math.min(SEMITONE_RANGE, yToSemitone(Math.max(8, Math.min(HEIGHT - 8, y))))
      );
      return { offsetMs: newMs, semitone: newSemitone };
    });
    commit(next);
  };

  const handleMouseUp = () => setDraggingIndex(null);

  const handleDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const y = ((e.clientY - rect.top) / rect.height) * HEIGHT;
    const newPoint: PitchPoint = { offsetMs: xToMs(x), semitone: yToSemitone(y) };
    commit([...points, newPoint]);
  };

  const handleDeletePoint = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (index === 0 || points.length <= 1) return; // 先頭(PBS基準点)は残す
    commit(points.filter((_, i) => i !== index));
  };

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${msToX(p.offsetMs).toFixed(1)} ${semitoneToY(p.semitone).toFixed(1)}`)
    .join(' ');

  const noteStartX = msToX(0);
  const noteEndX = msToX(noteLengthMs);
  const zeroY = semitoneToY(0);

  return (
    <div className="space-y-1.5">
      <svg
        ref={svgRef}
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="bg-slate-950 border border-slate-700 rounded-md cursor-crosshair select-none"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 0半音の基準線 */}
        <line x1={0} y1={zeroY} x2={WIDTH} y2={zeroY} stroke="#334155" strokeWidth={1} strokeDasharray="3,3" />
        {/* ノートの範囲を示す帯 */}
        <rect x={noteStartX} y={0} width={Math.max(0, noteEndX - noteStartX)} height={HEIGHT}
              fill="#22d3ee" fillOpacity={0.06} />
        <line x1={noteStartX} y1={0} x2={noteStartX} y2={HEIGHT} stroke="#0e7490" strokeWidth={1} strokeDasharray="2,2" />

        {/* カーブ本体 */}
        <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* 制御点 */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={msToX(p.offsetMs)}
            cy={semitoneToY(p.semitone)}
            r={draggingIndex === i ? 6 : 4.5}
            fill={i === 0 ? '#f0f0f2' : '#22d3ee'}
            stroke="#0e7490"
            strokeWidth={1}
            onMouseDown={handlePointerDown(i)}
            onContextMenu={handleDeletePoint(i)}
            className="cursor-grab active:cursor-grabbing"
          />
        ))}
      </svg>
      <p className="text-[10px] text-slate-500">
        ドラッグで移動・ダブルクリックで点を追加・右クリックで削除(先頭点を除く)
      </p>
    </div>
  );
}
