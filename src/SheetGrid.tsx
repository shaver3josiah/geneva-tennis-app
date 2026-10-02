import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { XCell } from './tennis';
import { cellValue } from './matches';
import { color, semantic } from './theme';

/**
 * The point log as a spreadsheet: pointLogRows() drawn cell for cell, so what the coach
 * reads here is exactly what lands in Excel and in his Google Sheet.
 *
 * The header row sits OUTSIDE the vertical list, which is what makes it sticky, and both
 * sit inside one horizontal scroller, which is what keeps the columns lined up with no
 * scroll syncing at all. The list is virtualised: a long three-setter is 250 rows of 22
 * cells, and drawing all 5,500 at once would stall the screen every time a point lands.
 */

const ROW_H = 38;

/** Points wide, by header. A column this table does not know gets a width from its name. */
const WIDTH: Record<string, number> = {
  '#': 44, Set: 40, Game: 50, Score: 64, Server: 112, Side: 56, '1st In': 54, 'Serve #': 62,
  'Serve mph': 80, Placement: 82, Rally: 54, Outcome: 128, 'Won by': 112, 'Ended by': 112,
  Wing: 86, 'Final shot': 104, Pressure: 74, 'Break pt': 72, Net: 100, Secs: 52, Source: 86, Note: 220,
};
/** Numbers read right-aligned, like any spreadsheet. Same list Code.gs keeps as numbers. */
const NUMERIC = new Set(['#', 'Set', 'Game', 'Serve #', 'Serve mph', 'Rally', 'Secs']);

const widthOf = (h: string) => WIDTH[h] ?? Math.max(56, h.length * 9 + 22);

export function SheetGrid({ rows, follow }: { rows: XCell[][]; follow: boolean }) {
  // Keyed on the header's TEXT: rows is a new array on every snapshot, and a new header
  // array would hand every row new widths and defeat the row memo below.
  const headKey = (rows[0] ?? []).map((c) => String(cellValue(c))).join('\u0001');
  const header = useMemo(() => (headKey ? headKey.split('\u0001') : []), [headKey]);
  const body = useMemo(() => rows.slice(1), [rows]);
  const widths = useMemo(() => header.map(widthOf), [header]);
  const total = widths.reduce((a, b) => a + b, 0);
  const at = useMemo(
    () => ({
      n: header.indexOf('#'),
      score: header.indexOf('Score'),
      outcome: header.indexOf('Outcome'),
      wonBy: header.indexOf('Won by'),
      endedBy: header.indexOf('Ended by'),
      pressure: header.indexOf('Pressure'),
    }),
    [header]
  );

  // The vertical list needs a real height inside a horizontal scroller, so it is measured.
  const [height, setHeight] = useState(0);
  const list = useRef<FlatList<XCell[]>>(null);
  // A live match follows the newest point, but only while the reader is already at the
  // bottom. Yanking someone back down while they read point 12 would be worse than nothing.
  const atEnd = useRef(follow);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - ROW_H * 2;
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: XCell[]; index: number }) => (
      <Row cells={item} index={index} widths={widths} header={header} at={at} />
    ),
    [widths, header, at]
  );

  return (
    <View style={s.wrap} onLayout={(e: LayoutChangeEvent) => setHeight(e.nativeEvent.layout.height)}>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator>
        <View style={{ width: total, height }}>
          <View style={[s.row, s.head]} accessibilityRole="header">
            {header.map((h, c) => (
              <Text
                key={h + c}
                style={[s.headText, { width: widths[c] }, NUMERIC.has(h) && s.right]}
                numberOfLines={1}
              >
                {h}
              </Text>
            ))}
          </View>
          <FlatList
            ref={list}
            data={body}
            renderItem={renderItem}
            keyExtractor={(r, i) => String(cellValue(r[at.n >= 0 ? at.n : 0]) || i)}
            getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
            initialNumToRender={20}
            windowSize={7}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onContentSizeChange={() => {
              if (follow && atEnd.current) list.current?.scrollToEnd({ animated: false });
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

type Cols = { n: number; score: number; outcome: number; wonBy: number; endedBy: number; pressure: number };

const Row = memo(
  function Row({
    cells,
    index,
    widths,
    header,
    at,
  }: {
    cells: XCell[];
    index: number;
    widths: number[];
    header: string[];
    at: Cols;
  }) {
    const v = (c: number) => (c >= 0 ? String(cellValue(cells[c])) : '');
    const pressure = v(at.pressure) === 'Yes';
    const outcome = at.outcome >= 0 ? cells[at.outcome] : null;
    const tone = outcome !== null && typeof outcome === 'object' ? outcome.s : undefined;
    return (
      <View
        style={[s.row, index % 2 === 1 && s.zebra, pressure && s.pressure]}
        accessible
        // One sentence per point instead of 22 cells read one by one.
        accessibilityLabel={
          `Point ${v(at.n)}, score ${v(at.score)}. ${v(at.outcome)} by ${v(at.endedBy)}, ` +
          `won by ${v(at.wonBy)}${pressure ? '. Pressure point' : ''}`
        }
      >
        {cells.map((c, k) => (
          <Text
            key={k}
            numberOfLines={1}
            style={[
              s.cell,
              { width: widths[k] },
              NUMERIC.has(header[k]) && s.right,
              k === at.n && s.strong,
              // The word in the cell is the signal; the colour only repeats it.
              k === at.outcome && tone === 'good' && s.good,
              k === at.outcome && tone === 'bad' && s.bad,
              k === at.pressure && pressure && s.pressureWord,
            ]}
          >
            {String(cellValue(c))}
          </Text>
        ))}
      </View>
    );
  },
  // pointLogRows builds fresh arrays on every snapshot. Comparing the values keeps a new
  // point from re-rendering the 200 rows that did not change.
  (a, b) =>
    a.index === b.index &&
    a.widths === b.widths &&
    a.cells.length === b.cells.length &&
    a.cells.every((c, k) => {
      const d = b.cells[k];
      if (c === d) return true;
      return c !== null && d !== null && typeof c === 'object' && typeof d === 'object' && c.v === d.v && c.s === d.s;
    })
);

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: semantic.surfacePage },
  row: { flexDirection: 'row', alignItems: 'center', height: ROW_H },
  head: {
    backgroundColor: color.ink,
    borderBottomWidth: 1,
    borderBottomColor: color.oldGold,
  },
  headText: {
    paddingHorizontal: 8,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  zebra: { backgroundColor: color.ink },
  pressure: { backgroundColor: color.goldTint },
  cell: {
    paddingHorizontal: 8,
    fontSize: 13,
    color: color.textLede,
    fontVariant: ['tabular-nums'],
  },
  right: { textAlign: 'right' },
  strong: { fontWeight: '800', color: color.chalk },
  good: { color: color.win, fontWeight: '800' },
  bad: { color: color.danger, fontWeight: '800' },
  pressureWord: { color: color.goldHot, fontWeight: '800' },
});
