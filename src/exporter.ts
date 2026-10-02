import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MailComposer from 'expo-mail-composer';
import {
  bytesToBase64,
  buildXlsx,
  computeStats,
  FORMATS,
  matchFileName,
  matchWorkbook,
  summaryRows,
  toCSV,
  pointLogRows,
  type MatchMeta,
  type PointRecord,
  type XCell,
} from './tennis';
import { cellValue, fullTitle, summarySections } from './matches';
import type { Match } from './types';

/**
 * Getting a match out of the app: files, the share sheet, and email.
 *
 * Everything is written to the cache directory and handed to the system. Nothing written
 * here is the record (Firestore is), so the OS is welcome to clear it.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';

/** iOS picks share targets by type identifier, not MIME. Without it, Numbers and Excel
 *  are missing from the sheet and "Save to Files" names the file oddly. */
const UTI: Record<string, string> = {
  [XLSX_MIME]: 'org.openxmlformats.spreadsheetml.sheet',
  [CSV_MIME]: 'public.comma-separated-values-text',
};

/** A file name the tracker sent, made safe for every file system it might land on. */
const safeName = (name: string) =>
  String(name || 'match').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);

function cacheFile(name: string, data: string, encoding: 'base64' | 'utf8'): File {
  const file = new File(Paths.cache, safeName(name));
  // Overwrite rather than fail: exporting the same match twice is the normal case.
  file.create({ overwrite: true });
  file.write(data, { encoding });
  return file;
}

