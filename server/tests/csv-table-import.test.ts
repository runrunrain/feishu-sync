import { describe, expect, it } from 'vitest';
import { renderCsvTableImport } from '../src/kb/csv-table-import.js';

describe('scripted CSV table import', () => {
  it('copies real rows, skips padded empty records, and keeps a verifiable source line range', () => {
    const csv = ',编号,名句\n,1,"兵者，\n诡道也 | 也"\n,2,"<待定>"\n,,\n,,\n';
    const table = renderCsvTableImport(csv, { columns: [1, 2], headerRecord: 1, firstRecord: 2 });
    expect(table.importedRows).toBe(2);
    expect(table.lineStart).toBe(1);
    expect(table.lineEnd).toBe(4);
    expect(table.markdown).toContain('| 1 | 兵者，<br>诡道也 &#124; 也 |');
    expect(table.markdown).toContain('| 2 | &lt;待定&gt; |');
    expect(table.markdown).not.toContain('|  |  |');
  });
});
