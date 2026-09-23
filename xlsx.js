/*
 * Minimal .xlsx writer — no dependencies, works offline.
 *
 * Adapted from Tikita's writer: same stored-zip container and inline strings,
 * but several sheets per workbook and number styles for bags and money.
 * Excel, LibreOffice and Google Sheets all open the result.
 */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var encoder = new TextEncoder();

  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /* Pack [{name, data:Uint8Array}] into a stored zip. */
  function zip(entries) {
    var stamp = dosDateTime(new Date());
    var locals = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (entry) {
      var nameBytes = encoder.encode(entry.name);
      var crc = crc32(entry.data);
      var size = entry.data.length;

      var local = new Uint8Array(30 + nameBytes.length + size);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);           // method: stored
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(entry.data, 30 + nameBytes.length);
      locals.push(local);

      var dir = new Uint8Array(46 + nameBytes.length);
      var dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, stamp.time, true);
      dv.setUint16(14, stamp.date, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, size, true);
      dv.setUint32(24, size, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, offset, true);
      dir.set(nameBytes, 46);
      central.push(dir);

      offset += local.length;
    });

    var centralSize = central.reduce(function (n, d) { return n + d.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    var out = new Uint8Array(offset + centralSize + 22);
    var pos = 0;
    locals.forEach(function (b) { out.set(b, pos); pos += b.length; });
    central.forEach(function (b) { out.set(b, pos); pos += b.length; });
    out.set(end, pos);
    return out;
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  /* 0 -> A, 25 -> Z, 26 -> AA */
  function colName(index) {
    var name = '';
    index += 1;
    while (index > 0) {
      var rem = (index - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      index = Math.floor((index - 1) / 26);
    }
    return name;
  }

  /* Style indexes available to callers. Keep in sync with cellXfs below. */
  var S = {
    DEFAULT: 0,
    TITLE: 1,
    SUBTITLE: 2,
    HEAD: 3,
    TEXT: 4,
    QTY: 5,
    MONEY: 6,
    TOTAL: 7,
    TOTAL_QTY: 8,
    TOTAL_MONEY: 9,
    VOID: 10,
    VOID_QTY: 11,
    VOID_MONEY: 12
  };

  // numFmtId 0 is General (1.5, 40); 4 is the built-in #,##0.00.
  var STYLES = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="6">',
    '<font><sz val="11"/><color rgb="FF1F2933"/><name val="Calibri"/></font>',
    '<font><b/><sz val="16"/><color rgb="FF2F6B3A"/><name val="Calibri"/></font>',
    '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><color rgb="FF1F2933"/><name val="Calibri"/></font>',
    '<font><strike/><sz val="11"/><color rgb="FF9AA3A9"/><name val="Calibri"/></font>',
    '</fonts>',
    '<fills count="4">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF2F6B3A"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F1E9"/><bgColor indexed="64"/></patternFill></fill>',
    '</fills>',
    '<borders count="2">',
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border>',
    '<left style="thin"><color rgb="FFC8D0D6"/></left>',
    '<right style="thin"><color rgb="FFC8D0D6"/></right>',
    '<top style="thin"><color rgb="FFC8D0D6"/></top>',
    '<bottom style="thin"><color rgb="FFC8D0D6"/></bottom>',
    '<diagonal/></border>',
    '</borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="13">',
    // 0 DEFAULT
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    // 1 TITLE
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    // 2 SUBTITLE
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    // 3 HEAD
    '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
    // 4 TEXT
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
    // 5 QTY
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>',
    // 6 MONEY
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>',
    // 7 TOTAL
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>',
    // 8 TOTAL_QTY
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
    // 9 TOTAL_MONEY
    '<xf numFmtId="4" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>',
    // 10 VOID
    '<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
    // 11 VOID_QTY
    '<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>',
    // 12 VOID_MONEY
    '<xf numFmtId="4" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>',
    '</cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>'
  ].join('');

  /*
   * cell: null | string | number | {v, s, t, f}
   *   v  value
   *   s  style index (see S)
   *   t  'n' for number, 's' for text (inferred when omitted)
   *   f  formula, without the leading '=' (v is then the cached result)
   */
  function cellXml(ref, cell) {
    if (cell === null || cell === undefined || cell === '') return '';
    var value = cell;
    var style = 0;
    var type = null;
    var formula = null;
    if (typeof cell === 'object') {
      value = cell.v;
      style = cell.s || 0;
      type = cell.t || null;
      formula = cell.f || null;
    }
    var attrs = ' r="' + ref + '"' + (style ? ' s="' + style + '"' : '');

    if (formula) {
      var cached = (typeof value === 'number' && isFinite(value)) ? '<v>' + value + '</v>' : '';
      return '<c' + attrs + '><f>' + esc(formula) + '</f>' + cached + '</c>';
    }
    if (value === null || value === undefined || value === '') {
      return style ? '<c' + attrs + '/>' : '';
    }
    if (type === 'n' || (type === null && typeof value === 'number')) {
      if (!isFinite(value)) return style ? '<c' + attrs + '/>' : '';
      return '<c' + attrs + '><v>' + value + '</v></c>';
    }
    return '<c' + attrs + ' t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  }

  function sheetName(name, i) {
    return (name || ('Sheet' + (i + 1))).replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 31);
  }

  /*
   * sheet: { name, rows, cols, merges, freeze, filter }
   *   rows    array of arrays of cells; a row may carry .height
   *   cols    [{width}] column widths in characters
   *   merges  ['A1:D1']
   *   freeze  {row, col} number of leading rows/cols to keep on screen
   *   filter  'A4:L20' — adds Excel's filter drop-downs to that range
   */
  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var cols = sheet.cols || [];
    var merges = sheet.merges || [];
    var freeze = sheet.freeze;

    var maxCols = rows.reduce(function (n, row) { return Math.max(n, row ? row.length : 0); }, 1);
    var dimension = 'A1:' + colName(Math.max(0, maxCols - 1)) + Math.max(1, rows.length);

    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    parts.push('<dimension ref="' + dimension + '"/>');

    parts.push('<sheetViews><sheetView workbookViewId="0" showGridLines="0">');
    if (freeze && (freeze.row || freeze.col)) {
      var topLeft = colName(freeze.col || 0) + ((freeze.row || 0) + 1);
      parts.push('<pane' +
        (freeze.col ? ' xSplit="' + freeze.col + '"' : '') +
        (freeze.row ? ' ySplit="' + freeze.row + '"' : '') +
        ' topLeftCell="' + topLeft + '" activePane="bottomRight" state="frozen"/>');
    }
    parts.push('</sheetView></sheetViews>');
    parts.push('<sheetFormatPr defaultRowHeight="16"/>');

    if (cols.length) {
      parts.push('<cols>');
      cols.forEach(function (col, i) {
        parts.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
          (col && col.width ? col.width : 10) + '" customWidth="1"/>');
      });
      parts.push('</cols>');
    }

    parts.push('<sheetData>');
    rows.forEach(function (row, r) {
      if (!row || !row.length) return;
      var cells = [];
      for (var c = 0; c < row.length; c++) {
        var xml = cellXml(colName(c) + (r + 1), row[c]);
        if (xml) cells.push(xml);
      }
      if (!cells.length) return;
      var height = row.height ? ' ht="' + row.height + '" customHeight="1"' : '';
      parts.push('<row r="' + (r + 1) + '"' + height + '>' + cells.join('') + '</row>');
    });
    parts.push('</sheetData>');

    if (sheet.filter) parts.push('<autoFilter ref="' + sheet.filter + '"/>');

    if (merges.length) {
      parts.push('<mergeCells count="' + merges.length + '">');
      merges.forEach(function (ref) { parts.push('<mergeCell ref="' + ref + '"/>'); });
      parts.push('</mergeCells>');
    }

    parts.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
    parts.push('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
    parts.push('</worksheet>');
    return parts.join('');
  }

  /* build({ sheets: [sheet, …] }) -> Blob */
  function build(options) {
    var sheets = options.sheets || [];
    var names = sheets.map(function (s, i) { return sheetName(s.name, i); });

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    // A sheet with filter drop-downs needs the hidden _FilterDatabase name.
    var definedNames = sheets.map(function (s, i) {
      if (!s.filter) return '';
      var abs = s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
      return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' +
        esc(names[i]).replace(/'/g, "''") + '\'!' + abs + '</definedName>';
    }).join('');

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + names.map(function (name, i) {
        return '<sheet name="' + esc(name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets>' +
      (definedNames ? '<definedNames>' + definedNames + '</definedNames>' : '') +
      '<calcPr fullCalcOnLoad="1"/>' +
      '</workbook>';

    var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    var entries = [
      { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
      { name: '_rels/.rels', data: encoder.encode(rels) },
      { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
      { name: 'xl/styles.xml', data: encoder.encode(STYLES) }
    ];
    sheets.forEach(function (s, i) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: encoder.encode(sheetXml(s)) });
    });

    return new Blob([zip(entries)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  global.XlsxWriter = { build: build, styles: S, colName: colName };
})(typeof self !== 'undefined' ? self : this);
