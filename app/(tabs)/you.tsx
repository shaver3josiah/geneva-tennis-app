import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession, useNames } from '../../src/session';
import { hasConsent, isAdult, savePrefs, setConsent, setMuted, subscribeThreads } from '../../src/data';
import { PRIVACY_URL } from '../../src/firebase';
import { Celebrate } from '../../src/Celebrate';
import { syncReminders } from '../../src/notify';
import {
  CELEBRATIONS,
  activeCelebration,
  isUnlocked,
  nextUp,
  readState,
  type Celebration,
} from '../../src/rewards';
import type { Thread, UserPrefs } from '../../src/types';
import { Avatar, Body, Button, Card, Eyebrow, Screen, Setting, Tag } from '../../src/ui';
import { CHAT_COLORS, bubbleColor, color, radius, semantic, type, type IconName } from '../../src/theme';

/**
 * Settings, as a grouped list rather than a stack of cards.
 *
 * The screen had grown one card per feature, eight of them, all the same weight: a
 * parent opening it to check consent scrolled past a streak scoreboard, six celebration
 * rows and a colour picker to reach the one switch that matters. The order here is by
 * what each role opens the screen FOR, the two personalisation pickers are collapsed to
 * a row each because they are chosen once, and every notification control now lives in
 * the same group instead of two.
 */
