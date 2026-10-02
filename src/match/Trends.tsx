import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';
import type { TrendAlert } from '../tennis';
import type { MatchClip } from '../types';
import { Card, Empty, GhostButton } from '../ui';
import { color, radius, type IconName } from '../theme';
import { PoseClip } from './PoseClip';

const SEVERITY: Record<TrendAlert['severity'], { word: string; icon: IconName; fg: string; line: string }> = {
  fix: { word: 'Fix now', icon: 'alert-circle', fg: color.danger, line: 'rgba(255,90,90,0.5)' },
  watch: { word: 'Watch', icon: 'eye-outline', fg: color.goldHot, line: color.goldLine },
  info: { word: 'Note', icon: 'information-circle-outline', fg: color.textLede, line: color.slate },
};

/**
 * What the tracker noticed, newest first, each with the one line to say at the changeover.
 * A clip, when the tracker cut one, opens under its own alert so the coach sees the body
 * shape next to the words that describe it.
 */
export function Trends({
  alerts,
  clips,
  names,
}: {
  alerts: TrendAlert[];
  clips: MatchClip[] | null;
  names: [string, string];
}) {
  const sorted = [...alerts].sort((a, b) => b.at - a.at);
  const byAlert = new Map((clips ?? []).map((c) => [c.alertId, c]));
  // An alert past the newest 60 is gone from the match, but its clip is still worth a look.
  const orphans = (clips ?? []).filter((c) => !alerts.some((a) => a.id === c.alertId));

  if (!sorted.length && !orphans.length) {
    return (
      <Empty icon="pulse-outline">
        No trends yet. While a match is tracked, patterns that hold get flagged here: a first-serve slump,
        errors piling up on one wing, short balls getting punished. Each comes with a line to say at the
        changeover.
      </Empty>
    );
  }

  return (
    <>
      {sorted.map((a) => (
        <AlertCard key={a.id} alert={a} clip={byAlert.get(a.id)} names={names} />
      ))}
      {orphans.length ? (
        <Card>
          <Text style={s.title}>More body-shape clips</Text>
          {orphans.map((c) => (
            <ClipToggle key={c.id} clip={c} names={names} />
          ))}
        </Card>
      ) : null}
    </>
  );
}

function AlertCard({ alert, clip, names }: { alert: TrendAlert; clip?: MatchClip; names: [string, string] }) {
  const sev = SEVERITY[alert.severity] ?? SEVERITY.info;
  return (
    <Card style={{ borderColor: sev.line }}>
      <View style={s.meta}>
        <View style={[s.chip, { borderColor: sev.line }]}>
          <Ionicons name={sev.icon} size={12} color={sev.fg} />
          <Text style={[s.chipText, { color: sev.fg }]}>{sev.word}</Text>
        </View>
        <Text style={s.who} numberOfLines={1}>
          {names[alert.who] ?? 'Player'} · after point {alert.at}
        </Text>
      </View>
      <Text style={s.title}>{alert.title}</Text>
      {alert.detail ? <Text style={s.detail}>{alert.detail}</Text> : null}
      {alert.cue ? (
        <View style={s.cue}>
          <Text style={s.cueLabel}>Say at the changeover:</Text>
          <Text style={s.cueText}>{alert.cue}</Text>
        </View>
      ) : null}
      {clip ? <ClipToggle clip={clip} names={names} /> : null}
    </Card>
  );
}

function ClipToggle({ clip, names }: { clip: MatchClip; names: [string, string] }) {
  const [open, setOpen] = useState(false);
  const who = names[clip.who] ?? 'Player';
  return (
    <View style={{ marginTop: 12 }}>
      <GhostButton
        label={open ? 'Hide body shape' : `Watch ${who}'s body shape`}
        icon={open ? 'close' : 'body-outline'}
        onPress={() => setOpen((o) => !o)}
      />
      {open ? (
        <View style={{ marginTop: 10 }}>
          <PoseClip frames={clip.frames} fps={clip.fps} label={`${who}: ${clip.title}`} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.badge,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  who: { flex: 1, fontSize: 12, color: color.textDim },
  title: { fontSize: 16, fontWeight: '800', color: color.chalk, lineHeight: 21 },
  detail: { fontSize: 14, lineHeight: 20, color: color.textBody, marginTop: 4 },
  cue: {
    marginTop: 12,
    backgroundColor: color.goldTint,
    borderLeftWidth: 3,
    borderLeftColor: color.gold,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  cueLabel: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.goldHot,
    marginBottom: 3,
  },
  cueText: { fontSize: 15.5, lineHeight: 21, fontWeight: '700', color: color.chalk },
});
