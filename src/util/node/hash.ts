/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Robert Wickel. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

/**
 * Computes SHA-256 hash of the given data.
 */
export function sha256(data: string | Buffer | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}
