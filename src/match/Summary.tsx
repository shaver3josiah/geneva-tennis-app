import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { pct, summaryRows, type MatchStats, type Ratio, type XCell } from '../tennis';
import { cellValue, summarySections } from '../matches';
import { Card, CardTitle } from '../ui';
import { color, radius, semantic } from '../theme';

/**
 * The Summary tab. The two pictures come first because they are what a coach can take in
 * during a 90-second changeover; the full table is below them for after the match.
 */
export function Summary({ stats, names }: { stats: MatchStats; names: [string, string] }) {
  const sections = useMemo(() => summarySections(summaryRows(stats, names)), [stats, names]);
  return (
    <>
      <Momentum values={stats.momentum} names={names} />
      <RallyBars stats={stats} names={names} />
      <Card>
        <CardTitle>Match stats</CardTitle>
        <View style={s.headRow}>
          <Text style={[s.label, s.headText]}>Stat</Text>
          {names.map((n, i) => (
            <Text key={i} style={[s.headText, s.valCol, s.headName]} numberOfLines={1}>
              {n}
            </Text>
          ))}
        </View>
        {sections.map((sec) => (
          <View key={sec.title}>
            <Text style={s.section} accessibilityRole="header">
              {sec.title}
            </Text>
            {sec.rows.map((r) => (
              <StatRow key={r.label} label={r.label} cells={r.cells} names={names} />
            ))}
          </View>
        ))}
      </Card>
    </>
  );
}

// --- the comparison table -----------------------------------------------------------

/** Fewer is better for these. */
const LOWER_WINS = /double fault|forced error|^out$|into the net|short balls/i;
/** No side of these is "better": a style, an estimate, or one number shared by both. */
const NEITHER = /average rally|mid-court|knee bend|spin/i;

/** '7/12 (58%)' compares on its percent; a plain number on itself. */
function numberOf(c: XCell): number | null {
  const v = cellValue(c);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /\((\d+)%\)$/.exec(String(v));
  return m ? Number(m[1]) : null;
}

function better(label: string, a: XCell, b: XCell): 0 | 1 | null {
  if (NEITHER.test(label)) return null;
  const x = numberOf(a);
  const y = numberOf(b);
  if (x === null || y === null || x === y) return null;
  return x > y !== LOWER_WINS.test(label) ? 0 : 1;
}

function StatRow({ label, cells, names }: { label: string; cells: [XCell, XCell]; names: [string, string] }) {
  const best = better(label, cells[0], cells[1]);
  const said = (c: XCell) => String(cellValue(c)) || 'none';
  return (
    <View
      style={s.row}
      accessible
      accessibilityLabel={
        `${label}: ${names[0]} ${said(cells[0])}, ${names[1]} ${said(cells[1])}` +
        (best !== null ? `. ${names[best]} ahead` : '')
      }
    >
      <Text style={s.label}>{label}</Text>
      <Value cell={cells[0]} strong={best === 0} />
      <Value cell={cells[1]} strong={best === 1} />
    </View>
  );
}

/** A ratio shows its percent large and its count small, so the column scans as numbers.
 *  The better side is heavier as well as brighter: weight does not depend on seeing colour. */
function Value({ cell, strong }: { cell: XCell; strong: boolean }) {
  const raw = String(cellValue(cell));
  const m = /^(\d+)\/(\d+) \((\d+)%\)$/.exec(raw);
  return (
    <View style={s.valCol}>
      <Text style={[s.val, strong && s.valStrong]}>{m ? `${m[3]}%` : raw === '' || raw === '-' ? '–' : raw}</Text>
      {m ? (
        <Text style={s.valSub}>
          {m[1]}/{m[2]}
        </Text>
      ) : null}
    </View>
  );
}

// --- momentum -----------------------------------------------------------------------

const SPARK_H = 84;

