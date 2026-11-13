const enc = new TextEncoder();

const xml = value => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  }[character]));

const letters = number => {
  let out = "";

  for (
    number++;
    number;
    number = Math.floor((number - 1) / 26)
  ) {
    out =
      String.fromCharCode(
        65 + (number - 1) % 26
      ) + out;
  }

  return out;
};

function sheet(tab) {
  const summary = new Set(tab.summaryRows || []);
  const lastSummary = (tab.summaryRows || []).at(-1);

  const rowXml = tab.rows.map((row, i) => {
    const rowNumber = i + 1;

    const header = (tab.headerRows || [1])
      .includes(rowNumber);

    const group = summary.has(rowNumber);

    const cells = row.map((value, j) => {
      const position = letters(j) + rowNumber;

      const formula =
        value &&
        typeof value === "object" &&
        "formula" in value;

      const numeric =
        typeof value === "number" || formula;

      const style = header
        ? 1
        : group
          ? rowNumber === lastSummary ? 4 : 3
          : numeric ? 2 : 0;

      const attributes =
        ' r="' + position + '" s="' + style + '"';

      if (formula) {
        const cached = value.value;

        return (
          "<c" +
          attributes +
          (typeof cached === "number" ? "" : ' t="str"') +
          "><f>" +
          xml(value.formula) +
          "</f><v>" +
          xml(cached) +
          "</v></c>"
        );
      }

      if (
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        return (
          "<c" +
          attributes +
          "><v>" +
          value +
          "</v></c>"
        );
      }

      return (
        "<c" +
        attributes +
        ' t="inlineStr"><is><t xml:space="preserve">' +
        xml(value) +
        "</t></is></c>"
      );
    }).join("");

    return (
      '<row r="' +
      rowNumber +
      '" ht="' +
      (header ? 34 : 23) +
      '" customHeight="1">' +
      cells +
      "</row>"
    );
  }).join("");

  const columns = (tab.widths || []).map(
    (width, i) =>
      '<col min="' +
      (i + 1) +
      '" max="' +
      (i + 1) +
      '" width="' +
      width +
      '" customWidth="1"/>'
  ).join("");

  const merges = (tab.mergeRows || []).map(
    row => '<mergeCell ref="B' + row + ":I" + row + '"/>'
  ).join("");

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    "</sheetView></sheetViews>" +
    (columns ? "<cols>" + columns + "</cols>" : "") +
    "<sheetData>" +
    rowXml +
    "</sheetData>" +
    (
      tab.filterLastRow
        ? '<autoFilter ref="A1:I' + tab.filterLastRow + '"/>'
        : ""
    ) +
    (
      merges
        ? '<mergeCells count="' +
          tab.mergeRows.length +
          '">' +
          merges +
          "</mergeCells>"
        : ""
    ) +
    "</worksheet>"
  );
}

const stylesXml =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +

  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Malgun Gothic"/></font>' +
  '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Malgun Gothic"/></font>' +
  '<font><b/><sz val="11"/><name val="Malgun Gothic"/></font>' +
  "</fonts>" +

  '<fills count="5">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF263F70"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEEEAF4"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF285B48"/><bgColor indexed="64"/></patternFill></fill>' +
  "</fills>" +

  '<borders count="1"><border/></borders>' +

  '<cellStyleXfs count="1">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
  "</cellStyleXfs>" +

  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="2" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyFont="1"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="2" fontId="1" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyFont="1"><alignment vertical="center"/></xf>' +
  "</cellXfs>" +

  '<cellStyles count="1">' +
  '<cellStyle name="Normal" xfId="0" builtinId="0"/>' +
  "</cellStyles>" +
  "</styleSheet>";

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc =
        (crc >>> 1) ^
        ((crc & 1) ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const directories = [];

  let offset = 0;

  for (const [name, text] of files) {
    const filename = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);

    const header = new Uint8Array(
      30 + filename.length
    );

    const view = new DataView(header.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, filename.length, true);

    header.set(filename, 30);
    parts.push(header, data);

    const directory = new Uint8Array(
      46 + filename.length
    );

    const directoryView = new DataView(
      directory.buffer
    );

    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0x800, true);
    directoryView.setUint16(14, 33, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, data.length, true);
    directoryView.setUint32(24, data.length, true);
    directoryView.setUint16(28, filename.length, true);
    directoryView.setUint32(42, offset, true);

    directory.set(filename, 46);
    directories.push(directory);

    offset += header.length + data.length;
  }

  const size = directories.reduce(
    (sum, directory) => sum + directory.length,
    0
  );

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, size, true);
  endView.setUint32(16, offset, true);

  return new Blob(
    [...parts, ...directories, end],
    {
      type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
  );
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
      tabs.map(
        (_, i) =>
          '<Override PartName="/xl/worksheets/sheet' +
          (i + 1) +
          '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      ).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
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
      tabs.map(
        (tab, i) =>
          '<sheet name="' +
          xml(tab.name) +
          '" sheetId="' +
          (i + 1) +
          '" r:id="rId' +
          (i + 1) +
          '"/>'
      ).join("") +
      '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/>' +
      "</workbook>"
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      tabs.map(
        (_, i) =>
          '<Relationship Id="rId' +
          (i + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
          (i + 1) +
          '.xml"/>'
      ).join("") +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>"
    ],
    [
      "xl/styles.xml",
      stylesXml
    ]
  ];

  tabs.forEach((tab, i) => {
    files.push([
      "xl/worksheets/sheet" + (i + 1) + ".xml",
      sheet(tab)
    ]);
  });

  return zip(files);
}

export function downloadWorkbook(tabs, name) {
  const url = URL.createObjectURL(
    workbook(tabs)
  );

  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = name;

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(
    () => URL.revokeObjectURL(url),
    10000
  );
}
