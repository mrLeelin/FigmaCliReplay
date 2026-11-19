export interface RelayBuild {
  schemaVersion: 1;
  version: string;
  id: string;
}

export function readRelayBuild(root: string, verify?: boolean): RelayBuild | undefined;
export function writeRelayBuild(root: string): RelayBuild;