export default function You() {
  const { user, role, athlete, athletesById, consent, adult, prefs } = useSession();
  const names = useNames();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<'celebration' | 'colour' | null>(null);
  const [preview, setPreview] = useState({ id: 'spark', nonce: 0 });

  const rewards = readState(prefs);
  const chosen = CELEBRATIONS.find((c) => c.id === activeCelebration(rewards));
  const next = nextUp(rewards);
  const player = names.player.split(' ')[0];
  const parent = names.parent.split(' ')[0];

  useEffect(() => {
    if (!user) return;
    return subscribeThreads(user.uid, setThreads);
  }, [user?.uid]);

  const me = { coach: names.coach, parent: names.parent, player: names.player }[role];
  const roleLabel = {
    coach: 'Coach',
    parent: 'Parent / Guardian',
    player: athlete?.age ? `Player · Age ${athlete.age}` : 'Player',
  }[role];

  async function toggleConsent(nextOn: boolean) {
    if (!athlete) return;
    setError(null);
    try {
      await setConsent(athlete.id, nextOn);
    } catch {
      // The rule is the enforcement; if it says no, say so rather than flipping
      // the switch optimistically and lying about the state.
      setError('That change was refused. Only the guardian on this account can set consent.');
    }
  }

  /** Every picker on this screen writes to the same private document. */
  async function save(patch: Partial<UserPrefs>) {
    if (!user) return;
    setError(null);
    try {
      await savePrefs(user.uid, prefs, patch);
    } catch {
      setError('Could not save that. Check your connection.');
    }
  }

  async function toggleMute(threadId: string, muted: boolean) {
    if (!user) return;
    setError(null);
    try {
      await setMuted(user.uid, prefs, threadId, muted);
    } catch {
      setError('Could not save that notification setting.');
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <Screen>
        <View style={s.who}>
          <Avatar name={me} role={role} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{me}</Text>
            <Text style={s.role}>{roleLabel}</Text>
          </View>
        </View>

        {error ? (
          <Text style={s.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {/* Highest stakes first, and it is different for each of the three people. */}
        {role === 'parent' && (
          <>
            <Eyebrow style={s.firstGroup}>Consent</Eyebrow>
            <Card>
              <Setting
                first
                title="Training consent"
                description={`Lets ${player} message ${names.coach} directly. Turn it off and their thread goes read-only immediately.`}
                value={consent}
                onChange={toggleConsent}
              />
              <Setting
                title="Read every message"
                description="Always on for players under 18. Not something you or your player can switch off."
                value
                disabled
                tone="blue"
              />
              <Row
                icon="information-circle-outline"
                label={`${player}'s thread`}
                value={consent ? 'Open' : 'Locked'}
                valueTone={consent ? 'ok' : 'warn'}
                hint="Revoking locks it without deleting anything that was already said."
              />
            </Card>
          </>
        )}

        {role === 'coach' && (
          <>
            <Eyebrow style={s.firstGroup}>Roster</Eyebrow>
            <Card>
              {Object.values(athletesById).length === 0 ? (
                <Body>No players on the roster yet.</Body>
              ) : (
                // Consent is per athlete, so it is read off each row rather than off the
                // session — otherwise every athlete would inherit the first one's.
                Object.values(athletesById).map((a, i) => (
                  <View key={a.id} style={[s.row, i === 0 && s.rowFirst]}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowLabel}>
                        {a.playerName}
                        {a.age ? ` · ${a.age}` : ''}
                      </Text>
                      <Text style={s.rowHint}>
                        {isAdult(a) ? 'Adult player' : `Guardian: ${a.guardianName}`}
                      </Text>
                    </View>
                    <Tag tone={hasConsent(a) ? 'mon' : 'ro'}>
                      {hasConsent(a) ? 'Active' : 'Pending'}
                    </Tag>
                  </View>
                ))
              )}
              <Row
                icon="people-outline"
                label="Add or manage players"
                onPress={() => router.push('/roster')}
              />
            </Card>
          </>
        )}

        {/* The coach is not a player, so none of this is theirs. A guardian keeps it:
            an under-13 has no login and trains from the family account. */}
        {role !== 'coach' && (
          <>
            <Eyebrow style={role === 'player' ? s.firstGroup : undefined}>Training</Eyebrow>
            <Card>
              <Streak
                streak={rewards.streak}
                best={rewards.bestStreak}
                workouts={rewards.workouts}
              />
              <Row
                icon="sparkles-outline"
                label="Celebration"
                value={chosen?.label ?? 'Spark'}
                hint={next ? `Next: ${next.celebration.label}, ${next.hint}.` : 'Every one unlocked.'}
                expanded={open === 'celebration'}
                onPress={() => setOpen(open === 'celebration' ? null : 'celebration')}
              />
              {open === 'celebration' &&
                CELEBRATIONS.map((c) => (
                  <CelebrationRow
                    key={c.id}
                    celebration={c}
                    unlocked={isUnlocked(c, rewards)}
                    chosen={chosen?.id === c.id}
                    onPress={() => {
                      // Locked ones play but are not equipped. Watching what you are
                      // chasing is the point; a row of padlocks tells you nothing.
                      setPreview({ id: c.id, nonce: preview.nonce + 1 });
                      if (isUnlocked(c, rewards)) save({ celebration: c.id });
                    }}
                  />
                ))}
            </Card>
          </>
        )}

        <Eyebrow>Messaging</Eyebrow>
        <Card>
          {role === 'player' && (
            <Row
              first
              icon="chatbubbles-outline"
              label="Direct messages"
              value={consent ? 'Open' : 'Locked'}
              valueTone={consent ? 'ok' : 'warn'}
              hint={
                adult
                  ? consent
                    ? "You're 18+, so you manage your own consent."
                    : "You're 18+, so you manage your own consent. Messaging is not on yet: close the app and open it again to try once more."
                  : consent
                    ? `${parent} approved messaging and reads the thread too. That is how it works until you are 18.`
                    : `${parent} has not approved messaging yet. The calendar and the Locker still work.`
              }
            />
          )}
          {role === 'coach' && (
            <Row
              first
              icon="eye-outline"
              label="Every message is on the record"
              hint="A parent or guardian sees everything you send a player under 18, and nothing can be edited or deleted afterwards, by them or by you."
            />
          )}
          <Row
            first={role === 'parent'}
            icon="color-palette-outline"
            label="Your message colour"
            value={CHAT_COLORS[(prefs.chatColor ?? 'gold') as keyof typeof CHAT_COLORS]?.label ?? 'Geneva gold'}
            swatch={bubbleColor(prefs.chatColor)}
            expanded={open === 'colour'}
            onPress={() => setOpen(open === 'colour' ? null : 'colour')}
          />
          {open === 'colour' && (
            <View style={s.colourPanel}>
              <View style={s.swatches}>
                {(Object.keys(CHAT_COLORS) as (keyof typeof CHAT_COLORS)[]).map((k) => {
                  const on = (prefs.chatColor ?? 'gold') === k;
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={CHAT_COLORS[k].label}
                      onPress={() => save({ chatColor: k })}
                      style={[s.swatch, { backgroundColor: CHAT_COLORS[k].bg }, on && s.swatchOn]}
                    >
                      {on ? <Ionicons name="checkmark-sharp" size={20} color={color.bone} /> : null}
                    </Pressable>
                  );
                })}
              </View>
              <View style={[s.bubble, { backgroundColor: bubbleColor(prefs.chatColor) }]}>
                <Text style={s.bubbleText}>Your messages look like this.</Text>
              </View>
              <Text style={s.rowHint}>Only yours change. Everyone else keeps theirs.</Text>
            </View>
          )}
        </Card>

        {/* One home for every notification control. The streak reminder used to sit
            inside the streak card, three screens away from the thread switches. */}
        {role !== 'coach' && (
          <>
            <Eyebrow>Notifications</Eyebrow>
            <Card>
              <Setting
                first
                title="Streak reminders"
                description="A nudge in the evening when your streak is about to break, and a note the morning after if it does. Your phone sends these, not us."
                value={prefs.remind !== false}
                onChange={async (on) => {
                  await save({ remind: on });
                  await syncReminders(rewards, on);
                }}
              />
              {role === 'parent' &&
                threads.map((t) => {
                  const muted = (prefs.mutedThreads ?? []).includes(t.id);
                  // The only notifications this app sends are the local streak reminders
                  // in src/notify.ts. Nothing alerts on a message, so the description
                  // names the one thing muting does today, the tag on the thread row in
                  // Messages, and promises nothing about the phone.
                  return (
                    <Setting
                      key={t.id}
                      title={t.kind === 'coach-parent' ? 'Coach ↔ you' : `Coach ↔ ${player}`}
                      description={`${muted ? 'Muted, and tagged that way in Messages' : 'Not muted'}. The app sends no message alerts, so your phone stays quiet either way.`}
                      value={!muted}
                      onChange={(on) => toggleMute(t.id, !on)}
                    />
                  );
                })}
              {role === 'player' && !adult && (
                <Row
                  icon="lock-closed-outline"
                  label="Message alerts"
                  value="Parent"
                  hint={`${parent} controls notifications for your messages.`}
                />
              )}
            </Card>
          </>
        )}

        <Eyebrow>Account</Eyebrow>
        <Card>
          <Row first icon="mail-outline" label="Signed in as" value={user?.email ?? ''} />
          {/* Hidden until EXPO_PUBLIC_PRIVACY_URL is set: a link to nowhere is worse than none,
              and a store build is not releasable without one (docs/APP-STORE.md). */}
          {PRIVACY_URL ? (
            <Row
              icon="shield-checkmark-outline"
              label="Privacy policy"
              external
              onPress={() => Linking.openURL(PRIVACY_URL)}
            />
          ) : null}
          {/*
            THIS MUST NOT REACH THE COACH. The one route a player has for reporting a
            concern about their coach cannot go to that coach, cannot be a form that can
            answer a flagged message with a silent ok and mail nobody, and cannot ask a
            minor to certify their age before it will submit.

            Mail to the account holder instead. It needs no server, works for a minor,
            names no third party, and cannot be silently filtered. The address is the
            same one already published as the App Review contact.
          */}
          <Row
            icon="help-buoy-outline"
            label="Report a concern"
            external
            onPress={() =>
              Linking.openURL(
                'mailto:shaver3josiah@gmail.com' +
                  '?subject=' + encodeURIComponent('Geneva Tennis: report a concern') +
                  '&body=' + encodeURIComponent(
                    'Describe what happened. If it is about a message, say which conversation and roughly when.\n\n' +
                      'This goes to the person who runs the app, not to the coach.\n\n'
                  )
              )
            }
          />
          {role !== 'coach' && (
            <Row
              icon="trash-outline"
              label="Delete my account"
              danger
              onPress={() => router.push('/delete-account')}
            />
          )}
          <View style={{ height: 14 }} />
          <SignOutButton />
        </Card>
      </Screen>

      <Celebrate id={preview.id} nonce={preview.nonce} />
    </View>
  );
}

/**
 * The streak, as one line rather than three equal tiles.
 *
 * Three same-sized number tiles gave the best run and the workout count the same weight
 * as the streak itself, which is the number the athlete opened the screen to see. At
 * zero it is an empty state that says how to start one, not a zero.
 */
function Streak({ streak, best, workouts }: { streak: number; best: number; workouts: number }) {
  const hot = streak >= 3;
  return (
    <View style={[s.row, s.rowFirst]}>
      <View style={[s.flame, hot && { backgroundColor: 'rgba(255,122,24,0.14)', borderColor: '#FF7A18' }]}>
        <Ionicons name={hot ? 'flame' : 'flame-outline'} size={19} color={hot ? '#FF7A18' : color.textDim} />
      </View>
      <View style={{ flex: 1 }}>
        {streak === 0 ? (
          <>
            <Text style={s.streakLead}>No streak yet</Text>
            <Text style={s.rowHint}>
              Opening the app counts the day. Come back tomorrow and it becomes a run.
              {workouts > 0 ? ` ${workouts} logged so far.` : ''}
            </Text>
          </>
        ) : (
          <>
            <Text style={s.streakLead}>
              {streak} day{streak === 1 ? '' : 's'} in a row
            </Text>
            <Text style={s.rowHint}>
              Best run {best} · {workouts} workout{workouts === 1 ? '' : 's'} logged
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The one row vocabulary this screen uses for everything that is not a switch: a status,
 * a link out, a destination, or a disclosure. Same shape every time, so the accessory on
 * the right is the only thing that has to be read to know what a tap will do.
 */
function Row({
  icon,
  label,
  value,
  valueTone,
  hint,
  onPress,
  expanded,
  external,
  danger,
  swatch,
  first,
}: {
  icon?: IconName;
  label: string;
  value?: string;
  valueTone?: 'ok' | 'warn';
  hint?: string;
  onPress?: () => void;
  /** Present means this row discloses a panel below it; the chevron points at its state. */
  expanded?: boolean;
  external?: boolean;
  danger?: boolean;
  /** First row in its group: drops the divider, which belongs BETWEEN siblings. */
  first?: boolean;
  /** A solid dot of the chosen colour, for the picker row. */
  swatch?: string;
}) {
  const body = (
    <>
      {icon ? (
        <Ionicons
          name={icon}
          size={18}
          color={danger ? color.danger : color.textDim}
          style={{ marginTop: 1 }}
        />
      ) : null}
      <View style={{ flex: 1 }}>
        <View style={s.rowTop}>
          <Text style={[s.rowLabel, danger && { color: color.danger }]}>{label}</Text>
          {value ? (
            <Text
              style={[
                s.rowValue,
                valueTone === 'ok' && { color: color.win },
                valueTone === 'warn' && { color: color.danger },
              ]}
              numberOfLines={1}
            >
              {value}
            </Text>
          ) : null}
        </View>
        {hint ? <Text style={s.rowHint}>{hint}</Text> : null}
      </View>
      {swatch ? <View style={[s.dot, { backgroundColor: swatch }]} /> : null}
      {expanded !== undefined ? (
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={17} color={color.textDim} />
      ) : external ? (
        <Ionicons name="open-outline" size={16} color={color.textDim} />
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={17} color={color.textDim} />
      ) : null}
    </>
  );

  if (!onPress) return <View style={[s.row, first && s.rowFirst]}>{body}</View>;
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [s.row, first && s.rowFirst, pressed && { backgroundColor: color.inkHover }]}
    >
      {body}
    </Pressable>
  );
}

/**
 * A celebration, locked or not. A locked one still shows what it is, what it costs, and
 * PLAYS when tapped: a row of grey padlocks tells an athlete nothing about what they are
 * chasing, and the animation is the thing being chased. Tapping just does not equip it.
 */
function CelebrationRow({
  celebration: c,
  unlocked,
  chosen,
  onPress,
}: {
  celebration: Celebration;
  unlocked: boolean;
  chosen: boolean;
  onPress: () => void;
}) {
  const need = [
    c.needWorkouts !== undefined ? `${c.needWorkouts} workouts` : '',
    c.needStreak !== undefined ? `a ${c.needStreak} day streak` : '',
  ]
    .filter(Boolean)
    .join(' or ');

  return (
    <Pressable
      accessibilityRole={unlocked ? 'radio' : 'button'}
      accessibilityState={unlocked ? { selected: chosen } : undefined}
      accessibilityLabel={
        unlocked ? `${c.label}. ${c.blurb}` : `Play ${c.label}. Locked, unlocks at ${need}.`
      }
      onPress={onPress}
      style={({ pressed }) => [
        s.celeb,
        chosen && { borderColor: color.gold, backgroundColor: color.goldTint },
        pressed && { backgroundColor: color.inkHover },
        !unlocked && { opacity: 0.72 },
      ]}
    >
      <Ionicons
        name={!unlocked ? 'lock-closed' : chosen ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={!unlocked ? color.textFaint : chosen ? color.goldHot : color.textDim}
      />
      <View style={{ flex: 1 }}>
        <Text style={s.celebName}>{c.label}</Text>
        <Text style={s.rowHint}>{unlocked ? c.blurb : `${c.blurb} Unlocks at ${need}.`}</Text>
      </View>
      {chosen ? <Tag tone="mon">On</Tag> : <Ionicons name="play-circle-outline" size={19} color={color.textDim} />}
    </Pressable>
  );
}

function SignOutButton() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label="Sign out"
      busy={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await signOut();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

const s = StyleSheet.create({
  who: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 18,
    padding: 14,
  },
  name: { fontSize: 18, fontWeight: '800', color: color.chalk },
  role: { ...type.meta, marginTop: 2 },
  error: { color: color.danger, fontSize: 13.5, lineHeight: 19, marginTop: 12 },
  /** The first group sits closer to the identity card than groups do to each other. */
  firstGroup: { marginTop: 14 },

  // One row shape for the whole screen. The hairline is a divider between siblings, so
  // the first row in a group drops it rather than drawing a line under the card's title.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    minHeight: 48,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
  },
  rowFirst: { borderTopWidth: 0, paddingTop: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: '700', color: color.chalk },
  rowValue: { fontSize: 13, fontWeight: '700', color: color.textDim, maxWidth: '55%' },
  rowHint: { fontSize: 12.5, lineHeight: 17, color: color.textDim, marginTop: 2 },

  flame: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakLead: { fontSize: 17, fontWeight: '800', color: color.chalk, letterSpacing: -0.2 },
  /** The current bubble colour, shown on its row so the label is not the only evidence. */
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: semantic.borderStrong, marginTop: 1 },

  celeb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.chip,
    marginTop: 8,
  },
  celebName: { fontSize: 14.5, fontWeight: '700', color: color.chalk },

  colourPanel: { paddingTop: 12 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchOn: { borderColor: color.bone },
  bubble: {
    alignSelf: 'flex-end',
    marginTop: 14,
    borderRadius: 16,
    borderBottomRightRadius: 5,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  bubbleText: { fontSize: 15, lineHeight: 21, color: color.chalk },
});
