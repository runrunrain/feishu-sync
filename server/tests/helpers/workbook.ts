import ExcelJS from 'exceljs';

/** Valid native export bytes for sync tests that exercise downstream failures. */
export async function exportTestWorkbook(_token: string, outputPath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('主表');
  sheet.addRows([['a', 'b'], [1, 2]]);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}
