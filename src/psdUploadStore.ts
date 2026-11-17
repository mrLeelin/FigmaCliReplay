import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DATA_ROOT } from "./config.js";
import { isRecord } from "./utils.js";
import { assertPsdUploadSize, PSD_UPLOAD_CHUNK_BYTES } from "./psdUploadLimits.js";

interface UploadMetadata {
  fileName: string;
  totalBytes: number;
  chunkCount: number;
  sessionId: string;
  fileKey: string;
}

export function sanitizePsdFileName(value: string): string {
  return path.basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}

function uploadDirectory(uploadId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uploadId)) throw new Error("A stable PSD upload id is required");
  return path.join(DATA_ROOT, ".tmp", "psd-uploads", uploadId);
}

function validateMetadata(metadata: UploadMetadata): void {
  if (!metadata.fileName || !/\.psd$/i.test(metadata.fileName)) throw new Error("fileName must end with .psd");
  if (!Number.isSafeInteger(metadata.totalBytes) || metadata.totalBytes < 16) throw new Error("Invalid PSD upload size");
  assertPsdUploadSize(metadata.totalBytes);
  if (metadata.chunkCount !== Math.ceil(metadata.totalBytes / PSD_UPLOAD_CHUNK_BYTES)) throw new Error("Invalid PSD chunk count");
  if (!metadata.sessionId || !metadata.fileKey) throw new Error("PSD upload requires a Figma session and file");
}

function expectedChunkBytes(metadata: UploadMetadata, index: number): number {
  return Math.min(PSD_UPLOAD_CHUNK_BYTES, metadata.totalBytes - index * PSD_UPLOAD_CHUNK_BYTES);
}

/** Disk-only staging: identical chunk retries are safe and never submit a Figma job. */
export function stagePsdUploadChunk(payload: Record<string, unknown>): Record<string, unknown> {
  const uploadId = String(payload.clientRequestId || "");
  const directory = uploadDirectory(uploadId);
  const metadata: UploadMetadata = {
    fileName: sanitizePsdFileName(String(payload.fileName || "")),
    totalBytes: Number(payload.totalBytes),
    chunkCount: Number(payload.chunkCount),
    sessionId: String(payload.sessionId || ""),
    fileKey: String(payload.fileKey || ""),
  };
  validateMetadata(metadata);
  const index = Number(payload.chunkIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.chunkCount) throw new Error("Invalid PSD chunk index");
  const base64 = typeof payload.chunkBase64 === "string" ? payload.chunkBase64 : "";
  const byteLength = expectedChunkBytes(metadata, index);
  if (base64.length !== 4 * Math.ceil(byteLength / 3)) throw new Error("PSD chunk length does not match upload metadata");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== byteLength || bytes.toString("base64") !== base64) throw new Error("Invalid PSD chunk encoding");
  if (fs.existsSync(path.join(DATA_ROOT, ".tmp", "psd-to-figma", uploadId))) {
    throw new Error("PSD task artifacts already exist; execution status is unknown. Do not replay.");
  }
  const metadataPath = path.join(directory, "upload.json");
  if (fs.existsSync(metadataPath)) {
    if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(metadataPath, "utf8")), metadata)) {
      throw new Error("PSD upload id conflicts with its original metadata or Figma session");
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata), { flag: "wx" });
  }
  const chunkPath = path.join(directory, `${index}.chunk`);
  if (fs.existsSync(chunkPath)) {
    if (!fs.readFileSync(chunkPath).equals(bytes)) throw new Error("PSD chunk conflicts with its original bytes");
  } else {
    const temporaryPath = chunkPath + ".partial";
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, chunkPath);
  }
  return { uploadId, chunkIndex: index, chunkCount: metadata.chunkCount, byteLength };
}

export function hashPsdFile(filePath: string): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(PSD_UPLOAD_CHUNK_BYTES);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let count: number;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

/** Assemble in bounded buffers only after every chunk and the original target are verified. */
export function preparePsdUpload(uploadId: string, requestId: string, fileName: string, sessionId: string, fileKey: string): { sourcePath: string; size: number; sha256: string } {
  if (uploadId !== requestId) throw new Error("PSD upload id must match the original clientRequestId");
  const directory = uploadDirectory(uploadId);
  const metadataPath = path.join(directory, "upload.json");
  if (!fs.existsSync(metadataPath)) throw new Error("PSD upload is missing; stage the original chunks first");
  const value: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!isRecord(value)) throw new Error("Invalid PSD upload metadata");
  const metadata = value as unknown as UploadMetadata;
  validateMetadata(metadata);
  if (metadata.fileName !== fileName || metadata.sessionId !== sessionId || metadata.fileKey !== fileKey) {
    throw new Error("PSD upload belongs to a different file or Figma session");
  }
  for (let index = 0; index < metadata.chunkCount; index++) {
    const chunkPath = path.join(directory, `${index}.chunk`);
    if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size !== expectedChunkBytes(metadata, index)) {
      throw new Error(`PSD upload is incomplete at chunk ${index}`);
    }
  }
  const sourcePath = path.join(directory, "source.psd");
  const temporaryPath = sourcePath + ".partial";
  const descriptor = fs.openSync(temporaryPath, "w");
  const digest = createHash("sha256");
  try {
    for (let index = 0; index < metadata.chunkCount; index++) {
      const bytes = fs.readFileSync(path.join(directory, `${index}.chunk`));
      fs.writeFileSync(descriptor, bytes);
      digest.update(bytes);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, sourcePath);
  return { sourcePath, size: metadata.totalBytes, sha256: digest.digest("hex") };
}
