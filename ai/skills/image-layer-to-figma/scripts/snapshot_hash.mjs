// Reuse the plugin's canonical hash instead of maintaining a Python approximation.
import fs from 'node:fs';
import { computeCleanupSnapshotHashFromNodes } from '../../../../code/08_cleanup_transaction.mjs';
const snapshot = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(snapshot.nodes)) throw new Error('snapshot.nodes must be an array');
process.stdout.write(computeCleanupSnapshotHashFromNodes(snapshot.nodes));
