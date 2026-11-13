import { CRITERIA, aggregate } from "./core.js";

export function evaluationSheets(
  meta,
  responses,
  settings = meta
) {
  const result = aggregate(responses, settings);

  const people = Object.entries(responses || {}).sort(
    (a, b) =>
      a[1].submittedAt - b[1].submittedAt ||
      a[0].localeCompare(b[0])
  );

  const last = people.length + 1;

  const juryRow = last + 2;
  const audienceRow = juryRow + 1;
  const finalRow = juryRow + 2;

  const weightsRow = finalRow + 2;
  const mixRow = weightsRow + 2;

  const makeFormula = (formula, value) => ({
    formula,
    value
  });

  const dotFormula = (row, value) =>
    makeFormula(
      `SUMPRODUCT(C${row}:H${row},$C$${weightsRow}:$H$${weightsRow})/100`,
      value
    );

  const rows = [
    [
      "이름",
      "심사위원 여부(t/f)",
      ...CRITERIA.map(
        (criterion, i) =>
          `${i + 1}. ${criterion.title}`
      ),
      "최종 평가 점수"
    ]
  ];

  people.forEach(([id, response], i) => {
    const values = response.scores.map(
      value => 100 - value
    );

    const isJudge =
      settings.mode !== "audience" &&
      !!settings.judgeIds?.[id];

    const score = values.reduce(
      (sum, value, k) =>
        sum + value * CRITERIA[k].weight,
      0
    ) / 100;

    rows.push([
      response.name,
      isJudge ? "t" : "f",
      ...values,
      dotFormula(i + 2, score)
    ]);
  });

  rows.push([]);

  for (const [label, flag, means, row] of [
    [
      "심사위원",
      "t",
      result.judgeCriteria,
      juryRow
    ],
    [
      "청중",
      "f",
      result.audienceCriteria,
      audienceRow
    ]
  ]) {
    const cells = Array.from(
      { length: 6 },
      (_, i) => {
        const column = String.fromCharCode(67 + i);

        return makeFormula(
          `IFERROR(AVERAGEIF($B$2:$B$${last},"${flag}",${column}$2:${column}$${last}),"")`,
          means ? means[i] : ""
        );
      }
    );

    const groupScore =
      label === "심사위원"
        ? result.judgeScore
        : result.audienceScore;

    rows.push([
      label,
      "",
      ...cells,
      means
        ? dotFormula(row, groupScore)
        : makeFormula(
            `IF(C${row}="","",SUMPRODUCT(C${row}:H${row},$C$${weightsRow}:$H$${weightsRow})/100)`,
            ""
          )
    ]);
  }

  const finalCells = Array.from(
    { length: 6 },
    (_, i) => {
      const column = String.fromCharCode(67 + i);

      return makeFormula(
        `(IF(${column}${juryRow}="",0,${column}${juryRow})*$C$${mixRow}+IF(${column}${audienceRow}="",0,${column}${audienceRow})*$D$${mixRow})/100`,
        result.finalCriteria[i]
      );
    }
  );

  rows.push([
    "최종",
    "",
    ...finalCells,
    dotFormula(finalRow, result.score)
  ]);

  rows.push([]);

  rows.push([
    "항목 비중(%)",
    "",
    ...CRITERIA.map(criterion => criterion.weight)
  ]);

  rows.push([]);

  rows.push([
    "집단 반영 비중(%)",
    "",
    result.judgeWeight,
    100 - result.judgeWeight
  ]);

  rows.push([
    "",
    "",
    "심사위원",
    "청중"
  ]);

  const winner =
    result.winner === "A"
      ? "찬성 승"
      : result.winner === "B"
        ? "반대 승"
        : "무승부";

  rows.push([
    "승패",
    makeFormula(
      `IF(ROUND(I${finalRow},10)<50,"찬성 승",IF(ROUND(I${finalRow},10)>50,"반대 승","무승부"))`,
      winner
    )
  ]);

  rows.push([
    "판정 기준",
    "0=찬성, 100=반대. 최종 점수 50 미만: 찬성 승 / 초과: 반대 승 / 동일: 무승부"
  ]);

  rows.push([
    "논제",
    meta.topic
  ]);

  rows.push([
    "찬성",
    meta.people.A
      .map(person => person.name)
      .join(" · ")
  ]);

  rows.push([
    "반대",
    meta.people.B
      .map(person => person.name)
      .join(" · ")
  ]);

  return [
    {
      name: "평가 결과",
      rows,
      widths: [22, 24, 23, 23, 23, 23, 23, 23, 23],
      mergeRows: [
        rows.length - 3,
        rows.length - 2,
        rows.length - 1,
        rows.length
      ],
      headerRows: [1],
      summaryRows: [
        juryRow,
        audienceRow,
        finalRow
      ],
      filterLastRow: last,
      numberFormat: "0.00"
    }
  ];
}
