/** A standard document may include tables copied from frozen CSV attachments.
 * Keep the write and publish gates identical; the reader paginates long tables. */
export const MAX_STANDARD_DOC_BYTES = 8 * 1024 * 1024;
