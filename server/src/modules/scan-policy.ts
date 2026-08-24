/**
 * Shared policy for filesystem scans rooted at a knowledge base.
 *
 * These names are reserved for local operational artifacts. They must not
 * enter the document index or be reported as orphaned knowledge-base files.
 * Keep this list deliberately narrow: ordinary hidden directories and
 * user-created directories are not excluded merely because of their names.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '_reports',
  '.trash-bin',
  '.staging',
  '_staging',
  '.recovery',
  '_recovery',
  '.restore',
  '_restore',
]);

const EXCLUDED_FILE_SUFFIXES = ['.pre-migrate', '.bak'] as const;

export class ScanPolicy {
  /**
   * Whether a directory is reserved for local operational artifacts.
   */
  static shouldSkipDirectory(name: string): boolean {
    return EXCLUDED_DIRECTORY_NAMES.has(name);
  }

  /**
   * Whether a file is a migration or write-backup artifact.
   */
  static shouldSkipFile(name: string): boolean {
    return EXCLUDED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
  }
}
