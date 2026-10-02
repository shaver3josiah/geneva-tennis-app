import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSession } from '../../src/session';
import { computeStats, FORMATS, pointLogRows, type PointRecord } from '../../src/tennis';
import {
  dateLabel,
  matchState,
  setMatchFinal,
  subscribeClips,
  subscribeMatch,
  subscribePoints,
  subscribeTeamSettings,
} from '../../src/matches';
import { useMatchAccess } from '../../src/match/useMatchAccess';
import { StateTag } from '../../src/match/StateTag';
import { Scoreboard } from '../../src/match/Scoreboard';
import { Summary } from '../../src/match/Summary';
import { Trends } from '../../src/match/Trends';
import { Export } from '../../src/match/Export';
import { SheetGrid } from '../../src/SheetGrid';
import type { Match, MatchClip, TeamSettings } from '../../src/types';
import { Body, Button, Empty, GhostButton, Loading, Screen, Segmented } from '../../src/ui';
import { color, semantic, type } from '../../src/theme';

type Pane = 'sheet' | 'summary' | 'trends' | 'export';

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { role } = useSession();
  const { access, retry } = useMatchAccess();

  const [match, setMatch] = useState<Match | null | undefined>(undefined);
  const [points, setPoints] = useState<PointRecord[] | null>(null);
  const [clips, setClips] = useState<MatchClip[] | null>(null);
  const [settings, setSettings] = useState<TeamSettings>({});
  const [picked, setPicked] = useState<Pane | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (access !== 'ready' || !id) return;
    setFailed(false);
    return subscribeMatch(id, setMatch, () => setFailed(true));
  }, [access, id, attempt]);
  useEffect(() => {
    if (access !== 'ready' || !id) return;
    return subscribePoints(id, setPoints);
  }, [access, id, attempt]);
  useEffect(() => {
    if (access !== 'ready') return;
    return subscribeTeamSettings(setSettings);
  }, [access]);

  // A live match opens on the point log, a finished one on its summary. Decided once, when
  // the match first arrives: a coach watching the sheet when the last point lands should
  // not have the view switched out from under him.
  const opening = useRef<Pane | null>(null);
  if (!opening.current && match) opening.current = match.status === 'final' ? 'summary' : 'sheet';
  const view: Pane = picked ?? opening.current ?? 'sheet';

  // Clips are the heavy part of a match, up to 180 KB each, so they load only when asked.
  useEffect(() => {
    if (access !== 'ready' || !id || view !== 'trends') return;
    return subscribeClips(id, setClips);
  }, [access, id, view]);

  const namesKey = match ? match.names.join('\u0001') : '';
  const stats = useMemo(() => computeStats(points ?? []), [points]);
  const rows = useMemo(
    () => pointLogRows(points ?? [], (namesKey ? namesKey.split('\u0001') : ['', '']) as [string, string]),
    [points, namesKey]
  );

  if (access === 'checking') return <Loading label="Opening the match…" />;
  if (access === 'failed' || failed) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Match' }} />
        <Body>This match did not load. Check signal, then try again.</Body>
        <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
          <GhostButton
            label="Try again"
            icon="refresh"
            onPress={() => {
              retry();
              setAttempt((n) => n + 1);
            }}
          />
        </View>
      </Screen>
    );
  }
  if (match === undefined) return <Loading label="Opening the match…" />;
  if (match === null) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Match' }} />
        <Empty icon="trash-outline">This match was deleted.</Empty>
        <GhostButton label="Back to matches" icon="arrow-back" onPress={() => router.back()} />
      </Screen>
    );
  }

  const state = matchState(match);
  const formatLabel = FORMATS.find((f) => f.id === match.formatId)?.label;
  const track = () => router.push({ pathname: '/match/track/[id]', params: { id: match.id } });

  const top = (
    <>
      <Stack.Screen options={{ title: match.position || 'Match' }} />
      <View style={s.headTop}>
        <Text style={s.eyebrow} numberOfLines={1}>
          {dateLabel(match.date)} · {match.title}
        </Text>
        <StateTag state={state} />
      </View>
      <Scoreboard match={match} points={points ?? []} />
      <Text style={s.meta} numberOfLines={2}>
        {[
          match.opponentSchool ? `${match.names[1]} plays for ${match.opponentSchool}` : null,
          formatLabel,
          match.pointCount ? `${match.pointCount} points charted` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <View style={s.actions}>
        <View style={{ flex: 1 }}>
          <Button label="Track live" onPress={track} />
        </View>
        {role === 'coach' && match.status !== 'final' && (
          <GhostButton
            label="Mark final"
            icon="flag-outline"
            onPress={() => {
              setNote(null);
              // No need to wait for the server: the change shows here at once, and a
              // refusal comes back through this catch.
              setMatchFinal(match.id).catch(() => setNote('Not marked final. Check signal and try again.'));
            }}
          />
        )}
      </View>
      {note ? <Text style={s.note}>{note}</Text> : null}
      <View style={{ marginTop: 14, marginBottom: 12 }}>
        <Segmented
          label="Match view"
          value={view}
          onChange={setPicked}
          options={[
            { value: 'sheet', label: 'Sheet', icon: 'grid-outline' },
            { value: 'summary', label: 'Summary', icon: 'stats-chart-outline' },
            { value: 'trends', label: 'Trends', icon: 'pulse-outline' },
            { value: 'export', label: 'Export', icon: 'share-outline' },
          ]}
        />
      </View>
    </>
  );

  // The point log scrolls inside itself, both ways, under a header that stays put. Every
  // other view is an ordinary page, so the header scrolls away and gives it the room.
  if (view === 'sheet') {
    return (
      <View style={s.page}>
        <View style={s.pad}>{top}</View>
        {points === null ? (
          <Loading label="Loading points…" />
        ) : points.length === 0 ? (
          <View style={s.pad}>
            <Empty icon="tennisball-outline">
              No points yet. Tap Track live, set the phone on the back fence behind the baseline, and every point
              lands here as it is charted.
            </Empty>
          </View>
        ) : (
          <SheetGrid rows={rows} follow={state === 'live'} />
        )}
      </View>
    );
  }

  return (
    <Screen>
      {top}
      {view === 'summary' &&
        (points === null ? (
          <Text style={type.meta}>Loading points…</Text>
        ) : points.length === 0 ? (
          <Empty icon="stats-chart-outline">The summary fills in as points are charted.</Empty>
        ) : (
          <Summary stats={stats} names={match.names} />
        ))}
      {view === 'trends' && <Trends alerts={match.alerts ?? []} clips={clips} names={match.names} />}
      {view === 'export' && (
        <Export
          match={match}
          points={points ?? []}
          settings={settings}
          isCoach={role === 'coach'}
          onDeleted={() => (router.canGoBack() ? router.back() : router.replace('/matches'))}
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  pad: { paddingHorizontal: 16, paddingTop: 16 },
  headTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  eyebrow: { ...type.eyebrow, flex: 1, color: color.goldHot },
  meta: { ...type.meta, marginTop: 8, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  note: { color: color.danger, fontSize: 13, marginTop: 8 },
});