/** The browser build has no share sheet for local files, so it downloads instead. */
function download(name: string, mime: string, base64: string) {
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${base64}`;
  a.download = safeName(name);
  a.click();
}

async function share(file: File, mime: string, title: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone has no share sheet to open.');
  await Sharing.shareAsync(file.uri, { mimeType: mime, UTI: UTI[mime], dialogTitle: title });
}

export async function shareBase64(name: string, mime: string, base64: string) {
  if (Platform.OS === 'web') return download(name, mime, base64);
  await share(cacheFile(name, base64, 'base64'), mime, name);
}

export async function shareText(name: string, mime: string, text: string) {
  if (Platform.OS === 'web') {
    const a = document.createElement('a');
    a.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
    a.download = safeName(name);
    a.click();
    return;
  }
  await share(cacheFile(name, text, 'utf8'), mime, name);
}

/** What happened, in the words the screen shows. */
export type EmailOutcome = 'sent' | 'saved' | 'cancelled' | 'handed-off' | 'shared';

/**
 * Open the mail composer, addressed and with the file attached.
 *
 * When the phone has no mail account set up (common on a student's phone that only ever
 * used Gmail in a browser), the composer is not available at all. The share sheet still
 * reaches Gmail, Outlook and Messages, so the file goes there instead, and the caller
 * tells the student where to send it, because the share sheet cannot carry an address.
 */
export async function emailWithFile(opts: {
  to?: string;
  subject: string;
  body: string;
  isHtml: boolean;
  file?: { name: string; mime: string; base64: string };
}): Promise<EmailOutcome> {
  const file = opts.file && Platform.OS !== 'web' ? cacheFile(opts.file.name, opts.file.base64, 'base64') : null;
  if (await MailComposer.isAvailableAsync()) {
    const { status } = await MailComposer.composeAsync({
      recipients: opts.to ? [opts.to] : [],
      subject: opts.subject,
      body: opts.body,
      isHtml: opts.isHtml,
      attachments: file ? [file.uri] : [],
    });
    if (status === MailComposer.MailComposerStatus.SENT) return 'sent';
    if (status === MailComposer.MailComposerStatus.SAVED) return 'saved';
    if (status === MailComposer.MailComposerStatus.CANCELLED) return 'cancelled';
    // Android never says what happened in the mail app.
    return 'handed-off';
  }
  if (file && opts.file) {
    await share(file, opts.file.mime, opts.subject);
    return 'shared';
  }
  throw new Error('There is no mail app on this phone.');
}

// --- a match, as files ---------------------------------------------------------

export function matchMeta(m: Match): MatchMeta {
  return {
    title: fullTitle(m),
    date: m.date,
    names: m.names,
    formatLabel: FORMATS.find((f) => f.id === m.formatId)?.label,
  };
}

export function xlsxFile(m: Match, points: PointRecord[]) {
  const meta = matchMeta(m);
  return {
    name: matchFileName(meta, 'xlsx'),
    mime: XLSX_MIME,
    base64: bytesToBase64(buildXlsx(matchWorkbook(meta, points, m.alerts ?? []))),
  };
}

export function shareXlsx(m: Match, points: PointRecord[]) {
  const f = xlsxFile(m, points);
  return shareBase64(f.name, f.mime, f.base64);
}

/** The point log as CSV. The byte-order mark is for Excel on Windows, which otherwise reads
 *  UTF-8 as the local code page and mangles any accented name in the file. */
export function shareCsv(m: Match, points: PointRecord[]) {
  return shareText(matchFileName(matchMeta(m), 'csv'), CSV_MIME, '\ufeff' + toCSV(pointLogRows(points, m.names)));
}

const text = (c: XCell) => String(cellValue(c)) || '-';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);

/**
 * The email that carries a match to the coach: the stats table in the body, so it reads
 * on a phone without opening anything, and the full workbook attached.
 *
 * Android's mail intent flattens HTML through Html.fromHtml, which has no idea what a
 * table is: every cell runs into the next. So Android gets the same table as plain lines.
 */
export function statsEmail(m: Match, points: PointRecord[]) {
  const sections = summarySections(summaryRows(computeStats(points), m.names));
  const score = m.scoreLine || 'not started';
  const subject = `${fullTitle(m)} — stats`;
  const [a, b] = m.names;

  if (Platform.OS === 'android') {
    const body = [
      `${fullTitle(m)}, ${m.date}`,
      `${a} vs ${b}`,
      `Score (${a} first): ${score}`,
      `${points.length} points charted`,
      `Each line reads: ${a} | ${b}`,
      ...sections.flatMap((s) => [
        '',
        s.title.toUpperCase(),
        ...s.rows.map((r) => `${r.label}: ${text(r.cells[0])} | ${text(r.cells[1])}`),
      ]),
      '',
      'Every point is in the attached Excel file.',
    ].join('\n');
    return { subject, body, isHtml: false };
  }

  const font = 'font-family:-apple-system,Helvetica,Arial,sans-serif;';
  const td = `${font}font-size:14px;padding:5px 10px;border-bottom:1px solid #e6e1d6;`;
  const body = [
    `<p style="${font}font-size:16px;margin:0 0 4px"><b>${esc(fullTitle(m))}</b>, ${esc(m.date)}</p>`,
    `<p style="${font}font-size:14px;margin:0 0 12px">${esc(a)} vs ${esc(b)} · Score (${esc(a)} first): <b>${esc(score)}</b> · ${points.length} points charted</p>`,
    '<table cellspacing="0" style="border-collapse:collapse">',
    `<tr><th style="${td}text-align:left">Stat</th><th style="${td}text-align:right">${esc(a)}</th><th style="${td}text-align:right">${esc(b)}</th></tr>`,
    ...sections.flatMap((s) => [
      `<tr><td colspan="3" style="${td}background:#f3e8cc;font-weight:bold">${esc(s.title)}</td></tr>`,
      ...s.rows.map(
        (r) =>
          `<tr><td style="${td}">${esc(r.label)}</td><td style="${td}text-align:right">${esc(text(r.cells[0]))}</td><td style="${td}text-align:right">${esc(text(r.cells[1]))}</td></tr>`
      ),
    ]),
    '</table>',
    `<p style="${font}font-size:13px;color:#555">Every point is in the attached Excel file.</p>`,
  ].join('');
  return { subject, body, isHtml: true };
}
