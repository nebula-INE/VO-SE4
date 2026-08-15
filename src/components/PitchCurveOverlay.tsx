// PitchCurveOverlay.tsx
//
// ピアノロールのノートグリッドに重ねて表示する、読み取り専用のピッチカーブ。
// 各ノートのPBS/PBW/PBYから「そのノート基準音高からの半音オフセット」を求め、
// ノート本体と全く同じ座標系（x: tick/3840*100%, y: 半音1つ=28px）で描画するため、
// カーブが実際のノートの上を通って見える(SynthVのピッチ表示に近い見た目)。
//
// 編集はここでは行わない。個々のノートのピッチベンドを編集するのは
// PitchCurveMiniEditor（右パネルのインスペクター内）の役割。
// 理由: ピアノロールはノートのクリック選択・ドラッグ移動を既に処理しており、
// 同じ場所でカーブのドラッグ編集も受け付けると操作が競合しやすいため。

import React, { useMemo } from 'react';
import { parsePitchBend, msToTicks } from '../utils/pitchCurve';

interface NoteForCurve {
  id: string;
  noteNum: number;
  tick: number;
  pbs: string;
  pbw: string;
  pby: string;
}

interface PitchCurveOverlayProps {
  notes: NoteForCurve[];
  selectedNoteId: string | null;
  tempo: number;
  /** グリッドの高さ(px)。ピアノロール側の "h-[1036px]" と必ず一致させる */
  gridHeightPx?: number;
  /** タイムラインの総tick数。ピアノロール側のleftPct計算(tick/3840)と揃える */
  totalTicks?: number;
  rowHeightPx?: number;
}

export default function PitchCurveOverlay({
  notes,
  selectedNoteId,
  tempo,
  gridHeightPx = 1036,
  totalTicks = 3840,
  rowHeightPx = 28,
}: PitchCurveOverlayProps) {
  const segments = useMemo(() => {
    return notes
      .map((note) => {
        const points = parsePitchBend(note.pbs, note.pbw, note.pby);
        if (points.length === 0) return null;

        const rowIdx = 84 - note.noteNum;
        const centerY = rowIdx * rowHeightPx + rowHeightPx / 2;

        const coords = points.map((p) => {
          const tickOffset = msToTicks(p.offsetMs, tempo || 120);
          const xPct = ((note.tick + tickOffset) / totalTicks) * 100;
          const y = centerY - p.semitone * rowHeightPx;
          return { x: xPct, y };
        });

        const d = coords
          .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(3)} ${c.y.toFixed(2)}`)
          .join(' ');

        return { id: note.id, d, isSelected: note.id === selectedNoteId };
      })
      .filter((s): s is { id: string; d: string; isSelected: boolean } => s !== null);
  }, [notes, selectedNoteId, tempo, totalTicks, rowHeightPx]);

  if (segments.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-10"
      width="100%"
      height={gridHeightPx}
      viewBox={`0 0 100 ${gridHeightPx}`}
      preserveAspectRatio="none"
    >
      {segments.map((seg) => (
        <g key={seg.id}>
          {/* グロー(発光)レイヤー */}
          <path
            d={seg.d}
            fill="none"
            stroke={seg.isSelected ? '#22d3ee' : '#67e8f9'}
            strokeOpacity={seg.isSelected ? 0.35 : 0.18}
            strokeWidth={7}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* 芯となるライン */}
          <path
            d={seg.d}
            fill="none"
            stroke={seg.isSelected ? '#22d3ee' : '#67e8f9'}
            strokeOpacity={seg.isSelected ? 1 : 0.55}
            strokeWidth={seg.isSelected ? 2 : 1.3}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
}