/** The running points difference: above the line our player is ahead, below the opponent. */
function Momentum({ values, names }: { values: number[]; names: [string, string] }) {
  const [w, setW] = useState(0);
  if (values.length < 2) return null;

  const series = [0, ...values];
  const last = values[values.length - 1];
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = Math.max(3, hi, -lo);
  const mid = SPARK_H / 2;
  const x = (i: number) => (i / (series.length - 1)) * w;
  const y = (v: number) => mid - (v / span) * (mid - 6);
  const line = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const lead = (i: 0 | 1, n: number) => `${names[i]} +${n}`;
  const now = last > 0 ? `${lead(0, last)} on points` : last < 0 ? `${lead(1, -last)} on points` : 'Level on points';
  const peaks = [hi > 0 ? lead(0, hi) : '', lo < 0 ? lead(1, -lo) : ''].filter(Boolean).join(', ');
  const caption = `${now}.${peaks ? ` Biggest leads: ${peaks}.` : ''}`;

  return (
    <Card>
      <CardTitle>Momentum</CardTitle>
      <View
        style={{ height: SPARK_H }}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        accessible
        accessibilityLabel={`Momentum over ${values.length} points. ${caption}`}
      >
        {w > 0 && (
          <Svg width={w} height={SPARK_H}>
            <Line x1={0} x2={w} y1={mid} y2={mid} stroke={color.slate} strokeWidth={1} strokeDasharray="3 4" />
            <Path d={`${line} L${w.toFixed(1)},${mid} L0,${mid} Z`} fill={color.gold} fillOpacity={0.16} />
            <Path d={line} stroke={color.goldHot} strokeWidth={2} fill="none" strokeLinejoin="round" />
          </Svg>
        )}
        <Text style={[s.axis, { top: 0 }]} numberOfLines={1}>
          {names[0]} ahead
        </Text>
        <Text style={[s.axis, { bottom: 0 }]} numberOfLines={1}>
          {names[1]} ahead
        </Text>
      </View>
      <Text style={s.caption}>{caption}</Text>
    </Card>
  );
}

// --- rally length -------------------------------------------------------------------

function RallyBars({ stats, names }: { stats: MatchStats; names: [string, string] }) {
  const [p0, p1] = stats.players;
  const buckets: Array<{ label: string; r: [Ratio, Ratio] }> = [
    { label: '0–4 shots', r: [p0.rallyShort, p1.rallyShort] },
    { label: '5–8 shots', r: [p0.rallyMid, p1.rallyMid] },
    { label: '9+ shots', r: [p0.rallyLong, p1.rallyLong] },
  ];
  return (
    <Card>
      <CardTitle>Points won by rally length</CardTitle>
      {buckets.map(({ label, r }) => {
        const of = r[0].of;
        const a = pct(r[0]) ?? 0;
        const b = pct(r[1]) ?? 0;
        return (
          <View
            key={label}
            style={s.bucket}
            accessible
            accessibilityLabel={
              of ? `${label}, ${of} points. ${names[0]} won ${a} percent, ${names[1]} ${b} percent` : `${label}: none yet`
            }
          >
            <View style={s.bucketHead}>
              <Text style={s.bucketLabel}>{label}</Text>
              <Text style={s.bucketCount}>
                {of} {of === 1 ? 'point' : 'points'}
              </Text>
            </View>
            {of ? (
              <>
                <View style={s.bar}>
                  {r[0].won ? <View style={[s.barOurs, { flex: r[0].won }]} /> : null}
                  {r[1].won ? <View style={[s.barTheirs, { flex: r[1].won }]} /> : null}
                </View>
                <View style={s.barLabels}>
                  <Text style={[s.barText, { color: color.goldHot }]} numberOfLines={1}>
                    {names[0]} {a}%
                  </Text>
                  <Text style={[s.barText, s.right]} numberOfLines={1}>
                    {b}% {names[1]}
                  </Text>
                </View>
              </>
            ) : (
              <Text style={s.none}>None yet</Text>
            )}
          </View>
        );
      })}
    </Card>
  );
}

const s = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: color.oldGold,
  },
  headText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase', color: color.textDim },
  headName: { color: color.textLede, textAlign: 'right' },
  section: {
    marginTop: 14,
    marginBottom: 2,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: color.goldHot,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.border,
  },
  label: { flex: 1, fontSize: 13.5, lineHeight: 18, color: color.textBody, paddingRight: 8 },
  valCol: { width: 78, alignItems: 'flex-end' },
  val: { fontSize: 15, fontWeight: '600', color: color.textDim, fontVariant: ['tabular-nums'] },
  valStrong: { fontWeight: '800', color: color.chalk },
  valSub: { fontSize: 11, color: color.textDim, fontVariant: ['tabular-nums'], marginTop: 1 },

  axis: { position: 'absolute', left: 0, fontSize: 10.5, fontWeight: '700', color: color.textDim },
  caption: { fontSize: 13, lineHeight: 18, color: color.textBody, marginTop: 10 },

  bucket: { paddingVertical: 8 },
  bucketHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  bucketLabel: { fontSize: 14, fontWeight: '700', color: color.chalk },
  bucketCount: { fontSize: 12, color: color.textDim, fontVariant: ['tabular-nums'] },
  bar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: radius.badge,
    overflow: 'hidden',
    backgroundColor: color.inkHover,
    gap: 2,
  },
  barOurs: { backgroundColor: color.gold },
  barTheirs: { backgroundColor: color.slate },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5, gap: 10 },
  barText: { flex: 1, fontSize: 12.5, fontWeight: '700', color: color.textLede, fontVariant: ['tabular-nums'] },
  right: { textAlign: 'right' },
  none: { fontSize: 12.5, color: color.textDim },
});
