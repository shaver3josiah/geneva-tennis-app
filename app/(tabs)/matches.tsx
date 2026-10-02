import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useSession } from '../../src/session';
import {
  dateLabel,
  fullTitle,
  lineOrder,
  matchState,
  STATE_WORD,
  subscribeMatches,
  type MatchState,
} from '../../src/matches';
import { useMatchAccess } from '../../src/match/useMatchAccess';
import { StateTag } from '../../src/match/StateTag';
import type { Match } from '../../src/types';
import { Button, Eyebrow, GhostButton, Screen } from '../../src/ui';
import { color, radius, semantic, type, type IconName } from '../../src/theme';

/** Re-reads the clock every so often, so a match that stopped syncing stops pulsing
 *  even when nothing else on the screen changes. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export default function Matches() {
  const { role } = useSession();
  const router = useRouter();
  const { access, retry } = useMatchAccess();
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const now = useNow(60_000);

  useEffect(() => {
    if (access !== 'ready') return;
    setFailed(false);
    // A refused listener is dead for good, so trying again means a new subscription.
    return subscribeMatches(setMatches, () => setFailed(true));
  }, [access, attempt]);

  // The coach sets the Google Sheets connector up here; nobody else has anything to set.
  const headerRight = useCallback(
    () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Google Sheets setup"
        onPress={() => router.push('/match/sheets')}
        hitSlop={6}
        style={({ pressed }) => [s.headerAction, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="grid-outline" size={17} color={color.goldHot} />
        <Text style={s.headerActionText}>Google Sheets</Text>
      </Pressable>
    ),
    [router]
  );
  const options = useMemo(() => ({ headerRight: role === 'coach' ? headerRight : undefined }), [role, headerRight]);

  const { live, days } = useMemo(() => {
    const byLine = (a: Match, b: Match) => lineOrder(a.position) - lineOrder(b.position);
    const liveNow: Match[] = [];
    const byDay = new Map<string, Match[]>();
    for (const m of matches ?? []) {
      if (matchState(m, now) === 'live') liveNow.push(m);
      else byDay.set(m.date, [...(byDay.get(m.date) ?? []), m]);
    }
    return {
      live: liveNow.sort(byLine),
      days: [...byDay].sort(([a], [b]) => (a < b ? 1 : -1)).map(([d, ms]) => [d, ms.sort(byLine)] as const),
    };
  }, [matches, now]);

  const newMatch = () => router.push('/match/new');
  const open = (m: Match) => router.push({ pathname: '/match/[id]', params: { id: m.id } });

  let content: ReactNode;
  if (access === 'failed' || failed) {
    content = (
      <View style={s.problem} accessibilityLiveRegion="polite">
        <Text style={s.problemTitle}>Matches did not load</Text>
        <Text style={type.body}>
          Check signal, then try again. If it keeps happening, ask the coach to make sure you are on the roster.
        </Text>
        <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
          <GhostButton
            label="Try again"
            icon="refresh"
            onPress={() => {
              retry();
              setAttempt((n) => n + 1);
            }}
          />
        </View>
      </View>
    );
  } else if (access === 'checking' || matches === null) {
    content = (
      <View style={s.loading}>
        <ActivityIndicator color={color.goldHot} />
        <Text style={[type.meta, { marginTop: 10 }]}>Loading matches…</Text>
      </View>
    );
  } else if (matches.length === 0) {
    content = <Pitch onNew={newMatch} />;
  } else {
    content = (
      <>
        <Button label="New match" onPress={newMatch} />
        {live.length > 0 && (
          <>
            <Eyebrow style={{ marginTop: 22 }}>Live now</Eyebrow>
            {live.map((m) => (
              <MatchRow key={m.id} match={m} state="live" onPress={() => open(m)} />
            ))}
          </>
        )}
        {days.map(([day, ms], k) => (
          <View key={day}>
            <Eyebrow style={{ marginTop: k === 0 && !live.length ? 22 : 18 }}>{dateLabel(day)}</Eyebrow>
            {ms.map((m) => (
              <MatchRow key={m.id} match={m} state={matchState(m, now)} onPress={() => open(m)} />
            ))}
          </View>
        ))}
      </>
    );
  }

  return (
    <Screen>
      <Tabs.Screen options={options} />
      {content}
    </Screen>
  );
}

/** The empty state is the pitch: most of a team will meet this screen before any match. */
function Pitch({ onNew }: { onNew: () => void }) {
  const lines: Array<[IconName, string]> = [
    ['stats-chart-outline', 'Serve, rally and error stats, point by point'],
    ['pulse-outline', 'Trends flagged as they hold, with a line for the changeover'],
    ['share-outline', 'Excel, Google Sheets, or one email to the coach'],
  ];
  return (
    <View style={s.pitch}>
      <Ionicons name="tennisball-outline" size={38} color={color.ball} />
      <Text style={s.pitchTitle}>Chart a match live</Text>
      <Text style={s.pitchBody}>
        Mount a phone on the back fence, tap Track live, and the coach gets a live stat sheet every 3 points.
      </Text>
      <View style={s.pitchList}>
        {lines.map(([icon, text]) => (
          <View key={text} style={s.pitchLine}>
            <Ionicons name={icon} size={17} color={color.goldHot} />
            <Text style={s.pitchLineText}>{text}</Text>
          </View>
        ))}
      </View>
      <View style={{ alignSelf: 'stretch' }}>
        <Button label="New match" onPress={onNew} />
      </View>
    </View>
  );
}

