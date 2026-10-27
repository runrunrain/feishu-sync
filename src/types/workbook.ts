/** Read-only workbook preview DTO. Geometry is in CSS pixels at 100% zoom. */
export interface WorkbookFont {
  name?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface WorkbookCell {
  address: string;
  row: number;
  column: number;
  text: string;
  formula?: string;
  richText?: Array<{ text: string; font: WorkbookFont }>;
  font: WorkbookFont;
  fill?: string;
  horizontal?: string;
  vertical?: string;
  wrap?: boolean;
  indent?: number;
  rotation?: number;
  borders: Partial<Record<'top' | 'bottom' | 'left' | 'right', { color: string; style: string }>>;
}

export interface WorkbookMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface WorkbookImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface WorkbookSheetLayout {
  index: number;
  name: string;
  rows: number[];
  columns: number[];
  cells: WorkbookCell[];
  merges: WorkbookMerge[];
  images: WorkbookImage[];
  showGridLines: boolean;
  warnings: string[];
}

export interface WorkbookPreview {
  sheets: Array<{ index: number; name: string; state: string }>;
  sheet: WorkbookSheetLayout;
}
