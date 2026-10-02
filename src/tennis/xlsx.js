/**
 * Geneva Tennis: spreadsheet files with no dependencies. Contract: src/tennis/index.d.ts.
 *
 * buildXlsx writes a real OOXML workbook inside a ZIP (STORE, no compression). It has its
 * own UTF-8 encoder, CRC-32 and base64 because Hermes has no TextEncoder/Buffer/btoa.
 * Private helpers are prefixed `_xl_` (the tracker build concatenates all src/tennis/*.js).
 *
 * Added beyond the contract: utf8Bytes (a string to bytes, e.g. a CSV to attach) and
 * plainRows (cells to bare values, e.g. to post rows to the Google Sheets connector).
 */

// ---- bytes ----------------------------------------------------------------------------

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD. */
export function utf8Bytes(str) {
  const s = String(str);
  const out = new Uint8Array(s.length * 3); // at most 3 bytes per UTF-16 unit
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) {
      out[o++] = c;
    } else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    } else {
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 63);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    }
  }
  return out.slice(0, o);
}

const _xl_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding. */
export function bytesToBase64(bytes) {
  const n = bytes.length;
  const parts = [];
  let out = '';
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += _xl_B64.charAt((v >> 18) & 63) + _xl_B64.charAt((v >> 12) & 63) + _xl_B64.charAt((v >> 6) & 63) + _xl_B64.charAt(v & 63);
    if (out.length >= 8192) {
      parts.push(out);
      out = '';
    }
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    out += _xl_B64.charAt((v >> 18) & 63) + _xl_B64.charAt((v >> 12) & 63) + '==';
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += _xl_B64.charAt((v >> 18) & 63) + _xl_B64.charAt((v >> 12) & 63) + _xl_B64.charAt((v >> 6) & 63) + '=';
  }
  parts.push(out);
  return parts.join('');
}

let _xl_crcTable = null;

function _xl_crc32(bytes) {
  if (!_xl_crcTable) {
    _xl_crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _xl_crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = _xl_crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: Uint8Array }] -> one ZIP, STORE method, UTF-8 names. */
function _xl_zip(files) {
  const d = new Date();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  let centralSize = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = utf8Bytes(f.name);
    const crc = _xl_crc32(f.data);
    const size = f.data.length;

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method 0 = STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // local header offset (extra/comment/disk/attrs stay 0)
    ch.set(name, 46);

    locals.push(lh, f.data);
    centrals.push(ch);
    offset += lh.length + size;
    centralSize += ch.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  const parts = locals.concat(centrals, [end]);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

// ---- XML ------------------------------------------------------------------------------

/** XML-escape, and drop what XML 1.0 forbids (control characters, lone surrogates). CRLF and CR become LF. */
function _xl_esc(str) {
  const s = String(str);
  if (!/[&<>"\r\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 9 || c === 10) out += s.charAt(i);
    else if (c === 13) out += s.charCodeAt(i + 1) === 10 ? '' : '\n';
    else if (c < 32 || c === 0xfffe || c === 0xffff) continue;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s.charAt(i) + s.charAt(i + 1);
        i++;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) continue;
    else out += s.charAt(i);
  }
  return out;
}

const _xl_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const _xl_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const _xl_RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Style names, in cellXfs order: the index of a style is its position + 1 (0 is the default). */
const _xl_STYLES = ['title', 'sub', 'h', 'hl', 'int', 'num1', 'pct', 'muted', 'good', 'bad', 'gold', 'wrap', 'bold'];

function _xl_stylesXml() {
  const font = (extra, sz, rgb) => '<font>' + extra + '<sz val="' + sz + '"/><color rgb="' + rgb + '"/><name val="Calibri"/><family val="2"/></font>';
  const fonts = [
    font('', 11, 'FF222222'), // 0 default
    font('<b/>', 16, 'FF3E3114'), // 1 title
    font('<i/>', 11, 'FF6B6B6B'), // 2 sub
    font('<b/>', 11, 'FFFFFFFF'), // 3 header
    font('<b/>', 11, 'FF222222'), // 4 bold
    font('', 11, 'FF8A8A8A'), // 5 muted
  ];
  const solid = (rgb) => '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>';
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    solid('FF5E4A1F'), // 2 header
    solid('FFF3E8CC'), // 3 highlight / gold
    solid('FFDDF5E3'), // 4 good
    solid('FFFBE0E0'), // 5 bad
  ];
  const edge = (n) => '<' + n + ' style="thin"><color rgb="FF3E3114"/></' + n + '>';
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', '<border>' + edge('left') + edge('right') + edge('top') + edge('bottom') + '<diagonal/></border>'];
  const xf = (numFmt, fontId, fillId, borderId, align) =>
    '<xf numFmtId="' + numFmt + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"' +
    (numFmt ? ' applyNumberFormat="1"' : '') + (fontId ? ' applyFont="1"' : '') + (fillId ? ' applyFill="1"' : '') + (borderId ? ' applyBorder="1"' : '') +
    (align ? ' applyAlignment="1">' + align + '</xf>' : '/>');
  const xfs = [
    xf(0, 0, 0, 0, ''), // default
    xf(0, 1, 0, 0, ''), // title
    xf(0, 2, 0, 0, ''), // sub
    xf(0, 3, 2, 1, '<alignment horizontal="center" vertical="center" wrapText="1"/>'), // h
    xf(0, 4, 3, 0, ''), // hl
    xf(1, 0, 0, 0, ''), // int  '0'
    xf(164, 0, 0, 0, ''), // num1 '0.0'
    xf(9, 0, 0, 0, ''), // pct  '0%'
    xf(0, 5, 0, 0, ''), // muted
    xf(0, 0, 4, 0, ''), // good
    xf(0, 0, 5, 0, ''), // bad
    xf(0, 0, 3, 0, ''), // gold
    xf(0, 0, 0, 0, '<alignment vertical="top" wrapText="1"/>'), // wrap
    xf(0, 4, 0, 0, ''), // bold
  ];
  return (
    _xl_XML +
    '<styleSheet xmlns="' + _xl_NS + '">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>' +
    '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
    '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
    '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    '</styleSheet>'
  );
}

