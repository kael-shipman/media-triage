// Which files Immich indexes: its supported extensions, as of 3.3.5 (`utils/mime-types.ts`,
// `getSupportedFileExtensions`), matched without regard to case, as its crawler does (`caseSensitiveMatch: false`).

const IMAGES = [
  // Raw formats.
  ".3fr", ".ari", ".arw", ".cap", ".cin", ".cr2", ".cr3", ".crw", ".dcr", ".dng", ".erf", ".fff", ".iiq", ".k25", ".kdc",
  ".mrw", ".nef", ".nrw", ".orf", ".ori", ".pef", ".psd", ".raf", ".raw", ".rw2", ".rwl", ".sr2", ".srf", ".srw", ".x3f",
  // Others.
  ".avif", ".bmp", ".gif", ".jfif", ".jpeg", ".jpg", ".png", ".webp",
  ".heic", ".heif", ".hif", ".insp", ".jp2", ".jpe", ".jxl", ".mpo", ".svg", ".tif", ".tiff",
];

const VIDEOS = [
  ".3gp", ".3gpp", ".avi", ".flv", ".insv", ".m2t", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpe", ".mpeg", ".mpg",
  ".mts", ".mxf", ".ts", ".vob", ".webm", ".wmv",
];

/** Every extension Immich indexes, with its dot. */
export const IMMICH_EXTENSIONS: readonly string[] = [...IMAGES, ...VIDEOS];
