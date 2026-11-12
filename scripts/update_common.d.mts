export interface ReleaseConfig { schemaVersion: 1; manifestUrl: string; publicKey: string }
export interface ReleasePayload { schemaVersion: 1; version: string; publishedAt: string; notes: string[]; archiveUrl: string; sha256: string; size: number }
export interface SignedManifest { schemaVersion: 1; payload: string; signature: string }
export interface DownloadOptions { allowLoopbackHttp?: boolean; maxBytes?: number; expectedBytes?: number; timeoutMs?: number; onProgress?: (received: number, total: number) => void }
export const MAX_ARCHIVE_BYTES: number;
export function assertVersion(version: unknown): string;
export function compareVersions(left: string, right: string): number;
export function validateDownloadUrl(value: string, options?: { allowLoopbackHttp?: boolean }): URL;
export function readReleaseConfig(root: string): ReleaseConfig;
export function parseSignedManifest(envelope: unknown, publicKey: string, options?: { allowLoopbackHttp?: boolean }): ReleasePayload;
export function writeJsonAtomic(file: string, value: unknown): void;
export function pathInside(candidate: string, root: string): string;
export function acquireLock(file: string): () => void;
export function downloadFile(value: string, file: string, options?: DownloadOptions): Promise<{bytes: number}>;
export function hashFile(file: string): Promise<string>;
export function readInstall(root: string): ReleaseConfig & {currentVersion: string; previousVersion?: string};
export function versionRoot(root: string, version: string): string;
export function runtimeEnvironment(root: string, releaseRoot: string): NodeJS.ProcessEnv;
export function relayControl(root: string, releaseRoot: string, version: string, runtime: {port: number; tokenFile?: string}, action?: string, payload?: object, timeoutMs?: number): Promise<any>;
export function waitForHealth(root: string, releaseRoot: string, version: string, runtime: {port: number; tokenFile?: string}, timeoutMs?: number): Promise<any>;
