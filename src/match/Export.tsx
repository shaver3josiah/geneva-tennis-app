import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { pointLogRows, toTSV, type PointRecord } from '../tennis';
import { deleteMatch } from '../matches';
import { emailWithFile, shareCsv, shareXlsx, statsEmail, xlsxFile, type EmailOutcome } from '../exporter';
import type { Match, TeamSettings } from '../types';
import { Body, Button, Card, CardTitle, Empty, Eyebrow, GhostButton } from '../ui';
import { color, radius, semantic, type IconName } from '../theme';

const EMAIL_SAID: Record<EmailOutcome, string | null> = {
  sent: 'Sent.',
  saved: 'Saved to your drafts. Send it from your mail app.',
  cancelled: null,
  'handed-off': 'Your mail app has it, attachment and all. Tap send there.',
  shared: '', // filled in below: it names the address the share sheet could not carry
};

/**
 * Getting a match out: a file for Excel or Numbers, text for Google Sheets with no setup
 * at all, and one tap to email it all to the coach. That last one is how a student with
 * no Google connector gets a match to him, so on a student's phone it leads, full width.
 */
export function Export({
  match,
  points,
  settings,
  isCoach,
  onDeleted,
}: {
  match: Match;
  points: PointRecord[];
  settings: TeamSettings;
  isCoach: boolean;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const coachEmail = settings.coachEmail?.trim();
  const none = points.length === 0;

  async function run(key: string, job: () => Promise<string | null | void>) {
    setBusy(key);
    setNotice(null);
    try {
      const said = await job();
      if (said) setNotice({ ok: true, text: said });
    } catch (e) {
      setNotice({ ok: false, text: (e as Error)?.message || 'That did not work. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  const email = () =>
    run('email', async () => {
      const outcome = await emailWithFile({ to: coachEmail, ...statsEmail(match, points), file: xlsxFile(match, points) });
      if (outcome === 'shared') {
        return `This phone has no mail account set up, so the share sheet opened instead. Send it to ${coachEmail || 'your coach'}.`;
      }
      return EMAIL_SAID[outcome];
    });

  const tsv = () => toTSV(pointLogRows(points, match.names));

  return (
    <View>
      {none ? (
        <Empty icon="document-outline">
          Nothing to export yet. Once points are charted, this is where they go to Excel, Google Sheets or
          the coach’s inbox.
        </Empty>
      ) : (
        <>
          {!isCoach && (
            <Card>
              <CardTitle>Send it to the coach</CardTitle>
              <Body>
                {coachEmail
                  ? `Opens your mail app addressed to ${coachEmail}, with the stats in the message and every point in an Excel file.`
                  : 'Opens your mail app with the stats in the message and every point in an Excel file.'}
              </Body>
              <View style={{ height: 12 }} />
              <Button
                label={coachEmail ? 'Email stats to the coach' : 'Email stats'}
                onPress={email}
                busy={busy === 'email'}
                disabled={!!busy}
              />
            </Card>
          )}

          <Eyebrow>Files</Eyebrow>
          {isCoach && (
            <Action
              icon="mail-outline"
              title="Email stats"
              detail="The stats table in the message, every point in an attached Excel file."
              busy={busy === 'email'}
              disabled={!!busy}
              onPress={email}
            />
          )}
          <Action
            icon="grid-outline"
            title="Excel (.xlsx)"
            detail="Summary, every point, every shot, the serve map and the trends. Opens in Excel, Numbers and Google Sheets."
            busy={busy === 'xlsx'}
            disabled={!!busy}
            onPress={() => run('xlsx', () => shareXlsx(match, points))}
          />
          <Action
            icon="document-text-outline"
            title="CSV"
            detail="The point log as plain text, one row per point."
            busy={busy === 'csv'}
            disabled={!!busy}
            onPress={() => run('csv', () => shareCsv(match, points))}
          />

          <Eyebrow>Google Sheets</Eyebrow>
          {match.sheetUrl ? (
            <Action
              icon="open-outline"
              title="Open the linked Sheet"
              detail="This match's own spreadsheet, kept up to date while it is tracked."
              disabled={!!busy}
              onPress={() =>
                run('open', async () => {
                  await Linking.openURL(match.sheetUrl!);
                })
              }
            />
          ) : null}
          <Action
            icon="add-circle-outline"
            title="New Google Sheet"
            detail="Copies the point log and opens a blank sheet. Paste into cell A1. No setup needed."
            busy={busy === 'new'}
            disabled={!!busy}
            onPress={() =>
              run('new', async () => {
                // Copy first: opening the browser sends this app to the background.
                await Clipboard.setStringAsync(tsv());
                await Linking.openURL('https://sheets.new');
                return 'Copied. Paste into cell A1 of the new sheet.';
              })
            }
          />
          <Action
            icon="copy-outline"
            title="Copy for Google Sheets"
            detail="The point log, ready to paste into any sheet you already have."
            busy={busy === 'copy'}
            disabled={!!busy}
            onPress={() =>
              run('copy', async () => {
                await Clipboard.setStringAsync(tsv());
                return 'Copied. Paste into cell A1 of any Google Sheet.';
              })
            }
          />
        </>
      )}

      {notice ? (
        <View style={[s.notice, !notice.ok && s.noticeBad]} accessibilityLiveRegion="polite">
          <Ionicons
            name={notice.ok ? 'checkmark-circle' : 'alert-circle'}
            size={16}
            color={notice.ok ? color.win : color.danger}
          />
          <Text style={s.noticeText}>{notice.text}</Text>
        </View>
      ) : null}

      {isCoach && (
        <View style={{ marginTop: 26 }}>
          {confirmDelete ? (
            <Card>
              <CardTitle>Delete for good</CardTitle>
              <Body>
                The match, all {points.length} charted points and any body-shape clips come off every phone.
                A linked Google Sheet stays in your Drive.
              </Body>
              <View style={s.confirmRow}>
                <GhostButton
                  label={busy === 'delete' ? 'Deleting…' : 'Yes, delete'}
                  icon="trash-outline"
                  tone="danger"
                  disabled={!!busy}
                  onPress={() =>
                    run('delete', async () => {
                      await deleteMatch(match.id);
                      onDeleted();
                    })
                  }
                />
                <GhostButton label="Keep it" disabled={!!busy} onPress={() => setConfirmDelete(false)} />
              </View>
            </Card>
          ) : (
            <GhostButton label="Delete match" icon="trash-outline" tone="danger" onPress={() => setConfirmDelete(true)} />
          )}
        </View>
      )}
    </View>
  );
}

function Action({
  icon,
  title,
  detail,
  onPress,
  busy,
  disabled,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={detail}
      accessibilityState={{ busy: !!busy, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.action, pressed && { backgroundColor: color.inkHover }, disabled && !busy && { opacity: 0.55 }]}
    >
      <View style={s.icon}>
        {busy ? <ActivityIndicator color={color.goldHot} /> : <Ionicons name={icon} size={20} color={color.goldHot} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.title}>{title}</Text>
        <Text style={s.detail}>{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={color.textFaint} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.inkLift,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.card,
    padding: 12,
    marginBottom: 8,
    minHeight: 64,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.chip,
    backgroundColor: color.goldTint,
    borderWidth: 1,
    borderColor: color.oldGold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 15, fontWeight: '700', color: color.chalk },
  detail: { fontSize: 12.5, lineHeight: 17, color: color.textDim, marginTop: 2 },
  notice: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 10,
    padding: 12,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(70,214,140,0.45)',
    backgroundColor: 'rgba(70,214,140,0.08)',
  },
  noticeBad: { borderColor: 'rgba(255,90,90,0.5)', backgroundColor: 'rgba(255,90,90,0.08)' },
  noticeText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: color.chalk },
  confirmRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
});
