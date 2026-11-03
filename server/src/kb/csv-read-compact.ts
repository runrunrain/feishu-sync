import { parseCsvRecords } from './evidence-locator.js';

interface CsvSegment {
  resourceId?: string;
  outStart: number;
  outEnd: number;
  resStart?: number;
}

interface CsvResource {
  resourceId: string;
  kind: 'text' | 'csv';
  lines: string[];
}

export interface BlankCsvSkip {
  nextOffset: number | null;
  skipped: { resourceId: string; outputStart: number; outputEnd: number; resourceStart: number; resourceEnd: number } | null;
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function blankCsvLines(segments: CsvSegment[], resources: CsvResource[], start: number, end: number) {
  const blankAt = new Map<number, { resourceId: string; resourceLine: number }>();
  const byId = new Map(resources.filter((resource) => resource.kind === 'csv')
    .map((resource) => [resource.resourceId, resource]));
  for (const segment of segments) {
    if (!segment.resourceId || segment.resStart === undefined
      || segment.outEnd < start || segment.outStart > end) continue;
    const resource = byId.get(segment.resourceId);
    if (!resource) continue;
    const parsed = parseCsvRecords(resource.lines.join('\n'));
    for (const [index, record] of parsed.records.entries()) {
      const span = parsed.recordSpans[index]!;
      // A multiline quoted value may contain a comma-only physical line.
      // Collapse only a whole one-line logical record with no nonempty cell.
      if (span.lineCount !== 1 || record.some((cell) => cell.trim())) continue;
      const outLine = segment.outStart + span.startLine - segment.resStart;
      if (outLine >= start && outLine <= end && outLine <= segment.outEnd) {
        blankAt.set(outLine, { resourceId: segment.resourceId, resourceLine: span.startLine });
      }
    }
  }
  return blankAt;
}

/** Skip the rest of a verified blank CSV run when it starts at the next page.
 * The cursor remains an original output-line offset, so later receipts and
 * selectors keep their existing coordinates. Short runs remain readable. */
export function skipBlankCsvContinuation(
  nextOffset: number, totalLines: number, segments: CsvSegment[], resources: CsvResource[],
): BlankCsvSkip {
  if (nextOffset >= totalLines) return { nextOffset: null, skipped: null };
  const firstLine = nextOffset + 1;
  const blankAt = blankCsvLines(segments, resources, firstLine, totalLines);
  const first = blankAt.get(firstLine);
  if (!first) return { nextOffset, skipped: null };
  let endLine = firstLine;
  while (endLine + 1 <= totalLines) {
    const next = blankAt.get(endLine + 1);
    if (!next || next.resourceId !== first.resourceId
      || next.resourceLine !== first.resourceLine + endLine + 1 - firstLine) break;
    endLine += 1;
  }
  if (endLine - firstLine + 1 < 3) return { nextOffset, skipped: null };
  return {
    nextOffset: endLine >= totalLines ? null : endLine,
    skipped: { resourceId: first.resourceId, outputStart: firstLine, outputEnd: endLine,
      resourceStart: first.resourceLine, resourceEnd: first.resourceLine + endLine - firstLine },
  };
}

/** Keep raw_read's original pagination and receipts while hiding long runs of
 * verified empty CSV records from the model. The marker keeps exact physical
 * positions; callers can request includeBlankCsvRows to see original bytes. */
export function compactBlankCsvPage(
  slice: string[], offset: number, segments: CsvSegment[], resources: CsvResource[],
  linePrefix: (outputLine: number) => string = () => '',
): string[] {
  const pageStart = offset + 1;
  const pageEnd = offset + slice.length;
  const blankAt = blankCsvLines(segments, resources, pageStart, pageEnd);
  const display: string[] = [];
  for (let index = 0; index < slice.length;) {
    const startLine = pageStart + index;
    const first = blankAt.get(startLine);
    if (!first) { display.push(`${linePrefix(startLine)}${slice[index]!}`); index += 1; continue; }
    let end = index + 1;
    while (end < slice.length) {
      const next = blankAt.get(pageStart + end);
      if (!next || next.resourceId !== first.resourceId || next.resourceLine !== first.resourceLine + end - index) break;
      end += 1;
    }
    if (end - index >= 3) {
      display.push(`<blank_csv_rows resource_id="${xmlAttribute(first.resourceId)}" resource_lines="${first.resourceLine}-${first.resourceLine + end - index - 1}" output_lines="${startLine}-${pageStart + end - 1}" count="${end - index}" />`);
    } else {
      for (let at = index; at < end; at += 1) {
        display.push(`${linePrefix(pageStart + at)}${slice[at]!}`);
      }
    }
    index = end;
  }
  return display;
}

/** Labels model-visible lines with exact source-local coordinates. These labels
 * are presentation only; receipts and evidence still resolve against unmodified
 * frozen resources. CSV record numbers are logical RFC4180 records, so a quoted
 * multiline cell receives the same record number on each physical line. */
export function annotateRawReadPage(
  slice: string[], offset: number, segments: CsvSegment[], resources: CsvResource[],
  includeBlankCsvRows = false,
): string[] {
  const byId = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const csvRecordByLine = new Map<string, number[]>();
  const firstOutputLine = offset + 1;
  const lastOutputLine = offset + slice.length;
  const visibleResourceIds = new Set(segments.filter((segment) =>
    segment.resourceId && segment.outStart <= lastOutputLine && segment.outEnd >= firstOutputLine)
    .map((segment) => segment.resourceId));
  for (const resource of resources) {
    if (resource.kind !== 'csv' || !visibleResourceIds.has(resource.resourceId)) continue;
    const recordByLine: number[] = [];
    const { recordSpans } = parseCsvRecords(resource.lines.join('\n'));
    for (const [index, span] of recordSpans.entries()) {
      for (let line = span.startLine; line < span.startLine + span.lineCount; line += 1) {
        recordByLine[line] = index + 1;
      }
    }
    csvRecordByLine.set(resource.resourceId, recordByLine);
  }
  const prefix = (outputLine: number): string => {
    const segment = segments.find((item) => item.outStart <= outputLine && outputLine <= item.outEnd);
    if (!segment?.resourceId || segment.resStart === undefined) return `[O${outputLine}] `;
    const resourceLine = segment.resStart + outputLine - segment.outStart;
    const resource = byId.get(segment.resourceId);
    const record = resource?.kind === 'csv' ? csvRecordByLine.get(segment.resourceId)?.[resourceLine] : undefined;
    return `[O${outputLine}/R${resourceLine}${record ? `/C${record}` : ''}] `;
  };
  return includeBlankCsvRows
    ? slice.map((line, index) => `${prefix(offset + index + 1)}${line}`)
    : compactBlankCsvPage(slice, offset, segments, resources, prefix);
}
