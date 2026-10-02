import { useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Linking from 'expo-linking';
import { useKeepAwake } from 'expo-keep-awake';
import { useAnyOrientation } from '../../../src/orientation';
import { useSession } from '../../../src/session';
import { builtinWorkflow } from '../../../src/data';
import type { TrendAlert } from '../../../src/tennis';
import {
  loadUnsynced,
  subscribeMatch,
  subscribeTeamSettings,
  waitForPoints,
  type ClipMessage,
} from '../../../src/matches';
import { initScript, MatchSync, type PointsMessage, type SyncState } from '../../../src/match/sync';
import { useMatchAccess } from '../../../src/match/useMatchAccess';
import { emailWithFile, shareBase64, XLSX_MIME } from '../../../src/exporter';
import type { Match, TeamSettings } from '../../../src/types';
import { Body, GhostButton, Loading } from '../../../src/ui';
import { color, radius, semantic } from '../../../src/theme';

/** The tracker page ships inside the binary, built from tracker/ by scripts/build-tracker.mjs. */
const TRACKER_ID = 'builtin-match-tracker';

/** Everything the tracker page posts. docs/MATCH-DATA.md, "Bridge messages". */
type TrackerMessage =
  | { type: 'gt:ready' }
  | ({ type: 'gt:points' } & PointsMessage)
  | { type: 'gt:alert'; alert: TrendAlert }
  | { type: 'gt:clip'; clip: ClipMessage }
  | { type: 'gt:file'; name: string; mime: string; base64: string }
  | { type: 'gt:email'; subject: string; body: string; name?: string; mime?: string; base64?: string }
  | { type: 'gt:close' };

/**
 * Live tracking: the phone on the back fence. The camera, the pose model and the charting
 * all live in the tracker page; this screen hosts it full screen, keeps the phone awake,
 * and carries what the page charts into Firestore and the coach's sheet (src/match/sync.ts).
 */
export default function TrackScreen() {
  // A phone strapped to a fence that dims and locks after 30 seconds charts nothing.
  useKeepAwake();
  // The phone hangs on the fence in landscape: let the screen follow it while tracking.
  useAnyOrientation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { access, retry } = useMatchAccess();

  const web = useRef<WebView>(null);
  const engine = useRef<MatchSync | null>(null);
  const pageReady = useRef(false);
  /** Anything the page sends before the saved points have loaded, replayed once they have. */
  const early = useRef<TrackerMessage[]>([]);
  const matchRef = useRef<Match | null>(null);
  const settingsRef = useRef<TeamSettings>({});

  const [match, setMatch] = useState<Match | null | undefined>(undefined);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [details, setDetails] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped to remount the WebView after the OS kills its content process.
  const [webKey, setWebKey] = useState(0);
  const [started, setStarted] = useState(false);

  const html = builtinWorkflow(TRACKER_ID)?.html;
  // A new source object would reload the page, camera and all, on every render.
  const source = useMemo(() => ({ html: html ?? '', baseUrl: 'https://localhost/' }), [html]);

  useEffect(() => {
    if (access !== 'ready' || !id) return;
    return subscribeMatch(
      id,
      (m) => {
        matchRef.current = m;
        setMatch(m);
        if (m) engine.current?.setMatch(m);
      },
      () => setLoadError('The match did not load. Check signal, then open the tracker again.')
    );
  }, [access, id]);

  useEffect(() => {
    if (access !== 'ready') return;
    return subscribeTeamSettings((s) => {
      settingsRef.current = s;
      engine.current?.setSettings(s);
    });
  }, [access]);

  // The engine starts once, from the points already saved plus any this phone charted and
  // never got into Firestore, so the tracker resumes exactly where the match is.
  const haveMatch = !!match;
  useEffect(() => {
    const m = matchRef.current;
    if (!haveMatch || !m || !user) return;
    let live = true;
    let stop: (() => void) | undefined;
    loadUnsynced(m.id).then((restored) => {
      if (!live) return;
      stop = waitForPoints(
        m.id,
        m.pointCount ?? 0,
        (saved) => {
          stop?.();
          stop = undefined;
          if (!live) return;
          const e = new MatchSync(matchRef.current ?? m, saved, restored, user.uid, setSync);
          e.setSettings(settingsRef.current);
          engine.current = e;
          setStarted(true);
          early.current.splice(0).forEach(route);
          inject();
        },
        () => live && setLoadError('The points already charted did not load. Check signal, then open the tracker again.')
      );
    });
    return () => {
      live = false;
      stop?.();
      engine.current?.dispose();
      engine.current = null;
    };
    // Keyed on the match EXISTING, not on the match: matchRef carries the latest snapshot,
    // and re-running on every snapshot would restart the engine every three points.
  }, [haveMatch, user?.uid]);

  // Android's back button leaves the screen as fast as the arrow does, so it asks first too.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if ((engine.current?.unsaved() ?? 0) === 0) return false;
      setConfirmLeave(true);
      return true;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  function inject() {
    if (!engine.current || !pageReady.current) return;
    web.current?.injectJavaScript(initScript(engine.current.initPayload()));
  }

  const exit = () =>
    router.canGoBack() ? router.back() : router.replace({ pathname: '/match/[id]', params: { id: id ?? '' } });

  function leave() {
    if ((engine.current?.unsaved() ?? 0) > 0) return setConfirmLeave(true);
    exit();
  }

  function route(msg: TrackerMessage) {
    const e = engine.current;
    switch (msg.type) {
      case 'gt:points':
        return e ? e.onPoints(msg) : void early.current.push(msg);
      case 'gt:alert':
        return e ? e.onAlert(msg.alert) : void early.current.push(msg);
      case 'gt:clip':
        return e ? e.onClip(msg.clip) : void early.current.push(msg);
      case 'gt:file':
        shareBase64(msg.name, msg.mime, msg.base64).catch((err: Error) => setNotice(`The file did not open. ${err.message}`));
        return;
      case 'gt:email': {
        const to = settingsRef.current.coachEmail?.trim();
        emailWithFile({
          to,
          subject: msg.subject,
          body: msg.body,
          isHtml: /^\s*</.test(msg.body ?? ''),
          file: msg.base64 ? { name: msg.name ?? 'match.xlsx', mime: msg.mime ?? XLSX_MIME, base64: msg.base64 } : undefined,
        })
          .then((outcome) => {
            if (outcome === 'shared') {
              setNotice(`No mail account on this phone, so the share sheet opened. Send it to ${to || 'the coach'}.`);
            }
          })
          .catch((err: Error) => setNotice(`The email did not open. ${err.message}`));
        return;
      }
      case 'gt:close':
        return leave();
    }
  }

  function onMessage(ev: WebViewMessageEvent) {
    let msg: TrackerMessage;
    try {
      msg = JSON.parse(ev.nativeEvent.data);
    } catch {
      return; // not one of ours
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'gt:ready') {
      // Also after a reload: the page starts empty again and gets every point back.
      pageReady.current = true;
      inject();
      return;
    }
    route(msg);
  }

  function reloadPage() {
    pageReady.current = false;
    setWebKey((k) => k + 1);
  }

  if (access === 'checking' || (access === 'ready' && match === undefined && !loadError)) {
    return <Loading label="Opening the tracker…" />;
  }

  // A deleted match ends charting at once: a tracker left running would take points with
  // nowhere to put them. A load error only blocks a tracker that never started; once it is
  // running, a listener hiccup must not take the camera away mid-set.
  const problem =
    access === 'failed'
      ? 'This phone could not confirm you are on the team, so it cannot save points. Check signal, then try again.'
      : !html
        ? 'This build of the app does not include the match tracker. Update the app, then try again.'
        : match === null
          ? 'This match was deleted, so there is nothing left to chart into.'
          : started
            ? null
            : loadError;
  if (problem) {
    return (
      <View style={[s.page, s.center, { paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Body>{problem}</Body>
        <View style={s.problemRow}>
          {access === 'failed' && <GhostButton label="Try again" icon="refresh" onPress={retry} />}
          <GhostButton label="Back" icon="arrow-back" onPress={exit} />
        </View>
      </View>
    );
  }

  const pill = pillFor(sync);
  const waiting = sync?.waiting ?? 0;

  return (
    <View style={s.page}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[s.bar, { paddingTop: insets.top + 4 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Leave the tracker"
          onPress={leave}
          hitSlop={6}
          style={({ pressed }) => [s.back, pressed && { backgroundColor: color.inkHover }]}
        >
          <Ionicons name="chevron-back" size={24} color={color.chalk} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sync status: ${pill.text}`}
          accessibilityHint="Shows what the sync is doing"
          accessibilityLiveRegion="polite"
          onPress={() => setDetails((d) => !d)}
          style={[s.pill, { borderColor: TONE[pill.tone].line }]}
        >
          <View style={[s.pillDot, { backgroundColor: TONE[pill.tone].dot }]} />
          <Text style={s.pillText} numberOfLines={1}>
            {pill.text}
          </Text>
        </Pressable>
      </View>

      {details ? (
        <View style={s.details}>
          <Text style={s.detailText}>{detailFor(sync)}</Text>
        </View>
      ) : null}
      {notice ? (
        <View style={s.details} accessibilityLiveRegion="polite">
          <Text style={s.detailText}>{notice}</Text>
        </View>
      ) : null}

      <WebView
        key={webKey}
        ref={web}
        originWhitelist={['*']}
        // A real origin, as app/workflow/[id].tsx explains: getUserMedia is offered only to
        // a secure context, and the camera is the whole point of this page.
        source={source}
        // The same containment as every Locker page: scripts run, nothing else gets out.
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // Lets a developer attach Safari or Chrome devtools to the tracker. Never in a release.
        webviewDebuggingEnabled={__DEV__}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(req) => {
          if (req.url === 'about:blank' || req.url.startsWith('https://localhost/')) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        // Camera, pose model and a long match are exactly what gets a web content process
        // killed for memory. Left alone the view goes blank mid-set; remounted, the page
        // asks for its points again and resumes from every one of them.
        onContentProcessDidTerminate={reloadPage}
        onRenderProcessGone={reloadPage}
        style={s.web}
      />

      {confirmLeave && (
        <View style={[s.confirm, { bottom: insets.bottom + 16 }]}>
          <Text style={s.confirmTitle}>
            {waiting} {waiting === 1 ? 'point is' : 'points are'} not saved yet
          </Text>
          <Text style={s.confirmBody}>
            They stay on this phone and go the next time the tracker opens for this match. Staying a moment is
            better: they go as soon as there is signal.
          </Text>
          <View style={s.problemRow}>
            <GhostButton label="Stay" onPress={() => setConfirmLeave(false)} />
            <GhostButton label="Leave anyway" tone="danger" onPress={exit} />
          </View>
        </View>
      )}
    </View>
  );
}

type Tone = 'ok' | 'warn' | 'bad';
const TONE: Record<Tone, { dot: string; line: string }> = {
  ok: { dot: color.win, line: 'rgba(70,214,140,0.45)' },
  warn: { dot: color.ball, line: 'rgba(221,245,74,0.5)' },
  bad: { dot: color.danger, line: 'rgba(255,90,90,0.55)' },
};

/** The pill says it in words; the dot only repeats it. */
function pillFor(s: SyncState | null): { text: string; tone: Tone } {
  if (!s) return { text: 'Loading saved points…', tone: 'warn' };
  if (s.db === 'gone') return { text: 'Match deleted — not saving', tone: 'bad' };
  if (s.db === 'failed') return { text: 'Not saved — check signal. Retrying…', tone: 'bad' };
  if (s.db === 'denied') return { text: 'Not saved — no permission. Retrying…', tone: 'bad' };
  if (s.db === 'offline') return { text: `Offline — will retry · ${s.waiting} waiting`, tone: 'warn' };
  const sheet = { off: '', idle: '', pushing: ' · Sheet …', ok: ' · Sheet ✓', failed: ' · Sheet retrying' }[s.sheet];
  return { text: `Synced ${s.synced} pts${sheet}`, tone: s.sheet === 'failed' ? 'warn' : 'ok' };
}

function detailFor(s: SyncState | null): string {
  if (!s) return 'Loading the points already charted, so the tracker resumes where the match is.';
  const db = {
    ok: `${s.synced} points saved to the team's matches.${s.waiting ? ` ${s.waiting} on their way.` : ''}`,
    offline: `No signal. ${s.waiting} points are kept on this phone and go as soon as it comes back.`,
    failed: `The last save failed. ${s.waiting} points are kept on this phone and retried every few seconds.`,
    denied: 'The team database refused the save. This account may not be on the roster, or the latest rules are not deployed. Points are kept on this phone.',
    gone: 'The coach deleted this match, so nothing more is saved.',
  }[s.db];
  const sheet = {
    off: 'No Google Sheet: the coach has not set up the connector.',
    idle: 'Google Sheet: waiting for the first batch.',
    pushing: 'Google Sheet: sending.',
    ok: 'Google Sheet: up to date.',
    failed: `Google Sheet: not updated. ${s.sheetError ?? ''} Retrying with the next batch.`,
  }[s.sheet];
  return `${db}\n${sheet}`;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.night },
  center: { justifyContent: 'center', padding: 24 },
  problemRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 8,
    paddingBottom: 6,
    backgroundColor: semantic.surfaceBand,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: color.inkLift,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { flexShrink: 1, fontSize: 12.5, fontWeight: '700', color: color.chalk, fontVariant: ['tabular-nums'] },
  details: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: semantic.surfaceBand,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
  },
  detailText: { fontSize: 12.5, lineHeight: 18, color: color.textBody },
  web: { flex: 1, backgroundColor: color.night },
  confirm: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: color.danger,
    borderRadius: radius.cardLg,
    padding: 16,
  },
  confirmTitle: { fontSize: 16, fontWeight: '800', color: color.chalk },
  confirmBody: { fontSize: 13.5, lineHeight: 19, color: color.textBody, marginTop: 6 },
});
