export function worksheetToObjects(worksheet) {
  if (!worksheet) return [];
  const headers = [];
  worksheet.getRow(1).eachCell((cell, column) => { headers[column] = String(cell.value ?? '').trim(); });
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      const header = headers[column];
      if (!header) return;
      const value = cell.value;
      record[header] = value && typeof value === 'object' && 'result' in value ? value.result : value;
    });
    rows.push(record);
  });
  return rows;
}
