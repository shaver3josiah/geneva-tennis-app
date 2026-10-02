import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Linking from 'expo-linking';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../src/firebase';
import { useSession, useNames } from '../../src/session';
import { builtinWorkflow, saveWorkflowAnswers, subscribeSubmissions } from '../../src/data';
import { periodLabel, submissionId } from '../../src/period';
import { COLLECT_SCRIPT, bridgeScript } from '../../src/workflowBridge';
import type { SavedWorkflow, Workflow } from '../../src/types';
import { Button, Loading } from '../../src/ui';
import { emailWithFile, shareBase64, XLSX_MIME } from '../../src/exporter';
import { useAnyOrientation } from '../../src/orientation';
import { color, semantic, type } from '../../src/theme';

export default function WorkflowScreen() {
  const { id, athlete: athleteParam, sid } = useLocalSearchParams<{
    id: string;
    athlete?: string;
    sid?: string;
  }>();
  const { role, athlete, athletesById } = useSession();
  const names = useNames();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  // The Match Tracker can run from the Locker too, on a phone turned sideways on the fence.
  useAnyOrientation(id === 'builtin-match-tracker');

  const [workflow, setWorkflow] = useState<Workflow | null | undefined>(undefined);
  const [submissions, setSubmissions] = useState<Record<string, SavedWorkflow> | null>(null);
  const [seed, setSeed] = useState<Record<string, unknown> | undefined>();
  const [seeded, setSeeded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Assumed until the page says otherwise, so Save does not flash away on every open.
  const [hasFields, setHasFields] = useState(true);

  // Whose submission are we looking at? The coach arrives with an explicit athlete;
  // a family only ever has its own.
  const targetAthleteId = athleteParam || athlete?.id || '';
  const targetAthlete = athletesById[targetAthleteId] ?? athlete;

  useEffect(() => {
    if (!id) return;
    // A worksheet that ships in the binary has no Firestore document to watch, and
    // asking for one would render "no longer published" for a file that is right here.
    const local = builtinWorkflow(id);
    if (local) {
      setWorkflow(local);
      return;
    }
    return onSnapshot(doc(db, 'workflows', id), (snap) =>
      setWorkflow(snap.exists() ? ({ id: snap.id, ...snap.data() } as Workflow) : null)
    );
  }, [id]);

  useEffect(() => {
    if (!targetAthleteId) {
      setSubmissions({});
      return;
    }
    return subscribeSubmissions(targetAthleteId, setSubmissions);
  }, [targetAthleteId]);

  const cadence = workflow?.cadence ?? 'once';

  // With no sid, open the CURRENT period — that is what "fill in this week's evaluation"
  // means. With one, open exactly that submission, which may be a past period.
  const openId = useMemo(
    () => sid || (workflow ? submissionId(workflow.id, cadence, new Date()) : ''),
    [sid, workflow?.id, cadence]
  );

  useEffect(() => {
    if (!submissions || !openId) return;
    // Seed the WebView once. Re-injecting on every snapshot would stomp on whatever the
    // athlete is typing right now.
    setSeed((prev) => prev ?? submissions[openId]?.answers ?? {});
    setSeeded(true);
  }, [submissions, openId]);

  const current = submissions?.[openId];
  const isCurrentPeriod = !sid || (workflow ? openId === submissionId(workflow.id, cadence, new Date()) : false);

  /**
   * The coach reads submissions; they never author them. A family may write its own
   * player's answers — the parent as well as the player, because under-13s are meant
   * to use the guardian's account rather than have a login of their own.
   * Past periods are read-only: last week's evaluation is a record, not a draft.
   */
  const mayWrite =
    role !== 'coach' && targetAthleteId === athlete?.id && !!targetAthleteId && isCurrentPeriod;

  function onMessage(e: WebViewMessageEvent) {
    let payload: {
      type?: string;
      answers?: Record<string, string | boolean | number>;
      count?: number;
      name?: string;
      mime?: string;
      base64?: string;
      subject?: string;
      body?: string;
    };
    try {
      payload = JSON.parse(e.nativeEvent.data);
    } catch {
      return; // Not ours. The page is the coach's HTML and may post anything.
    }
    // A page with no `data-k` anywhere — one that keeps its own record on the phone and
    // marks nothing — has nothing for Save to collect. Take the button away rather than
    // let it write an empty submission under a hint that promises otherwise.
    // The Match Tracker opened from the Locker (no match behind it: the demo, or a quick
    // practice chart) still hands its Excel files and emails to the phone, the same way the
    // Matches screen does. A WebView cannot download a file on its own.
    if (payload.type === 'gt:file' && payload.base64) {
      shareBase64(payload.name ?? 'match.xlsx', payload.mime ?? XLSX_MIME, payload.base64).catch(() =>
        setStatus('The file did not open on this phone.')
      );
      return;
    }
    if (payload.type === 'gt:email') {
      emailWithFile({
        subject: payload.subject ?? 'Match stats',
        body: payload.body ?? '',
        isHtml: false,
        file: payload.base64 ? { name: payload.name ?? 'match.xlsx', mime: payload.mime ?? XLSX_MIME, base64: payload.base64 } : undefined,
      }).catch(() => setStatus('The email did not open on this phone.'));
      return;
    }
    if (payload.type === 'wffields') {
      setHasFields((payload.count ?? 0) > 0);
      return;
    }
    if (payload.type !== 'wfstate' || !targetAthleteId || !workflow) return;
    saveWorkflowAnswers(targetAthleteId, workflow, payload.answers ?? {}, new Date())
      .then(() => setStatus('Saved'))
      .catch(() => setStatus('Could not save. Check your connection.'));
  }

  if (workflow === undefined || !seeded) return <Loading label="Opening workflow…" />;
  if (workflow === null) {
    return (
      <View style={s.missing}>
        <Stack.Screen options={{ title: 'Workflow' }} />
        <Text style={type.body}>That workflow is no longer published.</Text>
      </View>
    );
  }

  const period = periodLabel(cadence, current?.periodKey ?? (sid ? '' : ''));
  const heading = period ? `${workflow.name} · ${period}` : workflow.name;

  return (
    <View style={s.page}>
      <Stack.Screen options={{ title: workflow.name }} />

      <View style={s.bar}>
        <View style={s.live} />
        <Text style={s.barText} numberOfLines={1}>
          {!hasFields
            ? 'Rendered in-app · nothing is recorded'
            : role === 'coach' && targetAthlete
              ? `${targetAthlete.playerName} · read only`
              : mayWrite
                ? 'Rendered in-app · sandboxed · no download'
                : 'Read only'}
        </Text>
      </View>

      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{
          html: workflow.html,
          // Both platforms get a real origin. Android needs one or the page is opaque
          // and its own inline script and storage are blocked. iOS was happy with
          // about:blank until a worksheet asked for the microphone: getUserMedia is
          // offered only to a secure context, and an opaque origin is not one, so the
          // Match Tracker would have found no navigator.mediaDevices to call, and no
          // camera.
          baseUrl: 'https://localhost/',
        }}
        // The document is the team's own HTML, so this is containment, not distrust:
        // scripts run (the forms need them) but the page gets no file system, no
        // cross-origin reach, and no way to navigate the frame somewhere else.
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        // The Match Tracker watches the court and listens for the racket. It runs on the
        // origin this WebView is already on, so a capture request from it is granted and
        // one from anywhere else still prompts. It does not skip the OS:
        // iOS asks the first time, using the two usage strings in app.json, and Android's
        // WebView routes the request through RECORD_AUDIO and CAMERA. Both of those are
        // declared in app.json — the microphone via expo-audio's `recordAudioAndroid`,
        // which used to be false, and the camera via `android.permissions`. Without the
        // manifest entry the WebView's own prompt is refused instantly and the page finds
        // no stream, which looks exactly like a broken page.
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        injectedJavaScript={bridgeScript(seed)}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(req) => {
          // The initial render is about:blank / the baseUrl. Anything else is a link
          // someone tapped: hand it to the system browser and stay put. The CDN and font
          // fetches the Match Tracker makes are subresources, not navigations, so they never
          // reach here.
          if (req.url === 'about:blank' || req.url.startsWith('https://localhost/')) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        style={s.web}
      />

      <View style={[s.saveBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Text style={s.hint} accessibilityLiveRegion="polite">
          {!hasFields
            ? 'This one keeps its own record on the phone. There is nothing to save.'
            : (status ??
              hintFor({ role, mayWrite, isCurrentPeriod, saved: !!current, heading, names }))}
        </Text>
        {mayWrite && hasFields && (
          <Button
            label="Save"
            onPress={() => {
              setStatus(null);
              webRef.current?.injectJavaScript(COLLECT_SCRIPT);
            }}
          />
        )}
      </View>
    </View>
  );
}

function hintFor({
  role,
  mayWrite,
  isCurrentPeriod,
  saved,
  heading,
  names,
}: {
  role: string;
  mayWrite: boolean;
  isCurrentPeriod: boolean;
  saved: boolean;
  heading: string;
  names: { player: string };
}): string {
  if (role === 'coach') return `${heading}. The player's own answers.`;
  if (!isCurrentPeriod) return `${heading}. Past entries are a record, not a draft.`;
  if (!mayWrite) return `${names.player.split(' ')[0]}’s answers. You can read them, not change them.`;
  return saved ? 'Saved earlier. Pick up where you left off.' : 'Your answers save to your account, not the coach’s file.';
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  missing: { flex: 1, backgroundColor: semantic.surfacePage, padding: 24, justifyContent: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: semantic.surfaceBand,
  },
  live: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.courtBlue },
  barText: {
    flex: 1,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: color.textDim,
  },
  web: { flex: 1, backgroundColor: color.bone },
  saveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surfaceBand,
  },
  hint: { flex: 1, ...type.meta, lineHeight: 17 },
});