/** Column letters for a 0-based index: 0 -> A, 26 -> AA. */
function _xl_col(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function _xl_cellXml(ref, cell) {
  let v = cell;
  let style = '';
  if (cell !== null && typeof cell === 'object') {
    v = cell.v;
    const k = _xl_STYLES.indexOf(cell.s);
    if (k >= 0) style = ' s="' + (k + 1) + '"';
  }
  const blank = style ? '<c r="' + ref + '"' + style + '/>' : '';
  if (v === null || v === undefined || v === '') return blank;
  if (typeof v === 'number') return Number.isFinite(v) ? '<c r="' + ref + '"' + style + '><v>' + v + '</v></c>' : blank;
  if (typeof v === 'boolean') return '<c r="' + ref + '"' + style + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
  const text = String(v).slice(0, 32767); // the most a cell can hold
  const keep = /^\s|\s$|\n|\t/.test(text) ? ' xml:space="preserve"' : '';
  return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t' + keep + '>' + _xl_esc(text) + '</t></is></c>';
}

/** A filter ref on a single row ('A1:V1') is stretched down over the data rows. */
function _xl_filterRef(ref, rowCount) {
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(String(ref).trim());
  if (!m) return String(ref).trim();
  const last = Math.max(Number(m[2]), Number(m[4]), rowCount);
  return m[1].toUpperCase() + m[2] + ':' + m[3].toUpperCase() + last;
}

function _xl_sheetXml(sh, selected, filterRef) {
  const rows = sh.rows || [];
  let data = '';
  let maxC = 0;
  let maxR = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    let cells = '';
    for (let c = 0; c < row.length; c++) {
      const x = _xl_cellXml(_xl_col(c) + (r + 1), row[c]);
      if (!x) continue;
      cells += x;
      if (c + 1 > maxC) maxC = c + 1;
    }
    if (cells) {
      data += '<row r="' + (r + 1) + '">' + cells + '</row>';
      maxR = r + 1;
    }
  }

  const fr = Math.max(0, (sh.freeze && sh.freeze.rows) | 0);
  const fc = Math.max(0, (sh.freeze && sh.freeze.cols) | 0);
  let view = '<sheetView workbookViewId="0"' + (selected ? ' tabSelected="1"' : '') + '>';
  if (fr || fc) {
    const tl = _xl_col(fc) + (fr + 1);
    const pane = fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
    view += '<pane' + (fc ? ' xSplit="' + fc + '"' : '') + (fr ? ' ySplit="' + fr + '"' : '') + ' topLeftCell="' + tl + '" activePane="' + pane + '" state="frozen"/>';
    if (fr && fc) {
      view += '<selection pane="topRight" activeCell="' + _xl_col(fc) + '1" sqref="' + _xl_col(fc) + '1"/>';
      view += '<selection pane="bottomLeft" activeCell="A' + (fr + 1) + '" sqref="A' + (fr + 1) + '"/>';
    }
    view += '<selection pane="' + pane + '" activeCell="' + tl + '" sqref="' + tl + '"/>';
  }
  view += '</sheetView>';

  const cols = (sh.cols || []).map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (Number(w) > 0 ? Number(w) : 10) + '" customWidth="1"/>').join('');
  const merges = (sh.merges || []).map((m) => '<mergeCell ref="' + _xl_esc(m) + '"/>').join('');

  return (
    _xl_XML +
    '<worksheet xmlns="' + _xl_NS + '">' +
    '<dimension ref="A1' + (maxC ? ':' + _xl_col(maxC - 1) + maxR : '') + '"/>' +
    '<sheetViews>' + view + '</sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? '<cols>' + cols + '</cols>' : '') +
    '<sheetData>' + data + '</sheetData>' +
    (filterRef ? '<autoFilter ref="' + _xl_esc(filterRef) + '"/>' : '') +
    (merges ? '<mergeCells count="' + sh.merges.length + '">' + merges + '</mergeCells>' : '') +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ , no edge apostrophes, unique ignoring case. */
function _xl_sheetNames(sheets) {
  const used = {};
  return sheets.map((s, i) => {
    const base =
      String(s && s.name != null ? s.name : '')
        .replace(/[\[\]:*?\/\\\u0000-\u001f]/g, '')
        .replace(/^'+|'+$/g, '')
        .slice(0, 31)
        .trim() || 'Sheet' + (i + 1);
    let name = base;
    for (let k = 2; used[name.toLowerCase()]; k++) {
      const suffix = ' (' + k + ')';
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used[name.toLowerCase()] = true;
    return name;
  });
}

/** A real .xlsx (OOXML in a ZIP, STORE) with styles. Opens in Excel, Numbers and Google Sheets. */
export function buildXlsx(sheets) {
  const list = sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = _xl_sheetNames(list);
  const files = [];
  const add = (name, text) => files.push({ name, data: utf8Bytes(text) });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

  add(
    '[Content_Types].xml',
    _xl_XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      list.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>'
  );
  add(
    '_rels/.rels',
    _xl_XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + REL + 'officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="' + REL + 'extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>'
  );
  add(
    'docProps/core.xml',
    _xl_XML +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:creator>Geneva Tennis</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      '</cp:coreProperties>'
  );
  add(
    'docProps/app.xml',
    _xl_XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Geneva Tennis</Application></Properties>'
  );

  // sheets: the filter range also becomes the hidden _FilterDatabase name Excel expects
  const filters = [];
  const sheetFiles = list.map((sh, i) => {
    const ref = sh.autoFilter ? _xl_filterRef(sh.autoFilter, (sh.rows || []).length) : '';
    if (ref) filters.push({ i, ref });
    return _xl_sheetXml(sh, i === 0, ref);
  });
  const quoted = (n) => "'" + n.replace(/'/g, "''") + "'";
  const absRef = (ref) => ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  add(
    'xl/workbook.xml',
    _xl_XML +
      '<workbook xmlns="' + _xl_NS + '" xmlns:r="' + _xl_RNS + '">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>' +
      '<sheets>' + names.map((n, i) => '<sheet name="' + _xl_esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
      (filters.length
        ? '<definedNames>' + filters.map((f) => '<definedName name="_xlnm._FilterDatabase" localSheetId="' + f.i + '" hidden="1">' + _xl_esc(quoted(names[f.i]) + '!' + absRef(f.ref)) + '</definedName>').join('') + '</definedNames>'
        : '') +
      '</workbook>'
  );
  add(
    'xl/_rels/workbook.xml.rels',
    _xl_XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + REL + 'worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (list.length + 1) + '" Type="' + REL + 'styles" Target="styles.xml"/>' +
      '</Relationships>'
  );
  add('xl/styles.xml', _xl_stylesXml());
  sheetFiles.forEach((xml, i) => add('xl/worksheets/sheet' + (i + 1) + '.xml', xml));
  return _xl_zip(files);
}

// ---- text exports ---------------------------------------------------------------------

const _xl_val = (c) => (c !== null && typeof c === 'object' ? c.v : c);

function _xl_text(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const t = String(v);
  // a text cell that starts like a formula would run when the file opens in Excel or Sheets
  return /^[=+@\t\r]/.test(t) || (t.length > 1 && t.charAt(0) === '-') ? "'" + t : t;
}

/** Cells as bare values (null and non-finite numbers become ''), e.g. for JSON. */
export function plainRows(rows) {
  return rows.map((r) =>
    r.map((c) => {
      const v = _xl_val(c);
      return v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : v;
    })
  );
}

/** RFC 4180: fields with a comma, quote or line break are quoted; records end in CRLF. */
export function toCSV(rows) {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const t = _xl_text(_xl_val(c));
          return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
        })
        .join(',')
    )
    .join('\r\n');
}

/** Tab-separated, for pasting into Google Sheets: tabs and line breaks inside a cell become spaces. */
export function toTSV(rows) {
  return rows.map((r) => r.map((c) => _xl_text(_xl_val(c)).replace(/\r\n|[\t\r\n]/g, ' ')).join('\t')).join('\n');
}
