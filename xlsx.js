const enc = new TextEncoder();

const xml = v => String(v ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  }[c]));

const letters = n => {
  let out = "";

  for (n++; n; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + (n - 1) % 26) + out;
  }

  return out;
};

function sheet(rows) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews><sheetData>' +
    rows.map((row, i) =>
      '<row r="' + (i + 1) + '">' +
      row.map((v, j) => {
        const pos = letters(j) + (i + 1);

        return typeof v === "number" && Number.isFinite(v)
          ? '<c r="' + pos + '"><v>' + v + '</v></c>'
          : '<c r="' + pos +
            '" t="inlineStr"><is><t xml:space="preserve">' +
            xml(v) + '</t></is></c>';
      }).join("") +
      "</row>"
    ).join("") +
    "</sheetData></worksheet>"
  );
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const b of bytes) {
    crc ^= b;

    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const dirs = [];
  let offset = 0;

  for (const [name, text] of files) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);

    const h = new Uint8Array(30 + n.length);
    const v = new DataView(h.buffer);

    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x800, true);
    v.setUint16(12, 33, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, n.length, true);

    h.set(n, 30);
    parts.push(h, data);

    const d = new Uint8Array(46 + n.length);
    const w = new DataView(d.buffer);

    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint16(8, 0x800, true);
    w.setUint16(14, 33, true);
    w.setUint32(16, crc, true);
    w.setUint32(20, data.length, true);
    w.setUint32(24, data.length, true);
    w.setUint16(28, n.length, true);
    w.setUint32(42, offset, true);

    d.set(n, 46);
    dirs.push(d);
    offset += h.length + data.length;
  }

  const size = dirs.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);

  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);

  return new Blob([...parts, ...dirs, end], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

export function workbook(tabs) {
  const files = [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      tabs.map((_, i) =>
        '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      ).join("") +
      "</Types>"
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>"
    ],
    [
      "xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" +
      tabs.map((t, i) =>
        '<sheet name="' + xml(t.name) +
        '" sheetId="' + (i + 1) +
        '" r:id="rId' + (i + 1) + '"/>'
      ).join("") +
      "</sheets></workbook>"
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      tabs.map((_, i) =>
        '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>'
      ).join("") +
      "</Relationships>"
    ]
  ];

  tabs.forEach((t, i) => {
    files.push([
      "xl/worksheets/sheet" + (i + 1) + ".xml",
      sheet(t.rows)
    ]);
  });

  return zip(files);
}

export function downloadWorkbook(tabs, name) {
  const url = URL.createObjectURL(workbook(tabs));
  const a = document.createElement("a");

  a.href = url;
  a.download = name;

  document.body.append(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
