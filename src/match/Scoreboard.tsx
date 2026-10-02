import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MatchScore, type PlayerIdx, type PointRecord } from '../tennis';
import type { Match } from '../types';
import { color, radius, semantic } from '../theme';

interface Board {
  sets: Array<[number, number]>;
  /** The game in progress, per player: '30' / '15', 'AD' / '40', or tiebreak points. */
  game: [string, string] | null;
  server: PlayerIdx | null;
  winner: PlayerIdx | null;
}

const LABEL = ['0', '15', '30', '40'];

/**
 * The score read off the points themselves rather than parsed out of scoreLine, whose last
 * token is server-first and so cannot be put on the right row. Replaying is how the tracker
 * keeps score too, so the two cannot disagree.
 */
function boardOf(m: Match, points: PointRecord[]): Board | null {
  if (!points.length) return null;
  try {
    const sc = MatchScore.replay(m.format, m.firstServer, points.map((p) => p.winner), m.nearAtStart);
    // A coach can mark a match final short of a result: a retirement, rain, a clinched dual.
    const over = sc.matchWinner !== null || m.status === 'final';
    const [a, b] = sc.points;
    let game: [string, string] | null = null;
    if (!over) {
      if (sc.inTiebreak) game = [String(a), String(b)];
      else if (a >= 3 && b >= 3) game = a === b ? ['40', '40'] : a > b ? ['AD', '40'] : ['40', 'AD'];
      else game = [LABEL[a] ?? '40', LABEL[b] ?? '40'];
    }
    return {
      sets: sc.sets.map((s) => [s[0], s[1]] as [number, number]),
      game,
      server: over ? null : sc.server,
      winner: sc.matchWinner,
    };
  } catch {
    return null; // a format the replay cannot follow; the stored score line still shows
  }
}

export function Scoreboard({ match, points }: { match: Match; points: PointRecord[] }) {
  const board = useMemo(() => boardOf(match, points), [match, points]);
  const names = match.names;

  if (!board) {
    return (
      <Text style={s.fallback} accessibilityLabel={match.scoreLine ? `Score ${match.scoreLine}` : 'No points yet'}>
        {match.scoreLine || 'No points yet'}
      </Text>
    );
  }

  const done = (k: number) => k < board.sets.length - 1 || board.winner !== null;
  const setWinner = (k: number): PlayerIdx | null => {
    const [x, y] = board.sets[k];
    return !done(k) || x === y ? null : x > y ? 0 : 1;
  };
  const spoken =
    names.map((n, i) => `${n} ${board.sets.map((st) => st[i]).join(', ')}`).join('; ') +
    (board.game ? `. Game ${board.game[0]} to ${board.game[1]}` : '') +
    (board.server !== null ? `, ${names[board.server]} serving` : '') +
    (board.winner !== null ? `. ${names[board.winner]} won` : '');

  return (
    <View style={s.board} accessible accessibilityLabel={`Score: ${spoken}`}>
      {([0, 1] as const).map((i) => (
        <View key={i} style={[s.row, i === 1 && s.rowLine]}>
          <View style={s.nameCell}>
            {/* The ball marks the server. Its absence on the other row is the signal, so
                it does not lean on colour. */}
            <View style={[s.serve, board.server === i && s.serving]} />
            <Text style={[s.name, board.winner === i && { color: color.chalk }]} numberOfLines={1}>
              {names[i]}
            </Text>
            {board.winner === i ? <Text style={s.won}>WON</Text> : null}
          </View>
          {board.sets.map((st, k) => (
            <Text key={k} style={[s.cell, setWinner(k) === i ? s.cellWon : setWinner(k) !== null && s.cellLost]}>
              {st[i]}
            </Text>
          ))}
          {board.game ? <Text style={[s.cell, s.game]}>{board.game[i]}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  board: {
    backgroundColor: color.ink,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: radius.card,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 4 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border },
  nameCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 6 },
  serve: { width: 9, height: 9, borderRadius: 5 },
  serving: { backgroundColor: color.ball },
  name: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: color.textLede },
  won: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: color.night,
    backgroundColor: color.win,
    borderRadius: 4,
    overflow: 'hidden',
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  cell: {
    minWidth: 30,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '800',
    color: color.textLede,
    fontVariant: ['tabular-nums'],
  },
  cellWon: { color: color.chalk },
  cellLost: { color: color.textFaint, fontWeight: '600' },
  game: {
    minWidth: 42,
    marginLeft: 4,
    color: color.goldHot,
    backgroundColor: color.goldTint,
    borderRadius: 6,
    overflow: 'hidden',
    paddingVertical: 2,
  },
  fallback: { fontSize: 26, fontWeight: '800', color: color.chalk, fontVariant: ['tabular-nums'] },
});