function MatchRow({ match, state, onPress }: { match: Match; state: MatchState; onPress: () => void }) {
  const ours = match.pointCount ? match.summary?.[0] : undefined;
  // Our player's numbers. A doubles team has no one first name, so it gets the school's.
  const who = match.kind === 'doubles' ? 'Geneva' : match.names[0].split(' ')[0];
  const strip = ours
    ? [
        ours.fsPct !== null ? `1st serve ${ours.fsPct}%` : null,
        `${ours.winners} ${ours.winners === 1 ? 'winner' : 'winners'}`,
        `${ours.ue} UE`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        `${fullTitle(match)}. ${match.names[0]} versus ${match.names[1]}. ${STATE_WORD[state]}.` +
        (match.scoreLine ? ` Score ${match.scoreLine}.` : '') +
        (strip ? ` ${who}: ${strip}.` : '') +
        (match.sheetUrl ? ' Linked to a Google Sheet.' : '')
      }
      style={({ pressed }) => [s.row, state === 'live' && s.rowLive, pressed && { backgroundColor: color.inkHover }]}
    >
      <View style={s.rowTop}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {fullTitle(match)}
        </Text>
        <StateTag state={state} />
      </View>
      <View style={s.rowMid}>
        <Text style={s.names} numberOfLines={2}>
          {match.names[0]}
          <Text style={s.vs}> vs </Text>
          {match.names[1]}
        </Text>
        {match.scoreLine ? <Text style={s.score}>{match.scoreLine}</Text> : null}
      </View>
      {strip || match.sheetUrl ? (
        <View style={s.rowBottom}>
          <Text style={s.strip} numberOfLines={1}>
            {strip ? `${who}: ${strip}` : ''}
          </Text>
          {match.sheetUrl ? (
            <View style={s.sheetChip}>
              <Ionicons name="grid-outline" size={11} color={color.courtBlue} />
              <Text style={s.sheetChipText}>Sheet</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  headerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  headerActionText: { fontSize: 14, fontWeight: '700', color: color.goldHot },

  loading: { alignItems: 'center', paddingVertical: 48 },
  problem: {
    borderWidth: 1,
    borderColor: color.danger,
    backgroundColor: 'rgba(255,90,90,0.07)',
    borderRadius: radius.card,
    padding: 14,
    marginTop: 8,
  },
  problemTitle: { fontSize: 15, fontWeight: '800', color: color.chalk, marginBottom: 4 },

  pitch: {
    alignItems: 'center',
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: color.oldGold,
    borderRadius: radius.cardLg,
    paddingHorizontal: 20,
    paddingVertical: 26,
    marginTop: 8,
  },
  pitchTitle: { ...type.display, fontSize: 24, color: color.chalk, marginTop: 12, textAlign: 'center' },
  pitchBody: { ...type.body, color: color.textLede, textAlign: 'center', marginTop: 8, maxWidth: 420 },
  pitchList: { alignSelf: 'stretch', gap: 10, marginTop: 18, marginBottom: 20 },
  pitchLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pitchLineText: { flex: 1, fontSize: 14, lineHeight: 19, color: color.textBody },

  row: {
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.cardLg,
    padding: 14,
    marginBottom: 10,
    minHeight: 64,
  },
  rowLive: { borderColor: 'rgba(221,245,74,0.45)' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowTitle: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: color.goldHot,
  },
  rowMid: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  names: { flex: 1, fontSize: 16, fontWeight: '700', color: color.chalk, lineHeight: 21 },
  vs: { fontSize: 13, fontWeight: '600', color: color.textDim },
  score: { fontSize: 19, fontWeight: '800', color: color.chalk, fontVariant: ['tabular-nums'] },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  strip: { flex: 1, fontSize: 12.5, color: color.textDim, fontVariant: ['tabular-nums'] },
  sheetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: color.blueLine,
    backgroundColor: color.blueTint,
    borderRadius: radius.badge,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  sheetChipText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6, color: color.courtBlue },
});
