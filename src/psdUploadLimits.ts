export const MAX_PSD_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_INLINE_PSD_UPLOAD_BYTES = 256 * 1024 * 1024;
export const PSD_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
// Large PSDs use disk-backed chunks; never expand a 1 GiB file into one JS string.
export const MAX_PLUGIN_MESSAGE_BYTES = 4 * Math.ceil(MAX_INLINE_PSD_UPLOAD_BYTES / 3) + 1024 * 1024;

export function assertPsdUploadSize(byteLength: number): void {
  if (byteLength > MAX_PSD_UPLOAD_BYTES) throw new Error("PSD file exceeds the 1 GiB upload limit");
}
